// Retouche pure (sans DOM) : corrections globales du vetement, fond, ombre de contact, cadrage 3:4, controle de fidelite.
// Le vetement n'est jamais modifie autrement que par applyGlobal (gains de balance + exposition, meme table partout).
// Image : {width, height, data: Uint8ClampedArray} RGBA. Masque : {width, height, data: Float32Array} dans [0, 1].
import { resizeLanczos, resizeBilinear } from './resample.js';
import { erode } from './photo_q.js';

const OW = 1200, OH = 1600, EV_MAX = 0.7, G_MIN = 0.8, G_MAX = 1.25, CEIL = 250, SHADOW_CAP = 0.35, SHADOW_FLAT = 0.15;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const toLin = (v) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const toSrgb = (l) => 255 * (l <= 0.0031308 ? 12.92 * l : 1.055 * l ** (1 / 2.4) - 0.055);
const LIN = Float64Array.from({ length: 256 }, (_, v) => toLin(v));
const LUM = (r, g, b) => 0.2126 * LIN[r] + 0.7152 * LIN[g] + 0.0722 * LIN[b];
const inMask = (mask, i) => !mask || mask.data[i] >= 0.5;

// Table sRGB -> sRGB pour un gain lineaire g (arrondi, bornee a 0..255).
const lut = (g) => Uint8ClampedArray.from({ length: 256 }, (_, v) => Math.round(toSrgb(LIN[v] * g)));

// Gains de balance (lumiere lineaire, relatifs au vert, bornes) et exposition automatique, estimes sur la SCENE (pixels hors
// masque ; tout le cadre si mask = null), jamais sur le vetement. Candidats au neutre : clairs (max >= 100), non ecretes
// (aucun canal >= 250), saturation <= 0,08 (un mur creme ou beige n'est pas neutre). Moins de 0,5 % de l'image : gains
// [1,1,1], ev 0 (rien de fiable). Exposition : 98e centile de luminance des candidats ; ev = 0 sauf s'il atteint sRGB 215,
// cible 235 (ev auto <= environ +0,29 ; le reste est au curseur manuel, ev < 0 aussi).
// Plafond sur le sujet : un canal deja >= 250 a l'origine est ignore ; ev est baisse (jamais sous 0), puis les gains > 1 sont
// ramenes ensemble vers 1, jusqu'a ce qu'aucun canal du sujet (< 250 a l'origine) ne depasse 250.
export function neutralCorrection(img, mask) {
  const d = img.data, n = img.width * img.height, sum = [0, 0, 0], mx = [0, 0, 0], bins = new Uint32Array(4096);
  let cand = 0;
  for (let i = 0; i < n; i++) {
    const r = d[4 * i], g = d[4 * i + 1], b = d[4 * i + 2];
    if (inMask(mask, i)) {                                    // sujet (tout le cadre si mask = null) : plafond
      if (r < CEIL) mx[0] = Math.max(mx[0], r);
      if (g < CEIL) mx[1] = Math.max(mx[1], g);
      if (b < CEIL) mx[2] = Math.max(mx[2], b);
    }
    if (mask && inMask(mask, i)) continue;
    const hi = Math.max(r, g, b), lo = Math.min(r, g, b);
    if (hi >= CEIL || hi < 100 || (hi - lo) / hi > 0.08) continue;
    cand++; sum[0] += LIN[r]; sum[1] += LIN[g]; sum[2] += LIN[b];
    bins[Math.min(4095, Math.floor(clamp(LUM(r, g, b), 0, 1) * 4095))]++;
  }
  let gains = [1, 1, 1], ev = 0;
  if (cand >= 0.005 * n) {
    gains = sum.map((s) => clamp(sum[1] / s, G_MIN, G_MAX));
    let acc = 0, k = 0;
    while (k < 4095 && (acc += bins[k]) < 0.98 * cand) k++;
    const y = (k + 0.5) / 4095;
    if (y >= LIN[215]) ev = clamp(Math.log2(LIN[235] / y), 0, EV_MAX);
  }
  const over = (gs, e) => mx.some((m, c) => Math.round(toSrgb(LIN[m] * gs[c] * 2 ** e)) > CEIL);
  while (ev > 0 && over(gains, ev)) ev = Math.max(0, ev - 0.01);
  const g0 = gains;
  for (let t = 1; t > 0 && over(gains, ev);) { t = Math.max(0, t - 0.01); gains = g0.map((g) => (g > 1 ? 1 + t * (g - 1) : g)); }
  return { gains, ev };
}

