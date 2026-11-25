// Bord fidele (pur, sans DOM) : filtre guide de l'alpha dans la bande, demelage physique F = (I - (1-a)B)/a, CIEDE2000, edgeCheck.
// Image : {width, height, data: Uint8ClampedArray} RGBA. Alpha : {width, height, data: Float32Array}. Bande : Uint8Array (1 = bande de bord).
import { lab } from './photo_q.js';

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const A_MIN = 0.2, A_FULL = 0.9, BG_A = 0.1, BG_R = 6;

// Moyenne en boite (rayon r, bords normalises), separable.
function box(s, w, h, r) {
  const t = new Float64Array(s.length), o = new Float64Array(s.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let a = 0, k = 0;
    for (let d = Math.max(0, x - r); d <= Math.min(w - 1, x + r); d++) { a += s[y * w + d]; k++; }
    t[y * w + x] = a / k;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let a = 0, k = 0;
    for (let d = Math.max(0, y - r); d <= Math.min(h - 1, y + r); d++) { a += t[d * w + x]; k++; }
    o[y * w + x] = a / k;
  }
  return o;
}

// Dilatation carree separable (rx, ry) d'un masque Uint8.
function dil(m, w, h, rx, ry) {
  const t = new Uint8Array(m.length), o = new Uint8Array(m.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (m[y * w + x]) for (let xx = Math.max(0, x - rx); xx <= Math.min(w - 1, x + rx); xx++) t[y * w + xx] = 1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (t[y * w + x]) for (let yy = Math.max(0, y - ry); yy <= Math.min(h - 1, y + ry); yy++) o[yy * w + x] = 1;
  return o;
}

// Moyenne en boite sur tableaux compacts (pixels de L2) : passe horizontale en needH, verticale en needV. idx : pixel plein -> indice compact.
function boxC(s, w, h, r, idx, pos, needH, needV) {
  const m = pos.length, t = new Float64Array(m), o = new Float64Array(m);
  for (let k = 0; k < m; k++) if (needH[k]) {
    const x = pos[k] % w, y = (pos[k] / w) | 0, x0 = Math.max(0, x - r), x1 = Math.min(w - 1, x + r);
    let a = 0;
    for (let xx = x0; xx <= x1; xx++) a += s[idx[y * w + xx]];
    t[k] = a / (x1 - x0 + 1);
  }
  for (let k = 0; k < m; k++) if (needV[k]) {
    const x = pos[k] % w, y = (pos[k] / w) | 0, y0 = Math.max(0, y - r), y1 = Math.min(h - 1, y + r);
    let a = 0;
    for (let yy = y0; yy <= y1; yy++) a += t[idx[yy * w + x]];
    o[k] = a / (y1 - y0 + 1);
  }
  return o;
}

// Filtre guide couleur (He et al., guide RGB, covariance 3x3 par fenetre) : q = mean(a).I + mean(b), a = (Cov + eps U)^-1 cov(I, p).
// Les aretes iso-luminantes restent separees. Guide dans [0,1]. Seuls les pixels de `band` changent (obligatoire) ; le calcul est
// restreint a la bande dilatee de 2r (tableaux compacts), le reste de l'image n'est jamais touche.
export function guidedFilter(alpha, guide, r, eps, band) {
  const { width: w, height: h } = alpha, n = w * h, out = Float32Array.from(alpha.data);
  const L1 = dil(band, w, h, r, r), L2 = dil(L1, w, h, r, r), L1v = dil(L1, w, h, 0, r), Bv = dil(band, w, h, 0, r), idx = new Int32Array(n).fill(-1);
  let m = 0;
  for (let i = 0; i < n; i++) if (L2[i]) idx[i] = m++;
  if (!m) return { width: w, height: h, data: out };
  const pos = new Int32Array(m), hS = new Uint8Array(m), vS = new Uint8Array(m), hF = new Uint8Array(m), vF = new Uint8Array(m);
  for (let i = 0; i < n; i++) if (L2[i]) { const k = idx[i]; pos[k] = i; hS[k] = L1v[i]; vS[k] = L1[i]; hF[k] = Bv[i]; vF[k] = band[i]; }
  const F = () => new Float64Array(m), I0 = F(), I1 = F(), I2 = F(), p = F(), ip0 = F(), ip1 = F(), ip2 = F();
  const q00 = F(), q01 = F(), q02 = F(), q11 = F(), q12 = F(), q22 = F();
  for (let k = 0; k < m; k++) {
    const i = pos[k], a = alpha.data[i], r0 = guide.data[4 * i] / 255, g0 = guide.data[4 * i + 1] / 255, b0 = guide.data[4 * i + 2] / 255;
    I0[k] = r0; I1[k] = g0; I2[k] = b0; p[k] = a; ip0[k] = r0 * a; ip1[k] = g0 * a; ip2[k] = b0 * a;
    q00[k] = r0 * r0; q01[k] = r0 * g0; q02[k] = r0 * b0; q11[k] = g0 * g0; q12[k] = g0 * b0; q22[k] = b0 * b0;
  }
  const bx = (s) => boxC(s, w, h, r, idx, pos, hS, vS);
  const m0 = bx(I0), m1 = bx(I1), m2 = bx(I2), mp = bx(p), mp0 = bx(ip0), mp1 = bx(ip1), mp2 = bx(ip2);
  const v00 = bx(q00), v01 = bx(q01), v02 = bx(q02), v11 = bx(q11), v12 = bx(q12), v22 = bx(q22);
  const A0 = F(), A1 = F(), A2 = F(), bb = F();
  for (let k = 0; k < m; k++) {
    if (!vS[k]) continue;
    const s00 = v00[k] - m0[k] * m0[k] + eps, s01 = v01[k] - m0[k] * m1[k], s02 = v02[k] - m0[k] * m2[k];
    const s11 = v11[k] - m1[k] * m1[k] + eps, s12 = v12[k] - m1[k] * m2[k], s22 = v22[k] - m2[k] * m2[k] + eps;
    const c00 = s11 * s22 - s12 * s12, c01 = s02 * s12 - s01 * s22, c02 = s01 * s12 - s02 * s11, det = s00 * c00 + s01 * c01 + s02 * c02;
    const c11 = s00 * s22 - s02 * s02, c12 = s01 * s02 - s00 * s12, c22 = s00 * s11 - s01 * s01;
    const g0 = mp0[k] - m0[k] * mp[k], g1 = mp1[k] - m1[k] * mp[k], g2 = mp2[k] - m2[k] * mp[k];
    A0[k] = (c00 * g0 + c01 * g1 + c02 * g2) / det; A1[k] = (c01 * g0 + c11 * g1 + c12 * g2) / det; A2[k] = (c02 * g0 + c12 * g1 + c22 * g2) / det;
    bb[k] = mp[k] - A0[k] * m0[k] - A1[k] * m1[k] - A2[k] * m2[k];
  }
  const f = (s) => boxC(s, w, h, r, idx, pos, hF, vF), mA0 = f(A0), mA1 = f(A1), mA2 = f(A2), mb = f(bb);
  for (let k = 0; k < m; k++) if (vF[k]) out[pos[k]] = clamp(mA0[k] * I0[k] + mA1[k] * I1[k] + mA2[k] * I2[k] + mb[k], 0, 1);
  return { width: w, height: h, data: out };
}

// Demelage : dans la bande, la ou 0 < alpha < 0,9, F = (I - (1-a) B) / max(a, 0,2), B = fond local moyen (rayon 6).
// ext (optionnel) = {img, ok, ox, oy} : image elargie (marge de fond autour du recadrage), ok[j] = 1 si le pixel est du fond sur ;
// (ox, oy) = position du coin de `img` dans ext. Sans ext : fond = pixels d'alpha < 0,1 de img.
export function unmix(img, alpha, band, ext) {
  const { width: w, height: h } = img, o = new Uint8ClampedArray(img.data), ad = alpha.data;
  const E = ext ?? { img, ok: Uint8Array.from(ad, (v) => (v < BG_A ? 1 : 0)), ox: 0, oy: 0 }, ew = E.img.width, eh = E.img.height;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, a = ad[i];
    if (!band[i] || a <= 0 || a >= A_FULL) continue;
    const s = [0, 0, 0], cx = x + E.ox, cy = y + E.oy;
    let k = 0;
    for (let yy = Math.max(0, cy - BG_R); yy <= Math.min(eh - 1, cy + BG_R); yy++) for (let xx = Math.max(0, cx - BG_R); xx <= Math.min(ew - 1, cx + BG_R); xx++) {
      const j = yy * ew + xx;
      if (!E.ok[j]) continue;
      for (let c = 0; c < 3; c++) s[c] += E.img.data[4 * j + c];
      k++;
    }
    if (!k) continue;                                      // pas de fond voisin : pixel laisse tel quel
    const am = Math.max(a, A_MIN);
    for (let c = 0; c < 3; c++) o[4 * i + c] = clamp(Math.round((img.data[4 * i + c] - (1 - a) * (s[c] / k)) / am), 0, 255);
  }
  return { width: w, height: h, data: o };
}

