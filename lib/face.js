// Detection de visages (navigateur seulement) : MediaPipe Tasks Vision, Face Detector, modele blaze_face_short_range.
// Tout est servi par le site sous face/<version>/ (vision_bundle.mjs, wasm/vision_wasm_internal.*, blaze_face_short_range.tflite) :
// aucune requete externe. Ces fichiers (15 Mo) ne sont PAS dans le precache d'installation (sw.js) : a la premiere utilisation ils sont
// copies dans le cache « vs-face » (qui survit aux versions du site ; sw.js le laisse en place). Les chemins portent la version du
// paquet : une mise a jour ne sert jamais un fichier perime, et les versions anterieures sont purgees. Un seul detecteur par page.
const CACHE = 'vs-face', FILES = ['vision_bundle.mjs', 'wasm/vision_wasm_internal.js', 'wasm/vision_wasm_internal.wasm', 'blaze_face_short_range.tflite'];
let detector;

async function load() {
  const { face } = await (await fetch(new URL('../models.json', import.meta.url))).json(), base = new URL(`../face/${face.version}/`, import.meta.url).href;
  if (typeof caches !== 'undefined') {
    try {   // stockage plein (iPhone) ou cache indisponible : on charge depuis le reseau sans bloquer la detection
      const c = await caches.open(CACHE), keep = FILES.map((f) => base + f);
      for (const k of await c.keys()) if (!keep.includes(k.url)) await c.delete(k);
      for (const u of keep) if (!(await c.match(u))) { const r = await fetch(u); if (!r.ok) throw new Error(`${u} : HTTP ${r.status}`); await c.put(u, r); }
    } catch (e) { console.warn('face : cache vs-face indisponible, chargement direct', e); }
  }
  const { FaceDetector, FilesetResolver } = await import(base + 'vision_bundle.mjs');
  const fileset = await FilesetResolver.forVisionTasks(base + 'wasm');   // wasmLoaderPath / wasmBinaryPath relatifs au site
  return FaceDetector.createFromOptions(fileset, { baseOptions: { modelAssetPath: base + 'blaze_face_short_range.tflite', delegate: 'CPU' }, runningMode: 'IMAGE', minDetectionConfidence: 0.5 });
}

// img : {width, height, data: Uint8ClampedArray} RGBA. Retourne [{x, y, w, h, score}] en pixels de img, du plus sur au moins sur.
export async function detectFaces(img) {
  detector ??= load().catch((e) => { detector = undefined; throw e; });   // un echec de chargement n'est pas memorise
  const r = (await detector).detect(new ImageData(img.data, img.width, img.height));
  return r.detections.map((d) => ({ x: d.boundingBox.originX, y: d.boundingBox.originY, w: d.boundingBox.width, h: d.boundingBox.height, score: d.categories[0]?.score ?? 0 })).sort((a, b) => b.score - a.score);
}
