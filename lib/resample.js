// Rééchantillonnage et conversion en gris identiques à Pillow 12.1.1, la version du serveur de mesure (libImaging Resample.c,
// Geometry.c, Convert.c), images 8 bits.
// Image : {width, height, data: Uint8ClampedArray}, c octets par pixel avec c = data.length / (width * height)
// (RGBA, compatible ImageData : c = 4 ; gris : c = 1). Fonctions pures, sans DOM.

const PREC = 22;                                   // PRECISION_BITS = 32 - 8 - 2 (coefficients en virgule fixe)
const ONE = 1 << PREC, HALF = 1 << (PREC - 1);

const sinc = (x) => (x === 0 ? 1 : Math.sin(x * Math.PI) / (x * Math.PI));
const LANCZOS = { support: 3, f: (x) => (-3 <= x && x < 3 ? sinc(x) * sinc(x / 3) : 0) };
const BILINEAR = { support: 1, f: (x) => Math.max(0, 1 - Math.abs(x)) };

// precompute_coeffs + normalize_coeffs_8bpc : pour chaque sortie, premier indice source, nombre de taps, coefficients entiers.
function coeffs(inSize, outSize, { support, f }) {
  const scale = inSize / outSize, fs = Math.max(scale, 1), sup = support * fs, ss = 1 / fs;
  const ksize = Math.ceil(sup) * 2 + 1;
  const bounds = new Int32Array(outSize * 2), kk = new Int32Array(outSize * ksize), w = new Float64Array(ksize);
  for (let xx = 0; xx < outSize; xx++) {
    const center = (xx + 0.5) * scale;
    const xmin = Math.max(0, Math.trunc(center - sup + 0.5));
    const n = Math.min(inSize, Math.trunc(center + sup + 0.5)) - xmin;
    let ww = 0;
    for (let x = 0; x < n; x++) ww += w[x] = f((x + xmin - center + 0.5) * ss);
    for (let x = 0; x < n; x++) {
      const k = ww !== 0 ? w[x] / ww : w[x];
      kk[xx * ksize + x] = Math.trunc(k < 0 ? k * ONE - 0.5 : k * ONE + 0.5);
    }
    bounds[2 * xx] = xmin;
    bounds[2 * xx + 1] = n;
  }
  return { ksize, bounds, kk };
}

// Une passe sur un axe ; résultat entier tronqué et borné entre les passes (clip8 : le Uint8ClampedArray borne,
// `>> PREC` tronque ; la somme tient dans un int32 comme en C).
function horizontal(src, sw, sh, c, w, filter) {
  const { ksize, bounds, kk } = coeffs(sw, w, filter), out = new Uint8ClampedArray(w * sh * c);
  for (let y = 0; y < sh; y++)
    for (let xx = 0; xx < w; xx++) {
      const x0 = bounds[2 * xx], n = bounds[2 * xx + 1], k0 = xx * ksize, row = y * sw;
      for (let ch = 0; ch < c; ch++) {
        let s = HALF;
        for (let x = 0; x < n; x++) s += src[(row + x0 + x) * c + ch] * kk[k0 + x];
        out[(y * w + xx) * c + ch] = s >> PREC;
      }
    }
  return out;
}

function vertical(src, sw, sh, c, h, filter) {
  const { ksize, bounds, kk } = coeffs(sh, h, filter), out = new Uint8ClampedArray(sw * h * c), line = sw * c;
  for (let yy = 0; yy < h; yy++) {
    const y0 = bounds[2 * yy], n = bounds[2 * yy + 1], k0 = yy * ksize;
    for (let i = 0; i < line; i++) {
      let s = HALF;
      for (let y = 0; y < n; y++) s += src[(y0 + y) * line + i] * kk[k0 + y];
      out[yy * line + i] = s >> PREC;
    }
  }
  return out;
}

// ImagingResampleInner : deux passes séparables, toujours l'horizontale d'abord, comme Pillow 12.1.1 du serveur de mesure
// (annexe A : « redimensionner d'abord à l'horizontale, comme le serveur »). Pillow 13 passe parfois la verticale d'abord
// (horizontal_first) : l'ordre change les arrondis intermédiaires, d'un niveau sur ~14 % des valeurs de l'entrée u2netp.
function resample(img, w, h, filter) {
  const { width: sw, height: sh } = img, c = img.data.length / (sw * sh);
  let src = img.data;
  if (w !== sw) src = horizontal(src, sw, sh, c, w, filter);
  if (h !== sh) src = vertical(src, w, sh, c, h, filter);
  return { width: w, height: h, data: src === img.data ? src.slice() : src };
}