// Correction globale, par table : le seul traitement que subissent les pixels du vetement. ev borne a +-0,7, gains a [0,8 ; 1,25].
export function applyGlobal(img, corr) {
  const ev = clamp(corr.ev, -EV_MAX, EV_MAX), t = corr.gains.map((g) => lut(clamp(g, G_MIN, G_MAX) * 2 ** ev)), d = img.data, o = new Uint8ClampedArray(d);
  for (let i = 0; i < d.length; i += 4) for (let c = 0; c < 3; c++) o[i + c] = t[c][d[i + c]];
  return { width: img.width, height: img.height, data: o };
}

// Boite du masque >= 0,5, echelle = min(ajustement avec marge, 1), centree. Le sujet n'est jamais coupe.
export function placeSubject(img, mask, opts) {
  const { width: w, height: h } = mask;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (mask.data[y * w + x] >= 0.5) {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  if (x1 < 0) throw new Error('masque vide : aucun sujet a placer');
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1, m = Math.max(0.01, opts.margin ?? 0.08);   // le sujet ne touche jamais le cadre
  const scale = Math.min((OW * (1 - 2 * m)) / bw, (OH * (1 - 2 * m)) / bh, 1);
  const tw = Math.min(OW, Math.max(1, Math.round(bw * scale))), th = Math.min(OH, Math.max(1, Math.round(bh * scale)));
  return { transform: { scale, sx: x0, sy: y0, sw: bw, sh: bh, tw, th, ox: Math.round((OW - tw) / 2), oy: Math.round((OH - th) / 2) }, size: [OW, OH] };
}

const crop = (im, x0, y0, w, h, ch) => {
  const o = new im.data.constructor(w * h * ch);
  for (let y = 0; y < h; y++) o.set(im.data.subarray(((y0 + y) * im.width + x0) * ch, ((y0 + y) * im.width + x0 + w) * ch), y * w * ch);
  return { width: w, height: h, data: o };
};

// Silhouette : mask >= 0,5, plus les regions ENCLOSES (non reliees au bord du recadrage par mask < 0,5) dont mask >= 0,25.
// Un trou enclos a mask < 0,25 (boutonniere, anse) reste hors du vetement, quelle que soit sa taille.
function garment(a, w, h) {
  const g = Float32Array.from(a, (v) => (v >= 0.5 ? 1 : 0)), out = new Uint8Array(w * h), q = new Int32Array(w * h);
  let tail = 0;
  const push = (j) => { if (!g[j] && !out[j]) { out[j] = 1; q[tail++] = j; } };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  for (let head = 0; head < tail; head++) {
    const j = q[head], x = j % w, y = (j / w) | 0;
    if (x > 0) push(j - 1);
    if (x < w - 1) push(j + 1);
    if (y > 0) push(j - w);
    if (y < h - 1) push(j + w);
  }
  for (let i = 0; i < w * h; i++) if (!g[i] && !out[i] && a[i] >= 0.25) g[i] = 1;
  return g;
}

// Sujet recadre et redimensionne (Lanczos), identique pour sortie et reference. bin = silhouette du vetement. Coeur = bin
// erode de 2 px (apres 2 px de zeros : les ourlets au bord de la boite s'erodent aussi) -> alpha 1. Bande = bin hors coeur et
// 2 px autour du coeur -> alpha doux (bilineaire contraste), seul endroit decontamine. Ailleurs alpha 0.
function placed(img, mask, opts) {
  const { transform: t } = placeSubject(img, mask, opts);
  const { tw, th } = t, P = 2, pw = tw + 2 * P;
  let sub = crop(img, t.sx, t.sy, t.sw, t.sh, 4), a = crop(mask, t.sx, t.sy, t.sw, t.sh, 1);
  if (tw !== t.sw || th !== t.sh) {
    sub = resizeLanczos(sub, tw, th);
    const rgba = { width: t.sw, height: t.sh, data: new Uint8ClampedArray(t.sw * t.sh * 4) };
    for (let i = 0; i < a.data.length; i++) rgba.data[4 * i] = a.data[i] * 255;
    const r = resizeBilinear(rgba, tw, th);
    a = { width: tw, height: th, data: Float32Array.from({ length: tw * th }, (_, i) => r.data[4 * i] / 255) };
  }
  const bin = garment(a.data, tw, th), padded = new Float32Array(pw * (th + 2 * P));
  for (let y = 0; y < th; y++) padded.set(bin.subarray(y * tw, (y + 1) * tw), (y + P) * pw + P);
  const ep = erode({ width: pw, height: th + 2 * P, data: padded }, P).data, core = new Uint8Array(tw * th);
  for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) core[y * tw + x] = ep[(y + P) * pw + x + P];
  let near = core;                                          // coeur dilate de 2 px (croix)
  for (let p = 0; p < P; p++) {
    const e = near.slice();
    for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
      const j = y * tw + x;
      if (near[j] || (y > 0 && near[j - tw]) || (y < th - 1 && near[j + tw]) || (x > 0 && near[j - 1]) || (x < tw - 1 && near[j + 1])) e[j] = 1;
    }
    near = e;
  }
  for (let i = 0; i < a.data.length; i++) a.data[i] = core[i] ? 1 : bin[i] || near[i] ? clamp((a.data[i] - 0.5) * 4 + 0.5, 0, 1) : 0;
  return { sub, alpha: a, bin, t };
}

