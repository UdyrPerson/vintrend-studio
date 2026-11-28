// Ecran d'edition (logique pure, sans DOM) : reglages de serie -> options de composeStudio, recadrage en pleine resolution,
// rendu d'une photo selon son mode avec repli vers Lumiere seule, lumiere studio (S-R19), controles de fidelite, masquage du visage.
// Image : {width, height, data: Uint8ClampedArray} RGBA. Masque : {width, height, data: Float32Array} dans [0, 1].
import { neutralCorrection, applyGlobal, composeStudio, fidelityCheck, lightOnly, maskUsable, straightenAngle, sourceRect, subjectBox, anyCut } from './retouch.js';
import { wornStudio, wornFidelity, maskFace } from './worn.js';
import { REL_FR, hex } from './backdrop.js';
import { studioLight, colourIdentity } from './studiolight.js';

export const WORK = 2048, MAX_PIXELS = 40e6, EV_MAX = 0.7;
export const CUT_NOTE = 'Le vêtement touche le bord de la photo : reprenez-la avec un peu de marge pour un rendu studio complet.';
export const SHADOWS = { none: 0, light: 0.5, normal: 1 };   // echelle des ombres de backdrop.lighting()
export const LIGHTS = { none: 0, soft: 0.7, strong: 1 };   // Lumiere studio (S-R19) : Aucune / Douce / Forte = force de studioLight
const HEX = /^#[0-9a-f]{6}$/i;
const rgbOfHex = (s) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));

// set = {bg: 'auto' | '#RRGGBB' (fond choisi, toute la serie), auto: [r, g, b] | undefined (Auto de la serie : 1re suggestion de
// sa premiere photo À plat ; absent = celle de CETTE photo), shadow: 'none'|'light'|'normal', ev: nombre | null (auto)}
export function studioOpts(set) {
  return { bg: HEX.test(set.bg) ? rgbOfHex(set.bg) : set.auto, shadow: SHADOWS[set.shadow] };
}
// Reglages enregistres d'un article : fond inconnu (anciens blanc / gris / beige) -> Auto ; Lumiere studio absente ou inconnue -> Douce.
export const migrateSet = (s) => ({ ...s, bg: HEX.test(s.bg) ? s.bg.toUpperCase() : 'auto', light: s.light in LIGHTS ? s.light : 'soft' });
// Fond propose (backdrop.suggest) -> vue du nuancier : libelle = role, ou relation de teinte pour Auto / Option (« Ton sur ton »...).
const cap = (t) => t[0].toUpperCase() + t.slice(1);
const view = (x) => ({ hex: x.hex, rgb: x.rgb, name: x.name, label: x.role === 'Auto' || x.role === 'Option' ? cap(REL_FR[x.rel]) : x.role });

export const tooBig = (w, h) => w * h > MAX_PIXELS;
export function workSize(w, h, max = WORK) { const k = Math.min(1, max / Math.max(w, h)); return [Math.round(w * k), Math.round(h * k)]; }
export const cropSize = (r, max = WORK) => workSize(r.sw, r.sh, max);   // jamais d'agrandissement
export const exportName = (n) => `vintrend-${n}.jpg`;
// Partage : au plus `max` fichiers par appel (Chromium refuse plus de 10, NotAllowedError, alors que canShare repond oui).
// Retourne [indice de depart, lot] ; apres le dernier lot on repart du debut.
export const SHARE_MAX = 10;
export const nextBatch = (files, idx, max = SHARE_MAX) => { const i = idx < files.length ? idx : 0; return [i, files.slice(i, i + max)]; };

