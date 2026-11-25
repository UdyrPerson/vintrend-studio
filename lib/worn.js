// Mode Porte (vetement porte) : le vrai decor est conserve mais attenue, recadrage sur la personne, masquage du visage.
// Fonctions pures, sans DOM. Image : {width, height, data: Uint8ClampedArray} RGBA. Masque : {width, height, data: Float32Array} dans [0, 1].
// Le vetement n'est jamais modifie autrement que par applyGlobal ; le decor seul est attenue (aucune IA generative).
import { applyGlobal, fidelityDiff } from './retouch.js';
import { resizeLanczos, resizeBilinear } from './resample.js';

const OW = 1200, OH = 1600, RING = 6, SIDE = 0.05, TOP = 0.05, FEET = 0.03, FEATHER = 0.02, MIX = 0.35, EV_VIG = -0.15, PAD = [236, 234, 230];
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const toLin = (v) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const toSrgb = (l) => 255 * (l <= 0.0031308 ? 12.92 * l : 1.055 * l ** (1 / 2.4) - 0.055);
const LIN = Float64Array.from({ length: 256 }, (_, v) => toLin(v));
const SRGB = Float64Array.from({ length: 16385 }, (_, i) => toSrgb(i / 16384));   // lineaire -> sRGB par table (decor seulement)
const enc = (l) => SRGB[(l * 16384 + 0.5) | 0];

// Boite (inclusive) des pixels >= 0,5 ; null si le masque est vide. Un bord est TOUCHE seulement si un pixel >= 0,25 de son liseré de 2 px
// tombe dans l'etendue de la personne sur ce bord (x de la boite pour haut / bas, y pour gauche / droite, a +-2 px) : un pixel parasite
// loin de la personne ne compte pas, ni une ombre / un cadre de porte a 0,3 dont le coeur est loin du bord (coeur a plus de max(2 px, 3 %) du bord). Un bord touche etend la boite jusqu'a lui (jambes qui s'estompent a 0,3 sur les dernieres rangees).
function bbox(mask) {
  const { width: w, height: h, data } = mask;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let i = 0; i < data.length; i++) if (data[i] >= 0.5) { const x = i % w, y = (i / w) | 0; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < 0) return null;
  const hit = (x, y) => data[y * w + x] >= 0.25, t = { l: false, r: false, t: false, b: false };
  for (let y = Math.max(0, y0 - 2); y <= Math.min(h - 1, y1 + 2); y++) {
    for (let x = 0; x < Math.min(2, w); x++) if (hit(x, y)) t.l = true;
    for (let x = Math.max(0, w - 2); x < w; x++) if (hit(x, y)) t.r = true;
  }
  for (let x = Math.max(0, x0 - 2); x <= Math.min(w - 1, x1 + 2); x++) {
    for (let y = 0; y < Math.min(2, h); y++) if (hit(x, y)) t.t = true;
    for (let y = Math.max(0, h - 2); y < h; y++) if (hit(x, y)) t.b = true;
  }
  const nx = Math.max(2, 0.03 * w), ny = Math.max(2, 0.03 * h);   // et le coeur >= 0,5 doit lui-meme etre proche du bord (ombre au sol, cadre de porte : pas de contact)
  t.l = t.l && x0 <= nx; t.r = t.r && w - 1 - x1 <= nx; t.t = t.t && y0 <= ny; t.b = t.b && h - 1 - y1 <= ny;
  if (t.l) x0 = 0;
  if (t.r) x1 = w - 1;
  if (t.t) y0 = 0;
  if (t.b) y1 = h - 1;
  return { x0, y0, x1, y1, t };
}

