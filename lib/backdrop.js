// Choix du fond studio selon les couleurs du vetement. Module pur (pas de DOM), OKLab / OKLCH.
//   extract(px, alpha, w, h, ch)  -> palette du vetement (clusters, couleur du contour, drapeaux)
//   suggest(g, n, shown)          -> jusqu'a 4 fonds distincts { name, hex, rgb, L, C, h, rel, role, score, why }
//   candidates(g, relax, shown)   -> tous les fonds possibles, tries par score (dont « Ton sur ton » genere, id 'ton')
//   lighting(rgb)                 -> reglages lumiere / grain / ombres adaptes a la clarte du fond
// Auto-test : node pipeline/photo/test_backdrop.mjs

// --- couleur ---------------------------------------------------------------------------------------------------------------
const LIN = Array.from({ length: 256 }, (_, v) => (v / 255 <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4));
const enc = (c) => Math.round(255 * Math.max(0, Math.min(1, c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)));
export function oklab(r, g, b) {
  r = LIN[r]; g = LIN[g]; b = LIN[b];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b), m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b), s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
export function rgbOf(L, C, h) {   // OKLCH -> sRGB 0-255 (chromas faibles : la coupure par canal suffit)
  const a = C * Math.cos((h * Math.PI) / 180), b = C * Math.sin((h * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3, m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3, s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s].map(enc);
}
export const hex = (rgb) => '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();
const lchOf = ([L, a, b]) => ({ L, C: Math.hypot(a, b), h: ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360 });
const labOf = (c) => [c.L, c.C * Math.cos((c.h * Math.PI) / 180), c.C * Math.sin((c.h * Math.PI) / 180)];
const dE = (p, q) => { const A = labOf(p), B = labOf(q); return Math.hypot(A[0] - B[0], A[1] - B[1], A[2] - B[2]); };
const dh = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };
const Y = (rgb) => 0.2126 * LIN[rgb[0]] + 0.7152 * LIN[rgb[1]] + 0.0722 * LIN[rgb[2]];
export const wcag = (p, q) => { const a = Y(p), b = Y(q); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); };

// --- palette : familles OKLCH (la clarte exacte est choisie par vetement dans [lo, hi]) ---------------------------------------
// L0 = teinte de reference affichee dans le nuancier. trend = poids tendance 0-1 (1 = choix explicite de l'utilisateur : sauge,
// sable, anthracite). v2 : Lin (= Nuage a 0,03 pres), Gris perle et Galet retires ; Greige = Sable sous L 0,80 ; Beurre et
// Bordeaux ajoutes ; Argile rechauffee (h 30 -> 38, terre cuite claire) ; Bleu brume plus gris, jamais sous L 0,84 ; Anthracite chaud.
export const PALETTE = [
  { id: 'nuage', name: 'Nuage', h: 89, C: 0.007, L0: 0.949, lo: 0.90, hi: 0.97, trend: 1.0, src: 'Pantone 2026 Cloud Dancer #F0EEE9' },
  { id: 'sable', name: 'Sable', h: 79, C: 0.033, L0: 0.866, lo: 0.70, hi: 0.92, trend: 1.0, src: 'Pantone SS26 Angora ; Greige = SW 2026 Universal Khaki' },
  { id: 'beurre', name: 'Beurre', h: 93, C: 0.045, L0: 0.915, lo: 0.84, hi: 0.95, trend: 1.0, src: 'butter yellow 2025-27 (Pantone, WGSN)' },
  { id: 'sauge', name: 'Sauge', h: 130, C: 0.032, L0: 0.80, lo: 0.70, hi: 0.90, trend: 1.0, src: 'Dulux 2027 Soulful Sage, Pinterest 2026 Jade' },
  { id: 'brume', name: 'Bleu brume', h: 239, C: 0.020, L0: 0.86, lo: 0.84, hi: 0.93, trend: 0.85, src: 'Pinterest 2026 Cool Blue, Pantone Dutch Canal (grise)' },
  { id: 'lilas', name: 'Lilas', h: 315, C: 0.035, L0: 0.82, lo: 0.72, hi: 0.90, trend: 0.85, src: 'Pantone SS27 Lavender Oil, WGSN Peaceful Lilac' },
  { id: 'argile', name: 'Argile', h: 38, C: 0.040, L0: 0.78, lo: 0.70, hi: 0.90, trend: 0.9, src: 'Pantone AW26 Muted Clay, WGSN SS27 Clay' },
  { id: 'moka', name: 'Moka', h: 50, C: 0.045, L0: 0.56, lo: 0.45, hi: 0.64, trend: 0.9, src: 'Pantone Mocha Mousse / Toffee' },
  { id: 'olive', name: 'Olive', h: 115, C: 0.035, L0: 0.48, lo: 0.40, hi: 0.56, trend: 0.75, src: 'Pantone AW26 Burnt Olive, WGSN Deep Green' },
  { id: 'sarcelle', name: 'Sarcelle', h: 196, C: 0.045, L0: 0.42, lo: 0.34, hi: 0.50, trend: 0.7, src: 'WGSN 2026 Transformative Teal' },
  { id: 'encre', name: 'Bleu encre', h: 272, C: 0.045, L0: 0.42, lo: 0.34, hi: 0.50, trend: 0.8, src: 'Pantone SS27 Blue Indigo' },
  { id: 'bordeaux', name: 'Bordeaux', h: 12, C: 0.050, L0: 0.37, lo: 0.32, hi: 0.44, trend: 0.9, src: 'AW26 burgundy / cherry cola' },
  { id: 'anthracite', name: 'Anthracite', h: 85, C: 0.006, L0: 0.34, lo: 0.28, hi: 0.42, trend: 1.0, src: 'neutre sombre (rechauffe)' },
];
for (const f of PALETTE) f.hex = hex(rgbOf(f.L0, f.C, f.h));

