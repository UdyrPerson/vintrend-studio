// Retouche pure (sans DOM) : corrections globales du vetement, fond, ombre de contact, cadrage 3:4, controle de fidelite.
// Le vetement n'est jamais modifie autrement que par applyGlobal (gains de balance + exposition, meme table partout).
// Image : {width, height, data: Uint8ClampedArray} RGBA. Masque : {width, height, data: Float32Array} dans [0, 1].
import { resizeLanczos, resizeBilinear } from './resample.js';
import { erode } from './photo_q.js';
import { guidedFilter, unmix, trimBand, edgeCheck } from './edge.js';

const DEF_MARGIN = 0.07, DEF_LIFT = 0.015, OW = 1200, OH = 1600, EV_MAX = 0.7, G_MIN = 0.8, G_MAX = 1.25, CEIL = 250, SHADOW_CAP = 0.35, SHADOW_FLAT = 0.15;
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
// [1,1,1], ev 0 (rien de fiable). Exposition (v4) : ev = 0 sauf si le 98e centile de luminance des candidats atteint sRGB 150
// ET si les candidats couvrent >= 10 % du cadre ; alors cible 240, ev auto dans [0 ; 0,7] (ev < 0 : curseur manuel).
// Plafond sur le sujet : un canal deja >= 250 a l'origine est ignore ; ev est baisse (jamais sous 0), puis les gains > 1 sont
// ramenes ensemble vers 1, jusqu'a ce que, pour chaque canal, le 99,5e centile des pixels du sujet (< 250 a l'origine) ne
// depasse pas 250. Garanti : au plus 0,5 % des pixels d'un canal (hors canaux deja >= 250) peuvent depasser 250.
export function neutralCorrection(img, mask) {
  const d = img.data, n = img.width * img.height, sum = [0, 0, 0], hist = [0, 1, 2].map(() => new Uint32Array(256)), bins = new Uint32Array(4096);
  let cand = 0;
  for (let i = 0; i < n; i++) {
    const r = d[4 * i], g = d[4 * i + 1], b = d[4 * i + 2];
    if (inMask(mask, i)) {                                    // sujet (tout le cadre si mask = null) : plafond
      if (r < CEIL) hist[0][r]++;
      if (g < CEIL) hist[1][g]++;
      if (b < CEIL) hist[2][b]++;
    }
    if (mask && inMask(mask, i)) continue;
    const hi = Math.max(r, g, b), lo = Math.min(r, g, b);
    if (hi >= CEIL || hi < 100 || (hi - lo) / hi > 0.08) continue;
    cand++; sum[0] += LIN[r]; sum[1] += LIN[g]; sum[2] += LIN[b];
    bins[Math.min(4095, Math.floor(clamp(LUM(r, g, b), 0, 1) * 4095))]++;
  }
  let gains = [1, 1, 1], ev = 0;
  if (cand >= 0.005 * n) {   // gains fiables
    gains = sum.map((s) => clamp(sum[1] / s, G_MIN, G_MAX));
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

// Boite du masque >= 0,5, echelle = min(ajustement avec marge, 1), centree puis remontee de lift x hauteur du cadre (1,5 %).
// Regle du lift : le sujet ne passe jamais sous la marge haute ; s'il la toucherait, on reduit le lift (jamais de coupe ni de
// reduction en dessous de l'ajustement).
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
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1, m = Math.max(0.01, opts.margin ?? DEF_MARGIN);   // le sujet ne touche jamais le cadre
  const scale = Math.min((OW * (1 - 2 * m)) / bw, (OH * (1 - 2 * m)) / bh, 1);
  const tw = Math.min(OW, Math.max(1, Math.round(bw * scale))), th = Math.min(OH, Math.max(1, Math.round(bh * scale)));
  return { transform: { scale, sx: x0, sy: y0, sw: bw, sh: bh, tw, th, ox: Math.round((OW - tw) / 2), oy: Math.max(Math.round(m * OH), Math.round((OH - th) / 2) - Math.round(clamp(opts.lift ?? DEF_LIFT, 0, 0.1) * OH)) }, size: [OW, OH] };
}

// Rotation de deg degres (anti-horaire a l'ecran, y vers le bas) autour du centre, bilineaire, canevas agrandi pour ne rien couper.
// Image : bords repliques (le demelage ne voit pas de noir) ; masque : 0 hors source. deg = 0 : l'objet est rendu tel quel.
export function rotate(im, deg) {
  if (!deg) return im;
  const r = (deg * Math.PI) / 180, co = Math.cos(r), si = Math.sin(r), { width: w, height: h } = im, ch = im.data.length / (w * h), isImg = ch === 4;
  const W = Math.ceil(w * Math.abs(co) + h * Math.abs(si) - 1e-9), H = Math.ceil(w * Math.abs(si) + h * Math.abs(co) - 1e-9), o = new im.data.constructor(W * H * ch);
  const cx = (w - 1) / 2, cy = (h - 1) / 2, ox = (W - 1) / 2, oy = (H - 1) / 2, d = im.data;
  const px = (x, y, c) => (x < 0 || y < 0 || x >= w || y >= h ? (isImg ? d[4 * (clamp(y, 0, h - 1) * w + clamp(x, 0, w - 1)) + c] : 0) : d[(y * w + x) * ch + c]);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const dx = x - ox, dy = y - oy, sx = cx + dx * co - dy * si, sy = cy + dx * si + dy * co, x0 = Math.floor(sx), y0 = Math.floor(sy), fx = sx - x0, fy = sy - y0, k = (y * W + x) * ch;
    if (x0 >= 0 && y0 >= 0 && x0 < w - 1 && y0 < h - 1) {   // interieur : indexation directe
      const i = (y0 * w + x0) * ch, j = i + w * ch, w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
      for (let c = 0; c < ch; c++) o[k + c] = d[i + c] * w00 + d[i + ch + c] * w10 + d[j + c] * w01 + d[j + ch + c] * w11;
      continue;
    }
    for (let c = 0; c < ch; c++) o[k + c] = (px(x0, y0, c) * (1 - fx) + px(x0 + 1, y0, c) * fx) * (1 - fy) + (px(x0, y0 + 1, c) * (1 - fx) + px(x0 + 1, y0 + 1, c) * fx) * fy;
  }
  return { width: W, height: H, data: o };
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
  if (opts.angle) { img = rotate(img, opts.angle); mask = rotate(mask, opts.angle); }   // opts.angle (deg) : meme redressement pour sortie, reference et controles
  const { transform: t } = placeSubject(img, mask, opts);
  const { tw, th } = t, P = 2, pw = tw + 2 * P;
  let sub = crop(img, t.sx, t.sy, t.sw, t.sh, 4), a = crop(mask, t.sx, t.sy, t.sw, t.sh, 1);
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
  if (tw !== t.sw || th !== t.sh) { sub = resizeLanczos(sub, tw, th); a = rs1(a, tw, th); }
  const { bin, hole } = garment(a.data, tw, th), padded = new Float32Array(pw * (th + 2 * P));
  for (let y = 0; y < th; y++) padded.set(bin.subarray(y * tw, (y + 1) * tw), (y + P) * pw + P);
  const ep = erode({ width: pw, height: th + 2 * P, data: padded }, P).data, core = new Uint8Array(tw * th);
  for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) core[y * tw + x] = ep[(y + P) * pw + x + P];
  for (let i = 0; i < a.data.length; i++) a.data[i] = core[i] ? 1 : bin[i] ? clamp((a.data[i] - 0.5) * 4 + 0.5, 0, 1) : 0;
  const band = new Uint8Array(tw * th), ok = new Uint8Array(em.data.length);
  for (let i = 0; i < ok.length; i++) ok[i] = em.data[i] < 0.1 ? 1 : 0;
  for (let i = 0; i < band.length; i++) band[i] = bin[i] && !core[i] ? 1 : 0;
  for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) ok[(y + oy) * ew + x + ox] = a.data[y * tw + x] < 0.1 ? 1 : 0;   // dans le recadrage : silhouette avant filtre
  return { sub, alpha: a, bin, hole, band, ext: { img: eimg, ok, ox, oy }, t };
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

