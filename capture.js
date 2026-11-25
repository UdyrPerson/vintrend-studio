// Page de prise de vue guidée : caméra arrière, niveau (gravité), conseils en direct toutes les 250 ms, déclenchement auto
// après >= 4 ticks stables, bouton manuel. Repli : <input capture>. La photo part dans putShared puis l'appli s'ouvre sur ./?shared=1.
import { measure, advise, THRESHOLDS } from './lib/quality.js';
import { createStore } from './lib/store.js';

const $ = (id) => document.getElementById(id);
const q = new URLSearchParams(location.search), debug = q.has('debug') && q.get('debug') !== '0';
const TICK = 250, STABLE = 4, SIDE = 160;
const GUIDE = {
  flat: "Lumière de fenêtre sans soleil direct, plafonnier éteint, pas de flash. Étalez un drap blanc qui dépasse du vêtement, tenez le téléphone parallèle au sol, zoom 3x si possible. Vêtement défroissé, qui remplit 70 à 85 % du cadre.",
  upright: "Lumière de fenêtre sans soleil direct, plafonnier éteint, pas de flash. Porté : faites prendre la photo par quelqu'un d'autre, téléphone à hauteur de taille, zoom 3x si possible, face à la fenêtre. Téléphone bien vertical.",
};
const TAP = ". Ou touchez l'écran sur le vêtement."; // ajouté au conseil « sombre » (le guide est masqué en direct), seulement si le navigateur sait régler l'exposition au toucher
let mode = q.get('mode') === 'worn' ? 'upright' : 'flat';
let gen = 0, stream, track, timer, started = false, done = false, g = null, lastMotion = 0, motionOn = false, stable = 0, tilts = [], blurs = [], devices = [], devIdx = -1;

const store = createStore();
const say = (t) => { $('msg').textContent = t; };
const cv = Object.assign(document.createElement('canvas'), { width: SIDE * 3 / 4, height: SIDE });
const cx = cv.getContext('2d', { willReadFrequently: true });
cx.imageSmoothingQuality = 'high'; // réduction par moyenne de zone : le défaut 'low' laisse passer le bruit du capteur, qui masque le flou

// Rectangle source 3:4 centré dans l'image (même recadrage que object-fit: cover).
const crop = (w, h) => (w / h > 0.75 ? { sw: h * 0.75, sh: h, sx: (w - h * 0.75) / 2, sy: 0 } : { sw: w, sh: w / 0.75, sx: 0, sy: (h - w / 0.75) / 2 });

// Fenetre de stabilite du declenchement auto : a vider des que la camera s'arrete ou change, sinon elle repart pleine et re-declenche aussitot.
const resetWindow = () => { stable = 0; tilts = []; blurs = []; };
function setMode(m) {
  mode = m; resetWindow();
  for (const b of document.querySelectorAll('#modes button')) b.setAttribute('aria-pressed', String(b.dataset.mode === m));
  $('guide').textContent = GUIDE[m];
}
// Toucher pour exposer : pointsOfInterest n'apparaît dans getSettings() qu'après un premier réglage, d'où ce test sur les contraintes gérées.
const canTap = () => !!(navigator.mediaDevices?.getSupportedConstraints?.().pointsOfInterest && track?.getCapabilities?.().exposureMode);

// Capteur : la gravité (accelerationIncludingGravity) ne dépend pas des conventions d'angle iOS / Android.
// Sans capteur ou permission refusée : niveau masqué, déclenchement auto sans condition d'inclinaison.
async function startMotion() {
  try {
    if (typeof DeviceMotionEvent?.requestPermission === 'function' && (await DeviceMotionEvent.requestPermission()) !== 'granted') return; // iOS : doit rester dans le geste
    motionOn = true;
    addEventListener('devicemotion', (e) => { g = e.accelerationIncludingGravity; lastMotion = performance.now(); });
  } catch { motionOn = false; }
}

// gen : numéro de la dernière ouverture de caméra ; stop() l'incrémente, ce qui périme toute ouverture encore en attente.
function stop() {
  gen++; clearInterval(timer); timer = null; resetWindow();
  stream?.getTracks().forEach((t) => t.stop());
  stream = track = null; $('video').srcObject = null;
}