// --- palette du vetement -----------------------------------------------------------------------------------------------------
// px : RGBA ou RGB (ch = 4 ou 3), alpha : [0,1] par pixel. Pixels opaques (>= 0,9) sous-echantillonnes a ~40k : seuls les pixels
// (x, y) multiples de sampleStep(w, h) sont lus.
export const sampleStep = (w, h) => Math.max(1, Math.round(Math.sqrt((w * h) / 80000)));
export function extract(px, alpha, w, h, ch = 4) {
  const s = sampleStep(w, h), k = Math.max(1, (Math.hypot(w, h) / 2000));
  const r1 = Math.round(3 * k), r2 = Math.round(12 * k), dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [0.7, 0.7], [-0.7, 0.7], [0.7, -0.7], [-0.7, -0.7]];
  const op = (x, y) => x < 0 || y < 0 || x >= w || y >= h || alpha[y * w + x] >= 0.5;   // hors image : pas du fond
  let P = [], E = [], sumL = 0;
  const sp = [], esp = [];
  for (let y = 0; y < h; y += s) for (let x = 0; x < w; x += s) {
    const i = y * w + x; if (alpha[i] < 0.9) continue;
    const c = oklab(px[ch * i], px[ch * i + 1], px[ch * i + 2]); sumL += c[0];
    const s0 = c[0] > 0.98 && Math.hypot(c[1], c[2]) < 0.01;                          // reflet speculaire
    P.push(c); sp.push(s0);
    const near = dirs.some(([dx, dy]) => !op(Math.round(x + dx * r2), Math.round(y + dy * r2)));
    if (near && dirs.every(([dx, dy]) => op(Math.round(x + dx * r1), Math.round(y + dy * r1)))) { E.push(c); esp.push(s0); }
  }
  if (!P.length) return null;
  if (2 * sp.filter(Boolean).length < P.length) { P = P.filter((_, n) => !sp[n]); E = E.filter((_, n) => !esp[n]); }   // reflets ignores, sauf vetement blanc pur
  // k-means k = 8, initialisation k-means++ a graine fixe (deterministe ; attrape les petites rayures saturees)
  const K = 8, d2 = (c, q) => (c[0] - q[0]) ** 2 + (c[1] - q[1]) ** 2 + (c[2] - q[2]) ** 2;
  let seed = 7; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const sub = P.filter((_, n) => n % Math.max(1, Math.floor(P.length / 4000)) === 0);
  let cen = [sub[Math.floor(sub.length / 2)].slice()];
  while (cen.length < K) {
    const D = sub.map((c) => Math.min(...cen.map((q) => d2(c, q)))), tot = D.reduce((u, v) => u + v, 0);
    if (!tot) break; let r = rnd() * tot, n = 0; while ((r -= D[n]) > 0 && n < sub.length - 1) n++; cen.push(sub[n].slice());
  }
  let asg = new Int32Array(P.length);
  for (let it = 0; it < 10; it++) {
    const acc = cen.map(() => [0, 0, 0, 0]);
    P.forEach((c, n) => { let bj = 0, bd = 9; cen.forEach((q, j) => { const d = d2(c, q); if (d < bd) { bd = d; bj = j; } }); asg[n] = bj; const a = acc[bj]; a[0] += c[0]; a[1] += c[1]; a[2] += c[2]; a[3]++; });
    cen = cen.map((q, j) => (acc[j][3] ? acc[j].slice(0, 3).map((v) => v / acc[j][3]) : q));
  }
  let cl = cen.map((q, j) => ({ lab: q, n: P.reduce((t, _, n) => t + (asg[n] === j), 0) })).filter((c) => c.n);
  // fusion des ombrages d'une meme teinture
  const same = (a, b) => { const A = lchOf(a.lab), B = lchOf(b.lab), d = Math.hypot(a.lab[0] - b.lab[0], a.lab[1] - b.lab[1], a.lab[2] - b.lab[2]);
    if (d < 0.05) return true; if (Math.abs(A.L - B.L) > 0.25) return false;
    if (A.C < 0.03 && B.C < 0.03) return Math.abs(A.L - B.L) < 0.2;
    return Math.min(A.C, B.C) >= 0.02 && dh(A.h, B.h) < 15 && Math.abs(A.C - B.C) < 0.03; };
  for (let again = true; again;) {
    again = false;
    for (let i = 0; i < cl.length && !again; i++) for (let j = i + 1; j < cl.length && !again; j++) if (same(cl[i], cl[j])) {
      const a = cl[i], b = cl[j], n = a.n + b.n; a.lab = a.lab.map((v, t) => (v * a.n + b.lab[t] * b.n) / n); a.n = n; cl.splice(j, 1); again = true;
    }
  }
  const clusters = cl.map((c) => ({ ...lchOf(c.lab), w: c.n / P.length })).sort((a, b) => b.w - a.w);
  for (const c of clusters) c.hex = hex(rgbOf(c.L, c.C, c.h));
  const major = clusters.filter((c) => c.w >= 0.15);
  const eL = E.length ? E.map((c) => c[0]).sort((a, b) => a - b)[E.length >> 1] : clusters[0].L;
  const eAB = E.length ? [1, 2].map((t) => E.reduce((u, c) => u + c[t], 0) / E.length) : labOf(clusters[0]).slice(1);
  return {
    clusters, edge: lchOf([eL, ...eAB]), meanL: sumL / P.length,
    multi: major.some((a, i) => major.some((b, j) => j > i && dE(a, b) >= 0.15)),
    achro: Math.max(...major.map((c) => c.C)) < 0.03,
  };
}

