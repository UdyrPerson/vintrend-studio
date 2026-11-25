// Mesures de qualite de prise de vue (P3) sur une image reduite (~160 px) : flou, exposition, contre-jour, dominante chaude,
// inclinaison, et conseils en francais. Fonctions pures, sans DOM. Image : {width, height, data: Uint8ClampedArray} RGBA.
import { lab } from './photo_q.js';

// Valeurs de depart, a calibrer sur le S23 et l'iPhone 12 mini (capture.html?debug=1 affiche les mesures brutes).
export const THRESHOLDS = {
  blur: 1,            // variance du laplacien (luminance 0-255) : plancher absolu (image vide ; un tee blanc net sur drap blanc fait ~7), le reste est relatif...
  blurRel: 0.6,       // ... flou si le score tombe sous 0,6 x le meilleur score recent (m.blurMax) : le score depend de la scene
  blurN: 0.8,         // ... et flou d'une seule image : energie du laplacien / du gradient sur les pixels de bord forts, par axe, le pire axe (voir sharpness ; net 1,6-4, bouge de 2 px a 120 px de large 0,3-0,65, trames fines comprises)
  dark: 0.25,         // part de pixels de luminance < 20 ...
  lit: 0.05,          // ... mais pas sombre si au moins 5 % des pixels sont clairs (luminance >= 150) : vetement noir sur drap blanc bien eclaire
  bright: 0.08,       // part de pixels ecretes (luminance >= 250 ou deux canaux >= 254) ; un drap bien expose reste a 240-250
  backlight: 1.6,     // luminance moyenne du bord / du centre, en mode porte seulement...
  backlightClip: 0.1, // ... et seulement si plus de 10 % du bord est ecrete (fenetre / ciel derriere), pas pour un vetement sombre
  warmB: 12,          // b* moyen des pixels du bord les plus clairs (drap, mur : a moins de 6 L* du 90e centile, non ecretes, chroma < 40) : au-dessus, lumiere jaune
  tilt: 6,            // degres d'ecart a la position voulue (a plat : parallele au sol ; porte : vertical)
  tiltSpread: 1.5,    // degres : amplitude max de l'inclinaison sur la fenetre de stabilite du declenchement auto
};

const lum = (d, i) => 0.299 * d[4 * i] + 0.587 * d[4 * i + 1] + 0.114 * d[4 * i + 2];
const RING = 0.15, CORE = [0.3, 0.7]; // anneau : 15 % du bord de chaque cote ; centre : carre central 30-70 %
const inRing = (x, y, w, h) => x < w * RING || x >= w * (1 - RING) || y < h * RING || y >= h * (1 - RING);
const inCore = (x, y, w, h) => x >= w * CORE[0] && x < w * CORE[1] && y >= h * CORE[0] && y < h * CORE[1];

// Pixel ecrete : luminance >= 250, ou au moins deux canaux >= 254. Un seul canal a 255 est une couleur saturee (rouge, jaune), pas un ciel brule.
const clipped = (d, i) => lum(d, i) >= 250 || (d[4 * i] >= 254) + (d[4 * i + 1] >= 254) + (d[4 * i + 2] >= 254) >= 2;

// Variance du laplacien (4 voisins) de la luminance, et nettete locale : energie du laplacien / energie du gradient, par axe, sur les
// seuls pixels de bord forts : |gradient| > EDGE niveaux / px ET au moins REL x le 98e centile des gradients de bord (carre). Un degrade de
// lumiere, un pli doux ou une grande zone unie n'y comptent pas ; et une trame fine (vichy, cotele, pied-de-poule), dont le rapport ne depend
// que de la periode et pas de l'amplitude, ne noie plus les contours du vetement. Pire des deux axes (un bouge n'abime qu'un axe), un axe a
// moins de MIN_EDGE pixels de bord est ignore ; sans bord, Infinity (pas de verdict, le plancher absolu de la variance garde l'image vide).
// ponytail : un bouge de 1 px a 120 px de large reste sous le seuil, le critere relatif (blurMax) le voit si la scene a ete nette avant ;
// un bruit i.i.d. de 2-3 niveaux a 120 px (capture.js : imageSmoothingQuality = 'high' le ramene a ~0) n'est pas rattrape par ce choix.
const EDGE = 4, MIN_EDGE = 30, REL = 0.1;
function sharpness({ width: w, height: h, data: d }) {
  const Y = new Float64Array(w * h);
  for (let i = 0; i < Y.length; i++) Y[i] = lum(d, i);
  let s = 0, s2 = 0, n = 0;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x, l = 4 * Y[i] - Y[i - 1] - Y[i + 1] - Y[i - w] - Y[i + w];
    s += l; s2 += l * l; n++;
  }
  const r = [1, w].map((p) => { // par axe : [gradient^2, laplacien^2] des pixels de bord, puis le rapport sur les plus forts
    const e = [];
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x, g = (Y[i + p] - Y[i - p]) / 2;
      if (g * g > EDGE * EDGE) { const l1 = 2 * Y[i] - Y[i - p] - Y[i + p]; e.push([g * g, l1 * l1]); }
    }
    const ref = e.map((a) => a[0]).sort((a, b) => a - b)[Math.floor(0.98 * e.length)], k = e.filter((a) => a[0] >= REL * ref);
    return k.length >= MIN_EDGE ? k.reduce((t, a) => t + a[1], 0) / k.reduce((t, a) => t + a[0], 0) : null;
  }).filter((v) => v != null);
  return { lap: n ? s2 / n - (s / n) ** 2 : 0, edge: r.length ? Math.min(...r) : Infinity };
}
export const blurScore = (img) => sharpness(img).lap;

