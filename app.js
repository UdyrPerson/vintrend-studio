// Ecran d'edition (POC) : import, detourage une photo a la fois, rendu par mode, reglages de serie, export.
// Toute la logique testable est dans lib/edit.js ; ici seulement le DOM, le decodage et l'enregistrement.
import { getConfig, loadModel, releaseModel, segment } from './lib/models.js';
import { detectFaces } from './lib/face.js';
import { createStore } from './lib/store.js';
import { measure, advise } from './lib/quality.js';
import { thumbnailSize } from './lib/resample.js';
import { renderPhoto, hideFaces, workSize, tooBig, exportName, nextBatch, nextModel, startModel, maskSane, migrateSet, autoSource, seriesAuto, staleAuto } from './lib/edit.js';
import { PALETTE } from './lib/backdrop.js';

const $ = (id) => document.getElementById(id);
const store = createStore();
const MODES = [['flat', 'À plat'], ['worn', 'Porté'], ['light', 'Lumière seule']];
const LABEL = { birefnet: 'haute précision', isnet: 'précis', u2netp: 'léger' };
const photos = [];                                   // {file, mode, rot (degres horaires 0/90/180/270, applique au decodage), status: idle|pending|busy|done|error, final (erreur definitive), stale, mask, metrics, res, jpeg, url, el, msg}
const SET0 = { bg: 'auto', shadow: 'normal', ev: null, hideFace: false, light: 'soft' };   // bg : 'auto' ou '#RRGGBB' (edit.studioOpts) ; light : edit.LIGHTS
let set = { ...SET0 };
let modelName, files = [], pumping = false, shareIdx = 0;

const kv = (name) => (k, v) => { try { const st = globalThis[name]; return v === undefined ? st.getItem(k) : v === null ? st.removeItem(k) : st.setItem(k, v); } catch { return null; } };
const ss = kv('sessionStorage'), ls = kv('localStorage');   // ls : vsNoBiref = date du dernier echec de BiRefNet sur cet appareil (voir getMask)
const say = (t) => { $('status').textContent = t; $('spinner').hidden = !/en cours|Téléchargement|Préparation/.test(t); };
// Avis durables (repli de modele, plantage, detourage indisponible) : zone a part, jamais ecrasee par la ligne de progression.
const notes = [];
const note = (t) => { if (!notes.includes(t)) notes.push(t); $('model-note').textContent = notes.join(' '); };
const h = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids.filter((k) => k != null)); return e; };
const fr = (n) => String(n).replace('.', ',');

// --- decodage -------------------------------------------------------------------------------------------------------------
// Dessine bmp (ou la zone r, dans le repere APRES rotation) en w x h, tourne de rot degres horaires : transformation du canevas,
// aucune copie pleine resolution. Matrices [a b c d e f] des quarts de tour d'un bitmap W x H.
const TURNS = (W, H) => [[1, 0, 0, 1, 0, 0], [0, 1, -1, 0, H, 0], [-1, 0, 0, -1, W, H], [0, -1, 1, 0, 0, W]];
const sizeOf = (bmp, rot) => (rot % 180 ? [bmp.height, bmp.width] : [bmp.width, bmp.height]);
const canvasOf = (bmp, w, h, r, rot = 0) => {
  const c = Object.assign(document.createElement('canvas'), { width: w, height: h }), g = c.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingQuality = 'high';
  if (rot) {
    const [bw, bh] = sizeOf(bmp, rot), q = r ?? { sx: 0, sy: 0, sw: bw, sh: bh };
    g.scale(w / q.sw, h / q.sh); g.translate(-q.sx, -q.sy); g.transform(...TURNS(bmp.width, bmp.height)[rot / 90]); g.drawImage(bmp, 0, 0);
  } else if (r) g.drawImage(bmp, r.sx, r.sy, r.sw, r.sh, 0, 0, w, h); else g.drawImage(bmp, 0, 0, w, h);
  return c;
};
const pixels = (c) => ({ width: c.width, height: c.height, data: c.getContext('2d').getImageData(0, 0, c.width, c.height).data });
const free = (c) => { c.width = c.height = 0; };   // iOS compte les tampons des canvas dans la memoire