// --- choix des fonds ---------------------------------------------------------------------------------------------------------
// relation de teinte vetement -> fond. 'triade' (55-125 deg) n'est pas une faute a chroma faible (sauge / taupe, sauge / terracotta).
export const REL_FR = { neutre: 'neutre', teinte: 'teinte douce', ton: 'ton sur ton', analogue: 'analogue', complementaire: 'complémentaire', 'compl-divise': 'complémentaire doux', triade: 'contraste de teinte', echo: 'reprend le motif' };
const HARM = { echo: 0.9, ton: 1.0, analogue: 0.85, complementaire: 0.8, 'compl-divise': 0.7, teinte: 0.7, neutre: 0.6, triade: 0.45 };
// groupe de relation (diversite) ; sur un vetement neutre toutes les teintes sont « teinte douce » : on separe chaudes / froides
const GRP = (x) => (['ton', 'analogue', 'echo'].includes(x.rel) ? 'palette' : x.rel.startsWith('compl') ? 'compl' : x.rel === 'teinte' ? (x.h < 115 ? 'chaud' : 'froid') : x.rel);
const DARK = 0.66;   // fond sombre ou brun moyen (Moka, Olive) : un seul par planche, toujours en dernier
function rel(g, b) {
  if (b.C < 0.02) return 'neutre'; if (g.C < 0.03) return 'teinte';
  const d = dh(g.h, b.h); return d <= 25 ? 'ton' : d <= 55 ? 'analogue' : d >= 150 ? 'complementaire' : d >= 125 ? 'compl-divise' : 'triade';
}
const circMean = (cs) => { const x = cs.reduce((t, c) => t + c.w * Math.cos((c.h * Math.PI) / 180), 0), y = cs.reduce((t, c) => t + c.w * Math.sin((c.h * Math.PI) / 180), 0); return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360; };
// relax : 2e passe de suggest quand aucun fond clair ne passe (ecru + bleu roi : la nuance claire d'un complementaire vif
// tomberait dans l'ecru) : le complementaire reste une nuance (C <= 0,02) mais peut descendre sous L 0,86, et une famille trop
// desaturee par le plafond reste permise ; les ecarts au vetement (sep, floor) ne changent pas.
// Vetement AFFICHE (shown, eclaire par la lumiere studio) : les fonds sont decides sur g = le vetement sans lumiere studio (le meme
// en Aucune / Douce / Forte, donc le meme Auto), puis reverifies sur shown avec les ecarts au contour, aux couleurs majeures et au
// fond sombre de candidates(), a HYST pres (hysteresis : un fond decide garde 85 % de l'ecart exige, sinon une autre clarte de sa
// famille, sinon le fond suivant). Couleurs secondaires (< 15 %) jugees sur g seulement : la lumiere en cree de fausses (cretes
// eclairees des cotes d'un pull taupe = meme teinture, plus claire).
// 0,85 : ecart minimal mesure au contour affiche 0,064 (0,75 : 0,054) ; decide sur le vetement eclaire : 0,058 avec la lumiere de
// 196a189, 0,100 avec celle de 0f1bf13 (balayages r7).
// Clarte decidee sans lumiere qui ne tient plus devant le vetement affiche (greige L 0,76 porte a 0,84 : Sable s'arrete a 0,92) :
// la famille reprend la clarte du vetement affiche (plancher au contour, regime clair et cible du contour affiche : un cran plus
// sombre, Greige), au lieu de disparaitre (planche de 2-3 fonds, Auto Bleu brume ou Nuage) ; couleurs et preferences restent de g.
const HYST = 0.85;
const floorOf = (v) => (v.clusters[0].L > 0.84 && Math.max(...v.clusters.filter((c) => c.w >= 0.15).map((c) => c.C)) < 0.04 ? 0.06 : 0.10);   // vetement clair : l'ombre complete
// fond de clarte moyenne (0,70-0,84) : seulement derriere un vetement clair, un cran plus sombre (sinon mur boueux)
// anchor : blanc / creme (des 0,80, comme light : pas de falaise a 0,84) / noir : robustes a l'induction (plafond de chroma 0,035)
const frameOf = (v) => { const e = v.edge, d = v.clusters[0], light = e.L >= 0.80; return { e, major: v.clusters.filter((c) => c.w >= 0.15), floor: floorOf(v), light, target: light ? Math.max(0.72, e.L - 0.11) : 0.93, anchor: d.L > 0.80 || d.L < 0.3 }; };
function clear(s, b) {
  const major = s.clusters.filter((c) => c.w >= 0.15), floor = floorOf(s);
  return Math.abs(b.L - s.edge.L) >= HYST * floor && !(b.L < 0.5 && s.edge.L < b.L + HYST * 0.3)
    && !major.some((c) => (b.L < DARK && c.L < b.L + HYST * 0.3) || dE(b, c) < HYST * (floor < 0.1 ? 0.08 : 0.10));
}
export function candidates(g, relax = false, shown = g) {
  const major = g.clusters.filter((c) => c.w >= 0.15), dom = g.clusters[0], frames = shown === g ? [frameOf(g)] : [frameOf(g), frameOf(shown)];
  const Cg = Math.max(...major.map((c) => c.C));
  // creme / ivoire / ecru : un fond bleu a violet (complement du jaune, h 180-330) le fait paraitre jauni par contraste
  // simultane ; le blanc pur (C < 0,01) garde les bleus (ils le font paraitre plus blanc)
  const cream = dom.L > 0.78 && dom.h >= 60 && dom.h <= 110 && dom.C >= 0.01 && dom.C <= 0.05;
  // couleurs a ecarter du fond. Un blanc mineur (< 15 %, L > 0,8, C < 0,015) sur un vetement colore est presque toujours le sol vu
  // entre manche et corps (defaut de detourage) ou une etiquette : il bloquerait toute la bande claire, on l'ignore.
  // Cadre du vetement affiche : ses couleurs majeures, les secondaires de g (la lumiere en cree de fausses).
  const sep = g.clusters.filter((k) => !(k.w < 0.15 && k.L > 0.8 && k.C < 0.015 && dom.C >= 0.06)), minor = sep.filter((k) => k.w < 0.15);
  const fams = [...PALETTE];
  if (!g.multi && dom.C >= 0.05) {   // ton sur ton (vetement sourd : il ne serait qu'un Nuage bis) ; deux majeures a < 60 deg (rose + orange) : teinte moyenne ponderee = un pont
    const chrom = major.filter((c) => c.C >= 0.03), th = chrom.length > 1 && chrom.every((c) => dh(c.h, dom.h) <= 60) ? circMean(chrom) : dom.h;
    fams.push({ id: 'ton', name: 'Ton sur ton', h: th, C: Math.min(0.4 * dom.C, 0.032), L0: 0.88, lo: 0.62, hi: 0.95, trend: 0.85 });
  }
  // fond de la famille f le plus proche de la clarte t (null : aucun), dans le cadre de clarte F ; chk : ecarts au vetement affiche
  const place = (f, F, t, chk = true) => {
    // noir / marine : le fond est la seule couleur de l'image, il peut porter un vrai beurre ou sauge (0,05) ; blanc / creme : 0,035
    const cap = g.achro && dom.L < 0.3 ? 0.05 : F.anchor && Cg < 0.06 ? 0.035 : g.achro ? 0.022 : Math.max(0.025, Math.min(0.06, 0.7 * Cg));
    let C = Math.min(f.C, cap);
    const refs = g.multi ? major : [dom], rels = refs.map((k) => rel(k, { C, h: f.h }));
    // teinte sourde (taupe, kaki, jean delave) : teinte opposee a l'etat de nuance seulement, sinon elle la decale
    refs.forEach((k, i) => { if (k.C >= 0.03 && k.C < 0.06) C = Math.min(C, rels[i].startsWith('compl') ? 0.015 : rels[i] === 'triade' ? 0.02 : C); });
    // complementaire derriere un vetement vif : il exalte sa saturation (couleur non conforme) -> nuance claire seulement
    const loud = refs.some((k, i) => k.C >= 0.1 && rels[i].startsWith('compl'));
    if (loud) C = Math.min(C, 0.02);
    const keep = relax ? 0 : 0.6 * f.C;                                           // 2e passe : la separation prime sur l'identite
    if (C < keep || (g.multi && rels.includes('ton'))) return null;               // trop desature : perd son identite
    // vetement neutre a motif colore : un fond sourd qui reprend la teinte d'un accent (rayure, imprime >= 3 %) = « meme palette »
    const acc = g.achro && C >= 0.02 && g.clusters.find((k) => k.w >= 0.03 && k.C >= 0.06 && dh(k.h, f.h) <= 35);
    if (acc) rels[0] = 'echo';
    const hs = rels.map((r) => (r === 'triade' && Cg < 0.06 ? 0.65 : HARM[r])), harm = g.multi ? 0.65 * hs[0] + 0.35 * Math.min(...hs.slice(1)) : hs[0];
    // saturation percue ~ C / L : le plafond de chroma baisse avec la clarte pour les fonds moyens (pas pour les sombres)
    const cAt = (L) => (L >= 0.6 ? Math.min(C, cap * Math.min(1, L / 0.93)) : C), e = F.e, ks = F === frames[0] ? sep : [...F.major, ...minor], Ls = [];
    for (let L = f.lo; L <= f.hi + 1e-9; L += 0.01) if (Math.abs(L - e.L) >= F.floor && (L < 0.5 || F.light || L >= 0.84) && !(loud && !relax && L < 0.86)) Ls.push(+L.toFixed(2));
    Ls.sort((a, b) => Math.abs(a - t) - Math.abs(b - t));
    const L = Ls.find((L) => cAt(L) >= keep && Math.max(...rgbOf(L, cAt(L), f.h)) <= 248
      && !ks.some((k) => dE({ L, C: cAt(L), h: f.h }, k) < (k.w >= 0.15 ? (F.floor < 0.1 ? 0.08 : 0.10) : k.w >= 0.05 ? 0.06 : 0))
      && (!chk || shown === g || clear(shown, { L, C: cAt(L), h: f.h })));
    if (L == null || (L < 0.5 && e.L < L + 0.3) || (L < DARK && F.major.some((k) => k.L < L + 0.3))) return null;   // fond sombre : vetement clair seulement (toutes ses couleurs majeures, pas que le contour)
    const Cl = cAt(L), dL = Math.abs(L - e.L);
    const score = 0.35 * harm + 0.25 * (1 - Math.min(1, Math.abs(L - F.target) / 0.25)) + 0.15 * f.trend + 0.15 * (1 - Cl / 0.08) + 0.1 * Math.min(1, (dL - F.floor) / 0.12);
    const rgb = rgbOf(L, Cl, f.h), eRgb = rgbOf(e.L, e.C, e.h);
    return { id: f.id, accent: acc ? acc.hex : null, name: f.id === 'sable' && L < 0.8 ? 'Greige' : f.name, rgb, hex: hex(rgb), L, C: Cl, h: f.h, rel: rels[0], rels, score, dL, ratio: wcag(rgb, eRgb),
      triadeStrong: refs.some((k, i) => rels[i] === 'triade' && k.C >= 0.06) };
  };
  const out = [];
  for (const f of fams) {
    if (cream && f.h >= 180 && f.h <= 330 && f.C > 0.012) continue;
    // deux clartes par famille : la cible et la clarte de reference de la famille (variete des propositions) ; decidees sur g ;
    // aucune ne tient devant le vetement affiche : clarte prise dans le cadre du vetement affiche, rang (score) decide sur g
    for (const ref of [false, true]) {
      const [G, S] = frames, t = (F) => (ref ? f.L0 : F.target);
      let x = place(f, G, t(G)), d;
      if (!x && S && (d = place(f, G, t(G), false)) && (x = place(f, S, t(S)))) x.score = d.score;
      if (x && !out.some((o) => o.id === x.id && o.L === x.L)) out.push(x);
    }
  }
  return out.sort((a, b) => b.score - a.score);
}
// Dernier recours (aucun fond clair ne passe, meme a la 2e passe : ecru + bleu roi a 30 / 70, ecru borde de bleu) : le papier
// clair (L >= 0,6), sourd (C <= 0,02), le plus eloigne de TOUTES les couleurs majeures ; jamais un Nuage fondu dans l'ecru.
function farthest(g) {
  const major = g.clusters.filter((c) => c.w >= 0.15), e = g.edge; let best = null;
  for (const f of PALETTE) for (let L = Math.max(0.6, f.lo); L <= f.hi + 1e-9; L += 0.01) {
    const C = Math.min(f.C, 0.02), rgb = rgbOf(L, C, f.h);
    if (Math.max(...rgb) > 248) continue;
    const d = Math.min(...major.map((k) => dE({ L, C, h: f.h }, k)));
    if (!best || d > best.d) best = { d, f, L: +L.toFixed(2), C, rgb };
  }
  if (!best) return null;
  const { f, L, C, rgb } = best, eRgb = rgbOf(e.L, e.C, e.h), r = rel(g.clusters[0], { C, h: f.h });
  return { id: f.id, accent: null, name: f.id === 'sable' && L < 0.8 ? 'Greige' : f.name, rgb, hex: hex(rgb), L, C, h: f.h, rel: r, rels: [r], score: 0, dL: Math.abs(L - e.L), ratio: wcag(rgb, eRgb), triadeStrong: false };
}
export function suggest(g, n = 4, shown = g) {
  let out = candidates(g, false, shown); const light = g.edge.L >= 0.80;
  if (!out.some((x) => x.L >= 0.6)) out = candidates(g, true, shown);
  if (!out.some((x) => x.L >= 0.6) && shown !== g) return suggest(shown, n);   // aucun fond decide ne tient devant le vetement affiche : decision sur celui-ci
  // 4 vrais choix : familles differentes (Sable / Greige = une seule), au plus 2 par groupe de relation, un seul fond sombre,
  // dE >= 0,05 dans un meme groupe et >= 0,03 sinon (deux teintes claires a C 0,03 ne sont qu'a ~0,02-0,05 l'une de l'autre) ;
  // vetement sourd (plafond 0,025) : en dernier recours 0,02 (Nuage contre Sable clair)
  const pick = [], ok = (x, cap2 = true) => pick.length < n && !pick.some((p) => p.id === x.id || dE(p, x) < (!cap2 ? 0.02 : GRP(p) === GRP(x) ? 0.05 : 0.03))
    && (!cap2 || pick.filter((p) => GRP(p) === GRP(x)).length < 2) && !(x.L < DARK && pick.some((p) => p.L < DARK));
  const add = (xs, role, cap2) => { for (const x of xs) if (x && ok(x, cap2)) return pick.push({ ...x, role }); };
  const lit = out.filter((x) => x.L >= 0.6);
  let auto = lit[0];
  if (!auto) auto = farthest(g);   // sugg[0] = Auto partout : jamais un fond sombre par defaut, jamais un papier fondu dans le vetement
  if (!auto) return [];
  if (auto.C < 0.015) { const t = lit.find((x) => x.C >= 0.015); if (t && auto.score - t.score <= 0.08) auto = t; }   // pas de blanc « sans ame » par defaut
  add([auto], 'Auto');
  add(out.filter((x) => GRP(x) === 'palette'), 'Même palette');
  add(out.filter((x) => GRP(x) === 'compl'), 'Contraste doux');
  if (!light) add(out.filter((x) => x.id === 'nuage'), 'Neutre fidèle');
  add(out.filter((x) => x.L < DARK), 'Sombre');
  // options ; si un groupe sature (creme : tout le chaud est analogue), on leve la limite de 2 plutot que de rendre 3 fonds
  for (const cap2 of [true, false]) while (pick.length < n && out.some((x) => !x.triadeStrong && ok(x, cap2))) add(out.filter((x) => !x.triadeStrong), 'Option', cap2);
  pick.sort((a, b) => (a.L < DARK) - (b.L < DARK));                               // le fond sombre en dernier
  for (const p of pick) if (p.L < DARK) p.role = 'Sombre';
  for (const p of pick) p.why = `${REL_FR[p.rel]}${p.accent ? ' ' + p.accent : ''}${g.multi ? ' (motif : ' + p.rels.map((r) => REL_FR[r]).join(' / ') + ')' : ''}, ΔL ${p.dL.toFixed(2)}, contraste ${p.ratio.toFixed(1)}:1`;
  return pick;
}