// Position d'un cadre de taille F sur un axe de longueur S, personne = [p0, p1) (p1 exclu), marges mLo / mHi au moins.
// Priorite : (1) cote touche = cadre cale sur ce bord, rien n'est invente ; (2) sinon la position preferee, DECALEE vers le vrai decor
// si elle depasse l'image, tant que les marges restent respectees ; (3) sinon bande de pad, plafonnee a 10 % de F : au-dela, pas
// de pad (le cadre est ramene dans l'image, F peut diminuer) et le cadre cesse d'etre 3:4.
function place(p0, p1, S, F, mLo, mHi, tLo, tHi, pref) {
  if (tLo && tHi) return { v: 0, F: S };
  let v;
  if (tLo) v = 0;
  else if (tHi) v = S - F;
  else {
    const lo = p1 + mHi - F, hi = p0 - mLo, a = Math.max(lo, 0), c = Math.min(hi, S - F);
    v = F <= S && a <= c ? clamp(pref, a, c) : clamp(clamp(pref, Math.min(0, S - F), Math.max(0, S - F)), lo, hi);   // pad minimal
  }
  v = Math.round(v);
  if (Math.max(0, -v) + Math.max(0, v + F - S) > 0.1 * F) return F > S ? { v: 0, F: S } : { v: clamp(v, 0, S - F), F };
  return { v, F };
}

// Cadre de sortie dans le repere de l'original (peut depasser l'image : x, y negatifs ou x + w > largeur).
// Regle : 3:4, marges 5 % (cotes, haut) et 3 % sous les pieds, mesurees sur le cadre. Un cote touche par la personne n'a pas de
// marge : le cadre s'arrete sur ce bord et la taille est RECALCULEE sans cette marge (3:4 conserve si possible). Si deux bords
// opposes sont touches, l'axe vaut l'image et l'autre en decoule. Voir place pour le decalage vers le vrai decor et le pad.
function frame(b, w, h) {
  const { t } = b, bw = b.x1 - b.x0 + 1, bh = b.y1 - b.y0 + 1;
  const needW = bw / (1 - (t.l ? 0 : SIDE) - (t.r ? 0 : SIDE)), needH = bh / (1 - (t.t ? 0 : TOP) - (t.b ? 0 : FEET));
  let fw, fh;
  if (t.l && t.r && t.t && t.b) { fw = w; fh = h; }
  else if (t.l && t.r) { fw = w; fh = Math.max(Math.min(h, Math.round((4 * w) / 3)), Math.ceil(needH)); }
  else if (t.t && t.b) { fh = h; fw = Math.max(Math.min(w, Math.round((3 * h) / 4)), Math.ceil(needW)); }
  else { fw = 3 * Math.ceil(Math.max(needW, 0.75 * needH) / 3); fh = (fw * 4) / 3; }
  const X = place(b.x0, b.x1 + 1, w, fw, SIDE * fw, SIDE * fw, t.l, t.r, Math.round(b.x0 + bw / 2 - fw / 2));
  const Y = place(b.y0, b.y1 + 1, h, fh, TOP * fh, FEET * fh, t.t, t.b, Math.round(b.y1 + 1 + FEET * fh - fh));
  return { rect: { x: X.v, y: Y.v, w: X.F, h: Y.F }, ratioOk: X.F * 4 === Y.F * 3 };
}

// Copie de la fenetre rect de im (ch octets par pixel) sur un canevas rect.w x rect.h rempli de fill ; hors de l'image : fill.
function window_(im, rect, fill, ch = 4) {
  const o = new im.data.constructor(rect.w * rect.h * ch);
  if (fill) for (let i = 0; i < o.length; i++) o[i] = fill[i % ch];
  const x0 = Math.max(0, rect.x), x1 = Math.min(im.width, rect.x + rect.w);
  for (let y = Math.max(0, rect.y); y < Math.min(im.height, rect.y + rect.h); y++)
    if (x1 > x0) o.set(im.data.subarray((y * im.width + x0) * ch, (y * im.width + x1) * ch), ((y - rect.y) * rect.w + x0 - rect.x) * ch);
  return { width: rect.w, height: rect.h, data: o };
}

const outSize = (rect, ratioOk) => {
  const s = Math.min(1, OW / rect.w, OH / rect.h);
  if (s === 1) return { s, w: rect.w, h: rect.h };
  const w = ratioOk ? 3 * Math.round((rect.w * s) / 3) : Math.max(1, Math.round(rect.w * s));
  return { s, w, h: ratioOk ? (w * 4) / 3 : Math.max(1, Math.round(rect.h * s)) };
};

