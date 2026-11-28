// Retouche pure (sans DOM) : corrections globales du vetement, fond studio eclaire (backdrop.lighting), ombres, cadrage 3:4, controle de fidelite.
// Le vetement n'est jamais modifie autrement que par applyGlobal (gains de balance + exposition, meme table partout).
// Image : {width, height, data: Uint8ClampedArray} RGBA. Masque : {width, height, data: Float32Array} dans [0, 1].
import { resizeLanczos, resizeLanczosStep, resizeBilinear } from './resample.js';
import { erode } from './photo_q.js';
import { guidedFilter, unmix, trimBand, edgeCheck } from './edge.js';
import { extract, sampleStep, suggest, candidates, lighting } from './backdrop.js';

const WB_MIN = 0.88, WB_MAX = 1.12, WB_FRAME = 0.05, WB_COVER = 0.6, DEF_MARGIN = 0.07, DEF_LIFT = 0.015, OW = 1200, OH = 1600, EV_MAX = 0.7, G_MIN = 0.8, G_MAX = 1.25, CEIL = 250, NUAGE = [240, 238, 233];
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
// (aucun canal >= 250), saturation <= 0,08 (un mur creme ou beige n'est pas neutre). Regle R-WB : neutre fiable seulement si les candidats font
// >= 5 % du cadre ET >= 60 % des pixels clairs non ecretes de la scene (sinon gains [1,1,1], ev 0) ; gains bornes a [0,88 ; 1,12]. Exposition (v4) : ev = 0 sauf si le 98e centile de luminance des candidats atteint sRGB 150
// ET si les candidats couvrent >= 10 % du cadre ; alors cible 240, ev auto dans [0 ; 0,7] (ev < 0 : curseur manuel).
// Plafond sur le sujet : un canal deja >= 250 a l'origine est ignore ; ev est baisse (jamais sous 0), puis les gains > 1 sont
// ramenes ensemble vers 1, jusqu'a ce que, pour chaque canal, le 99,5e centile des pixels du sujet (< 250 a l'origine) ne
// depasse pas 250. Garanti : au plus 0,5 % des pixels d'un canal (hors canaux deja >= 250) peuvent depasser 250.
export function neutralCorrection(img, mask) {
  const d = img.data, n = img.width * img.height, sum = [0, 0, 0], hist = [0, 1, 2].map(() => new Uint32Array(256)), bins = new Uint32Array(4096);
  let cand = 0, bright = 0;
  for (let i = 0; i < n; i++) {
    const r = d[4 * i], g = d[4 * i + 1], b = d[4 * i + 2];
    if (inMask(mask, i)) {                                    // sujet (tout le cadre si mask = null) : plafond
      if (r < CEIL) hist[0][r]++;
      if (g < CEIL) hist[1][g]++;
      if (b < CEIL) hist[2][b]++;
    }
    if (mask && inMask(mask, i)) continue;
    const hi = Math.max(r, g, b), lo = Math.min(r, g, b);
    if (hi >= CEIL || hi < 100) continue;
    bright++;                                                 // scene claire non ecretee : denominateur de la couverture
    if ((hi - lo) / hi > 0.08) continue;
    cand++; sum[0] += LIN[r]; sum[1] += LIN[g]; sum[2] += LIN[b];
    bins[Math.min(4095, Math.floor(clamp(LUM(r, g, b), 0, 1) * 4095))]++;
  }
  let gains = [1, 1, 1], ev = 0;
  if (cand >= WB_FRAME * n && cand >= WB_COVER * bright) {   // neutre fiable : une grande surface neutre, pas la queue d'une scene colore
    gains = sum.map((s) => clamp(sum[1] / s, WB_MIN, WB_MAX));
    let acc = 0, k = 0;
    while (k < 4095 && (acc += bins[k]) < 0.98 * cand) k++;
    const y = (k + 0.5) / 4095;
    if (y >= LIN[150] && cand >= 0.1 * n) ev = clamp(Math.log2(LIN[240] / y), 0, EV_MAX);
  }
  const mx = hist.map((h) => { let tot = 0, a = 0, k = 0; for (const v of h) tot += v; while (k < 255 && (a += h[k]) < 0.995 * tot) k++; return k; });   // 99,5e centile par canal
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

// Boite (inclusive) du masque >= 0,5 + bords COUPES par la photo : un bord est touche si le masque >= 0,5 occupe son liseré de 2 px
// sur une longueur >= 5 % de la boite (min. 3 px : un pixel parasite ne compte pas) ; la boite est alors etendue jusqu'a lui. null si le masque est vide.
// (meme idee que le bbox de worn.js : un bord touche n'a pas de marge, rien n'est invente.)
export function subjectBox(mask) {
  const { width: w, height: h, data } = mask;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let i = 0; i < data.length; i++) if (data[i] >= 0.5) { const x = i % w, y = (i / w) | 0; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < 0) return null;
  const rows = (xs) => { let n = 0; for (let y = y0; y <= y1; y++) if (xs.some((x) => data[y * w + x] >= 0.5)) n++; return n >= Math.max(3, 0.05 * (y1 - y0 + 1)); };
  const cols = (ys) => { let n = 0; for (let x = x0; x <= x1; x++) if (ys.some((y) => data[y * w + x] >= 0.5)) n++; return n >= Math.max(3, 0.05 * (x1 - x0 + 1)); };
  const l = rows([0, Math.min(1, w - 1)]), r = rows([w - 1, Math.max(0, w - 2)]), t = cols([0, Math.min(1, h - 1)]), b = cols([h - 1, Math.max(0, h - 2)]);
  return { x0: l ? 0 : x0, y0: t ? 0 : y0, x1: r ? w - 1 : x1, y1: b ? h - 1 : y1, l, r, t, b };
}
export const anyCut = (b) => b.l || b.r || b.t || b.b;