// --- detourage : BiRefNet (WebGPU), repli isnet puis u2netp (wasm), voir edit.startModel ------------------------------------
const showModel = () => { $('model').textContent = `Détourage : ${LABEL[modelName] ?? modelName}`; };
// Drapeau « detourage en cours » (vsSeg = nom du modele) : pose des que les octets du modele sont tous recus (la creation de la
// session, pic memoire sur iPhone, et segment() sont donc couverts) mais pas pendant le telechargement : quitter la page alors ne
// ressemble pas a un plantage ; s'il est encore la au chargement, l'onglet a plante (memoire) -> modele suivant pour la session.
let segOn = false;   // un detourage (creation de session comprise) est en cours
// Onglet cache (changement d'appli) : iOS peut le tuer en arriere-plan sans que ce soit la faute du modele -> drapeau efface,
// remis au retour si le detourage continue. Un plantage au premier plan reste detecte.
document.addEventListener('visibilitychange', () => ss('vsSeg', !document.hidden && segOn ? modelName : null));
async function getMask(canvas) {
  for (;;) {
    try {
      const prep = modelName === 'birefnet' ? 'Préparation du modèle (première fois, jusqu’à 1 min)…' : 'Préparation du modèle…';
      const session = await loadModel(modelName, (got, total) => { if (got < total) return say(`Téléchargement du modèle… ${Math.round((100 * got) / total)} %`); segOn = true; ss('vsSeg', modelName); say(prep); });
      $('banner').hidden = true;   // modèle reçu par l'appli : la bannière n'a plus lieu d'être
      say(modelName === 'birefnet' ? 'Détourage en cours…' : 'Détourage en cours (~25 s)…');
      segOn = true; ss('vsSeg', modelName);   // session deja chargee : aucun rappel de progression
      const m = await segment(session, modelName, canvas);   // ponytail: sur le fil principal (spinner CSS) ; Web Worker si cela gene sur les telephones
      if (modelName !== 'birefnet' || maskSane(m)) return m;
      throw Object.assign(new Error('masque incohérent'), { insane: true });   // garde de coherence (NaN, masque vide ou plein)
    } catch (e) {
      // Echec apres reception du modele (session, detourage, garde ; vsSeg encore pose) : repli pour la session et, pour BiRefNet, sur
      // cet appareil pendant 7 jours (localStorage, sinon chaque lancement replanterait) ; un simple echec de telechargement ne fige rien.
      // La session abandonnee est liberee avant le repli (memoire GPU et tas wasm partage, iPhone 4 Go).
      const next = nextModel(modelName), sticky = e.insane || ss('vsSeg') === modelName;
      releaseModel(modelName).catch(() => {});
      if (sticky && modelName === 'birefnet') ls('vsNoBiref', String(Date.now()));
      if (!next) { note(`Détourage indisponible (${e.message || e}) : Lumière seule.`); return null; }
      if (sticky) ss('vsModel', next);
      note(e.insane ? 'Détourage haute précision incohérent sur cet appareil : détourage précis utilisé pendant 7 jours.' : `Détourage ${LABEL[modelName]} indisponible : détourage ${LABEL[next]} utilisé.`);
      modelName = next; showModel();
    } finally { segOn = false; ss('vsSeg', null); }
  }
}
// Masque en memoire : 1 octet par pixel (3 Mo a 2048 px) au lieu de 4 ; la quantification est la meme a chaque rendu.
const pack = (m) => ({ width: m.width, height: m.height, data: Uint8Array.from(m.data, (v) => Math.round(v * 255)) });
const unpack = (m) => ({ width: m.width, height: m.height, data: Float32Array.from(m.data, (v) => v / 255) });