// Distance de Tchebychev (8 voisins, exacte) au masque binaire ; 0 dans le masque. L'anneau de 6 px est donc un CARRE : il contient
// le disque euclidien de rayon 6 (on protege plus, jamais moins).
function dist(bin, w, h) {
  const d = new Uint16Array(w * h);
  for (let i = 0; i < bin.length; i++) d[i] = bin[i] ? 0 : 65000;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    let m = d[i], v;
    if (x && (v = d[i - 1] + 1) < m) m = v;
    if (y) {
      if ((v = d[i - w] + 1) < m) m = v;
      if (x && (v = d[i - w - 1] + 1) < m) m = v;
      if (x < w - 1 && (v = d[i - w + 1] + 1) < m) m = v;
    }
    d[i] = m;
  }
  for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
    const i = y * w + x;
    let m = d[i], v;
    if (x < w - 1 && (v = d[i + 1] + 1) < m) m = v;
    if (y < h - 1) {
      if ((v = d[i + w] + 1) < m) m = v;
      if (x < w - 1 && (v = d[i + w + 1] + 1) < m) m = v;
      if (x && (v = d[i + w - 1] + 1) < m) m = v;
    }
    d[i] = m;
  }
  return d;
}

// Porte : corrections globales, decor attenue hors de la personne dilatee de 6 px (distance de Tchebychev) puis fondu vers
// l'EXTERIEUR sur 2 % de la hauteur du cadre, recadrage 3:4 (voir frame), sortie <= 1200 x 1600. Pas d'ombre.
// Decor attenue : 35 % vers PAD, saturation / 2, vignette -0,15 EV (lumiere lineaire, 0 au centre du cadre, pleine aux coins).
// Retourne {out, outMask, rect, ratioOk, scale}. Les pixels a moins de 6 px de la personne sont exactement ceux de applyGlobal.
// Raccord du pad : le vrai decor glisse vers la couleur du pad sur 2 % de la hauteur du cadre a partir de la bande ajoutee
// (la regle de l'anneau de 6 px reste prioritaire pres de la personne). Aucune allocation par pixel.
export function wornStudio(img, personMask, corr) {
  const b = bbox(personMask);
  if (!b) throw new Error('masque vide : aucune personne');
  const { rect, ratioOk } = frame(b, img.width, img.height), { w: cw, h: chh } = rect, n = cw * chh;
  if (b.x0 < rect.x || b.y0 < rect.y || b.x1 >= rect.x + cw || b.y1 >= rect.y + chh) throw new Error('Cadrage impossible : la personne depasserait du cadre (anomalie interne, rien ne sera exporte).');
  const canvas = window_(applyGlobal(img, corr), rect, [...PAD, 255]), m = window_(personMask, rect, null, 1), md = m.data;
  const bin = new Uint8Array(n), padBin = new Uint8Array(n);
  let anyPad = false;
  for (let i = 0; i < n; i++) bin[i] = md[i] >= 0.5 ? 1 : 0;
  if (rect.x < 0 || rect.y < 0 || rect.x + cw > img.width || rect.y + chh > img.height) {
    anyPad = true;
    for (let y = 0; y < chh; y++) for (let x = 0; x < cw; x++) { const sx = x + rect.x, sy = y + rect.y; if (sx < 0 || sy < 0 || sx >= img.width || sy >= img.height) padBin[y * cw + x] = 1; }
  }
  const d = dist(bin, cw, chh), dp = anyPad ? dist(padBin, cw, chh) : null;
  const F = Math.max(1, Math.round(FEATHER * chh)), cx = (cw - 1) / 2, cy = (chh - 1) / 2, r2 = cx * cx + cy * cy, o = canvas.data;
  for (let i = 0; i < n; i++) {
    const wb = clamp((d[i] - RING) / F, 0, 1);
    if (!wb) continue;
    const x = i % cw, y = (i / cw) | 0, gain = 2 ** (EV_VIG * (((x - cx) ** 2 + (y - cy) ** 2) / r2)), wp = dp ? clamp(1 - dp[i] / F, 0, 1) : 0, k = 4 * i;
    const r = (1 - wp) * o[k] + wp * PAD[0], g = (1 - wp) * o[k + 1] + wp * PAD[1], bl = (1 - wp) * o[k + 2] + wp * PAD[2];
    const ar = (1 - MIX) * r + MIX * PAD[0], ag = (1 - MIX) * g + MIX * PAD[1], ab = (1 - MIX) * bl + MIX * PAD[2], y0 = 0.2126 * ar + 0.7152 * ag + 0.0722 * ab;
    o[k] = (1 - wb) * o[k] + wb * enc(LIN[clamp(Math.round(y0 + (ar - y0) / 2), 0, 255)] * gain);   // Uint8ClampedArray arrondit
    o[k + 1] = (1 - wb) * o[k + 1] + wb * enc(LIN[clamp(Math.round(y0 + (ag - y0) / 2), 0, 255)] * gain);
    o[k + 2] = (1 - wb) * o[k + 2] + wb * enc(LIN[clamp(Math.round(y0 + (ab - y0) / 2), 0, 255)] * gain);
  }
  const { s, w, h } = outSize(rect, ratioOk), om = { width: cw, height: chh, data: Float32Array.from(bin) };
  return s === 1 ? { out: canvas, outMask: om, rect, ratioOk, scale: 1 } : { out: resizeLanczos(canvas, w, h), outMask: resizeBilinear(om, w, h), rect, ratioOk, scale: s };
}