// Boite du masque, echelle = min(ajustement avec marge, 1), centree puis remontee de lift x hauteur du cadre (1,5 %).
// Regle du lift : le sujet ne passe jamais sous la marge haute ; s'il la toucherait, on reduit le lift (jamais de coupe ni de
// reduction en dessous de l'ajustement). Bord de la photo touche (S-R18) : pas de marge de ce cote, le sujet est cale a ras du MEME
// bord du cadre (transform.cut = cotes cales). Deux cotes opposes touches : cet axe est REMPLI (echelle = cadre / boite, <= 1) tant que
// l'autre axe tient dans le cadre (sa marge se reduit, jusqu'a 0), centre sans lift ni plancher de marge ; sinon (sujet plus petit que le
// cadre, ou trop haut/large) il reste centre. Le sujet ne sort jamais du cadre.
export function placeSubject(img, mask, opts) {
  const b = subjectBox(mask);
  if (!b) throw new Error('masque vide : aucun sujet a placer');
  const bw = b.x1 - b.x0 + 1, bh = b.y1 - b.y0 + 1, m = Math.max(0.01, opts.margin ?? DEF_MARGIN);   // le sujet ne touche jamais le cadre (sauf cote coupe)
  let scale = Math.min((OW * (1 - m * ((b.l ? 0 : 1) + (b.r ? 0 : 1)))) / bw, (OH * (1 - m * ((b.t ? 0 : 1) + (b.b ? 0 : 1)))) / bh, 1);
  if (b.l && b.r && OW / bw <= OH / bh) scale = Math.max(scale, Math.min(OW / bw, 1));
  if (b.t && b.b && OH / bh <= OW / bw) scale = Math.max(scale, Math.min(OH / bh, 1));
  const tw = Math.min(OW, Math.max(1, Math.round(bw * scale))), th = Math.min(OH, Math.max(1, Math.round(bh * scale)));
  const lift = Math.round(clamp(opts.lift ?? DEF_LIFT, 0, 0.1) * OH), cx = Math.round((OW - tw) / 2), cy = Math.round((OH - th) / 2);
  const flush = (lo, hi, F, len, c, free) => (lo && !hi ? 0 : hi && !lo ? F - len : lo && hi ? c : free);
  return {
    transform: {
      scale, sx: b.x0, sy: b.y0, sw: bw, sh: bh, tw, th, cut: { l: b.l, r: b.r, t: b.t, b: b.b },
      ox: flush(b.l, b.r, OW, tw, cx, cx),
      oy: flush(b.t, b.b, OH, th, cy, Math.max(Math.min(Math.round(m * OH), cy), cy - lift)),   // plancher de marge haute seulement si le sujet tient avec ses marges
    }, size: [OW, OH],
  };
}

