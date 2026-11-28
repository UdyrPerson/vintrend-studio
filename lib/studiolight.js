// Studio light for a garment photo. Pure JS (typed arrays, running-sum boxes, grey guided filter, separable gaussian), no DOM.
// Light only: one smooth scalar luminance gain per pixel applied to linear RGB, so hue is kept exactly, except (a) a soft
// max-channel shoulder that scales all three channels together, (b) a neutral top-up on the few very dark pixels whose gain
// would exceed `gainChroma` and (c) a small chroma compensation of the lift (`hunt`: a lighter colour looks more colourful).
// Shape, pattern, colour identity and defects are never touched: the gain is a function of the smooth light field only
// (robust quadratic fit + relight), never of the pixel's own lightness, so a print, a colour block or a stain keeps its
// contrast (the max-channel shoulder takes the larger of the pixel and the closing of its max channel, lifted, so a mark
// darker than its surround gets the surround's factor; the lift is held back so that the shoulders squeeze at most
// kneeBudget of the garment).
//
// studioLight(img, mask, opts) -> { out, info }
//   img  : { width, height, data: Uint8ClampedArray RGBA }
//   mask : { width, height, data: Float32Array 0..1 } (garment matte; BiRefNet near-binary preferred)
//   opts : { profile: 'flat' | 'worn', strength: 0..1 (default STRENGTH; UI "Lumiere studio : douce / forte"), any knob }
//          'flat' = strong studio (flat lay / hanger), 'worn' = mild (worn photo, person mask: the person is not retouched)
//   out  : { width, height, data: Uint8ClampedArray RGBA }; pixels with mask <= 0.4 are bit-identical.
// colourIdentity(before, after, mask, opts) -> { ok, medianDrift, p95Drift, n, structure, ns } : export check, chromaticity +
// lightness structure (a global light gain is free).

const FLAT = {
  r1: 0.008, e1: 0.03,   // texture/base split: guided filter radius (fraction of sqrt(garment bbox area)), eps (log2^2)
  rS: 0.012,             // light layer: radius of the two masked boxes (fraction of sqrt(garment bbox area))
  flat: 0.9, flatMax: 1.2, // flat-field: share of the robust quadratic light field removed, bounded to +-flatMax EV
  rG: 0.05,              // gradient layer: S smoothed again over this radius (fraction of the garment size): a print is gone
  gFloor: 0.5,           // EV per half garment: floor of the Tukey scale of the light-field fit on that gradient. A level
                         // step (colour block, stripe, stain, another material such as black leggings or a face) is a gradient
                         // outlier, never light, so it is never flattened (no mid-scale shading removal either: at that
                         // scale a fold cannot be told from a colour block or a stain)
  support: 0.25,         // the curvature of the light field needs the samples that carry it (not D, see fitField) to fit it:
                         // mean Tukey weight >= support, else no curvature (real photos 0.90-0.95, tests >= 0.6; a vignette print on a black
                         // body, where only the print's centre row fits its own curvature: 0.005-0.015)
  kd: 1.5,               // EV: a pixel this much darker than S is dark detail, left out of the sparse-support gradient (step 3)
  fieldMax: 2,           // EV: the fitted field stays within +-fieldMax of its median (no runaway extrapolation)
  key: 0.3,              // softbox key light: +key EV top-left, -key EV bottom-right (corners of the garment bbox)
  evMax: 0.55, dL: 7,    // median lift: at most evMax EV and at most dL CIELAB L* ("taupe stays taupe")
  hiY: [0.955, 0.913], clipBudget: 0.01, // share of pixels whose brightest linear channel reaches hiY (250/255 for a near
                         // neutral, 245/255 for a saturated colour: JPEG 4:2:0 then rounds a saturated channel up to 255) may
                         // grow by clipBudget at most, already clipped pixels counted
  kneeBudget: 0.02, kneeTol: 0.03, // share of the (not already clipped) pixels that the gKnee shoulder squeezes by more than
                         // kneeTol: a lifted white pinned by the shoulder loses its texture and its light (with a per-pixel shoulder
                         // input a 0.15 EV mark on a 248 white went 3.5 -> 1.4 L* without this budget; see step 6)
  hunt: 0.35, huntMax: 0.002, // chroma x gain^(-hunt/3) (0 = pure gain, OKLCH C/L kept exactly; 1 = OKLab chroma kept),
                         // never more than huntMax OKLab chroma removed (a saturated colour keeps its C/L)
  sCurve: 0.08, pivot: 0.55, // S-curve on the light field in cbrt-lightness; small
  blackY: 0.02, blackSpan: 2, // intrinsic blacks: below blackY no lift, no curve, no clarity; full effect blackSpan EV above
  gDet: 1.2,             // texture clarity (detail gain on the log-luminance detail layer)
  core: 0.012, coreDark: 0.05, // detail coring threshold (log2); larger in dark tones (= luminance denoise of lifted shadows)
  usm: 0.3, usmS: 0.9, usmT: 0.02, // sharpening on log-luminance, cored
  knee: 0.85,            // soft tanh shoulder on Y (base)
  gKnee: 0.85,           // rational shoulder on max(max linear channel, rho x smooth lifted Y, lifted closing of the max
                         // channel) (gamut, hue kept): 1.0 -> 0.925
  kneeMargin: 0.04,      // EV: the smooth shoulder input rho x 2^(lifted field) sits this much above the lifted field, which
                         // can run ~0.02 EV under the real light (lit contour corner) and takes ~0.01 EV of a mark; a surround
                         // above its input is squeezed per pixel and the mark loses contrast (cream r 30 -0.1 EV in the bbox
                         // corner 0.72 -> 0.84; costs ~10 % of T on a white, median Y -0.5 %)
  rK: 0.15,              // closing radius of the shoulder input (fraction of the garment size): a darker mark up to ~1.4 rK
                         // across, or a darker band up to 2 rK wide, takes its surround's input (see step 6)
  gainChroma: 2.5,       // beyond this gain the extra light is added neutral (no neon streaks in dark lifted folds)
  edge: 4,               // px: interior ramp, no clarity/sharpening on contour pixels that hold background
  erode: 0,              // px: effect weight = mask * erode(mask)^2 ramp; 0 = the gain reaches the contour
};
export const PROFILES = {
  flat: FLAT,
  // worn photo: mask = the whole person; mixed hair/door and sleeve/door pixels are not lifted (erode), no clarity, no
  // sharpening, detail layer above the JPEG 8x8 block scale and cored (blocks are not amplified), small lift
  worn: { ...FLAT, r1: 0.014, flat: 0.35, flatMax: 0.5, key: 0, evMax: 0.4, dL: 4, sCurve: 0, gDet: 1,
    core: 0.025, coreDark: 0.06, usm: 0, erode: 6 },
};
export const STRENGTH = 0.7;   // default strength; profile amounts are given at this strength and scale linearly with it
const SCALED = ['flat', 'key', 'evMax', 'dL', 'sCurve', 'usm'];