// Controle d'export du mode Porte : dans la personne (outMask) erodee de 3 px, la sortie egale l'original corrige globalement,
// cadre (info.rect) et reduit (info.scale) de la meme facon. Meme comparaison que fidelityCheck (fidelityDiff de retouch.js).
export function wornFidelity(out, outMask, img, corr, info) {
  const ref = window_(applyGlobal(img, corr), info.rect, [...PAD, 255]);
  return fidelityDiff(out, info.scale === 1 ? ref : resizeLanczos(ref, out.width, out.height), outMask);
}

// Masquage du visage. box = {x, y, w, h} (pixels de img). keepMask = pixels a ne JAMAIS toucher (>= 0,5).
// 'chin' : renvoie {rect} (cadre de recadrage pleine largeur qui commence sous le menton : bas de la boite + 4 % de sa hauteur).
// 'flat' / 'pixelate' : renvoient une COPIE ou seuls changent les pixels de la boite elargie de 15 % dont keepMask < 0,5 ;
//   aplat = couleur moyenne de ces pixels ; pixellisation = blocs de 10 % de la largeur du visage (>= 6 %), moyenne par bloc.
// En mode Porte, le masque de la personne contient le visage : il ne faut PAS le passer en keepMask. L'appelant passe un masque
// du VETEMENT seul (Tache 6 : issu du reglage manuel de la boite du visage) ; sans masque (null), toute la zone est masquee.
export function maskFace(img, box, mode, keepMask = null) {
  if (mode === 'chin') {
    const y = clamp(Math.round(box.y + box.h * 1.04), 0, img.height - 1);
    return { rect: { x: 0, y, w: img.width, h: img.height - y } };
  }
  const { width: w, height: h } = img, o = new Uint8ClampedArray(img.data), ex = 0.075 * box.w, ey = 0.075 * box.h;
  const x0 = clamp(Math.floor(box.x - ex), 0, w), x1 = clamp(Math.ceil(box.x + box.w + ex), 0, w), y0 = clamp(Math.floor(box.y - ey), 0, h), y1 = clamp(Math.ceil(box.y + box.h + ey), 0, h);
  const free = (i) => !keepMask || keepMask.data[i] < 0.5, flat = mode === 'flat', bs = Math.max(2, Math.ceil(0.1 * box.w));
  const bw = flat ? x1 - x0 : bs, bh = flat ? y1 - y0 : bs;
  for (let by = y0; by < y1; by += bh) for (let bx = x0; bx < x1; bx += bw) {
    const s = [0, 0, 0], idx = [];
    for (let y = by; y < Math.min(y1, by + bh); y++) for (let x = bx; x < Math.min(x1, bx + bw); x++) { const i = y * w + x; if (free(i)) { idx.push(i); for (let c = 0; c < 3; c++) s[c] += img.data[4 * i + c]; } }
    for (const i of idx) for (let c = 0; c < 3; c++) o[4 * i + c] = Math.round(s[c] / idx.length);
  }
  return { width: w, height: h, data: o };
}
