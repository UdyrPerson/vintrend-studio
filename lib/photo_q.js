// Critères photo_q de la photo principale, opération par opération comme pixels(), u2_mask(), erode() et lab() de
// pipeline/live/photo_q.py (son code fait foi). Prouvés équivalents par test_photo_q_parity.mjs. Fonctions pures, sans DOM.
// Image : {width, height, data: Uint8ClampedArray} RGBA. Masque : {width, height, data: Float32Array} valeurs 0 ou 1.
import { resizeLanczos, resizeBilinear, resizeNearest, thumbnailSize, toL, pyRound } from './resample.js';

export { pyRound };

// pq_version de photo_q.py (avec VT_PQ_NOCLIP=1) contre laquelle vectors/expected.ndjson a été produit.
export const PQ_REF = 'photo_q:703f260497c3+text:v001+noclip';

const EDGE = 0.08, SIDE = 400, CLUTTER_SIDE = 128, ERODE = 3, VAR_FLOOR = 100, CLUTTER_GAP = 2;
const SOBEL_T = { t1: 20, t2: 40, t3: 80 };
const F = Math.fround;                                   // photo_q.py prépare l'entrée du modèle en float32
const U2_MEAN = [0.485, 0.456, 0.406].map(F), U2_STD = [0.229, 0.224, 0.225].map(F);

// _r : 5 chiffres significatifs, null pour NaN / inf / absent.
// ponytail: toPrecision arrondit les égalités exactes loin de zéro, Python au pair ; écart ≤ 1 unité au 5e chiffre, rarissime.
const r5 = (x) => (Number.isFinite(x) ? Number(x.toPrecision(5)) : null);

// np.percentile, interpolation linéaire.
export function percentile(values, q) {
  const s = Float64Array.from(values).sort(), i = (q / 100) * (s.length - 1), lo = Math.floor(i);
  return lo + 1 < s.length ? s[lo] + (i - lo) * (s[lo + 1] - s[lo]) : s[lo];
}