// Moyenne RGB des pixels flag=1 de im dans le carre de rayon BG_R autour de (cx, cy) ; null si aucun.
function localMean(im, flag, cx, cy) {
  const s = [0, 0, 0];
  let k = 0;
  for (let yy = Math.max(0, cy - BG_R); yy <= Math.min(im.height - 1, cy + BG_R); yy++) for (let xx = Math.max(0, cx - BG_R); xx <= Math.min(im.width - 1, cx + BG_R); xx++) {
    const j = yy * im.width + xx;
    if (!flag[j]) continue;
    for (let c = 0; c < 3; c++) s[c] += im.data[4 * j + c];
    k++;
  }
  return k ? s.map((v) => v / k) : null;
}

// Rognage colorimetrique de la bande (masque trop large) : un pixel de bande dont la couleur est a dE00 < 10 du fond local B ET a dE00 > 20
// du coeur voisin F (moyenne du coeur a 6 px) est du fond : alpha = 0. Seuls les pixels d'alpha AVANT filtre (pre) < 1 sont concernes.
// core : Uint8Array (1 = coeur du vetement). ext comme unmix.
export function trimBand(img, alpha, band, core, ext, pre = alpha) {
  const { width: w, height: h } = img, out = Float32Array.from(alpha.data), E = ext ?? { img, ok: Uint8Array.from(alpha.data, (v) => (v < BG_A ? 1 : 0)), ox: 0, oy: 0 };
  const Lab = (c) => { const r = lab({ width: 1, height: 1, data: Uint8ClampedArray.of(c[0], c[1], c[2], 255) }); return [r.L[0], r.A[0], r.B[0]]; };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (!band[i] || alpha.data[i] <= 0 || pre.data[i] >= 1) continue;   // masque sur de lui (alpha avant filtre = 1) : jamais rogne
    const B = localMean(E.img, E.ok, x + E.ox, y + E.oy), F = localMean(img, core, x, y);
    if (!B || !F) continue;
    const I = Lab([img.data[4 * i], img.data[4 * i + 1], img.data[4 * i + 2]]);
    if (deltaE00(I, Lab(B)) < 10 && deltaE00(I, Lab(F)) > 20) out[i] = 0;
  }
  return { width: w, height: h, data: out };
}