// Ombre de contour (flat lay vu du dessus) : silhouette binaire floue (sigma 1,5 % de la hauteur du sujet), decalee de 0,6 % vers
// le bas ; strength = assombrissement VISIBLE juste a l'exterieur du contour (la silhouette est dilatee de 2 rayons de flou avant
// le flou, sinon le pic n'est atteint qu'a l'interieur). Presente de tous les cotes, plus forte en bas.
function dilate(s, d) {                                    // dilatation carree de d px (distance au plus proche pixel actif, par ligne puis par colonne)
  const dist = new Int32Array(Math.max(OW, OH));
  for (const [len, step, outer, ostep] of [[OW, 1, OH, OW], [OH, OW, OW, 1]]) {
    for (let o = 0; o < outer; o++) {
      for (let k = 0, last = -1e9; k < len; k++) { if (s[o * ostep + k * step]) last = k; dist[k] = k - last; }
      for (let k = len - 1, last = 1e9; k >= 0; k--) { if (s[o * ostep + k * step]) last = k; dist[k] = Math.min(dist[k], last - k); }
      for (let k = 0; k < len; k++) s[o * ostep + k * step] = dist[k] <= d ? 1 : 0;
    }
  }
}
// Trous fermes (hole : zeros de la silhouette non relies au bord, fournis par garment()) : jamais dilates ; leur ombre = 0,4 x le flou non dilate (au plus 0,5)
// (liseré discret au bord, centre propre : un trou assombri se lirait comme une tache).
function flatShadow(bin, hole, t, strength) {
  const { tw, th } = t, off = Math.round(0.006 * th), r = Math.max(2, Math.round(0.015 * th)), outer = new Float32Array(OW * OH), inner = new Float32Array(OW * OH);
  for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
    const yy = t.oy + y + off, j = y * tw + x;
    if (yy >= OH) continue;
    if (bin[j]) inner[yy * OW + t.ox + x] = outer[yy * OW + t.ox + x] = 1;
    else if (hole[j]) outer[yy * OW + t.ox + x] = 1;
  }
  dilate(outer, 2 * r);
  const hasHole = hole.some((v) => v), d = blur3(outer, r), u = hasHole ? blur3(inner, r) : null, k = clamp(strength, 0, 1), res = new Float32Array(d.length);
  for (let i = 0; i < res.length; i++) res[i] = Math.min(1, d[i]) * k;
  for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) if (u && hole[y * tw + x]) { const i = (t.oy + y) * OW + t.ox + x; res[i] = 0.4 * Math.min(1, u[i]) * k; }
  return res;
}

