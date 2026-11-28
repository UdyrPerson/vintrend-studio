// Banc d'essai : détoure des photos avec un seul modèle (?model=...), mesure les temps, produit un rapport JSON.
import { getConfig, loadModel, segment } from './lib/models.js';

const $ = (id) => document.getElementById(id);
const name = new URLSearchParams(location.search).get('model') || 'u2netp';
const FLAG = 'vt_bench_running';
const report = { ua: navigator.userAgent, model: name, ep: null, gpu: !!navigator.gpu, loadMs: null, downloadMs: null, sessionMs: null, photos: [] };
$('model').textContent = name;
getConfig().then((c) => {
  const m = c.models[name];
  if (!m) $('status').textContent = 'Modèle inconnu.';
  else if (m.wasm_ok === false) { $('status').textContent = 'non supporté (WASM)'; $('files').disabled = true; }
  else {
    report.ep = m.ep ?? 'wasm';
    $('model').textContent = `${name} (EP ${report.ep}${m.gate_label ? ', ' + m.gate_label : ''})`;
    if (report.ep === 'webgpu' && !navigator.gpu) $('status').textContent = 'WebGPU absent de ce navigateur : ce modèle ne pourra pas se charger.';
  }
}).catch((e) => { $('status').textContent = 'Erreur : impossible de lire models.json (' + (e && e.message || e) + ')'; $('files').disabled = true; });

try { if (sessionStorage.getItem(FLAG)) $('crash').hidden = false; } catch {}
const flag = (on) => { try { on ? sessionStorage.setItem(FLAG, '1') : sessionStorage.removeItem(FLAG); } catch {} };
const heapMB = () => (performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null);

// Original à gauche ; détourage sur gris moyen à droite (le gris est celui du canvas).
function show(bitmap, mask, line) {
  const row = document.createElement('div');
  row.className = 'row';
  const a = document.createElement('canvas'), b = document.createElement('canvas');
  const k = Math.min(1, 480 / bitmap.width);
  a.width = b.width = Math.round(bitmap.width * k);
  a.height = b.height = Math.round(bitmap.height * k);
  a.getContext('2d').drawImage(bitmap, 0, 0, a.width, a.height);
  const src = a.getContext('2d').getImageData(0, 0, a.width, a.height);
  const gx = b.getContext('2d');
  const dst = gx.createImageData(a.width, a.height);
  for (let y = 0; y < a.height; y++) for (let x = 0; x < a.width; x++) {
    const i = (y * a.width + x) * 4;
    const al = mask.data[Math.min(mask.height - 1, Math.floor(y / k)) * mask.width + Math.min(mask.width - 1, Math.floor(x / k))];
    for (let c = 0; c < 3; c++) dst.data[i + c] = src.data[i + c] * al + 128 * (1 - al);
    dst.data[i + 3] = 255;
  }
  gx.putImageData(dst, 0, 0);
  const pre = document.createElement('pre');
  pre.textContent = line;
  row.append(a, b, pre);
  $('out').prepend(row);
}

$('files').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  if (!files.length) return;
  flag(true);
  try {
    if (report.loadMs === null) {
      $('status').textContent = `Chargement du modèle ${name}...`;
      const t = performance.now();
      await loadModel(name, (got, tot) => {
        $('status').textContent = got < tot ? `Chargement ${name} : ${Math.round(got / 1048576)} / ${Math.round(tot / 1048576)} Mo` : `Création de la session (EP ${report.ep})…`;
        if (got >= tot) report.downloadMs = Math.round(performance.now() - t);
      });
      report.loadMs = Math.round(performance.now() - t);
      report.sessionMs = report.loadMs - report.downloadMs;   // création de la session (compilation WebGPU comprise)
    }
    for (const [i, f] of files.entries()) {
      $('status').textContent = `Photo ${i + 1} / ${files.length} : ${f.name}`;
      const bmp = await createImageBitmap(f);
      const [bw, bh] = [bmp.width, bmp.height];
      const timing = {};
      const t = performance.now();
      const mask = await segment(await loadModel(name), name, bmp, timing);
      const r = { file: f.name, w: bw, h: bh, preMs: Math.round(timing.pre), inferMs: Math.round(timing.infer), postMs: Math.round(timing.post), totalMs: Math.round(performance.now() - t), nan: mask.nan, heapMB: heapMB() };
      report.photos.push(r);
      show(bmp, mask, JSON.stringify(r, null, 1));
      bmp.close();
    }
    $('status').textContent = `Terminé : ${report.photos.length} photo(s).`;
  } catch (err) {
    report.error = String(err && err.message || err);
    $('status').textContent = 'Erreur : ' + report.error;
  }
  flag(false);
});

$('copy').addEventListener('click', async () => {
  const txt = JSON.stringify(report);
  try { await navigator.clipboard.writeText(txt); $('status').textContent = 'Rapport copié.'; }
  catch { prompt('Copie le rapport :', txt); }
});

// Partage : un JPEG de test, construit au chargement pour que navigator.share soit appelé directement dans le clic
// (Safari exige un geste utilisateur sans attente). L'utilisateur note si Vinted apparaît dans le menu.
let shareFile = null;
{
  const c = document.createElement('canvas');
  c.width = c.height = 600;
  const g = c.getContext('2d');
  g.fillStyle = '#808080'; g.fillRect(0, 0, 600, 600);
  g.fillStyle = '#fff'; g.font = '48px sans-serif'; g.fillText('Vintrend test', 120, 320);
  c.toBlob((blob) => { shareFile = new File([blob], 'test-vintrend.jpg', { type: 'image/jpeg' }); c.width = 0; }, 'image/jpeg', 0.9);
}
$('share').addEventListener('click', () => {
  if (!shareFile || !navigator.canShare?.({ files: [shareFile] })) { report.share = 'non pris en charge'; $('shareout').textContent = 'Partage de fichiers non pris en charge.'; return; }
  navigator.share({ files: [shareFile] })
    .then(() => { report.share = 'menu ouvert'; $('shareout').textContent = 'Menu ouvert : note si Vinted apparaît.'; })
    .catch((err) => { report.share = err.name + ' ' + err.message; $('shareout').textContent = 'Partage : ' + (err.name === 'AbortError' ? 'annulé' : err.message); });
});