function fallback(why) {
  stop(); $('live').hidden = true; $('start').hidden = true; $('fallback').hidden = false;
  say(why + " Utilisez l'appareil photo du téléphone ci-dessous.");
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) return fallback('Caméra indisponible dans ce navigateur.');
  stop(); const my = gen; // une seule ouverture à la fois : la précédente (en cours ou ouverte) est coupée
  const video = devIdx >= 0 ? { deviceId: { exact: devices[devIdx].deviceId } } : { facingMode: { ideal: 'environment' } };
  let s;
  try {
    s = await navigator.mediaDevices.getUserMedia({ audio: false, video: { ...video, zoom: true, width: { ideal: 3024 }, height: { ideal: 4032 }, aspectRatio: { ideal: 0.75 } } });
  } catch (e) {
    if (my !== gen) return;
    return fallback(e.name === 'NotAllowedError' ? 'Accès à la caméra refusé (réglages du navigateur).' : 'Caméra indisponible.');
  }
  if (my !== gen || done || document.hidden) return s.getTracks().forEach((t) => t.stop()); // page quittée ou ouverture remplacée pendant l'attente
  stream = s; track = s.getVideoTracks()[0];
  const v = $('video'); v.srcObject = stream; await v.play().catch(() => {});
  if (my !== gen) return; // stop() a déjà coupé le flux
  $('live').hidden = false; $('start').hidden = true; say('');
  if (!devices.length) { // libellés disponibles seulement après l'autorisation
    const all = (await navigator.mediaDevices.enumerateDevices().catch(() => [])).filter((d) => d.kind === 'videoinput');
    const back = all.filter((d) => /back|rear|arri|environment/i.test(d.label));
    devices = back.length ? back : all;
    if (my !== gen) return;
    devIdx = Math.max(0, devices.findIndex((d) => d.deviceId === track.getSettings().deviceId));
  }
  $('switch').hidden = devices.length < 2;
  setupZoom();
  clearInterval(timer); timer = setInterval(tick, TICK);
}

function setupZoom() {
  const z = track.getCapabilities?.().zoom, box = $('zoom');
  box.replaceChildren(); box.hidden = !z;
  if (!z) return;
  for (const f of [1, 2, 3].filter((f) => f >= z.min && f <= z.max)) {
    const b = Object.assign(document.createElement('button'), { type: 'button', textContent: f + 'x' });
    b.onclick = async () => {
      blurs = [];
      try { await track.applyConstraints({ advanced: [{ zoom: f }] }); } catch {}
      for (const o of box.children) o.setAttribute('aria-pressed', String(o === b));
    };
    box.append(b);
  }
}

// Toucher l'écran : point d'exposition (si le navigateur l'accepte), utile pour un vêtement sombre.
$('video').onclick = async (e) => {
  const v = $('video'), r = v.getBoundingClientRect();
  if (!canTap() || !v.videoWidth) return;
  const { sx, sy, sw, sh } = crop(v.videoWidth, v.videoHeight);
  const x = (sx + ((e.clientX - r.left) / r.width) * sw) / v.videoWidth, y = (sy + ((e.clientY - r.top) / r.height) * sh) / v.videoHeight;
  try { await track.applyConstraints({ advanced: [{ pointsOfInterest: [{ x, y }], exposureMode: 'continuous' }] }); } catch {}
};