// --- traitement d'une photo (une a la fois) -----------------------------------------------------------------------------------
async function process(p) {
  p.status = 'busy'; p.stale = false; p.final = false; p.msg = ''; paint(p);
  let bmp, wc;
  try {
    try { bmp = await createImageBitmap(p.file, { imageOrientation: 'from-image' }); }
    catch { throw Object.assign(new Error('Photo illisible (format non pris en charge, HEIC ?) : ignorée.'), { final: true }); }
    const rot = p.rot;   // rotation de ce traitement (lue apres le decodage : mesures et masque de la meme) ; Pivoter ensuite la rend perimee (redo -> p.stale)
    if (tooBig(bmp.width, bmp.height)) throw Object.assign(new Error(`Photo trop grande (${Math.round((bmp.width * bmp.height) / 1e6)} Mpx, maximum 40) : ignorée.`), { final: true });
    const [bw, bh] = sizeOf(bmp, rot), [ww, wh] = workSize(bw, bh);   // tout le reste (travail, mesures, masque, recadrages) vit dans le repere tourne
    wc = canvasOf(bmp, ww, wh, null, rot);
    const work = pixels(wc);
    if (!p.metrics) { const t = canvasOf(bmp, ...thumbnailSize(ww, wh, 160), null, rot); p.metrics = measure(pixels(t), { mode: 'flat' }); free(t); }
    if (p.mask === undefined) {   // bitmap pleine résolution libéré pendant le détourage (pic mémoire d'isnet sur iPhone), puis relu
      bmp.close(); bmp = null; p.mask = null;
      const m = await getMask(wc); if (m && p.rot === rot) p.mask = pack(m);   // Pivoter pendant le detourage : masque d'une autre rotation jete
      if (p.stale) { p.status = 'pending'; return paint(p); }   // reglage change pendant le detourage : pas de rendu perime, la photo repart
      bmp = await createImageBitmap(p.file, { imageOrientation: 'from-image' });
    }
    free(wc); wc = null;
    const src = { work, mask: p.mask && unpack(p.mask), origW: bw, origH: bh, cropFn: (r, w, hh) => { const c = canvasOf(bmp, w, hh, r, rot), im = pixels(c); free(c); return im; } };
    say(`Rendu en cours… (${photos.indexOf(p) + 1}/${photos.length})`);
    let res = renderPhoto(src, p.mode, { ...set, auto: seriesAuto(photos, p) });
    if (set.hideFace && p.mode === 'worn' && res.ok) { say('Détection du visage en cours (15 Mo à la première utilisation)…'); res = await hideFaces(res, detectFaces); }
    p.res = res; p.jpeg = null;
    if (!res.ok && p.url) { URL.revokeObjectURL(p.url); p.url = null; }
    if (res.ok) {
      const c = Object.assign(document.createElement('canvas'), { width: res.out.width, height: res.out.height });
      c.getContext('2d').putImageData(new ImageData(res.out.data, res.out.width, res.out.height), 0, 0);
      p.jpeg = await new Promise((ok) => c.toBlob(ok, 'image/jpeg', 0.92));
      free(c);
      if (!p.jpeg) throw new Error('encodage JPEG impossible');
      if (p.url) URL.revokeObjectURL(p.url);
      p.url = URL.createObjectURL(p.jpeg);
    }
    p.res.out = null;   // les pixels ne restent pas en memoire : l'apercu et l'export viennent du JPEG
    p.status = p.stale ? 'pending' : 'done';
  } catch (e) {
    p.status = 'error'; p.final = !!e.final; p.msg = e.final ? e.message : `Échec du traitement : ${e.message || e}`;
  } finally {
    bmp?.close(); if (wc) free(wc);
  }
  paint(p);
}

async function pump() {
  if (pumping) return;
  pumping = true;
  let n = 0, ok = 0;
  try { for (let p; (p = photos.find((q) => q.status === 'pending'));) { await process(p); n++; if (p.status !== 'error') ok++; syncAuto(); } }
  finally { pumping = false; if (n) say(ok ? 'Terminé.' : 'Aucune photo traitée.'); else if (!photos.length) say(''); refresh(); }
}