// sRGB -> L*, a*, b* (D65), pour chaque pixel d'une image RGBA : {L, A, B} en Float64Array.
const LIN = Float64Array.from({ length: 256 }, (_, v) => (v / 255 <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4));
const fLab = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
export function lab(img) {
  const n = img.width * img.height, d = img.data, L = new Float64Array(n), A = new Float64Array(n), B = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const r = LIN[d[4 * i]], g = LIN[d[4 * i + 1]], b = LIN[d[4 * i + 2]];
    const fx = fLab((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047);
    const fy = fLab(0.2126 * r + 0.7152 * g + 0.0722 * b);
    const fz = fLab((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
    L[i] = 116 * fy - 16;
    A[i] = 500 * (fx - fy);
    B[i] = 200 * (fy - fz);
  }
  return { L, A, B };
}

// k passes d'érosion binaire en croix (4 voisins) ; l'extérieur de l'image compte comme sujet.
export function erode(mask, k) {
  const { width: w, height: h } = mask;
  let m = mask.data;
  for (let p = 0; p < k; p++) {
    const e = m.slice();
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const j = y * w + x;
        if (m[j] && ((y > 0 && !m[j - w]) || (y < h - 1 && !m[j + w]) || (x > 0 && !m[j - 1]) || (x < w - 1 && !m[j + 1]))) e[j] = 0;
      }
    m = e;
  }
  return { width: w, height: h, data: m };
}

// Masque U2-Net-p : sigmoïde brute bornée, uint8(p * 255) tronqué, BILINEAR à la taille de img, puis ≥ 0,5.
export async function u2Mask(img, runU2) {
  const s = resizeBilinear(img, 320, 320).data, N = 320 * 320;
  let max = 0;
  for (let i = 0; i < N; i++) for (let c = 0; c < 3; c++) max = Math.max(max, F(s[4 * i + c] / 255));
  const div = F(Math.max(max, 1e-6)), x = new Float32Array(3 * N);
  for (let i = 0; i < N; i++)
    for (let c = 0; c < 3; c++) x[c * N + i] = F(F(F(s[4 * i + c] / 255) / div) - U2_MEAN[c]) / U2_STD[c];
  const p = await runU2(x), q = new Uint8ClampedArray(N);
  for (let i = 0; i < N; i++) q[i] = Math.trunc(F(Math.min(Math.max(p[i], 0), 1) * 255));
  const up = resizeBilinear({ width: 320, height: 320, data: q }, img.width, img.height).data;
  return { width: img.width, height: img.height, data: Float32Array.from(up, (v) => (v >= 128 ? 1 : 0)) };   // v / 255 ≥ 0,5
}

// Moyenne et écart-type de population de values[i] pour les i où sel(i) est vrai.
function stats(values, sel, n) {
  let k = 0, s = 0;
  for (let i = 0; i < n; i++)
    if (sel(i)) {
      k++;
      s += values[i];
    }
  const mean = s / k;
  let v = 0;
  for (let i = 0; i < n; i++) if (sel(i)) v += (values[i] - mean) ** 2;
  return { mean, sd: Math.sqrt(v / k), var: v / k, n: k };
}

// Critères d'une image de 800 px de grand côté (vignette de Vinted) : mêmes clés et valeurs que measure() de photo_q.py,
// sans CLIP. runU2(Float32Array 1x3x320x320) -> Promise<Float32Array 320x320>.
export async function measure(img800, runU2) {
  const W0 = img800.width, H0 = img800.height, [W, H] = thumbnailSize(W0, H0, SIDE);
  // ponytail: Image.thumbnail ajoute un reduce() quand l'échelle atteint 4 (reducing_gap = 2) ; jamais avec 800 px.
  if (Math.trunc(W0 / W / 2) > 1 || Math.trunc(H0 / H / 2) > 1) throw new Error('image trop grande : réduire à 800 px de grand côté');
  const img = resizeLanczos(img800, W, H), d = img.data, N = W * H;
  const { L, A, B } = lab(img), C = A.map((a, i) => Math.hypot(a, B[i]));
  const hi = new Uint8Array(N), lo = new Uint8Array(N), g = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const r = d[4 * i], gr = d[4 * i + 1], b = d[4 * i + 2];
    hi[i] = r >= 250 && gr >= 250 && b >= 250;
    lo[i] = r <= 5 && gr <= 5 && b <= 5;
    g[i] = r * 0.299 + gr * 0.587 + b * 0.114;
  }
  const lw = W - 2, lap = new Float64Array(lw * (H - 2));            // laplacien 4 voisins sur l'intérieur
  for (let y = 1; y < H - 1; y++)
    for (let x = 1; x < W - 1; x++) {
      const j = y * W + x;
      lap[(y - 1) * lw + x - 1] = g[j - W] + g[j + W] + g[j - 1] + g[j + 1] - 4 * g[j];
    }
  const bh = Math.max(1, pyRound(EDGE * H)), bw = Math.max(1, pyRound(EDGE * W));
  const band = (i) => { const y = Math.floor(i / W), x = i % W; return y < bh || y >= H - bh || x < bw || x >= W - bw; };
  const all = () => true, sL = stats(L, all, N), lapVar = stats(lap, all, lap.length).var, gVar = stats(g, all, N).var;
  const eL = stats(L, band, N);
  const r = {
    L_mean: sL.mean, L_p05: percentile(L, 5), L_p95: percentile(L, 95), L_sd: sL.sd,
    clip_hi: stats(hi, all, N).mean, clip_lo: stats(lo, all, N).mean,
    lap_var: lapVar, lap_norm: lapVar / (gVar + VAR_FLOOR),
    a_mean: stats(A, all, N).mean, b_mean: stats(B, all, N).mean, chroma_mean: stats(C, all, N).mean,
    edge_L: eL.mean, edge_sd: eL.sd, edge_chroma: stats(C, band, N).mean,
  };
  const mask = await u2Mask(img, runU2), m = mask.data;
  const fs = stats(m, all, N).mean, ok = fs >= 0.02 && fs <= 0.98;
  r.fg_share = fs;
  if (ok) {
    const er = erode(mask, ERODE).data, fg = (i) => m[i] === 1, bg = (i) => m[i] !== 1;
    // bg_edges : Sobel sur une copie à 128 px en gris ; fond = hors du sujet dilaté de 2 px à 128 px, intérieur seulement
    const [sw, sh] = thumbnailSize(W, H, CLUTTER_SIDE), gs = toL(resizeLanczos(img, sw, sh)).data;
    const mb = resizeNearest({ width: W, height: H, data: Uint8ClampedArray.from(m, (v) => v * 255) }, sw, sh).data;
    const cbg = erode({ width: sw, height: sh, data: mb.map((v) => (v > 127 ? 0 : 1)) }, CLUTTER_GAP).data;
    const cnt = { t1: 0, t2: 0, t3: 0 };
    let nbg = 0;
    for (let y = 1; y < sh - 1; y++)
      for (let x = 1; x < sw - 1; x++) {
        const j = y * sw + x;
        if (!cbg[j]) continue;
        const gx = gs[j - sw + 1] + 2 * gs[j + 1] + gs[j + sw + 1] - (gs[j - sw - 1] + 2 * gs[j - 1] + gs[j + sw - 1]);
        const gy = gs[j + sw - 1] + 2 * gs[j + sw] + gs[j + sw + 1] - (gs[j - sw - 1] + 2 * gs[j - sw] + gs[j - sw + 1]);
        const mag = F(Math.hypot(gx, gy));
        nbg++;
        for (const k in SOBEL_T) cnt[k] += mag > SOBEL_T[k];
      }
    let y0 = H, y1 = -1, x0 = W, x1 = -1, ring = 0;
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++)
        if (m[y * W + x]) {
          y0 = Math.min(y0, y); y1 = Math.max(y1, y); x0 = Math.min(x0, x); x1 = Math.max(x1, x);
          if (y === 0 || y === H - 1 || x === 0 || x === W - 1) ring++;
        }
    // netteté du sujet sur le masque érodé de 3 px (intérieur du laplacien), variance du gris sur tout le masque érodé
    const mi = (i) => er[(Math.floor(i / lw) + 1) * W + (i % lw) + 1] === 1;
    const lapFg = stats(lap, mi, lap.length), gFg = stats(g, (i) => er[i] === 1, N);
    const Lf = stats(L, fg, N), Af = stats(A, fg, N), Bf = stats(B, fg, N), Lb = stats(L, bg, N), Ab = stats(A, bg, N), Bb = stats(B, bg, N);
    Object.assign(r, {
      fg_bbox_share: ((y1 - y0 + 1) * (x1 - x0 + 1)) / (H * W), cut: ring / (2 * W + 2 * (H - 2)),
      L_mean_fg: Lf.mean, clip_hi_fg: stats(hi, fg, N).mean, clip_lo_fg: stats(lo, fg, N).mean,
      lap_var_fg: lapFg.n ? lapFg.var : null,
      lap_norm_fg: lapFg.n ? lapFg.var / (gFg.var + VAR_FLOOR) : null,
      bg_L: Lb.mean, bg_sd: Lb.sd,
      fg_bg_dE: Math.hypot(Lf.mean - Lb.mean, Af.mean - Ab.mean, Bf.mean - Bb.mean),
      cast_bg: Math.hypot(Ab.mean, Bb.mean),
      ...Object.fromEntries(Object.keys(SOBEL_T).map((k) => [`bg_edges_${k}`, nbg ? cnt[k] / nbg : null])),
    });
  } else {
    for (const k of ['fg_bbox_share', 'cut', 'L_mean_fg', 'clip_hi_fg', 'clip_lo_fg', 'lap_var_fg', 'lap_norm_fg', 'bg_L', 'bg_sd',
      'fg_bg_dE', 'bg_edges_t1', 'bg_edges_t2', 'bg_edges_t3']) r[k] = null;
    r.cast_bg = Math.hypot(stats(A, band, N).mean, stats(B, band, N).mean);
  }
  const out = Object.fromEntries(Object.entries(r).map(([k, v]) => [k, r5(v)]));
  return { ...out, mask_ok: ok, img_w: W0, img_h: H0 };
}