function tick() {
  const v = $('video');
  if (done || v.readyState < 2 || !v.videoWidth) return;
  const { sx, sy, sw, sh } = crop(v.videoWidth, v.videoHeight);
  cx.drawImage(v, sx, sy, sw, sh, 0, 0, cv.width, cv.height);
  const sensor = motionOn && performance.now() - lastMotion < 1000;
  const m = measure(cx.getImageData(0, 0, cv.width, cv.height), { mode, g: sensor ? g : null });
  blurs = [...blurs, m.blur].slice(-8); m.blurMax = Math.max(...blurs); // flou relatif : le score dépend du contraste de la scène
  const tips = advise(m, mode);
  $('advice').replaceChildren(...tips.map((t) => Object.assign(document.createElement('li'), { textContent: t.text + (t.code === 'sombre' && canTap() ? TAP : ''), className: t.blocking ? '' : 'soft' })));
  const lv = $('level'); lv.hidden = m.tilt == null;
  if (m.tilt != null) { lv.textContent = `Niveau ${m.tilt.toFixed(1).replace('.', ',')}°`; lv.className = m.tilt <= THRESHOLDS.tilt ? 'ok' : ''; }
  // Stabilité : aucun conseil bloquant et inclinaison qui ne bouge pas (sans capteur : pas de condition d'inclinaison).
  tilts = m.tilt == null ? [] : [...tilts, m.tilt].slice(-STABLE);
  const steady = m.tilt == null || Math.max(...tilts) - Math.min(...tilts) < THRESHOLDS.tiltSpread; // fenetre de STABLE ticks : le 4e tick stable suffit
  stable = tips.some((t) => t.blocking) || !steady ? 0 : stable + 1;
  $('state').textContent = stable ? `Ne bougez plus… ${stable}/${STABLE}` : '';
  if (debug) { $('debug').hidden = false; $('debug').textContent = JSON.stringify({ ...m, capteur: sensor, stable, tilts }, (k, x) => (typeof x === 'number' ? Math.round(x * 1000) / 1000 : x), 1); }
  if (stable >= STABLE) shoot();
}

async function send(blob) {
  done = true; stop();
  try {
    await store.putShared([new File([blob], `photo-${Date.now()}.jpg`, { type: blob.type || 'image/jpeg' })]);
  } catch { // IndexedDB indisponible (navigation privée iOS, quota) : on reste sur la page, caméra relancée
    done = false;
    if (!$('live').hidden) await startCamera(); // startCamera efface le message : on le pose après
    return say('Enregistrement impossible, réessayez.');
  }
  location.href = './?shared=1';
}

async function shoot() {
  if (done) return;
  done = true; clearInterval(timer);
  let blob;
  try { blob = await new ImageCapture(track).takePhoto(); } catch {} // pleine résolution quand le navigateur sait
  if (!blob) { // repli : la plus haute résolution du flux, recadrée en 3:4
    const v = $('video'), { sx, sy, sw, sh } = crop(v.videoWidth, v.videoHeight), c = Object.assign(document.createElement('canvas'), { width: sw, height: sh });
    c.getContext('2d').drawImage(v, sx, sy, sw, sh, 0, 0, sw, sh);
    blob = await new Promise((ok) => c.toBlob(ok, 'image/jpeg', 0.95));
  }
  if (!blob) { // camera coupee pendant la prise (bascule, page cachee) : on la rouvre, sinon on relance les ticks
    done = false; resetWindow();
    if (track?.readyState === 'live') timer = setInterval(tick, TICK); else await startCamera(); // startCamera efface le message : on le pose après
    return say('Capture impossible, réessayez.');
  }
  await send(blob);
}

$('start').onclick = async () => { $('start').disabled = true; started = true; await startMotion(); await startCamera(); };
$('shutter').onclick = shoot;
$('switch').onclick = async (e) => {
  const b = e.currentTarget; b.disabled = true; devIdx = (devIdx + 1) % devices.length;
  try { await startCamera(); } finally { b.disabled = false; }
};
$('file').onchange = (e) => { if (e.target.files[0]) send(e.target.files[0]); };
for (const b of document.querySelectorAll('#modes button')) b.onclick = () => setMode(b.dataset.mode);
// Caméra coupée quand la page est cachée ou quittée (le voyant reste sinon allumé), relancée au retour.
document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); else if (started && !done) startCamera(); });
addEventListener('pagehide', stop);
addEventListener('pageshow', (e) => { if (e.persisted) location.reload(); }); // retour depuis le cache avant/arrière : état figé (done, caméra coupée)
setMode(mode);
if (!navigator.mediaDevices?.getUserMedia) fallback('Caméra indisponible dans ce navigateur.');