// Un reglage change : les photos concernees repartent des masques en cache (pas de nouveau detourage) ; une erreur passagere = nouvel essai.
const redo = (pred) => { for (const p of photos) if (pred(p)) { if (p.status === 'busy') p.stale = true; else if (p.status === 'done' || (p.status === 'error' && !p.final)) p.status = 'pending'; paint(p); } refresh(); persist(); pump(); };

// Fond Auto de la serie (edit.seriesAuto) : la source change (premiere rendue, retiree, changee de mode) -> les photos Auto rendues sont refaites.
const source = () => autoSource(photos)?.res.choices;
const syncAuto = () => { const stale = staleAuto(photos, set); if (stale && photos.some(stale)) redo(stale); };
const pickBg = (v) => { if (set.bg !== v) { set.bg = v; redo((p) => p.mode === 'flat'); } };

// Pivoter (S-R20) : un quart de tour horaire, puis nouveau detourage sur la photo tournee (BiRefNet detoure moins bien une photo
// couchee : un trou de sol entre manche et corps restait dans le masque tourne) ; les mesures sont refaites.
const turn = (p) => { p.rot = (p.rot + 90) % 360; p.mask = undefined; p.metrics = undefined; redo((q) => q === p); };

// --- persistance : originaux + modes + rotations + reglages (les masques restent en memoire) ---------------------------------------------
// ponytail: tout l'article est reecrit a chaque changement ; ecrire seulement le delta si cela pese.
const persist = () => store.saveItem({ photos: photos.filter((p) => !(p.status === 'error' && p.final)).map((p) => ({ file: p.file, mode: p.mode, rot: p.rot })), set, updatedAt: Date.now() }).catch(() => {});

// --- interface ----------------------------------------------------------------------------------------------------------------
function add(list, status = 'pending', modes = [], rots = []) {   // restauration (idle) : on ne reecrit pas l'article, sa date de peremption ne bouge pas
  for (const [i, file] of [...list].entries()) {
    const p = { file, mode: modes[i] ?? 'flat', rot: rots[i] ?? 0, status, mask: undefined };
    p.el = h('section', { className: 'card' });
    photos.push(p); $('list').append(p.el); paint(p);
  }
  refresh(); if (status !== 'idle') persist(); pump();
}

function paint(p) {
  const r = p.res, busy = p.status === 'busy';
  const img = h('img', { alt: 'Résultat', hidden: !p.url || !r?.ok });
  if (p.url) {
    img.src = p.url;
    const show = (u) => { img.src = u; };
    img.onpointerdown = () => show(URL.createObjectURL(p.file));   // maintenir : l'original
    for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) img.addEventListener(ev, () => { if (img.src !== p.url) { URL.revokeObjectURL(img.src); show(p.url); } });
    img.oncontextmenu = (e) => e.preventDefault();
  }
  const advice = p.metrics ? advise(p.metrics, p.mode === 'worn' ? 'upright' : 'flat') : [];
  const state = { idle: 'En attente : touchez « Traiter les photos ».', pending: 'En file d’attente…', busy: 'Traitement en cours…' }[p.status];
  const modes = h('div', { className: 'seg', role: 'group', ariaLabel: 'Mode' }, ...MODES.map(([m, l]) => h('button', { type: 'button', textContent: l, ariaPressed: String(p.mode === m), disabled: p.status === 'error' && p.final, onclick: () => { if (p.mode !== m || p.status === 'error') { p.mode = m; redo((q) => q === p); } } })));
  p.el.replaceChildren(...[
    h('p', { className: 'name', textContent: p.file.name || 'Photo' }),
    img, r?.ok ? h('p', { className: 'hint', textContent: 'Maintenez l’image pour voir l’original.' }) : null,
    modes,
    h('button', { type: 'button', textContent: 'Pivoter', className: 'ghost', disabled: p.status === 'error' && p.final, onclick: () => turn(p) }),
    state && h('p', { textContent: state }),
    r && h('p', { textContent: r.summary }),
    r?.reason && h('p', { className: 'bad', textContent: r.reason }),
    r?.note && h('p', { className: 'note', textContent: r.note }),
    p.msg && h('p', { className: 'bad', textContent: p.msg }),
    ...advice.map((a) => h('p', { className: 'note', textContent: a.text })),
    h('button', { type: 'button', textContent: 'Retirer', className: 'ghost', disabled: busy, onclick: () => { if (p.url) URL.revokeObjectURL(p.url); photos.splice(photos.indexOf(p), 1); p.el.remove(); refresh(); persist(); syncAuto(); } }),
  ].filter(Boolean));
}