// Rotation de deg degres (anti-horaire a l'ecran, y vers le bas) autour du centre, bilineaire, canevas agrandi pour ne rien couper.
// Image : bords repliques (le demelage ne voit pas de noir) ; masque : 0 hors source. deg = 0 : l'objet est rendu tel quel.
// win = { x, y, w, h } : seule cette fenetre de la rotation complete (memes octets), sans le reste du canevas.
export function rotate(im, deg, win) {
  if (!deg) return im;
  const r = (deg * Math.PI) / 180, co = Math.cos(r), si = Math.sin(r), { width: w, height: h } = im, ch = im.data.length / (w * h), isImg = ch === 4;
  const W = Math.ceil(w * Math.abs(co) + h * Math.abs(si) - 1e-9), H = Math.ceil(w * Math.abs(si) + h * Math.abs(co) - 1e-9), f = win ?? { x: 0, y: 0, w: W, h: H }, o = new im.data.constructor(f.w * f.h * ch);
  const cx = (w - 1) / 2, cy = (h - 1) / 2, ox = (W - 1) / 2, oy = (H - 1) / 2, d = im.data;
  const px = (x, y, c) => (x < 0 || y < 0 || x >= w || y >= h ? (isImg ? d[4 * (clamp(y, 0, h - 1) * w + clamp(x, 0, w - 1)) + c] : 0) : d[(y * w + x) * ch + c]);
  for (let y = f.y; y < f.y + f.h; y++) for (let x = f.x; x < f.x + f.w; x++) {
    const dx = x - ox, dy = y - oy, sx = cx + dx * co - dy * si, sy = cy + dx * si + dy * co, x0 = Math.floor(sx), y0 = Math.floor(sy), fx = sx - x0, fy = sy - y0, k = ((y - f.y) * f.w + x - f.x) * ch;
    if (x0 >= 0 && y0 >= 0 && x0 < w - 1 && y0 < h - 1) {   // interieur : indexation directe
      const i = (y0 * w + x0) * ch, j = i + w * ch, w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
      for (let c = 0; c < ch; c++) o[k + c] = d[i + c] * w00 + d[i + ch + c] * w10 + d[j + c] * w01 + d[j + ch + c] * w11;
      continue;
    }
    for (let c = 0; c < ch; c++) o[k + c] = (px(x0, y0, c) * (1 - fx) + px(x0 + 1, y0, c) * fx) * (1 - fy) + (px(x0, y0 + 1, c) * (1 - fx) + px(x0 + 1, y0 + 1, c) * fx) * fy;
  }
  return { width: f.w, height: f.h, data: o };
}

// Angle de redressement (degres, a passer a rotate / opts.angle) : axe principal du masque binaire (moments d'ordre 2), ramene
// a l'axe de l'image le plus proche. 0 si l'elongation (rapport des axes) < 1,15 ; borne a +-10.
export function straightenAngle(mask) {
  let n = 0, sx = 0, sy = 0;
  const { width: w, data } = mask;
  for (let i = 0; i < data.length; i++) if (data[i] >= 0.5) { n++; sx += i % w; sy += (i / w) | 0; }
  if (n < 2) return 0;
  const mx = sx / n, my = sy / n;
  let a = 0, b = 0, c = 0;
  for (let i = 0; i < data.length; i++) if (data[i] >= 0.5) { const dx = (i % w) - mx, dy = ((i / w) | 0) - my; a += dx * dx; b += dy * dy; c += dx * dy; }
  const t = Math.hypot(a - b, 2 * c), l1 = (a + b + t) / 2, l2 = (a + b - t) / 2;
  if (l2 <= 0 || Math.sqrt(l1 / l2) < 1.15) return 0;
  let deg = (0.5 * Math.atan2(2 * c, a - b) * 180) / Math.PI;   // axe principal, inclinaison horaire a l'ecran
  deg -= 90 * Math.round(deg / 90);                              // ecart a l'axe image le plus proche, [-45 ; 45]
  return clamp(deg, -10, 10);
}

// Boite du sujet (masque >= 0,5, repere work) + marge (fraction de chaque dimension de la boite, par cote), convertie dans le repere
// de l'original, entiers, bornee a l'image. Pour createImageBitmap(file, sx, sy, sw, sh).
export function sourceRect(mask, workW, workH, origW, origH, margin = 0) {
  const { width: w, height: h, data } = mask;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let i = 0; i < data.length; i++) if (data[i] >= 0.5) { const x = i % w, y = (i / w) | 0; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < 0) throw new Error('masque vide : aucun sujet');
  const kx = origW / workW, ky = origH / workH, mxp = (x1 - x0 + 1) * margin, myp = (y1 - y0 + 1) * margin;
  const ax = clamp(Math.floor((x0 - mxp) * kx), 0, origW - 1), ay = clamp(Math.floor((y0 - myp) * ky), 0, origH - 1);
  const bx = clamp(Math.ceil((x1 + 1 + mxp) * kx), ax + 1, origW), by = clamp(Math.ceil((y1 + 1 + myp) * ky), ay + 1, origH);
  return { sx: ax, sy: ay, sw: bx - ax, sh: by - ay };
}