// Chaine de detourage (S-R20) : BiRefNet sur WebGPU, puis isnet, puis u2netp (wasm). null apres u2netp : Lumiere seule.
export const SEG_CHAIN = ['birefnet', 'isnet', 'u2netp'];
export const nextModel = (name) => SEG_CHAIN[SEG_CHAIN.indexOf(name) + 1] ?? null;
// Modele au chargement : saved = repli deja decide pour la session (sessionStorage vsModel) ; crashed = modele en cours quand
// l'onglet a plante (drapeau vsSeg ; valeur inconnue, ex. '1' d'avant S-R20 = modele leger) ; gpu = adaptateur WebGPU obtenu ;
// noBiref = date (ms) du dernier echec de BiRefNet sur cet appareil (localStorage vsNoBiref : survit aux lancements de l'appli) ;
// ecarte NO_BIREF_MS seulement (un onglet supprime en arriere-plan ou un GPU perdu une fois ne le bannit pas pour toujours).
export const NO_BIREF_MS = 7 * 864e5;
export function startModel({ def, saved, crashed, gpu, noBiref, now = Date.now() }) {
  let m = crashed ? (SEG_CHAIN.includes(crashed) ? nextModel(crashed) ?? 'u2netp' : 'u2netp') : saved ?? def;
  if (m === 'birefnet' && (!gpu || now - (+noBiref || 0) < NO_BIREF_MS)) m = 'isnet';
  return m;
}
// Fond Auto de la serie (decision du 28/11) : 1re suggestion de la premiere photo À plat deja rendue (autoSource) ; si c'est p (ou
// aucune), renderPhoto prend celle de p. staleAuto -> predicat des photos a refaire quand la source change (null : rien a faire) :
// photos 'done' seulement (une erreur garde son ancien rendu et serait relancee sans fin ; une photo en attente prendra la source).
export const autoSource = (photos) => photos.find((q) => q.mode === 'flat' && q.res?.choices);
export const seriesAuto = (photos, p) => { const s = photos.find((q) => q.mode === 'flat' && (q === p || q.res?.choices)); return s && s !== p ? s.res.choices.sugg[0]?.rgb : undefined; };
export function staleAuto(photos, set) {
  const a = autoSource(photos)?.res.choices.sugg[0]?.hex;
  return set.bg === 'auto' && a ? (q) => q.status === 'done' && q.mode === 'flat' && !!q.res?.bg && q.res.bg !== a : null;
}
// Garde de coherence du masque BiRefNet sur l'appareil : NaN (mask.nan = NaN de la sortie brute, compte par segment()) ou masque
// degenere (moins de 0,2 % ou plus de 99,8 % de pixels >= 0,5) -> inutilisable, repli isnet pour la session.
export function maskSane(mask) {
  if (mask.nan) return false;
  let fg = 0;
  for (const v of mask.data) { if (v !== v) return false; if (v >= 0.5) fg++; }
  const k = fg / mask.data.length;
  return k > 0.002 && k < 0.998;
}

// Masque de travail -> zone `rect` (pixels de l'ORIGINAL, voir sourceRect) reechantillonnee bilineairement a w x h.
export function cropMask(mask, rect, origW, origH, w, h) {
  const { width: mw, height: mh, data } = mask, kx = mw / origW, ky = mh / origH, out = new Float32Array(w * h);
  const at = (v, max) => Math.min(max, Math.max(0, v));
  for (let y = 0; y < h; y++) {
    const fy = at((rect.sy + ((y + 0.5) * rect.sh) / h) * ky - 0.5, mh - 1), y0 = Math.floor(fy), y1 = Math.min(y0 + 1, mh - 1), ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = at((rect.sx + ((x + 0.5) * rect.sw) / w) * kx - 0.5, mw - 1), x0 = Math.floor(fx), x1 = Math.min(x0 + 1, mw - 1), tx = fx - x0;
      out[y * w + x] = (data[y0 * mw + x0] * (1 - tx) + data[y0 * mw + x1] * tx) * (1 - ty) + (data[y1 * mw + x0] * (1 - tx) + data[y1 * mw + x1] * tx) * ty;
    }
  }
  return { width: w, height: h, data: out };
}

// Resume des corrections appliquees, ex. « Fond remplacé · balance des blancs corrigée · exposition +0,3 EV · lumière studio douce ».
export function summary(mode, corr, light) {
  const parts = [{ flat: 'Fond remplacé', worn: 'Décor atténué', light: 'Lumière seule' }[mode]], e = Math.round(corr.ev * 10) / 10;
  if (corr.gains.some((g) => Math.abs(g - 1) > 0.01)) parts.push('balance des blancs corrigée');
  if (e) parts.push(`exposition ${e > 0 ? '+' : ''}${String(e).replace('.', ',')} EV`);
  if (LIGHTS[light] && mode !== 'light') parts.push(`lumière studio ${light === 'strong' ? 'forte' : 'douce'}`);
  return parts.join(' · ');
}