export const resizeLanczos = (img, w, h) => resample(img, w, h, LANCZOS);
// Seuls les pixels (x, y) multiples de step sont calcules (les autres a 0), aux memes octets que resizeLanczos (memes coefficients,
// horizontale d'abord, memes arrondis) : ~1/step du cout de la passe horizontale, ~1/step^2 de la verticale.
export function resizeLanczosStep(img, w, h, step) {
  const { width: sw, height: sh } = img, c = img.data.length / (sw * sh), src = img.data, nx = Math.ceil(w / step), out = new Uint8ClampedArray(w * h * c);
  let hb = new Uint8ClampedArray(sh * nx * c);                        // colonnes 0, step, 2 step... apres la passe horizontale
  const H = w !== sw && coeffs(sw, w, LANCZOS);
  for (let y = 0; y < sh; y++) for (let j = 0; j < nx; j++) for (let ch = 0; ch < c; ch++) {
    const xx = j * step;
    if (!H) { hb[(y * nx + j) * c + ch] = src[(y * sw + xx) * c + ch]; continue; }
    const x0 = H.bounds[2 * xx], n = H.bounds[2 * xx + 1], k0 = xx * H.ksize;
    let s = HALF;
    for (let x = 0; x < n; x++) s += src[(y * sw + x0 + x) * c + ch] * H.kk[k0 + x];
    hb[(y * nx + j) * c + ch] = s >> PREC;
  }
  const V = h !== sh && coeffs(sh, h, LANCZOS);
  for (let yy = 0; yy < h; yy += step) for (let j = 0; j < nx; j++) for (let ch = 0; ch < c; ch++) {
    const o = (yy * w + j * step) * c + ch;
    if (!V) { out[o] = hb[(yy * nx + j) * c + ch]; continue; }
    const y0 = V.bounds[2 * yy], n = V.bounds[2 * yy + 1], k0 = yy * V.ksize;
    let s = HALF;
    for (let y = 0; y < n; y++) s += hb[((y0 + y) * nx + j) * c + ch] * V.kk[k0 + y];
    out[o] = s >> PREC;
  }
  return { width: w, height: h, data: out };
}
export const resizeBilinear = (img, w, h) => resample(img, w, h, BILINEAR);

// ImagingScaleAffine : la position source s'accumule (xo += sw / w), comme Pillow ; ce n'est pas floor((x + 0.5) * sw / w)
// (les deux diffèrent pour 46 882 couples de tailles < 700, et Pillow 12.1.1 comme 13 suit l'accumulation).
export function resizeNearest(img, w, h) {
  const { width: sw, height: sh } = img, c = img.data.length / (sw * sh);
  const xs = new Int32Array(w), out = new Uint8ClampedArray(w * h * c);
  for (let x = 0, a = sw / w, xo = a * 0.5; x < w; x++, xo += a) xs[x] = Math.trunc(xo);
  for (let y = 0, a = sh / h, yo = a * 0.5; y < h; y++, yo += a) {
    const row = Math.trunc(yo) * sw;
    for (let x = 0; x < w; x++)
      for (let ch = 0; ch < c; ch++) out[(y * w + x) * c + ch] = img.data[(row + xs[x]) * c + ch];
  }
  return { width: w, height: h, data: out };
}

// Taille de sortie de Image.thumbnail((side, side)) : round_aspect, le plancher l'emporte en cas d'égalité.
export function thumbnailSize(w, h, side) {
  if (side >= w && side >= h) return [w, h];
  const aspect = w / h;
  const roundAspect = (n, key) => Math.max(key(Math.ceil(n)) < key(Math.floor(n)) ? Math.ceil(n) : Math.floor(n), 1);
  return aspect <= 1
    ? [roundAspect(side * aspect, (n) => Math.abs(aspect - n / side)), side]
    : [side, roundAspect(side / aspect, (n) => (n === 0 ? 0 : Math.abs(aspect - side / n)))];
}

// convert("L") depuis RGB : L24 >> 16. Rend une image grise (1 octet par pixel).
export function toL(img) {
  const n = img.width * img.height, c = img.data.length / n, d = img.data, out = new Uint8ClampedArray(n);
  for (let i = 0; i < n; i++) out[i] = (d[i * c] * 19595 + d[i * c + 1] * 38470 + d[i * c + 2] * 7471 + 0x8000) >> 16;
  return { width: img.width, height: img.height, data: out };
}

// round() de Python : arrondi au pair pour les demis.
export const pyRound = (x) => (x - Math.floor(x) === 0.5 ? 2 * Math.round(x / 2) : Math.round(x));