// Fond studio RGBA opaque : couleur bg, degrade vertical bgTop -> bgBottom (niveaux sRGB, interpole en lineaire, bg au milieu),
// vignette (EV aux coins, en r^2), ombre sh (multiplication du fond), tramage de Bayer 4x4 +-0,5 (deterministe, sans bandes).
const SRGB_N = 8192, SRGB = Float64Array.from({ length: SRGB_N + 2 }, (_, k) => toSrgb(k / SRGB_N));   // toSrgb tabulee sur [0, 1], interpolee
const fastSrgb = (l) => { const p = Math.min(1, Math.max(0, l)) * SRGB_N, k = Math.floor(p); return SRGB[k] + (SRGB[k + 1] - SRGB[k]) * (p - k); };
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
function studioBg(sh, o) {
  const grad = o.bgTop != null && o.bgBottom != null, lt = grad ? toLin(o.bgTop) : 1, lb = grad ? toLin(o.bgBottom) : 1, ref = grad ? toLin((o.bgTop + o.bgBottom) / 2) : 1;   // gradient relatif : bg garde sa couleur au milieu
  const vg = o.vignette ?? 0, base = o.bg.map(toLin), cx = (OW - 1) / 2, cy = (OH - 1) / 2, r2 = cx * cx + cy * cy, out = new Uint8ClampedArray(OW * OH * 4);
  for (let y = 0; y < OH; y++) {
    const row = (lt + ((lb - lt) * y) / (OH - 1)) / ref;
    for (let x = 0; x < OW; x++) {
      const i = y * OW + x, v = row * 2 ** ((vg * ((x - cx) ** 2 + (y - cy) ** 2)) / r2) * (1 - sh[i]), d = (BAYER[(y & 3) * 4 + (x & 3)] + 0.5) / 16 - 0.5;
      for (let c = 0; c < 3; c++) out[4 * i + c] = Math.round(fastSrgb(base[c] * v) + d);
      out[4 * i + 3] = 255;
    }
  }
  return out;
}