const crop = (im, x0, y0, w, h, ch) => {
  const o = new im.data.constructor(w * h * ch);
  for (let y = 0; y < h; y++) o.set(im.data.subarray(((y0 + y) * im.width + x0) * ch, ((y0 + y) * im.width + x0 + w) * ch), y * w * ch);
  return { width: w, height: h, data: o };
};

// Silhouette : mask >= 0,5, plus les regions ENCLOSES (composantes de mask < 0,5 non reliees au bord du recadrage) dont au
// moins 90 % des pixels ont mask >= 0,25 (le modele doutait presque partout ; quelques pixels bas isoles, plis sombres, n'y changent
// rien). Decision par region, pas par pixel : un vrai trou (boutonniere, anse), meme entoure d'une rampe a 0,25-0,5, reste hors du
// vetement avec sa frontiere a 0,5.
function garment(a, w, h) {
  const n = w * h, g = new Float32Array(n), seen = new Uint8Array(n), q = new Int32Array(n);
  for (let i = 0; i < n; i++) g[i] = a[i] >= 0.5 ? 1 : 0;
  let tail = 0;
  const push = (j) => { if (!g[j] && !seen[j]) { seen[j] = 1; q[tail++] = j; } };
  const flood = (from) => {                                // remplit seen depuis q[from..tail) ; renvoie la part de pixels de la region avec a >= 0,25
    let hit = 0;
    for (let head = from; head < tail; head++) {
      const j = q[head], x = j % w, y = (j / w) | 0;
      if (a[j] >= 0.25) hit++;
      if (x > 0) push(j - 1);
      if (x < w - 1) push(j + 1);
      if (y > 0) push(j - w);
      if (y < h - 1) push(j + w);
    }
    return hit / (tail - from);
  };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  flood(0);
  const outside = tail;                                    // q[0..outside) = exterieur relie au bord
  for (let i = 0; i < n; i++) {
    if (g[i] || seen[i]) continue;
    const from = tail;
    push(i);
    if (flood(from) >= 0.9) for (let k = from; k < tail; k++) g[q[k]] = 1;
  }
  const hole = new Uint8Array(n);                          // trous reels : regions enclosees refusees ci-dessus
  for (let k = outside; k < tail; k++) if (!g[q[k]]) hole[q[k]] = 1;
  return { bin: g, hole };
}

