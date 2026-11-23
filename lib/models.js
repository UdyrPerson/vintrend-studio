// Chargement des modèles de détourage (onnxruntime-web 1.23.0, wasm mono-thread) et segmentation.
// models.json (à la racine du site) décrit chaque modèle ; les fichiers sont dans models/.
import * as ort from '../ort.wasm.min.mjs';

ort.env.wasm.numThreads = 1;                          // pas de coi-serviceworker : jamais de multithread
ort.env.wasm.wasmPaths = new URL('../', import.meta.url).href; // ort-wasm-simd-threaded.{mjs,wasm} servis par le site

let config;
const sessions = new Map();                           // une seule session par modèle et par chargement de page

export async function getConfig() {
  config ??= await (await fetch(new URL('../models.json', import.meta.url))).json();
  return config;
}

// Télécharge les morceaux dans l'ordre vers un seul Uint8Array pré-alloué (sizes : octets de chaque morceau,
// connus par models.json ; à défaut Content-Length, à défaut croissance par concaténation).
// onProgress(octets reçus, total).
async function fetchBytes(urls, sizes, onProgress) {
  const resps = await Promise.all(urls.map((u) => fetch(u)));
  resps.forEach((r, i) => { if (!r.ok) throw new Error(`${urls[i]} : HTTP ${r.status}`); });
  const lens = sizes?.length === urls.length ? sizes : resps.map((r) => Number(r.headers.get('content-length') || 0));
  const total = lens.reduce((a, b) => a + b, 0);
  let buf = new Uint8Array(total || 1 << 20);
  let got = 0;
  for (const r of resps) {
    const rd = r.body.getReader();
    for (;;) {
      const { done, value } = await rd.read();
      if (done) break;
      if (got + value.length > buf.length) { const nb = new Uint8Array(Math.max(buf.length * 2, got + value.length)); nb.set(buf.subarray(0, got)); buf = nb; }
      buf.set(value, got);
      got += value.length;
      onProgress?.(got, total || got);
    }
  }
  return buf.subarray(0, got);
}

export function loadModel(name, onProgress) {
  if (!sessions.has(name)) {
    const p = (async () => {
      const m = (await getConfig()).models[name];
      if (!m) throw new Error(`modèle inconnu : ${name}`);
      if (m.wasm_ok === false) throw new Error('non supporté (WASM)'); // ne rien télécharger
      const bytes = await fetchBytes(m.files.map((f) => new URL(`../models/${f}`, import.meta.url).href), m.sizes, onProgress);
      return ort.InferenceSession.create(bytes, { executionProviders: ['wasm'], graphOptimizationLevel: m.ort_opt ?? 'all' });
    })();
    p.catch(() => sessions.delete(name));             // un échec ne reste pas en cache
    sessions.set(name, p);
  }
  return sessions.get(name);
}

// Dessine img (ImageBitmap, canvas ou image) à w x h et renvoie ses pixels RGBA.
function pixels(img, w, h) {
  const c = new OffscreenCanvas(w, h);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingQuality = 'high';
  g.drawImage(img, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h).data;
  c.width = c.height = 0; // libère le tampon du canvas (iOS compte ces tampons dans la mémoire)
  return d;
}

// timing (optionnel) reçoit {pre, infer, post} en ms. Mask : { width, height, data: Float32Array valeurs 0..1 } à la taille de img.
export async function segment(session, name, img, timing = {}) {
  const t0 = performance.now();
  const m = (await getConfig()).models[name];
  const S = m.input_size, N = S * S;
  const W = img.width, H = img.height;
  const rgba = pixels(img, S, S);
  let max = 1e-6;
  if (m.divide_by_max) for (let i = 0; i < rgba.length; i++) if (i % 4 < 3 && rgba[i] / 255 > max) max = rgba[i] / 255;
  const x = new Float32Array(3 * N);
  for (let i = 0; i < N; i++)
    for (let c = 0; c < 3; c++) x[c * N + i] = (rgba[i * 4 + c] / 255 / (m.divide_by_max ? max : 1) - m.mean[c]) / m.std[c];
  const t1 = performance.now();
  const out = await session.run({ [m.input_name]: new ort.Tensor('float32', x, [1, 3, S, S]) });
  const t2 = performance.now();
  const p = out[m.output_name].data;
  let lo = 0, span = 1;
  if (m.output === 'minmax') {
    let mn = Infinity, mx = -Infinity;
    for (let i = 0; i < N; i++) { if (p[i] < mn) mn = p[i]; if (p[i] > mx) mx = p[i]; }
    lo = mn; span = Math.max(mx - mn, 1e-6);
  }
  // Masque en gris (S x S), puis mise à l'échelle bilinéaire vers la taille de img.
  const small = new OffscreenCanvas(S, S);
  const id = new ImageData(S, S);
  for (let i = 0; i < N; i++) {
    const v = m.output === 'sigmoid' ? 1 / (1 + Math.exp(-p[i])) : (p[i] - lo) / span;
    id.data[i * 4] = id.data[i * 4 + 1] = id.data[i * 4 + 2] = Math.round(Math.min(1, Math.max(0, v)) * 255);
    id.data[i * 4 + 3] = 255;
  }
  small.getContext('2d').putImageData(id, 0, 0);
  const full = pixels(small, W, H);
  small.width = small.height = 0;
  const data = new Float32Array(W * H);
  for (let i = 0; i < data.length; i++) data[i] = full[i * 4] / 255;
  Object.assign(timing, { pre: t1 - t0, infer: t2 - t1, post: performance.now() - t2 }); // ms
  return { width: W, height: H, data };
}