const LIN = new Float32Array(256).map((_, i) => { const s = i / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
const ENC = new Uint8Array(65536).map((_, i) => { const l = (i / 65535) ** 2; return Math.round(255 * (l <= 0.0031308 ? 12.92 * l : 1.055 * l ** (1 / 2.4) - 0.055)); });
const LMAX = Float32Array.from(LIN, (v) => Math.log2(Math.max(v, 1e-6)));   // log2 of a linear channel, per 8-bit value
const enc = (l) => (l <= 0 ? 0 : l >= 1 ? 255 : ENC[(Math.sqrt(l) * 65535 + 0.5) | 0]);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// running max (sign > 0) or min over a (2R+1) window along rows (horiz) or columns, in place, beyond the image = pad;
// van Herk / Gil-Werman: O(1) per pixel whatever R (a min is the max of the negated values)
function vhg(a, w, h, R, horiz, sign, pad) {
  const L = horiz ? w : h, cnt = horiz ? h : w, st = horiz ? 1 : w, K = 2 * R + 1, P = L + 2 * R, sg = sign > 0 ? 1 : -1;
  const f = new Float32Array(P), g = new Float32Array(P), hh = new Float32Array(P);
  for (let c = 0; c < cnt; c++) {
    const o = horiz ? c * w : c;
    f.fill(sg * pad, 0, R); f.fill(sg * pad, R + L);
    for (let i = 0; i < L; i++) f[R + i] = sg * a[o + i * st];
    for (let b = 0; b < P; b += K) {   // prefix max forward and suffix max backward within each block of K
      const e = Math.min(P, b + K); g[b] = f[b]; hh[e - 1] = f[e - 1];
      for (let i = b + 1; i < e; i++) { const u = g[i - 1], v = f[i]; g[i] = u > v ? u : v; }
      for (let i = e - 2; i >= b; i--) { const u = hh[i + 1], v = f[i]; hh[i] = u > v ? u : v; }
    }
    for (let i = 0; i < L; i++) { const u = hh[i], v = g[i + 2 * R]; a[o + i * st] = sg * (u > v ? u : v); }
  }
}

// box SUM over (2r+1)^2, zero outside, separable running sums
function boxSum(src, w, h, r, out, tmp) {
  for (let y = 0; y < h; y++) {
    const o = y * w; let s = 0;
    for (let x = 0; x <= r && x < w; x++) s += src[o + x];
    for (let x = 0; x < w; x++) { tmp[o + x] = s; if (x + r + 1 < w) s += src[o + x + r + 1]; if (x - r >= 0) s -= src[o + x - r]; }
  }
  const cs = new Float64Array(w);
  for (let y = 0; y <= r && y < h; y++) for (let x = 0, o = y * w; x < w; x++) cs[x] += tmp[o + x];
  for (let y = 0; y < h; y++) {
    const o = y * w, ad = y + r + 1 < h ? (y + r + 1) * w : -1, sb = y - r >= 0 ? (y - r) * w : -1;
    for (let x = 0; x < w; x++) out[o + x] = cs[x];
    if (ad >= 0) for (let x = 0; x < w; x++) cs[x] += tmp[ad + x];
    if (sb >= 0) for (let x = 0; x < w; x++) cs[x] -= tmp[sb + x];
  }
  return out;
}

// grey self-guided filter, every box statistic weighted by wt (garment only: the floor never leaks in)
function guided(p, wt, w, h, r, eps) {
  const n = w * h, F = () => new Float32Array(n), tmp = F(), wb = boxSum(wt, w, h, r, F(), tmp);
  const a = F(), b = F(), t = F();
  for (let i = 0; i < n; i++) t[i] = p[i] * wt[i];
  const m = boxSum(t, w, h, r, F(), tmp);
  for (let i = 0; i < n; i++) t[i] = p[i] * p[i] * wt[i];
  const v = boxSum(t, w, h, r, F(), tmp);
  for (let i = 0; i < n; i++) {
    const k = wb[i] > 1e-6 ? 1 / wb[i] : 0, mi = m[i] * k, vi = v[i] * k - mi * mi, ai = vi / (vi + eps);
    a[i] = ai * wt[i]; b[i] = (mi - ai * mi) * wt[i];
  }
  const ma = boxSum(a, w, h, r, t, tmp), mb = boxSum(b, w, h, r, m, tmp);
  for (let i = 0; i < n; i++) { const k = wb[i] > 1e-6 ? 1 / wb[i] : 0; v[i] = wb[i] > 1e-6 ? ma[i] * k * p[i] + mb[i] * k : p[i]; }
  return v;
}

function gauss(src, w, h, s) { // separable, edge-clamped
  const R = Math.ceil(3 * s), K = 2 * R + 1, k = new Float32Array(K); let z = 0;
  for (let i = -R; i <= R; i++) z += k[i + R] = Math.exp(-0.5 * (i / s) ** 2);
  for (let i = 0; i < K; i++) k[i] /= z;
  const out = new Float32Array(w * h), tmp = new Float32Array(w * h), line = new Float32Array(Math.max(w, h) + 2 * R);
  const pass = (from, to, len, cnt, step, stride) => {
    for (let c = 0; c < cnt; c++) {
      const o = c * stride;
      for (let i = 0; i < len; i++) line[i + R] = from[o + i * step];
      for (let i = 0; i < R; i++) { line[i] = line[R]; line[len + R + i] = line[len + R - 1]; }
      for (let i = 0; i < len; i++) { let acc = 0; for (let j = 0; j < K; j++) acc += k[j] * line[i + j]; to[o + i * step] = acc; }
    }
  };
  pass(src, tmp, w, h, 1, w); pass(tmp, out, h, w, w, 1);
  return out;
}

function quant(vals, q) { // quantile of a plain array / typed array (small samples only)
  const s = Float64Array.from(vals).sort();
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : 0;
}

function kth(a, k) { // k-th smallest of a (reordered in place): quickselect, = the sorted array's [k]
  let lo = 0, hi = a.length - 1;
  while (hi > lo) {
    const pv = a[(lo + hi) >> 1]; let i = lo, j = hi;
    while (i <= j) { while (a[i] < pv) i++; while (a[j] > pv) j--; if (i <= j) { const t = a[i]; a[i] = a[j]; a[j] = t; i++; j--; } }
    if (k <= j) hi = j; else if (k >= i) lo = i; else break;
  }
  return a[k];
}

function solve6(A, y) { // Gauss with partial pivoting, 6x6
  const M = A.map((row, i) => [...row, y[i]]);
  for (let c = 0; c < 6; c++) {
    let p = c; for (let r = c + 1; r < 6; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c] || 1e-12;
    for (let r = c + 1; r < 6; r++) { const f = M[r][c] / d; for (let k = c; k < 7; k++) M[r][k] -= f * M[c][k]; }
  }
  const x = new Array(6).fill(0);
  for (let r = 5; r >= 0; r--) { let s = M[r][6]; for (let k = r + 1; k < 6; k++) s -= M[r][k] * x[k]; x[r] = s / (M[r][r] || 1e-12); }
  return x;
}

// robust (IRLS Tukey) quadratic light field from gradient samples (u, v, dz/du, dz/dv): the field's gradient is linear in
// c1..c5 (c0 = 0 here, the caller sets the level). A level step (colour block, stripe edge, stain, another material) is a
// gradient outlier and drops out; the gradients of a fine pattern are zero-mean and average out. Fewer than 30 samples ->
// flat field. Samples that span little of an axis (a chest logo, a hem band, a collar: the only lit part of a black or navy
// garment) do not determine a curvature along it (std < 0.3: no u^2 / uv / v^2 term) nor, below 0.1, a slope: those terms
// are held at 0 (a huge ridge), never extrapolated over the garment. Samples flagged D (a black body: a weaker light in 8-bit
// shadows, and the floor's flare near the outline, which reads as a bowl) set the slopes only: no curvature in their rows,
// the curvature spread is that of the other samples (fewer than 30 of them: no curvature). A curvature must be supported: if
// the samples that carry it end with a mean Tukey weight below `support`, the field is refitted without it (a vignette print
// that reaches the outline or merges with a lit trim on a black body: the D samples hold the slopes, Tukey drops the print's
// samples but its centre row, whose gradient is 2 c3 u alone, and that row set c3 to the print's own -3 to -8 EV).
function fitField(U, V, GU, GV, D, floor, support) {
  const n = U.length, wt = new Float64Array(n), res = new Float64Array(n), rs = new Float64Array(n);
  if (n < 30) return [0, 0, 0, 0, 0, 0];
  const sd = (a, all) => { let m = 0, q = 0, k = 0; for (let i = 0; i < n; i++) if (all || !D[i]) { m += a[i]; k++; } m /= k || 1; for (let i = 0; i < n; i++) if (all || !D[i]) q += (a[i] - m) ** 2; return k < 30 ? 0 : Math.sqrt(q / k); };
  const su = sd(U, 1), sv = sd(V, 1), lu = sd(U, 0), lv = sd(V, 0), on = [false, su >= 0.1, sv >= 0.1, lu >= 0.3, lu >= 0.3 && lv >= 0.3, lv >= 0.3];
  const irls = () => {
    let c; wt.fill(1);
    for (let it = 0; it < 6; it++) {
      // normal equations of the gradient rows d/du = [0, 1, 0, 2u, v, 0], d/dv = [0, 0, 1, 0, u, 2v] of [1, u, v, u^2, uv, v^2]
      // (a D sample: [0, 1, 0, 0, 0, 0], [0, 0, 1, 0, 0, 0]), from weighted moment sums
      let w0 = 0, wd = 0, mu = 0, mv = 0, muu = 0, muv = 0, mvv = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0;
      for (let k = 0; k < n; k++) {
        const wk = wt[k]; if (!wk) continue;
        const a = wk * GU[k], b = wk * GV[k]; g1 += a; g2 += b;
        if (D[k]) { wd += wk; continue; }
        const u = U[k], v = V[k]; w0 += wk; mu += wk * u; mv += wk * v; muu += wk * u * u; muv += wk * u * v; mvv += wk * v * v; g3 += a * u; g4 += a * v + b * u; g5 += b * v;
      }
      const A = [[0, 0, 0, 0, 0, 0], [0, w0 + wd, 0, 2 * mu, mv, 0], [0, 0, w0 + wd, 0, mu, 2 * mv], [0, 2 * mu, 0, 4 * muu, 2 * muv, 0], [0, mv, mu, 2 * muv, muu + mvv, 2 * muv], [0, 0, 2 * mv, 0, 2 * muv, 4 * mvv]];
      const yv = [0, g1, g2, 2 * g3, g4, 2 * g5];
      for (let i = 0; i < 6; i++) A[i][i] += on[i] ? 1e-6 : 1e12;
      c = solve6(A, yv);
      for (let k = 0; k < n; k++) { const e = D[k] ? 0 : 1, a = GU[k] - c[1] - e * (2 * c[3] * U[k] + c[4] * V[k]), b = GV[k] - c[2] - e * (c[4] * U[k] + 2 * c[5] * V[k]); res[k] = Math.sqrt(a * a + b * b); }
      rs.set(res); const s = Math.max(floor, 4.685 * 1.4826 * kth(rs, n >> 1));   // = quant(res, 0.5)
      for (let k = 0; k < n; k++) { const q = res[k] / s; wt[k] = q < 1 ? (1 - q * q) ** 2 : 0; }
    }
    return c;
  };
  let c = irls();
  if (on[3] || on[5]) {   // support: the samples that carry the curvature must mostly fit it (mean Tukey weight >= support)
    let sw = 0, k = 0; for (let i = 0; i < n; i++) if (!D[i]) { sw += wt[i]; k++; }
    if (sw < support * k) { on[3] = on[4] = on[5] = false; c = irls(); }
  }
  return c;
}

export function studioLight(img, mask, opts = {}) {
  const prof = PROFILES[opts.profile || 'flat'];
  if (!prof) throw new Error(`unknown profile ${opts.profile}`);
  const p = { ...prof, ...opts }, f = clamp(p.strength ?? STRENGTH, 0, 1) / STRENGTH;
  for (const k of SCALED) p[k] *= f;
  p.flat = Math.min(p.flat, 1); p.gDet = 1 + (p.gDet - 1) * f;
  const W = img.width, H = img.height, src = img.data, md = mask.data;
  if (mask.width !== W || mask.height !== H) throw new Error('mask size differs from image size');
  const outData = new Uint8ClampedArray(src), out = { width: W, height: H, data: outData };
  // 0. crop to the effect region (mask > 0.4) + margin: memory and time scale with the garment, not the photo
  let cx0 = W, cx1 = -1, cy0 = H, cy1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (md[y * W + x] > 0.4) { if (x < cx0) cx0 = x; if (x > cx1) cx1 = x; if (y < cy0) cy0 = y; if (y > cy1) cy1 = y; }
  if (cx1 < 0) return { out, info: { empty: true } };
  const pad = p.edge + 6; cx0 = Math.max(0, cx0 - pad); cy0 = Math.max(0, cy0 - pad); cx1 = Math.min(W - 1, cx1 + pad); cy1 = Math.min(H - 1, cy1 + pad);
  const w = cx1 - cx0 + 1, h = cy1 - cy0 + 1, n = w * h;

  // 1. linear RGB, luminance, log2 luminance, hardened effect mask a, statistics weight wt
  const lin = new Float32Array(3 * n), Y = new Float32Array(n), l = new Float32Array(n), a = new Float32Array(n), wt = new Float32Array(n);
  let x0 = w, x1 = -1, y0 = h, y1 = -1, nw = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, j = (y + cy0) * W + x + cx0, r = LIN[src[4 * j]], g = LIN[src[4 * j + 1]], b = LIN[src[4 * j + 2]];
    lin[3 * i] = r; lin[3 * i + 1] = g; lin[3 * i + 2] = b;
    Y[i] = 0.2126 * r + 0.7152 * g + 0.0722 * b; l[i] = Math.log2(Y[i] + 1e-4);
    a[i] = clamp((md[j] - 0.4) / 0.4, 0, 1);
    if (a[i] > 0.5) { wt[i] = 1; nw++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (nw < 64) return { out, info: { empty: true } };
  const size = Math.sqrt((x1 - x0 + 1) * (y1 - y0 + 1)), r1 = Math.max(2, Math.round(p.r1 * size));
  const bx = (x0 + x1) / 2, by = (y0 + y1) / 2, hx = Math.max(1, (x1 - x0) / 2), hy = Math.max(1, (y1 - y0) / 2);

  // 2. texture layer: fine base B1 (masked guided filter on log luminance, r1 ~ 1 % of the garment), detail D = l - B1.
  //    light layer: S = masked smooth of l (two normalised boxes, rS ~ 1.2 %): the light gain is computed on S only, so it
  //    is smooth and a print/jacquard/stripe keeps its exact contrast (a per-pixel curve would flatten a dark motif on white).
  const B1 = guided(l, wt, w, h, r1, p.e1), tmp = new Float32Array(n), t1 = new Float32Array(n);
  const smooth = (from, wgt, r, to, fb) => { // two normalised masked boxes of `from` weighted by wgt; fb where no weight
    const wb = boxSum(wgt, w, h, r, new Float32Array(n), tmp);
    for (let pass = 0; pass < 2; pass++, from = to) {
      for (let i = 0; i < n; i++) t1[i] = from[i] * wgt[i];
      boxSum(t1, w, h, r, to, tmp);
      for (let i = 0; i < n; i++) to[i] = wb[i] > 1e-3 ? to[i] / wb[i] : fb[i];
    }
    return to;
  };
  const S = smooth(l, wt, Math.max(3, Math.round(p.rS * size)), new Float32Array(n), l);
  // interior ramp gi: 1 at >= edge px inside the garment, 0 on the contour (no clarity there). Effect weight ae: the mask,
  // times erode(mask)^2 for the worn profile (a ramp of `erode` px: thin hair strands and mixed edge pixels get nothing)
  const gi = boxSum(wt, w, h, p.edge, new Float32Array(n), tmp), full = (2 * p.edge + 1) ** 2;
  for (let i = 0; i < n; i++) gi[i] = clamp((gi[i] / full - 0.75) * 4, 0, 1) * wt[i];
  const ae = a;
  if (p.erode > 0) {
    const re = Math.round(p.erode), eb = boxSum(wt, w, h, re, new Float32Array(n), tmp), fe = (2 * re + 1) ** 2;
    for (let i = 0; i < n; i++) { const e = clamp((eb[i] / fe - 0.5) * 2, 0, 1); ae[i] *= e * e; }
  }

  // dk: 0 on intrinsic blacks (Y <= blackY), 1 from blackSpan EV above: no relight, no curve, no clarity on blacks
  const lb = Math.log2(p.blackY);
  const dk = (v) => { const t = (v - lb) / p.blackSpan; return t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t); };
  // 3. light field: robust quadratic fitted on the gradient of the light layer (interior samples every 4 px, coordinates in
  //    the garment bbox -1..1); level c0 = median of S - field. Light evidence cls (1 lit: S above the intrinsic black, 2
  //    unlit, 0 none): a connected region of one class that reaches the outline (>= 3 % of the garment size along the `edge`
  //    band): the body, a collar, a hem band, cuffs, a stripe. A region enclosed by the other class (a print or a logo on a
  //    black body, a black logo on a lit one, a polka dot) is not evidence: its own shading (a fade, a vignette) cannot be
  //    told from the light, and the body around it shows the light. Lit pixels lw: lit evidence with no unlit garment pixel
  //    within the S radius + 2 (not S's blur of a step to black either). Where they fill the gradient window (+-2 rG), the
  //    gradient is that of S smoothed over rG (masked, two boxes, central differences over +-2 px). Elsewhere (stripes or
  //    dots on black, a lit band, a charcoal half in the dark) that box mean only moved when lit pixels entered or left the
  //    box (a zero or wrong-sign slope): the gradient there is the mean, over the same window, of the differences of l
  //    between neighbouring evidence pixels (lw or unlit) that are not dark detail (l > S - kd: the black of a fine stripe,
  //    S's blur of a step; l - S does not change with a smooth light) and not a step (|dl| < 1 EV, a light moves l by < 0.01
  //    EV per px): between two excluded pixels they add up to the light across a stripe, a band or a dot. Lit pairs where the
  //    window holds enough of them, else unlit ones (a black body, between dots or around a print; slope only, see fitField).
  //    Counts and sums per 4 px cell, boxed twice
  const cls = new Uint8Array(n), qu = new Int32Array(t1.buffer), rimMin = p.edge * 0.03 * size;
  for (let y = 1; y < h - 1; y++) for (let x = 1, i = y * w + 1; x < w - 1; x++, i++) cls[i] = wt[i] ? (S[i] > lb ? 1 : 2) : 0;   // crop border 0: no bounds checks
  for (let s0 = 0; s0 < n; s0++) {   // flood fill of each region (visited: + 4), its pixels in qu, then 4 if it is enclosed
    const c = cls[s0]; if (c === 0 || c > 2) continue;
    let qh = 0, qt = 1, rim = 0; qu[0] = s0; cls[s0] = c + 4;
    while (qh < qt) {
      const i = qu[qh++];
      if (gi[i] < 1) rim++;
      if (cls[i - 1] === c) { cls[i - 1] = c + 4; qu[qt++] = i - 1; }
      if (cls[i + 1] === c) { cls[i + 1] = c + 4; qu[qt++] = i + 1; }
      if (cls[i - w] === c) { cls[i - w] = c + 4; qu[qt++] = i - w; }
      if (cls[i + w] === c) { cls[i + w] = c + 4; qu[qt++] = i + w; }
    }
    if (rim < rimMin) for (let q = 0; q < qt; q++) cls[qu[q]] = 4;
  }
  for (let i = 0; i < n; i++) cls[i] &= 3;
  const F = new Float32Array(n), Fn = new Float32Array(n), lw = F;   // lw in F, Fn scratch: both are set in full below
  for (let i = 0; i < n; i++) Fn[i] = wt[i] && !(S[i] > lb) ? 1 : 0;
  boxSum(Fn, w, h, Math.max(3, Math.round(p.rS * size)) + 2, lw, tmp);
  for (let i = 0; i < n; i++) { lw[i] = cls[i] === 1 && lw[i] < 0.5 ? 1 : 0; Fn[i] = (lw[i] || cls[i] === 2) && gi[i] >= 1 && l[i] - S[i] > -p.kd ? 1 : 0; }
  const rG = Math.max(3, Math.round(p.rG * size)), Sg = smooth(S, lw, rG, new Float32Array(n), S), gS = (i, d) => (Sg[i + d] - Sg[i - d]) / 4;
  const w4 = (w + 3) >> 2, h4 = (h + 3) >> 2, n4 = w4 * h4, F4 = () => new Float32Array(n4), P = Array.from({ length: 8 }, F4), cg = F4(), cl = F4(), t4 = F4();
  for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i++) {
    if (!wt[i]) continue;
    const g = (y >> 2) * w4 + (x >> 2); cg[g]++; cl[g] += lw[i];
    if (!Fn[i]) continue;
    const o = cls[i] === 1 ? 0 : 4;   // P[o..o+3]: count and sum of the x then y differences, lit (o = 0) or unlit (o = 4) pairs
    if (x < w - 1 && Fn[i + 1]) { const d = l[i + 1] - l[i]; if (d < 1 && d > -1) { P[o][g]++; P[o + 1][g] += d; } }
    if (y < h - 1 && Fn[i + w]) { const d = l[i + w] - l[i]; if (d < 1 && d > -1) { P[o + 2][g]++; P[o + 3][g] += d; } }
  }
  const R4 = Math.max(1, Math.round(rG / 4));
  for (let pass = 0; pass < 2; pass++) for (const m of [...P, cg, cl]) boxSum(m, w4, h4, R4, m, t4);
  const U = [], V = [], GU = [], GV = [], D = [];
  for (let y = 4; y < h - 4; y += 4) for (let x = 4; x < w - 4; x += 4) {
    const i = y * w + x, g = (y >> 2) * w4 + (x >> 2);
    if (!(gi[i] >= 1 && gi[i - 2] >= 1 && gi[i + 2] >= 1 && gi[i - 2 * w] >= 1 && gi[i + 2 * w] >= 1)) continue;
    if (cl[g] >= 0.95 * cg[g]) { U.push((x - bx) / hx); V.push((y - by) / hy); GU.push(gS(i, 2) * hx); GV.push(gS(i, 2 * w) * hy); D.push(0); }
    else for (const o of [0, 4]) if (P[o][g] >= 0.05 * cg[g] && P[o + 2][g] >= 0.05 * cg[g]) { U.push((x - bx) / hx); V.push((y - by) / hy); GU.push(P[o + 1][g] / P[o][g] * hx); GV.push(P[o + 3][g] / P[o + 2][g] * hy); D.push(o / 4); break; }
  }
  const c = fitField(U, V, GU, GV, D, p.gFloor, p.support), Zr = [], Q = [];
  const quad0 = (u, v) => c[1] * u + c[2] * v + c[3] * u * u + c[4] * u * v + c[5] * v * v;
  for (let y = 0; y < h; y += 4) for (let x = 0; x < w; x += 4) if (gi[y * w + x] >= 1) Q.push(quad0((x - bx) / hx, (y - by) / hy));
  const qm = quant(Q, 0.5), quad = (u, v) => qm + clamp(quad0(u, v) - qm, -p.fieldMax, p.fieldMax);
  for (let y = 0; y < h; y += 4) for (let x = 0; x < w; x += 4) { const i = y * w + x; if (gi[i] >= 1) Zr.push(S[i] - quad((x - bx) / hx, (y - by) / hy)); }
  c[0] = quant(Zr, 0.5);
  const field = (u, v) => c[0] + quad(u, v), fm = c[0] + qm;
  // F: quadratic light field; Fn: the field after flat-field and softbox key (log2 Y), smooth by construction
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const u = (x - bx) / hx, v = (y - by) / hy, i = y * w + x;
    F[i] = field(u, v);
    Fn[i] = F[i] + clamp(p.key * clamp(-(u + v) / 2, -1, 1) - p.flat * clamp(F[i] - fm, -p.flatMax, p.flatMax), -p.flatMax, p.flatMax);
  }
  // Mc: closing (max then min over a square of radius rK, garment cells only) of the masked rS smooth of log2 of the
  // original max channel = the closing shoulder input of step 6 before the lift (smoothed first: a closing of the raw
  // pixels sits at the knit's texture peaks, above an unfilled mark's input). On the 2x grid: a level map smooth at rS
  // loses nothing there, at a quarter of the time and memory
  const w2 = (w + 1) >> 1, h2 = (h + 1) >> 1, n2 = w2 * h2, Mc = new Float32Array(n2), c2 = new Float32Array(n2), q2 = new Float32Array(n2), t2 = new Float32Array(n2);
  const cell = (i) => (((i / w) | 0) >> 1) * w2 + ((i % w) >> 1);
  for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i++) if (wt[i]) { const g = (y >> 1) * w2 + (x >> 1), j = 4 * ((y + cy0) * W + x + cx0); Mc[g] += LMAX[Math.max(src[j], src[j + 1], src[j + 2])]; c2[g]++; }
  for (let g = 0; g < n2; g++) if (c2[g]) { Mc[g] /= c2[g]; c2[g] = 1; }
  const rs2 = Math.max(2, Math.round(p.rS * size / 2)), R2 = Math.max(1, Math.round(p.rK * size / 2)), wb2 = boxSum(c2, w2, h2, rs2, new Float32Array(n2), t2);
  for (let pass = 0; pass < 2; pass++) {
    for (let g = 0; g < n2; g++) q2[g] = c2[g] ? Mc[g] : 0;
    boxSum(q2, w2, h2, rs2, Mc, t2);
    for (let g = 0; g < n2; g++) Mc[g] = c2[g] ? Mc[g] / wb2[g] : -Infinity;
  }
  vhg(Mc, w2, h2, R2, true, 1, -Infinity); vhg(Mc, w2, h2, R2, false, 1, -Infinity);
  for (let g = 0; g < n2; g++) if (!c2[g]) Mc[g] = Infinity;
  vhg(Mc, w2, h2, R2, true, -1, Infinity); vhg(Mc, w2, h2, R2, false, -1, Infinity);
  for (let g = 0; g < n2; g++) if (Mc[g] === Infinity) Mc[g] = -Infinity;   // a soft mask blob farther than rK from the garment: no input (not 2^Inf = NaN, black)

  // 4. tone curve on the light field: exposure with a white-point roll-off, f(Y) = E*Y / (1 + (E-1)*Y) (slope E in the
  //    darks, f(1) = 1: a bright part of the garment gets less lift), then an S-curve in cbrt lightness, all faded to
  //    identity on intrinsic blacks; soft tanh shoulder on Y as a guard. Per-pixel log gain lg = dk(S) * (log2 tone(Fn) - F):
  //    one value for a stain and its surround, so its ratio is kept (blacks: no relight, no lift).
  const kn = p.knee, shoulder = (y) => (y > kn ? kn + (1 - kn) * Math.tanh((y - kn) / (1 - kn)) : y);
  const tone = (bn, E) => {
    const Yb = 2 ** bn, Y1 = E * Yb / (1 + (E - 1) * Yb), Lb = Math.cbrt(Yb), L1 = Math.cbrt(Y1), d = L1 - p.pivot, t = Math.min(Math.abs(d) / 0.5, 1);
    const L = Math.max(1e-3, Lb + dk(bn) * (L1 + p.sCurve * d * (1 - t * t) - Lb));
    return shoulder(L * L * L);
  };
  const lg = (i, e) => dk(S[i]) * (Math.log2(tone(Fn[i], e)) - F[i]);
  const gk = p.gKnee, lgk = Math.log2(gk), gam = (M) => { if (M <= gk) return M; const u = (M - gk) / (1 - gk); return gk + (1 - gk) * u / (1 + u); };
  const lo = new Float32Array(n), dkp = t1;   // fine base + cored/boosted detail; dk of the pixel's own fine base (noise is a pixel-level matter)
  for (let i = 0; i < n; i++) {
    const D = l[i] - B1[i], dkv = dkp[i] = dk(B1[i]), cc = p.core + p.coreDark * (1 - dkv), Dc = D * D * D / (D * D + cc * cc);
    const g = gi[i] * dkv, De = g * Dc * (1 + (p.gDet - 1) * dkv) + (1 - g) * D;
    lo[i] = B1[i] + De;
  }
  // lift: the garment median gets up to evMax EV and up to dL L* above its original lightness, then the largest E <= that
  // which keeps (per pixel, clarity included) the share of pixels whose brightest channel reaches hiY within clipBudget of the
  // original share AND the share squeezed by the shoulder within kneeBudget; if even E = 1 breaks that (key light / flat-field
  // on a white), the whole light change is scaled by T < 1 (one factor for the smooth gain: a stain keeps its ratio)
  let ns = 0;   // staggered samples (no aliasing with a rib), typed arrays (a garment holds ~1M of them)
  for (let y = 0; y < h; y++) for (let i = y * w + y % 3; i < (y + 1) * w; i += 3) if (gi[i] >= 1) ns++;
  const sI = new Int32Array(ns), F32 = () => new Float32Array(ns), sFn = F32(), sS = F32(), sM = F32(), sT = F32(), sX = F32(), sC = F32(), sF = F32(), sR = F32();   // sC: closed input; sF: field
  for (let y = 0, q = 0; y < h; y++) for (let i = y * w + y % 3; i < (y + 1) * w; i += 3) if (gi[i] >= 1) {
    const M = Math.max(lin[3 * i], lin[3 * i + 1], lin[3 * i + 2]), sat = 1 - Math.min(lin[3 * i], lin[3 * i + 1], lin[3 * i + 2]) / Math.max(M, 1e-6);
    sI[q] = i; sR[q] = M / Math.max(Y[i], 1e-6); sFn[q] = Fn[i]; sS[q] = S[i]; sX[q] = 2 ** (lo[i] - l[i]); sM[q] = M; sC[q] = Mc[cell(i)]; sF[q] = F[i]; sT[q++] = p.hiY[0] + (p.hiY[1] - p.hiY[0]) * clamp((sat - 0.2) / 0.3, 0, 1);
  }
  // rho: garment median of max channel / luminance (1 on a neutral, ~1.04 cream, ~1.6 light blue): rho * 2^(lifted field) is
  // the smooth max channel of the garment's own colour, the other shoulder input (see step 6): the closing cannot fill a
  // mark that reaches the outline (no surround beyond it), the garment-wide one does
  const rho = Math.max(1, quant(sR, 0.5)), rf = rho * 2 ** p.kneeMargin;
  const sP = new Float32Array(ns), lrf = Math.log2(rf);   // the step 6 shoulder input before the lift
  for (let q = 0; q < ns; q++) sP[q] = 2 ** Math.max(lrf + sF[q], sC[q]);
  const Y0 = 2 ** quant(sS, 0.5), Ym = Math.min(0.95, 2 ** quant(sFn, 0.5)), Yt = ((116 * Math.cbrt(Y0) + p.dL) / 116) ** 3;
  const G = Math.max(1, Math.min(2 ** p.evMax, Yt / Ym, 0.98 / Ym));
  let E = G * (1 - Ym) / (1 - G * Ym), T = 1;
  const lift = (i, e) => T * lg(i, e);
  // sL = lg of each sample at the current E (E is fixed during the T fit: one pass of tone() per E, not per bisection step)
  const sL = new Float32Array(sI.length), setE = (e) => { E = e; for (let q = 0; q < sI.length; q++) sL[q] = lg(sI[q], e); };
  const hiShare = () => { let c = 0, s = 0; for (let q = 0; q < sM.length; q++) {
    const v = T * sL[q], e = 2 ** v, k = sX[q] * e, m = sM[q] * k, mf = Math.max(m, sP[q] * e);   // the step 6 shoulder
    const o = k > 1 && mf > gk ? Math.max(Math.min(sM[q], m), m * gam(mf) / mf) : m;
    if (o >= sT[q]) c++; else if (sM[q] < sT[q] && m > gk && o < (1 - p.kneeTol) * m) s++;   // in the shoulder itself (a dark band
    // holding its light surround's closed input keeps its texture: one factor over the band, not a pinned highlight)
  } return [c / sM.length, s / sM.length]; };
  let hi0 = 0; for (let q = 0; q < sM.length; q++) if (sM[q] >= sT[q]) hi0++;
  hi0 /= sM.length || 1;
  const over = () => { const [c, s] = hiShare(); return c > hi0 + p.clipBudget || s > p.kneeBudget; };
  const fit = (set) => { let a = 0, b = 1; for (let it = 0; it < 10; it++) { set((a + b) / 2); if (over()) b = (a + b) / 2; else a = (a + b) / 2; } set(a); };
  const E0 = E;
  setE(E);
  if (over()) fit((t) => setE(1 + t * (E0 - 1)));
  if (over()) fit((t) => { T = t; });
  const hiEnd = hiShare();
  const ev = Math.log2(E / (1 + (E - 1) * Ym));   // lift of the median, EV

  // 5. output log luminance lo = fine base + detail + lg: the detail cored (denoise, stronger in darks) and boosted inside
  //    the garment only (edges and blacks untouched); cored sharpening comes after
  for (let i = 0; i < n; i++) { const v = lift(i, E); lo[i] += v; Fn[i] = F[i] + v; }   // Fn: now the smooth lifted light (log2 Y)
  const gl = p.usm > 0 ? gauss(lo, w, h, p.usmS) : lo, ok = [0, 0, 0];
  // 6. recomposition: scalar gain on linear RGB, neutral top-up beyond gainChroma, chroma compensation, max-channel
  //    shoulder (hue kept), blend by the effect weight
  for (let i = 0; i < n; i++) {
    const x = i % w, y = (i / w) | 0, j = 4 * ((y + cy0) * W + x + cx0), fw = ae[i];
    if (fw <= 0.002 || md[j >> 2] <= 0) continue; // mask 0 stays bit-identical
    const dd = lo[i] - gl[i], s = p.usm * gi[i] * dkp[i];
    let yo = Math.max(2 ** (lo[i] + s * dd * Math.abs(dd) / (Math.abs(dd) + p.usmT)) - 1e-4, 0);
    yo = yo > 0.9 ? 0.9 + 0.1 * Math.tanh((yo - 0.9) / 0.1) : yo;
    const Yi = Y[i], k = yo / Math.max(Yi, 1e-6), gc = Math.min(k, p.gainChroma, yo / Math.max(Yi, 0.006)), add = Math.max(0, yo - Yi * gc);
    let r = lin[3 * i] * gc + add, g = lin[3 * i + 1] * gc + add, b = lin[3 * i + 2] * gc + add;
    if (p.hunt > 0 && k > 1) { oklab(src[j], src[j + 1], src[j + 2], ok); const sc = Math.max(k ** (-p.hunt / 3), 1 - p.huntMax / Math.max(Math.hypot(ok[1], ok[2]), 1e-6)), Yg = 0.2126 * r + 0.7152 * g + 0.0722 * b; r = Yg + sc * (r - Yg); g = Yg + sc * (g - Yg); b = Yg + sc * (b - Yg); }
    // gamut: rational shoulder on the max channel (all channels scaled together), on the added light only: a pixel is
    // never pushed below its own original brightest channel (an already clipped white stays white, not 250 grey). Its input
    // is the largest of the pixel's own max channel, the smooth lifted max channel of the garment's colour rf * 2^Fn and the
    // closing Mc of its max channel lifted by the smooth gain (no detail). The closing fills every darker feature smaller
    // than rK (a mark, a stain, a dark print or stripe on a white) with its surround's level, so the feature gets the
    // surround's factor and keeps its ratio, and keeps colour-block and light-print edges where they are (a block brighter
    // than the garment median gets its own level: no per-pixel shoulder on it, no halo on the darker side of its edge);
    // rf * 2^Fn covers a mark that reaches the outline, where the closing has no surround beyond it
    const M = Math.max(r, g, b), lq = Math.max(lrf + Fn[i], Mc[(y >> 1) * w2 + (x >> 1)] + Fn[i] - F[i]);   // log2 of the smooth inputs
    if (M > gk || lq > lgk) { const Mf = Math.max(M, 2 ** lq), M0 = Math.max(lin[3 * i], lin[3 * i + 1], lin[3 * i + 2]), sc = Math.max(Math.min(M0, M), M * gam(Mf) / Mf) / M; r *= sc; g *= sc; b *= sc; }
    outData[j] = enc(fw * r + (1 - fw) * lin[3 * i]); outData[j + 1] = enc(fw * g + (1 - fw) * lin[3 * i + 1]); outData[j + 2] = enc(fw * b + (1 - fw) * lin[3 * i + 2]);
  }
  return { out, info: { profile: opts.profile || 'flat', strength: +(f * STRENGTH).toFixed(2), ev: +ev.toFixed(3), E: +E.toFixed(3), medianY: +Ym.toFixed(4), hi: [+hi0.toFixed(3), ...hiEnd.map((v) => +v.toFixed(3))], T: +T.toFixed(3), rho: +rho.toFixed(3), crop: [cx0, cy0, w, h], r1, field: c.map((v) => +v.toFixed(3)) } };
}