// Sujet recadre et redimensionne (Lanczos), identique pour sortie et reference. bin = silhouette du vetement. Coeur = bin
// erode de 2 px (apres 2 px de zeros : les ourlets au bord de la boite s'erodent aussi) -> alpha 1. Bande = bin hors coeur
// -> alpha doux (bilineaire contraste), seul endroit demele. Ailleurs alpha 0.
function placed(img, mask, opts) {
  const rot = opts.angle && !anyCut(subjectBox(mask) ?? {});
  if (rot) { img = rotate(img, opts.angle); mask = rotate(mask, opts.angle); }   // opts.angle (deg) : meme redressement pour sortie, reference et controles ; jamais si un bord est coupe (la coupe resterait en biais)
  const { transform: t } = placeSubject(img, mask, opts);
  const { tw, th } = t, P = 2, pw = tw + 2 * P;
  const fit = (im) => { const c = crop(im, t.sx, t.sy, t.sw, t.sh, 4); return tw !== t.sw || th !== t.sh ? resizeLanczos(c, tw, th) : c; };
  let sub = fit(img), a = crop(mask, t.sx, t.sy, t.sw, t.sh, 1);
  const rs1 = (m, w2, h2) => {                             // masque redimensionne (bilineaire)
    const rgba = { width: m.width, height: m.height, data: new Uint8ClampedArray(m.width * m.height * 4) };
    for (let i = 0; i < m.data.length; i++) rgba.data[4 * i] = m.data[i] * 255;
    const r = resizeBilinear(rgba, w2, h2);
    const o = new Float32Array(w2 * h2);
    for (let i = 0; i < o.length; i++) o[i] = r.data[4 * i] / 255;
    return { width: w2, height: h2, data: o };
  };
  // Marge de fond (8 px de sortie, bornee a l'image) autour du recadrage : le demelage y cherche le fond voisin des ourlets droits.
  const ps = Math.ceil(8 / t.scale), pl = Math.min(ps, t.sx), pt = Math.min(ps, t.sy), pr = Math.min(ps, img.width - t.sx - t.sw), pb = Math.min(ps, img.height - t.sy - t.sh);
  const ox = Math.round(pl * t.scale), oy = Math.round(pt * t.scale), ew = ox + tw + Math.round(pr * t.scale), eh = oy + th + Math.round(pb * t.scale);
  let eimg = crop(img, t.sx - pl, t.sy - pt, pl + t.sw + pr, pt + t.sh + pb, 4), em = crop(mask, t.sx - pl, t.sy - pt, pl + t.sw + pr, pt + t.sh + pb, 1);
  if (eimg.width !== ew || eimg.height !== eh) { eimg = resizeLanczos(eimg, ew, eh); em = rs1(em, ew, eh); }
  if (tw !== t.sw || th !== t.sh) a = rs1(a, tw, th);
  const { bin, hole } = garment(a.data, tw, th), padded = new Float32Array(pw * (th + 2 * P));
  const edge = (v, n, lo, hi) => (v < 0 ? (lo ? 0 : -1) : v >= n ? (hi ? n - 1 : -1) : v);   // bord coupe : le vetement se prolonge (pas de zeros, donc pas de bande molle sur la coupe)
  for (let y = 0; y < th + 2 * P; y++) for (let x = 0; x < pw; x++) {
    const sx = edge(x - P, tw, t.cut.l, t.cut.r), sy = edge(y - P, th, t.cut.t, t.cut.b);
    if (sx >= 0 && sy >= 0) padded[y * pw + x] = bin[sy * tw + sx];
  }
  const ep = erode({ width: pw, height: th + 2 * P, data: padded }, P).data, core = new Uint8Array(tw * th);
  for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) core[y * tw + x] = ep[(y + P) * pw + x + P];
  for (let i = 0; i < a.data.length; i++) a.data[i] = core[i] ? 1 : bin[i] ? clamp((a.data[i] - 0.5) * 4 + 0.5, 0, 1) : 0;
  const band = new Uint8Array(tw * th), ok = new Uint8Array(em.data.length);
  for (let i = 0; i < ok.length; i++) ok[i] = em.data[i] < 0.1 ? 1 : 0;
  for (let i = 0; i < band.length; i++) band[i] = bin[i] && !core[i] ? 1 : 0;
  for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) ok[(y + oy) * ew + x + ox] = a.data[y * tw + x] < 0.1 ? 1 : 0;   // dans le recadrage : silhouette avant filtre
  // sampled : autre image de meme geometrie placee comme sub, aux seuls pixels que lit extract (memes octets que fit a ces positions ;
  // seule la fenetre recadree est tournee) : Lanczos 1636 x 1896 -> 1200 x 1391 en 32 ms au lieu de 200 (pas 5)
  const sampled = (im) => {
    const c = rot ? rotate(im, opts.angle, { x: t.sx, y: t.sy, w: t.sw, h: t.sh }) : crop(im, t.sx, t.sy, t.sw, t.sh, 4);
    return tw !== t.sw || th !== t.sh ? resizeLanczosStep(c, tw, th, sampleStep(tw, th)) : c;
  };
  return { sub, alpha: a, bin, hole, band, ext: { img: eimg, ok, ox, oy }, t, sampled };
}

// Flou gaussien approche : 3 passes de boite (horizontale puis verticale) de rayon r, sur un tableau OW x OH.
function blur3(s, r) {
  let a = s, b = new Float32Array(s.length);
  const buf = new Float32Array(Math.max(OW, OH) + 2 * r + 2), inv = 1 / (2 * r + 1);   // ligne copiee avec r+1 zeros de chaque cote
  for (let pass = 0; pass < 3; pass++) {
    for (const [len, step, outer, ostep] of [[OW, 1, OH, OW], [OH, OW, OW, 1]]) {
      for (let o = 0; o < outer; o++) {
        const base = o * ostep;
        for (let k = 0; k < len; k++) buf[k + r + 1] = a[base + k * step];
        buf.fill(0, 0, r + 1); buf.fill(0, len + r + 1, len + 2 * r + 2);
        let acc = 0;
        for (let k = 1; k <= 2 * r + 1; k++) acc += buf[k];   // fenetre [-r, r] autour de k = 0
        for (let k = 0; k < len; k++) { b[base + k * step] = acc * inv; acc += buf[k + 2 * r + 2] - buf[k + 1]; }
      }
      [a, b] = [b, a];
    }
  }
  return a;
}