// Rend une photo. src = {work, mask (ou null), origW, origH, cropFn(rect, w, h) -> image recadree dans l'ORIGINAL oriente, corr?}
// (src.corr est calcule une fois sur l'image de travail et garde). mode : 'flat' | 'worn' | 'light'. set : voir studioOpts + ev.
// Retourne {out, ok, reason, note, summary, edgeMode, mode, corr, angle, maxDiff, bg, choices} : bg = fond utilise (hex) et
// choices = {sugg: 4 fonds, ton: Ton sur ton | null} ({hex, rgb, name, label}) pour À plat ; mode = mode reellement applique (repli vers
// 'light' avec `note` si le masque est inutilisable, si le cadrage Porte echoue ou si le bord n'est pas verifiable) ; ok = false
// bloque l'export de cette photo (controle de fidelite ou des couleurs echoue, `reason`). deps : doublures pour les tests.
// Lumiere studio (S-R19, set.light, defaut Douce) en À plat et Porté : corrections globales -> studioLight sur le vetement (ou la
// personne) -> composition SANS correction (ID). Controles : placement exact contre le vetement eclaire (fidelite, +-2/255) ET
// colourIdentity contre le vetement corrige (chromaticite + structure de clarte : taches, blocs de couleur ; drift = sa mesure). Aucune : studioLight n'est pas appele, rendu d'avant a l'octet pres.
const ID = { gains: [1, 1, 1], ev: 0 };
export function renderPhoto(src, mode, set, { compose = composeStudio, worn = wornStudio, relight = studioLight } = {}) {
  const { work, mask } = src;
  src.corr ??= neutralCorrection(work, mask);
  const corr = { gains: src.corr.gains, ev: Math.max(-EV_MAX, Math.min(EV_MAX, set.ev ?? src.corr.ev)) }, lv = set.light in LIGHTS ? set.light : 'soft', k = LIGHTS[lv];
  const relit = (im, m, profile) => { const c = applyGlobal(im, corr); return [c, k ? relight(c, m, { profile, strength: k }).out : c]; };
  const light = (note) => ({ out: lightOnly(work, corr), ok: true, note, summary: summary('light', corr), mode: 'light', corr });
  const done = (r, m, fid, drift, extra) => {
    const reason = !fid.ok ? 'Contrôle de fidélité échoué : export bloqué (bug)' : !drift.ok ? 'Contrôle des couleurs échoué : export bloqué (choisissez Lumière studio « Aucune »).' : undefined;
    return { out: r.out, ok: !reason, reason, maxDiff: fid.maxDiff, drift, summary: summary(m, corr, lv), mode: m, corr, ...extra };
  };
  if (mode === 'light') return light();
  if (!mask) return light('Détourage indisponible : Lumière seule appliquée.');
  if (!maskUsable(mask)) return light('Détourage non fiable : Lumière seule appliquée.');
  if (mode === 'worn') {
    const [c, lit] = relit(work, mask, 'worn');
    let r;
    try { r = worn(lit, mask, ID); } catch { return light('Cadrage Porté impossible : Lumière seule appliquée.'); }
    return done(r, 'worn', wornFidelity(r.out, r.outMask, lit, ID, r), colourIdentity(c, lit, mask));
  }
  // À plat : recadrage en pleine resolution (marge 4 %, <= 2048), masque recadre, redressement, meme opts pour composition et controle.
  const rect = sourceRect(mask, work.width, work.height, src.origW, src.origH, 0.04), [cw, ch] = cropSize(rect);
  const crop = src.cropFn(rect, cw, ch), cm = cropMask(mask, rect, src.origW, src.origH, cw, ch);
  const cut = anyCut(subjectBox(cm));   // le vetement touche un bord de la photo : sortie calee sur le cadre (retouch.placeSubject), pas de redressement
  const opts = { ...studioOpts(set), angle: cut ? 0 : straightenAngle(cm) }, [c, lit] = relit(crop, cm, 'flat');
  let r;
  // fonds decides sur le vetement sans lumiere (base = c, le meme a toute force), ecarts verifies sur le vetement eclaire
  try { r = compose(lit, cm, ID, k ? { ...opts, base: c } : opts); } catch { return light('Cadrage À plat impossible : Lumière seule appliquée.'); }
  if (!r.edge.ok) return light('Bord non vérifiable : Lumière seule appliquée.');
  const choices = r.choices && { sugg: r.choices.sugg.map(view), ton: r.choices.ton && { ...view(r.choices.ton), label: 'Ton sur ton' } };
  return done(r, 'flat', fidelityCheck(r.out, lit, cm, ID, opts), colourIdentity(c, lit, cm), { edgeMode: r.edgeMode, angle: opts.angle, note: cut ? CUT_NOTE : undefined, bg: r.bg && hex(r.bg), choices });
}

// « Masquer le visage » (photo demandee en Porté, y compris si elle a replié en Lumière seule ; pas À plat ; photo exportable) : APRES le controle de fidelite, detection sur la sortie puis pixellisation de
// chaque visage sur une copie. detect(img) -> [{x, y, w, h}]. Un echec de detection n'empeche pas l'export (message, visage non masque).
export async function hideFaces(res, detect) {
  if (res.mode === 'flat' || !res.ok) return res;
  const add = (t) => [res.note, t].filter(Boolean).join(' ');   // garde la note de repli éventuelle
  try {
    const faces = await detect(res.out);
    if (!faces.length) return { ...res, note: add('Aucun visage détecté : vérifiez la photo avant de la partager.') };
    let out = res.out;
    for (const f of faces) out = maskFace(out, f, 'pixelate', null);
    return { ...res, out, note: add("Visage masqué. Vérifiez que le col n'est pas flouté.") };
  } catch (e) {
    return { ...res, note: add(`Visage non masqué (détection indisponible : ${e.message || e}).`) };
  }
}