// Decontamination : pixels d'alpha < 1, couleur = moyenne des voisins d'alpha 1 dans 2 px (reste de l'ancien fond evite).
function decontaminate(sub, alpha) {
  const { width: w, height: h } = alpha, src = sub.data.slice();
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (alpha.data[i] >= 1 || alpha.data[i] <= 0) continue;
    let s0 = 0, s1 = 0, s2 = 0, k = 0;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= w || yy >= h || alpha.data[yy * w + xx] < 1) continue;
      const j = 4 * (yy * w + xx);
      s0 += src[j]; s1 += src[j + 1]; s2 += src[j + 2]; k++;
    }
    if (k) { sub.data[4 * i] = s0 / k; sub.data[4 * i + 1] = s1 / k; sub.data[4 * i + 2] = s2 / k; }
  }
}

// Ombre de contact : silhouette aplatie a 15 % sur la base du sujet, legerement decalee, floue ; opacite <= 0,35.
function shadowAlpha(alpha, t, strength) {
  const s = new Float32Array(OW * OH), base = t.oy + t.th, off = Math.round(0.01 * t.th), top = base + off - SHADOW_FLAT * t.th;
  for (let y = Math.max(0, Math.ceil(top)); y < Math.min(OH, base + off); y++) {
    const sy = Math.min(t.th - 1, Math.floor((y - top) / SHADOW_FLAT));
    for (let x = 0; x < t.tw; x++) s[y * OW + t.ox + x] = alpha.data[sy * t.tw + x];
  }
  const r = Math.max(2, Math.round(0.012 * t.th));
  let a = s, b = new Float32Array(s.length);
  for (let pass = 0; pass < 3; pass++) {            // flou : 3 passes de boite horizontale puis verticale
    for (const [len, step, outer, ostep] of [[OW, 1, OH, OW], [OH, OW, OW, 1]]) {
      for (let o = 0; o < outer; o++) {
        const at = (k) => (k < 0 || k >= len ? 0 : a[o * ostep + k * step]);
        let acc = 0;
        for (let k = -r; k <= r; k++) acc += at(k);
        for (let k = 0; k < len; k++) { b[o * ostep + k * step] = acc / (2 * r + 1); acc += at(k + r + 1) - at(k - r); }
      }
      [a, b] = [b, a];
    }
  }
  const k = SHADOW_CAP * clamp(strength, 0, 1);
  return Float32Array.from(a, (v) => Math.min(1, v) * k);
}