// Fichiers prets AVANT d'activer les boutons : un JPEG par photo exportable, nommes dans l'ordre.
function refresh() {
  const settled = photos.every((p) => p.status === 'done' || p.status === 'error');
  files = photos.filter((p) => p.status === 'done' && p.res?.ok && p.jpeg).map((p, i) => new File([p.jpeg], exportName(i + 1), { type: 'image/jpeg' }));
  shareIdx = 0;
  $('save').disabled = $('share').disabled = !settled || !files.length;
  $('resume').hidden = !photos.some((p) => p.status === 'idle');
  $('actions').hidden = !photos.length;
  const blocked = photos.filter((p) => p.status === 'done' && p.res && !p.res.ok).length;
  $('blocked').textContent = blocked ? `${blocked} photo(s) non exportable(s) : contrôle de fidélité ou des couleurs échoué.` : '';
  paintBg();
}

// Nuancier du fond (tout l'article) : Auto, les suggestions pour le vetement de la serie (nom + relation), puis toute la palette
// (avec le « Ton sur ton » genere) ; une couleur choisie absente de ces listes (autre vetement) reste affichee.
function paintBg() {
  const c = source(), sugg = c?.sugg ?? [], all = [...(c?.ton ? [c.ton] : []), ...PALETTE], open = $('bg').querySelector('details')?.open;
  const sw = (hex, name, label, val = hex) => h('button', { type: 'button', className: 'sw', ariaPressed: String(set.bg === val), onclick: () => pickBg(val) },
    h('span', { className: 'chip', style: `background:${hex}` }), h('span', { textContent: name }), label ? h('small', { textContent: label }) : null);
  const known = set.bg === 'auto' || [...sugg, ...all].some((x) => x.hex === set.bg);
  $('bg').replaceChildren(
    sw(sugg[0]?.hex ?? PALETTE[0].hex, 'Auto', sugg[0]?.name ?? 'selon le vêtement', 'auto'),
    ...sugg.map((x) => sw(x.hex, x.name, x.label)),
    ...(known ? [] : [sw(set.bg, 'Votre choix')]),
    h('details', { open }, h('summary', { textContent: 'Toute la palette' }), h('div', { className: 'swatches' }, ...all.map((x) => sw(x.hex, x.name, x.label)))),
  );
}

const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const shared = async (data) => { try { await navigator.share(data); return true; } catch (e) { if (e.name !== 'AbortError') say(`Partage impossible : ${e.message || e}`); return false; } };
async function save() {
  if (isIOS && navigator.canShare?.({ files })) return void (await shared({ files }));   // iOS : feuille de partage (« Enregistrer N images »)
  for (const f of files) {
    const a = h('a', { href: URL.createObjectURL(f), download: f.name });
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    await new Promise((ok) => setTimeout(ok, 300));
  }
}
async function share() {
  // Au plus SHARE_MAX fichiers par partage (Chromium refuse au-dela, alors que canShare repond oui) ; la suite au prochain appui.
  const [i, all] = nextBatch(files, shareIdx);
  let batch = all;
  if (!navigator.canShare?.({ files: batch })) batch = batch.slice(0, 1);   // sinon une photo par appui : un geste par partage
  if (!navigator.canShare?.({ files: batch })) return say('Partage indisponible sur cet appareil : utilisez Enregistrer.');
  if (await shared({ files: batch })) { shareIdx = i + batch.length; say(shareIdx < files.length ? `${shareIdx}/${files.length} photos partagées : touchez Partager pour la suite.` : 'Toutes les photos sont partagées.'); }
}