// Flou ~gaussien d'ecart-type sigma px : 3 boites de rayon r, r (r + 1) ~ sigma^2.
const blurSigma = (s, sigma) => blur3(s, Math.max(1, Math.round(Math.sqrt(sigma * sigma + 0.25) - 0.5)));

// Ombres du flat lay (critique des fonds) : contact ao (silhouette floue, serree) x douce soft x ambiante amb (silhouette et trous
// decales de [dx, dy] >= 0, vers le bas a droite, a l'oppose de la lumiere, puis flous) ; opacites de lighting(), x k (reglage Ombre).
// Assombrissement = 1 - produit des couches. Trous fermes (hole, voir garment()) : 0,4 x le contact seul (lisere discret, centre
// propre : un trou assombri se lirait comme une tache).
function flatShadow(bin, hole, t, L, k) {
  const { tw, th } = t, n = OW * OH, res = new Float32Array(n), [a0, s0, m0] = [L.ao, L.soft, L.amb].map((v) => clamp(v[0] * k, 0, 1));
  if (!(a0 || s0 || m0)) return res;
  const put = (dx, dy, holes) => {
    const s = new Float32Array(n);
    for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
      const X = t.ox + x + dx, Y = t.oy + y + dy, j = y * tw + x;
      if (X < OW && Y < OH && (bin[j] || (holes && hole[j]))) s[Y * OW + X] = 1;
    }
    return s;
  };
  const ao = blurSigma(put(0, 0, false), L.ao[1]), so = blurSigma(put(L.soft[2], L.soft[3], true), L.soft[1]), am = blurSigma(put(L.amb[2], L.amb[3], true), L.amb[1]);
  for (let i = 0; i < n; i++) res[i] = 1 - (1 - a0 * Math.min(1, ao[i])) * (1 - s0 * Math.min(1, so[i])) * (1 - m0 * Math.min(1, am[i]));
  for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) if (hole[y * tw + x]) { const i = (t.oy + y) * OW + t.ox + x; res[i] = 0.4 * a0 * Math.min(1, ao[i]); }
  return res;
}

// Grain fin deterministe (graine fixe) : somme de 4 uniformes (~gaussien), adoucie en croix ; niveaux sRGB, ecart-type ~0,9 x sigma.
function grain(sigma) {
  const n = OW * OH, a = new Float32Array(n), o = new Float32Array(n), k = (1.6 * sigma) / 8;
  let seed = 12345;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  for (let i = 0; i < n; i++) a[i] = (rnd() + rnd() + rnd() + rnd() - 2) * 1.732;
  for (let y = 1; y < OH - 1; y++) for (let x = 1; x < OW - 1; x++) { const i = y * OW + x; o[i] = (4 * a[i] + a[i - 1] + a[i + 1] + a[i - OW] + a[i + OW]) * k; }
  return o;
}