// Fond -> ombre -> sujet (corrige globalement, decontamine). outMask = silhouette en 1200 x 1600.
export function composeStudio(img, mask, corr, opts) {
  const { sub, alpha, bin, t } = placed(applyGlobal(img, corr), mask, opts);
  decontaminate(sub, alpha);
  const sh = shadowAlpha(alpha, t, opts.shadow), out = new Uint8ClampedArray(OW * OH * 4), om = new Float32Array(OW * OH);
  for (let i = 0; i < OW * OH; i++) {
    const k = 1 - sh[i];
    for (let c = 0; c < 3; c++) out[4 * i + c] = opts.bg[c] * k;
    out[4 * i + 3] = 255;
  }
  for (let y = 0; y < t.th; y++) for (let x = 0; x < t.tw; x++) {
    const a = alpha.data[y * t.tw + x], i = (t.oy + y) * OW + t.ox + x, j = 4 * (y * t.tw + x);
    for (let c = 0; c < 3; c++) out[4 * i + c] = a * sub.data[j + c] + (1 - a) * out[4 * i + c];
    om[i] = bin[y * t.tw + x];
  }
  return { out: { width: OW, height: OH, data: out }, outMask: { width: OW, height: OH, data: om } };
}

// Mode Lumiere seule : corrections globales, recadrage centre 3:4, 1600 px de haut au plus.
export function lightOnly(img, corr) {
  const g = applyGlobal(img, corr), w = g.width, h = g.height;
  const ch = w / h > 0.75 ? h : Math.round(w / 0.75), cw = ch === h ? Math.round(h * 0.75) : w;
  const c = crop(g, Math.floor((w - cw) / 2), Math.floor((h - ch) / 2), cw, ch, 4);
  return ch > OH ? resizeLanczos(c, Math.round(OH * 0.75), OH) : c;
}

// Controle d'export : dans outMask erode de 3 px, la sortie egale l'original corrige globalement et place de la meme facon.
export function fidelityCheck(out, img, mask, corr, opts) {
  if (out.width !== OW || out.height !== OH) return { ok: false, maxDiff: 255 };
  const { sub, bin, t } = placed(applyGlobal(img, corr), mask, opts);
  const om = new Float32Array(OW * OH);
  for (let y = 0; y < t.th; y++) for (let x = 0; x < t.tw; x++) om[(t.oy + y) * OW + t.ox + x] = bin[y * t.tw + x];
  const er = erode({ width: OW, height: OH, data: om }, 3).data;
  let maxDiff = 0, n = 0;
  for (let y = 0; y < t.th; y++) for (let x = 0; x < t.tw; x++) {
    const i = (t.oy + y) * OW + t.ox + x;
    if (!er[i]) continue;
    n++;
    for (let c = 0; c < 3; c++) maxDiff = Math.max(maxDiff, Math.abs(out.data[4 * i + c] - sub.data[4 * (y * t.tw + x) + c]));
  }
  return n ? { ok: maxDiff <= 2, maxDiff } : { ok: false, maxDiff: 255 };   // rien a comparer : on bloque
}

// Part du sujet dans [0,02 ; 0,98].
export function maskUsable(mask) {
  let n = 0;
  for (const v of mask.data) if (v >= 0.5) n++;
  const p = n / mask.data.length;
  return p >= 0.02 && p <= 0.98;
}

// Reglages par defaut (spec 6.5) : blanc casse, gris moyen si le sujet est tres clair (L* moyen > 85).
export function defaultSettings(img, mask) {
  let s = 0, n = 0;
  for (let i = 0; i < mask.data.length; i++) if (mask.data[i] >= 0.5) {
    const y = 0.2126 * LIN[img.data[4 * i]] + 0.7152 * LIN[img.data[4 * i + 1]] + 0.0722 * LIN[img.data[4 * i + 2]];
    s += y > 0.008856 ? 116 * Math.cbrt(y) - 16 : 903.3 * y;
    n++;
  }
  return { bg: n && s / n > 85 ? [200, 200, 198] : [245, 244, 240], shadow: 0.5, margin: 0.08 };
}