// ---- export check: colour identity (chromaticity + hue) and lightness structure, global light free ------------------
// Per garment-core pixel (mask >= 0.8) in OKLab: rescale the after pixel's (a, b) to the before lightness (a pure light gain
// k multiplies L, a and b by cbrt(k), so it gives exactly 0) and take the (a, b) distance. Pixels darker than L 0.25 in
// either image are skipped for the drift (8-bit noise dominates there); the structure term judges every pixel light BEFORE
// (a light print turned black is a structure loss, not a skipped pixel). 0.02 is about one just-noticeable OKLab difference.
// Thresholds from the 4 test photos: this pipeline 0.0005-0.0006 median / 0.0010-0.0012 p95 on raw buffers, 0.0012-0.0031 /
// 0.0037-0.0087 after JPEG q93 (engineers A, B, C: up to 0.0045 / 0.0131); a ~6 deg hue shift gives 0.026, chroma +30 % 0.040.
// Lightness structure (a stain, a colour block, a stripe keeps its contrast): band-pass of log2 Y on the same 2x grid =
// masked box mean over sS minus a masked least-squares plane over sL of the garment size, read at the pixel (texture and
// clarity below, light field and key light above); slope after/before (least squares) over core pixels whose before
// structure exceeds sEV must stay >= `structure`. Fewer than sMin such pixels: nothing to judge (slope 1, ns says how many
// were judged). sEV 0.04 sees a faint -0.15 EV mark of any width up to sL (0.1 let 0.15-0.2 EV stains and stains wider than
// ~sL through unjudged). Every core pixel counts, the contour band too (collar, cuffs, hem, whole sleeves): a plane is blind
// to a linear light gradient even on a box cut by the contour, where a box mean leaked it into the band (a plain garment
// under 1.3 EV of light read 0.25-0.36, so round 2 judged only pixels whose sL box lay 90 % inside the garment, ~0.4 sL from
// the outline). A wider sL (0.25) takes the flat-field and key light for structure (0.5-0.77 on this pipeline). This
// pipeline: 0.9-1.05 (4 real photos 0.96-1.05); a flattening to 40 % of the contrast gives 0.4.
export const IDENTITY = { median: 0.005, p95: 0.015, minL: 0.25, core: 0.8, structure: 0.7, sEV: 0.04, sMin: 10, sS: 0.01, sL: 0.1 };
function oklab(r8, g8, b8, o) {
  const r = LIN[r8], g = LIN[g8], b = LIN[b8];
  const L = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b), M = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b), S = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  o[0] = 0.2104542553 * L + 0.7936177850 * M - 0.0040720468 * S; o[1] = 1.9779984951 * L - 2.4285922050 * M + 0.4505937099 * S; o[2] = 0.0259040371 * L + 0.7827717662 * M - 0.8086757660 * S;
}
export function colourIdentity(before, after, mask, opts = {}) {
  const t = { ...IDENTITY, ...opts }, A = before.data, B = after.data, m = mask.data, W = before.width, H = before.height;
  const p = [0, 0, 0], q = [0, 0, 0], d = [], gw = (W + 1) >> 1, gh = (H + 1) >> 1, gn = gw * gh, F = () => new Float32Array(gn);
  const la = F(), lb = F(), wt = F(), use = new Uint8Array(gn), ly = (D, i) => Math.log2(0.2126 * LIN[D[4 * i]] + 0.7152 * LIN[D[4 * i + 1]] + 0.0722 * LIN[D[4 * i + 2]] + 1e-4);
  let nw = 0, nu = 0;
  for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) {   // every 2nd pixel each way: plenty, 4x cheaper
    const i = y * W + x, g = (y >> 1) * gw + (x >> 1); if (m[i] < t.core) continue;
    wt[g] = 1; nw++; la[g] = ly(A, i); lb[g] = ly(B, i);
    oklab(A[4 * i], A[4 * i + 1], A[4 * i + 2], p); oklab(B[4 * i], B[4 * i + 1], B[4 * i + 2], q);
    if (p[0] < t.minL) continue;
    use[g] = 1; nu++; if (q[0] < t.minL) continue;
    const s = p[0] / q[0]; d.push(Math.hypot(q[1] * s - p[1], q[2] * s - p[2]));
  }
  if (!nu) return { ok: true, medianDrift: 0, p95Drift: 0, n: 0, structure: 1, ns: 0 };
  const tmp = F(), t2 = F(), rs = Math.max(1, Math.round(t.sS * Math.sqrt(nw))), rl = Math.max(rs + 1, Math.round(t.sL * Math.sqrt(nw)));
  const wS = boxSum(wt, gw, gh, rs, F(), tmp), a = F(), b = F();
  // large scale: weighted least-squares plane over the rl box, read at the pixel (not the box mean): on a box cut by the
  // contour the mean sits at the box centroid, inside the garment, and a light gradient leaks into the band; a plane does
  // not see any linear light, wherever the pixel is. k0, kx, ky = first row of the inverse moment matrix (coordinates
  // centred on the pixel; grid-centred X, Y keep the float32 sums exact enough; +1 on the diagonal: a 1-px strip is fine)
  const hx = gw >> 1, hy = gh >> 1, X = (g) => (g % gw) - hx, Yc = (g) => ((g / gw) | 0) - hy;
  const bs = (fn, o) => { for (let g = 0; g < gn; g++) t2[g] = fn(g); return boxSum(t2, gw, gh, rl, o, tmp); };
  const k0 = bs((g) => wt[g], F()), kx = bs((g) => wt[g] * X(g), F()), ky = bs((g) => wt[g] * Yc(g), F());
  const mxx = bs((g) => wt[g] * X(g) * X(g), F()), mxy = bs((g) => wt[g] * X(g) * Yc(g), F()), myy = bs((g) => wt[g] * Yc(g) * Yc(g), F());
  for (let g = 0; g < gn; g++) {
    if (!wt[g]) { k0[g] = kx[g] = ky[g] = 0; continue; }
    const x = X(g), y = Yc(g), s0 = k0[g], sx = kx[g] - x * s0, sy = ky[g] - y * s0;
    const sxx = mxx[g] - 2 * x * kx[g] + x * x * s0 + s0, sxy = mxy[g] - x * ky[g] - y * kx[g] + x * y * s0, syy = myy[g] - 2 * y * ky[g] + y * y * s0 + s0;
    const c0 = sxx * syy - sxy * sxy, c1 = sy * sxy - sx * syy, c2 = sx * sxy - sy * sxx, det = s0 * c0 + sx * c1 + sy * c2;
    k0[g] = c0 / det; kx[g] = c1 / det; ky[g] = c2 / det;
  }
  const band = (l, o) => {   // o = box mean over rs - plane over rl at the pixel, weighted by wt
    for (let g = 0; g < gn; g++) tmp[g] = l[g] * wt[g];
    boxSum(tmp, gw, gh, rs, o, t2);
    for (let g = 0; g < gn; g++) o[g] = wt[g] ? o[g] / wS[g] : 0;
    const L0 = bs((g) => l[g] * wt[g], mxx), LX = bs((g) => l[g] * wt[g] * X(g), mxy), LY = bs((g) => l[g] * wt[g] * Yc(g), myy);
    for (let g = 0; g < gn; g++) if (wt[g]) o[g] -= k0[g] * L0[g] + kx[g] * (LX[g] - X(g) * L0[g]) + ky[g] * (LY[g] - Yc(g) * L0[g]);
    return o;
  };
  band(la, a); band(lb, b);
  let sxy = 0, sxx = 0, ns = 0;
  for (let g = 0; g < gn; g++) if (use[g] && Math.abs(a[g]) > t.sEV) { sxy += a[g] * b[g]; sxx += a[g] * a[g]; ns++; }
  const structure = ns >= t.sMin ? sxy / sxx : 1, medianDrift = quant(d, 0.5), p95Drift = quant(d, 0.95);
  return { ok: medianDrift <= t.median && p95Drift <= t.p95 && structure >= t.structure, medianDrift: +medianDrift.toFixed(5), p95Drift: +p95Drift.toFixed(5), n: d.length, structure: +structure.toFixed(3), ns };
}