// Papier studio RGBA opaque 1200 x 1600 (modele du labo, lumiere du haut-gauche) : L = lighting(couleur). EV = flaque (gaussienne
// centree en poolAt, rayons poolR) + vignette douce (vers les coins) - degrade le long de dir (memes signes que le decalage des
// ombres : le cote oppose, en haut a gauche, est le plus clair) ; papier plafonne a L.max par canal, puis ombre sh (multiplication,
// null = aucune), puis grain.
const SRGB_N = 8192, SRGB = Float64Array.from({ length: SRGB_N + 2 }, (_, k) => toSrgb(k / SRGB_N));   // toSrgb tabulee sur [0, 1], interpolee
const fastSrgb = (l) => { const p = Math.min(1, Math.max(0, l)) * SRGB_N, k = Math.floor(p); return SRGB[k] + (SRGB[k + 1] - SRGB[k]) * (p - k); };
export function studioBg(sh, L) {
  const base = L.base.map((v) => LIN[v]), cap = LIN[L.max], [gx, gy] = L.poolAt, [rx, ry] = L.poolR, [dx, dy, dev] = L.dir, dl = Math.hypot(dx, dy);
  const ex = Float64Array.from({ length: OW }, (_, x) => Math.exp(-1.6 * ((x / OW - gx) / rx) ** 2)), ey = Float64Array.from({ length: OH }, (_, y) => Math.exp(-1.6 * ((y / OH - gy) / ry) ** 2));
  const gr = grain(L.grain), out = new Uint8ClampedArray(OW * OH * 4), VN = 4096;   // vignette tabulee sur c2 = r^2 dans [0, 2]
  const vt = Float64Array.from({ length: VN + 1 }, (_, k) => L.vig * Math.min(1, k / VN) ** 1.3), gu = Float64Array.from({ length: OW }, (_, x) => (2 * x) / OW - 1);
  for (let y = 0; y < OH; y++) {
    const v = y / OH, cv = (2 * v - 1) ** 2, dv = (dev * (v - 0.5) * dy) / dl;
    for (let x = 0; x < OW; x++) {
      const i = y * OW + x, s = sh ? 1 - sh[i] : 1, c2 = gu[x] * gu[x] + cv;
      const k = 2 ** (L.pool * ex[x] * ey[y] + vt[Math.round(c2 * VN / 2)] - (dev * (gu[x] / 2) * dx) / dl - dv);
      for (let c = 0; c < 3; c++) out[4 * i + c] = fastSrgb(Math.min(cap, base[c] * k) * s) + gr[i];
      out[4 * i + 3] = 255;
    }
  }
  return out;
}

// Fonds proposes pour un vetement (image corrigee + masque, toute taille ; extract sous-echantillonne a ~80 000 pixels) :
// sugg = 4 suggestions (backdrop.suggest), ton = « Ton sur ton » genere (meilleur candidat ; null si vetement sourd ou multicolore).
// base = le meme vetement sans lumiere studio (meme geometrie ; seuls les pixels lus par extract comptent) : il decide les fonds,
// img (affiche) sert au controle des ecarts.
export function backdrops(img, mask, base) {
  const s = extract(img.data, mask.data, img.width, img.height, 4), g = base ? extract(base.data, mask.data, base.width, base.height, 4) : s;
  return g && s ? { sugg: suggest(g, 4, s), ton: candidates(g, false, s).find((x) => x.id === 'ton') ?? null } : { sugg: [], ton: null };
}

// Options absentes ou undefined = reglages par defaut (shadow 1 = ombres de lighting(), marge, lift) ; une option explicite l'emporte.
const withDefaults = (opts) => ({ shadow: 1, margin: DEF_MARGIN, lift: DEF_LIFT, ...Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)) });

// Fond -> ombre -> sujet (corrige globalement, demele). outMask = silhouette en 1200 x 1600. Fond, ombres et grain ne
// modifient que des pixels d'alpha < 1 (le sujet d'alpha 1 est copie tel quel). opts.bg = couleur du fond vue au centre du cadre
// (absente : Auto = 1re suggestion pour CE vetement, calculee sur la couche placee) ; opts.shadow = echelle des ombres (0 : aucune) ;
// opts.base = img sans lumiere studio (meme geometrie, meme correction a appliquer) : fonds decides sur base place, verifies sur img place.
// Retour : + bg (couleur utilisee), choices = backdrops() du vetement place.
// Alpha de bande : filtre guide couleur (edgeMode 'guided'), rognage colorimetrique (pixels de bande couleur-fond), alpha >= 0,9 ramene a 1 (pixel de vetement copie tel quel). Si edgeCheck
// echoue, nouvel essai sans filtre (alpha de silhouette, demelage conserve : edgeMode 'basic').
export function composeStudio(img, mask, corr, opts = {}) {
  opts = withDefaults(opts);
  const p = placed(applyGlobal(img, corr), mask, opts), { bin, hole, band, t } = p, ref = { ...p.sub, data: p.sub.data.slice() };
  const choices = backdrops(p.sub, p.alpha, opts.base && p.sampled(applyGlobal(opts.base, corr))), bg = opts.bg ?? choices.sugg[0]?.rgb ?? NUAGE, light = lighting(bg);
  const snap = (al) => { for (let i = 0; i < al.data.length; i++) if (band[i] && al.data[i] >= 0.9) al.data[i] = 1; return al; };
  let flat = null;                                         // fond + ombres : identiques d'un essai a l'autre
  const base = () => (flat ??= studioBg(flatShadow(bin, hole, t, light, opts.shadow), light));
  const build = (alpha) => {
    const sub = unmix(ref, alpha, band, p.ext), fb = new Uint8Array(OW * OH), fa = new Float32Array(OW * OH), fr = new Uint8ClampedArray(OW * OH * 4);
    const out = base().slice(), om = new Float32Array(OW * OH);
    for (let y = 0; y < t.th; y++) for (let x = 0; x < t.tw; x++) {
      const a = alpha.data[y * t.tw + x], i = (t.oy + y) * OW + t.ox + x, j = 4 * (y * t.tw + x);
      for (let c = 0; c < 3; c++) out[4 * i + c] = a * sub.data[j + c] + (1 - a) * out[4 * i + c];
      om[i] = bin[y * t.tw + x]; fb[i] = band[y * t.tw + x]; fa[i] = a; fr.set(ref.data.subarray(j, j + 4), 4 * i);
    }
    const o = { width: OW, height: OH, data: out };
    return { out: o, outMask: { width: OW, height: OH, data: om }, band: fb, edge: edgeCheck(o, { width: OW, height: OH, data: fr }, { data: fa }, fb) };
  };
  const core = new Uint8Array(band.length), trim = (al) => trimBand(ref, al, band, core, p.ext, p.alpha);   // masque trop large : pixels de bande couleur-fond -> alpha 0
  for (let i = 0; i < core.length; i++) core[i] = p.alpha.data[i] >= 1 && !band[i] ? 1 : 0;
  const guided = { ...build(snap(trim(guidedFilter(p.alpha, ref, 2, 1e-3, band)))), edgeMode: 'guided', bg, choices };
  if (guided.edge.ok) return guided;
  return { ...build(snap(trim(p.alpha))), edgeMode: 'basic', bg, choices };
}

