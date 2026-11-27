// Ecran d'edition (logique pure, sans DOM) : reglages de serie -> options de composeStudio, recadrage en pleine resolution,
// rendu d'une photo selon son mode avec repli vers Lumiere seule, controles de fidelite, masquage du visage.
// Image : {width, height, data: Uint8ClampedArray} RGBA. Masque : {width, height, data: Float32Array} dans [0, 1].
import { neutralCorrection, composeStudio, fidelityCheck, lightOnly, maskUsable, straightenAngle, sourceRect } from './retouch.js';
import { wornStudio, wornFidelity, maskFace } from './worn.js';

export const WORK = 2048, MAX_PIXELS = 40e6, EV_MAX = 0.7;
// Fonds : niveau de la couleur, degrade bgTop = niveau + 4, bgBottom = niveau - 6 (comme les valeurs par defaut, 244 -> 248 / 238).
export const BGS = { blanc: [244, 244, 242], gris: [222, 222, 220], beige: [240, 236, 228] };
export const SHADOWS = { none: 0, light: 0.12 };   // « normale » = valeur par defaut de composeStudio (undefined)

// set = {bg: 'auto'|'blanc'|'gris'|'beige', shadow: 'none'|'light'|'normal', ev: nombre | null (auto)}
export function studioOpts(set) {
  const bg = BGS[set.bg];
  return { bg, bgTop: bg && bg[0] + 4, bgBottom: bg && bg[0] - 6, shadow: SHADOWS[set.shadow] };
}

export const tooBig = (w, h) => w * h > MAX_PIXELS;
export function workSize(w, h, max = WORK) { const k = Math.min(1, max / Math.max(w, h)); return [Math.round(w * k), Math.round(h * k)]; }
export const cropSize = (r, max = WORK) => workSize(r.sw, r.sh, max);   // jamais d'agrandissement
export const exportName = (n) => `vintrend-${n}.jpg`;
// Partage : au plus `max` fichiers par appel (Chromium refuse plus de 10, NotAllowedError, alors que canShare repond oui).
// Retourne [indice de depart, lot] ; apres le dernier lot on repart du debut.
export const SHARE_MAX = 10;
export const nextBatch = (files, idx, max = SHARE_MAX) => { const i = idx < files.length ? idx : 0; return [i, files.slice(i, i + max)]; };

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

// Resume des corrections appliquees, ex. « Fond remplacé · balance des blancs corrigée · exposition +0,3 EV ».
export function summary(mode, corr) {
  const parts = [{ flat: 'Fond remplacé', worn: 'Décor atténué', light: 'Lumière seule' }[mode]], e = Math.round(corr.ev * 10) / 10;
  if (corr.gains.some((g) => Math.abs(g - 1) > 0.01)) parts.push('balance des blancs corrigée');
  if (e) parts.push(`exposition ${e > 0 ? '+' : ''}${String(e).replace('.', ',')} EV`);
  return parts.join(' · ');
}

// Rend une photo. src = {work, mask (ou null), origW, origH, cropFn(rect, w, h) -> image recadree dans l'ORIGINAL oriente, corr?}
// (src.corr est calcule une fois sur l'image de travail et garde). mode : 'flat' | 'worn' | 'light'. set : voir studioOpts + ev.
// Retourne {out, ok, reason, note, summary, edgeMode, mode, corr, angle, maxDiff} : mode = mode reellement applique (repli vers
// 'light' avec `note` si le masque est inutilisable, si le cadrage Porte echoue ou si le bord n'est pas verifiable) ; ok = false
// bloque l'export de cette photo (controle de fidelite echoue, `reason`). deps : doublures pour les tests.
export function renderPhoto(src, mode, set, { compose = composeStudio, worn = wornStudio } = {}) {
  const { work, mask } = src;
  src.corr ??= neutralCorrection(work, mask);
  const corr = { gains: src.corr.gains, ev: Math.max(-EV_MAX, Math.min(EV_MAX, set.ev ?? src.corr.ev)) };
  const light = (note) => ({ out: lightOnly(work, corr), ok: true, note, summary: summary('light', corr), mode: 'light', corr });
  const done = (r, m, fid, extra) => ({ out: r.out, ok: fid.ok, reason: fid.ok ? undefined : 'Contrôle de fidélité échoué : export bloqué (bug)', maxDiff: fid.maxDiff, summary: summary(m, corr), mode: m, corr, ...extra });
  if (mode === 'light') return light();
  if (!mask) return light('Détourage indisponible : Lumière seule appliquée.');
  if (!maskUsable(mask)) return light('Détourage non fiable : Lumière seule appliquée.');
  if (mode === 'worn') {
    let r;
    try { r = worn(work, mask, corr); } catch { return light('Cadrage Porté impossible : Lumière seule appliquée.'); }
    return done(r, 'worn', wornFidelity(r.out, r.outMask, work, corr, r));
  }
  // À plat : recadrage en pleine resolution (marge 4 %, <= 2048), masque recadre, redressement, meme opts pour composition et controle.
  const rect = sourceRect(mask, work.width, work.height, src.origW, src.origH, 0.04), [cw, ch] = cropSize(rect);
  const crop = src.cropFn(rect, cw, ch), cm = cropMask(mask, rect, src.origW, src.origH, cw, ch);
  const opts = { ...studioOpts(set), angle: straightenAngle(cm) };
  const r = compose(crop, cm, corr, opts);
  if (!r.edge.ok) return light('Bord non vérifiable : Lumière seule appliquée.');
  return done(r, 'flat', fidelityCheck(r.out, crop, cm, corr, opts), { edgeMode: r.edgeMode, angle: opts.angle });
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