// CIEDE2000 (Sharma, Wu, Dalal 2005) ; lab = [L, a, b].
export function deltaE00([L1, a1, b1], [L2, a2, b2]) {
  const rad = Math.PI / 180, p7 = (v) => v ** 7 / (v ** 7 + 25 ** 7);
  const Cb = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2, G = 0.5 * (1 - Math.sqrt(p7(Cb)));
  const ap1 = (1 + G) * a1, ap2 = (1 + G) * a2, C1 = Math.hypot(ap1, b1), C2 = Math.hypot(ap2, b2);
  const hp = (b, a) => (b === 0 && a === 0 ? 0 : (Math.atan2(b, a) / rad + 360) % 360), h1 = hp(b1, ap1), h2 = hp(b2, ap2);
  const dL = L2 - L1, dC = C2 - C1, z = C1 * C2 === 0;
  let dh = z ? 0 : h2 - h1;
  if (dh > 180) dh -= 360; else if (dh < -180) dh += 360;
  const dH = 2 * Math.sqrt(C1 * C2) * Math.sin((dh * rad) / 2), Lb = (L1 + L2) / 2, Cp = (C1 + C2) / 2;
  let hb = h1 + h2;
  if (!z) hb = Math.abs(h1 - h2) <= 180 ? hb / 2 : hb < 360 ? (hb + 360) / 2 : (hb - 360) / 2;
  const T = 1 - 0.17 * Math.cos((hb - 30) * rad) + 0.24 * Math.cos(2 * hb * rad) + 0.32 * Math.cos((3 * hb + 6) * rad) - 0.2 * Math.cos((4 * hb - 63) * rad);
  const dth = 30 * Math.exp(-(((hb - 275) / 25) ** 2)), RT = -Math.sin(2 * dth * rad) * 2 * Math.sqrt(p7(Cp));
  const SL = 1 + (0.015 * (Lb - 50) ** 2) / Math.sqrt(20 + (Lb - 50) ** 2), SC = 1 + 0.045 * Cp, SH = 1 + 0.015 * Cp * T;
  const x = dL / SL, y = dC / SC, v = dH / SH;
  return Math.sqrt(x * x + y * y + v * v + RT * y * v);
}

// Controle de bord : dans la bande, la ou alphaOut >= 0,9, la sortie reste a dE00 <= 3 de la reference (original x corrections, place comme la sortie).
// out, ref : images de meme taille ; alphaOut : masque de meme taille ; band : Uint8Array (bande complete, pixels rognes compris : ils comptent au denominateur).
// Moins de 10 % des pixels de bande comparables : non verifiable (bloque). share = part comparee.
export function edgeCheck(out, ref, alphaOut, band) {
  const idx = [];
  let nb = 0;
  for (let i = 0; i < band.length; i++) if (band[i]) { nb++; if (alphaOut.data[i] >= A_FULL) idx.push(i); }
  if (!nb) return { ok: true, maxDE: 0, share: 1 };
  const share = idx.length / nb;
  if (share < 0.1) return { ok: false, maxDE: 0, share, reason: 'non-verifiable', message: 'Bord non vérifiable' };
  const g = (im) => { const d = new Uint8ClampedArray(4 * idx.length); idx.forEach((i, k) => d.set(im.data.subarray(4 * i, 4 * i + 4), 4 * k)); return lab({ width: idx.length, height: 1, data: d }); };
  const A = g(out), B = g(ref);
  let maxDE = 0;
  for (let k = 0; k < idx.length; k++) maxDE = Math.max(maxDE, deltaE00([A.L[k], A.A[k], A.B[k]], [B.L[k], B.A[k], B.B[k]]));
  return { ok: maxDE <= 3, maxDE, share };
}