// Mode Lumiere seule (S-R16) : corrections globales seulement, photo ENTIERE (aucun recadrage), cote long <= 1600, jamais d'agrandissement.
export function lightOnly(img, corr) {
  const g = applyGlobal(img, corr), k = Math.min(1, OH / Math.max(g.width, g.height));
  return k < 1 ? resizeLanczos(g, Math.round(g.width * k), Math.round(g.height * k)) : g;
}

// Comparaison commune des controles d'export : dans le masque (binaire, >= 0,5) erode de 3 px, out egale ref (meme taille), a +-2/255.
export function fidelityDiff(out, ref, mask) {
  if (out.width !== ref.width || out.height !== ref.height) return { ok: false, maxDiff: 255 };
  const bm = new Uint8Array(mask.data.length);
  for (let i = 0; i < bm.length; i++) bm[i] = mask.data[i] >= 0.5 ? 1 : 0;
  const er = erode({ width: mask.width, height: mask.height, data: bm }, 3).data;
  let maxDiff = 0, n = 0;
  for (let i = 0; i < er.length; i++) {
    if (!er[i]) continue;
    n++;
    for (let c = 0; c < 3; c++) maxDiff = Math.max(maxDiff, Math.abs(out.data[4 * i + c] - ref.data[4 * i + c]));
  }
  return n ? { ok: maxDiff <= 2, maxDiff } : { ok: false, maxDiff: 255 };   // rien a comparer : on bloque
}

// Controle d'export : dans outMask erode de 3 px, la sortie egale l'original corrige globalement et place de la meme facon.
export function fidelityCheck(out, img, mask, corr, opts = {}) {
  opts = withDefaults(opts);
  if (out.width !== OW || out.height !== OH) return { ok: false, maxDiff: 255 };
  const { sub, bin, t } = placed(applyGlobal(img, corr), mask, opts);
  const om = new Float32Array(OW * OH), ref = new Uint8ClampedArray(OW * OH * 4);
  for (let y = 0; y < t.th; y++) for (let x = 0; x < t.tw; x++) {
    const i = (t.oy + y) * OW + t.ox + x;
    om[i] = bin[y * t.tw + x];
    ref.set(sub.data.subarray(4 * (y * t.tw + x), 4 * (y * t.tw + x) + 4), 4 * i);
  }
  return fidelityDiff(out, { width: OW, height: OH, data: ref }, { width: OW, height: OH, data: om });
}

// Part du sujet dans [0,02 ; 0,98].
export function maskUsable(mask) {
  let n = 0;
  for (const v of mask.data) if (v >= 0.5) n++;
  const p = n / mask.data.length;
  return p >= 0.02 && p <= 0.98;
}