// Part de pixels sombres (luminance < 20), clairs (luminance >= 150, le drap) et ecretes (voir clipped).
export function exposure({ width: w, height: h, data: d }) {
  let dark = 0, lit = 0, bright = 0;
  for (let i = 0; i < w * h; i++) {
    const l = lum(d, i);
    if (l < 20) dark++;
    if (l >= 150) lit++;
    if (clipped(d, i)) bright++;
  }
  return { dark: dark / (w * h), lit: lit / (w * h), bright: bright / (w * h) };
}

// Rapport luminance moyenne de l'anneau / du centre, luminance moyenne du centre, part de l'anneau ecretee.
export function backlight({ width: w, height: h, data: d }) {
  let r = 0, nr = 0, c = 0, nc = 0, clip = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (inRing(x, y, w, h)) { const i = y * w + x; r += lum(d, i); nr++; if (clipped(d, i)) clip++; }
    else if (inCore(x, y, w, h)) { c += lum(d, y * w + x); nc++; }
  }
  const ring = r / nr, centre = c / nc;
  return { ratio: ring / Math.max(centre, 1), centre, clip: clip / nr };
}

// a*, b* moyens des pixels de l'anneau qui montrent la lumiere : sous une meme lumiere, le drap (ou le mur) est ce qu'il y a de plus clair
// dans l'anneau. Reference = 90e centile de L* des pixels non ecretes de l'anneau (pas le maximum : une etiquette, un interrupteur, un point
// chaud d'ampoule ne doivent pas decider) ; on ne garde que les pixels non ecretes a moins de 6 L* de la reference (et L* > 50), peu colores
// (chroma < 40). Un vetement beige, camel, moutarde ou rouge qui touche l'anneau est plus sombre que le drap : il n'est pas pris pour la
// lumiere. null si moins de 10 % de l'anneau y ressemble.
// ponytail : un mur beige en mode porte reste lu comme une lumiere jaune (indiscernable) ; le conseil ne bloque pas.
export function warmCast(img) {
  const { width: w, height: h, data: d } = img, { L, A, B } = lab(img), ring = [];
  let nr = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (inRing(x, y, w, h)) { const i = y * w + x; nr++; if (!clipped(d, i)) ring.push(i); }
  const top = ring.map((i) => L[i]).sort((a, b) => b - a)[Math.floor(0.1 * ring.length)];
  const keep = ring.filter((i) => L[i] > Math.max(50, top - 6) && Math.hypot(A[i], B[i]) < 40);
  return keep.length >= 0.1 * nr ? { a: keep.reduce((t, i) => t + A[i], 0) / keep.length, b: keep.reduce((t, i) => t + B[i], 0) / keep.length } : null;
}

// Ecart en degres a la position voulue, depuis la gravite g = {x, y, z} (accelerationIncludingGravity).
// 'flat' : le telephone est parallele au sol (gravite sur z) ; 'upright' : vertical (gravite sur y). Les valeurs absolues
// rendent les conventions de signe iOS / Android sans effet. null si pas de capteur.
export function tilt(g, mode) {
  if (![g?.x, g?.y, g?.z].every(Number.isFinite)) return null;
  const n = Math.hypot(g.x, g.y, g.z);
  if (!n) return null;
  return Math.acos(Math.min(1, Math.abs(mode === 'flat' ? g.z : g.y) / n)) * 180 / Math.PI;
}

// Toutes les mesures d'une image (et de la gravite, si disponible) dans un objet plat.
export function measure(img, { mode, g } = {}) {
  const { dark, lit, bright } = exposure(img), { ratio, centre, clip } = backlight(img), { lap, edge } = sharpness(img);
  return { mode, blur: lap, blurN: edge, dark, lit, bright, ratio, centre, clip, warm: warmCast(img), tilt: tilt(g, mode) };
}

// Conseils [{code, text, blocking}]. Bloquants : flou, sombre, brule, incline (ils empechent le declenchement auto).
// Flou : m.blurN (nettete d'une image, sans reference) ou chute sous m.blurMax (meilleur score des derniers ticks, fourni par l'appelant).
// Sombre : pas pour un vetement noir sur drap clair (m.lit : part de pixels clairs), seulement si toute la scene manque de lumiere.
// Contre-jour : mode porte seulement, bord ecrete et plus clair que le centre ; il remplace alors 'brule' (meme blocage).
// Dominante chaude : montree sans bloquer.
export function advise(m, mode, t = THRESHOLDS) {
  const out = [], add = (code, text, blocking) => out.push({ code, text, blocking });
  if (m.blur < t.blur || m.blurN < t.blurN || m.blur < t.blurRel * (m.blurMax ?? 0)) add('flou', 'Photo floue : tenez le téléphone immobile', true);
  if (m.dark > t.dark && (m.lit ?? 0) < t.lit) add('sombre', 'Trop sombre : rapprochez-vous de la fenêtre', true);
  const bk = mode === 'upright' && m.ratio > t.backlight && m.clip > t.backlightClip, burnt = m.bright > t.bright;
  if (burnt && !bk) add('brule', 'Zones brûlées : évitez le soleil direct et le flash', true);
  if (bk) add('contre-jour', 'Contre-jour : placez-vous face à la fenêtre', burnt);
  if (m.warm && m.warm.b > t.warmB) add('chaud', 'Lumière jaune : éteignez le plafonnier', false);
  if (m.tilt != null && m.tilt > t.tilt) add('incline', mode === 'flat' ? 'Téléphone incliné : tenez-le parallèle au sol' : 'Téléphone incliné : tenez-le bien vertical', true);
  return out;
}