// Ombre de contact (layout 'standing') : silhouette aplatie a 15 % sur la base du sujet, legerement decalee, floue ; opacite <= 0,35.
function shadowAlpha(alpha, t, strength) {
  const s = new Float32Array(OW * OH), base = t.oy + t.th, off = Math.round(0.01 * t.th), top = base + off - SHADOW_FLAT * t.th;
  for (let y = Math.max(0, Math.ceil(top)); y < Math.min(OH, base + off); y++) {
    const sy = Math.min(t.th - 1, Math.floor((y - top) / SHADOW_FLAT));
    for (let x = 0; x < t.tw; x++) s[y * OW + t.ox + x] = alpha.data[sy * t.tw + x];
  }
  const a = blur3(s, Math.max(2, Math.round(0.012 * t.th))), k = SHADOW_CAP * clamp(strength, 0, 1);
  return Float32Array.from(a, (v) => Math.min(1, v) * k);
}

// Options absentes ou undefined = reglages par defaut ; une option explicite l'emporte.
const withDefaults = (img, mask, opts) => ({ ...defaultSettings(img, mask), ...Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)) });

// Fond -> ombre -> sujet (corrige globalement, demele). outMask = silhouette en 1200 x 1600. Fond, ombre et vignette ne
// modifient que des pixels d'alpha < 1 (le sujet d'alpha 1 est copie tel quel). opts.layout : 'flat' (defaut) ou 'standing'.
// Alpha de bande : filtre guide couleur (edgeMode 'guided'), rognage colorimetrique (pixels de bande couleur-fond), alpha >= 0,9 ramene a 1 (pixel de vetement copie tel quel). Si edgeCheck
// echoue, nouvel essai sans filtre (alpha de silhouette, demelage conserve : edgeMode 'basic').
export function composeStudio(img, mask, corr, opts = {}) {
  opts = withDefaults(img, mask, opts);
  const p = placed(applyGlobal(img, corr), mask, opts), { bin, hole, band, t } = p, ref = { ...p.sub, data: p.sub.data.slice() };
  const snap = (al) => { for (let i = 0; i < al.data.length; i++) if (band[i] && al.data[i] >= 0.9) al.data[i] = 1; return al; };
  let flat = null;                                         // fond + ombre de contour : identiques d'un essai a l'autre (l'ombre 'standing' depend de l'alpha)
  const base = (alpha) => (opts.layout === 'standing' ? studioBg(shadowAlpha(alpha, t, opts.shadow), opts) : (flat ??= studioBg(flatShadow(bin, hole, t, opts.shadow), opts)));
  const build = (alpha) => {
    const sub = unmix(ref, alpha, band, p.ext), fb = new Uint8Array(OW * OH), fa = new Float32Array(OW * OH), fr = new Uint8ClampedArray(OW * OH * 4);
    const out = base(alpha).slice(), om = new Float32Array(OW * OH);
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
  const guided = { ...build(snap(trim(guidedFilter(p.alpha, ref, 2, 1e-3, band)))), edgeMode: 'guided' };
  if (guided.edge.ok) return guided;
  const basic = { ...build(snap(trim(p.alpha))), edgeMode: 'basic' };
  return basic;
}

// Mode Lumiere seule : corrections globales, recadrage centre 3:4, 1600 px de haut au plus.
export function lightOnly(img, corr) {
  const g = applyGlobal(img, corr), w = g.width, h = g.height;
  const ch = w / h > 0.75 ? h : Math.round(w / 0.75), cw = ch === h ? Math.round(h * 0.75) : w;
  const c = crop(g, Math.floor((w - cw) / 2), Math.floor((h - ch) / 2), cw, ch, 4);
  return ch > OH ? resizeLanczos(c, Math.round(OH * 0.75), OH) : c;
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
  opts = withDefaults(img, mask, opts);
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

// Reglages par defaut (spec 11.1) : blanc casse 244,244,242 ; gris 222 si le sujet est tres clair (L* moyen > 85, ombre 0,28).
export function defaultSettings(img, mask) {
  let s = 0, n = 0;
  for (let i = 0; i < mask.data.length; i++) if (mask.data[i] >= 0.5) {
    const y = 0.2126 * LIN[img.data[4 * i]] + 0.7152 * LIN[img.data[4 * i + 1]] + 0.0722 * LIN[img.data[4 * i + 2]];
    s += y > 0.008856 ? 116 * Math.cbrt(y) - 16 : 903.3 * y;
    n++;
  }
  const lt = n && s / n > 85, k = lt ? -22 : 0;
  return { bg: [244 + k, 244 + k, 242 + k], bgTop: 248 + k, bgBottom: 238 + k, vignette: -0.12, shadow: lt ? 0.28 : 0.2, layout: 'flat', margin: DEF_MARGIN, lift: DEF_LIFT };
}