// --- lumiere adaptee au fond -------------------------------------------------------------------------------------------------
// Papier reel : la meme lumiere donne la meme chute en EV quelle que soit la couleur du papier. Lumiere du HAUT-GAUCHE (critique
// des fonds) : dir = [dx, dy, EV] a les MEMES signes que le decalage des ombres (soft / amb dx, dy > 0 : l'ombre tombe en bas a
// droite), le cote clair est oppose ; flaque centree en poolAt (fraction du cadre, cote lumiere, hors du vetement), rayons poolR ;
// vignette douce -0,16 EV ; ombres ao (contact serre) + soft (directionnelle) + amb (large et faible) [opacite, sigma px, dx, dy] ;
// max = plafond sRGB par canal du papier (avant le grain). Chute centre-coin (flaque + vignette + demi-degrade) <= 0,60 EV
// (papier clair), 0,75 EV (fond sombre). La couleur choisie est celle vue au CENTRE du cadre : base = rgb assombri de la flaque.
const POOL_AT = [0.32, 0.18], POOL_R = [0.75, 0.65], AT_C = Math.exp(-1.6 * (((0.5 - POOL_AT[0]) / POOL_R[0]) ** 2 + ((0.5 - POOL_AT[1]) / POOL_R[1]) ** 2));
export function lighting(rgb) {
  const L = oklab(...rgb)[0], dark = Math.max(0, Math.min(1, (0.75 - L) / 0.4)), vig = 0.16, dir = 0.14;
  const k = Math.min(1.5, Math.max(1, (0.93 / L) ** 0.5)), budget = 0.60 + 0.15 * dark;
  const pool = Math.max(0.04, Math.min(0.18 * k, budget - vig - dir / 2, Math.log2(LIN[252] / Math.max(...rgb.map((v) => LIN[v]))) / (1 - AT_C)));
  const base = rgb.map((v) => enc(LIN[v] * 2 ** (-AT_C * pool)));
  return {
    base, pool, poolAt: POOL_AT, poolR: POOL_R, vig: -vig, dir: [0.6, 0.8, dir], falloff: pool + vig + dir / 2,
    grain: 1.2 + 0.3 * dark, max: 248,
    ao: [0.42 + 0.1 * dark, 4], soft: [0.24 + 0.1 * dark, 20, 7, 12], amb: [0.10 + 0.04 * dark, 80, 2, 8],
  };
}