function bind() {
  $('pick-btn').onclick = () => $('pick').click();
  $('pick').onchange = (e) => { add(e.target.files); e.target.value = ''; };
  $('resume').onclick = () => { for (const p of photos) if (p.status === 'idle') p.status = 'pending'; photos.forEach(paint); refresh(); pump(); };
  $('shadow').onchange = (e) => { set.shadow = e.target.value; redo((p) => p.mode === 'flat'); };
  $('light').onchange = (e) => { set.light = e.target.value; redo((p) => p.mode !== 'light'); };   // masques en cache : pas de nouveau detourage
  $('ev').oninput = (e) => { $('ev-out').textContent = `${e.target.value > 0 ? '+' : ''}${fr(e.target.value)} EV`; };
  $('ev').onchange = (e) => { set.ev = parseFloat(e.target.value); redo(() => true); };
  $('ev-auto').onclick = () => { set.ev = null; $('ev').value = 0; $('ev-out').textContent = 'Auto'; redo(() => true); };
  $('face').onchange = (e) => { set.hideFace = e.target.checked; redo((p) => p.mode === 'worn'); };
  $('save').onclick = save;
  $('share').onclick = share;
  $('new').onclick = async () => {
    if (photos.some((p) => p.status === 'busy')) return say('Attendez la fin du traitement en cours.');
    if (photos.length && !confirm('Effacer cet article et ses photos de l’appli ? (les originaux restent dans votre galerie)')) return;
    for (const p of photos) if (p.url) URL.revokeObjectURL(p.url);
    photos.length = 0; $('list').replaceChildren(); set = { ...SET0 }; syncSet();
    await store.clearItem().catch(() => {});
    say(''); refresh();
  };
}
function syncSet() {
  $('shadow').value = set.shadow; $('light').value = set.light; $('face').checked = set.hideFace;
  $('ev').value = set.ev ?? 0; $('ev-out').textContent = set.ev == null ? 'Auto' : `${set.ev > 0 ? '+' : ''}${fr(set.ev)} EV`;
}

// --- demarrage ----------------------------------------------------------------------------------------------------------------
// Modele de la session (exporte : la banniere d'index.html ne telecharge que celui-ci). BiRefNet seulement avec un adaptateur WebGPU.
// Rechargement ou navigation pendant un detourage (impatience au 1er usage, aller-retour vers la capture) : ce n'est pas un
// plantage. pagehide se declenche au dechargement normal, jamais quand l'onglet est tue pour manque de memoire (HTML, « unload »).
addEventListener('pagehide', () => ss('vsSeg', null));
const hasGpu = async () => { try { return !!(await navigator.gpu?.requestAdapter()); } catch { return false; } };
export const chosen = (async () => {
  const crashed = ss('vsSeg');
  if (crashed) ss('vsSeg', null);
  if (crashed === 'birefnet') ls('vsNoBiref', String(Date.now()));
  modelName = startModel({ def: (await getConfig()).default, saved: ss('vsModel'), crashed, gpu: await hasGpu(), noBiref: ls('vsNoBiref') });
  if (crashed) { ss('vsModel', modelName); note(`La page s’est fermée pendant le détourage : détourage ${LABEL[modelName]} utilisé ${crashed === 'birefnet' ? 'sur cet appareil pendant 7 jours' : 'pour cette session'}.`); }
  showModel();
  return modelName;
})();
(async () => {
  bind();
  await chosen;
  await store.purgeStale(Date.now(), 7).catch(() => {});
  const item = await store.loadItem().catch(() => null);
  if (item) { set = migrateSet({ ...set, ...item.set }); syncSet(); add(item.photos.map((x) => x.file), 'idle', item.photos.map((x) => x.mode), item.photos.map((x) => x.rot)); }
  const fresh = await store.takeShared().catch(() => []);
  if (fresh.length) { add(fresh); history.replaceState(null, '', './'); }
})().catch((e) => say(`Erreur au démarrage : ${e.message || e}`));
