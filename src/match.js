// Emparejamiento denso por bloques entre dos fotos que se solapan.
//
// En lugar de detectores de puntos (SIFT/ORB) se aprovecha que los sensores ya dan una
// orientación aproximada: la imagen B se deforma al encuadre de A con la homografía de
// rotación prevista y después se busca, parche a parche, el pequeño desplazamiento residual
// que maximiza la correlación cruzada normalizada (ZNCC). Es barato, no necesita
// dependencias y es robusto a cambios de exposición.

/** RGBA -> luminancia en Float32Array (0..255). */
export function grayFromRGBA(rgba, w, h) {
  const g = new Float32Array(w * h);
  for (let i = 0, j = 0; i < g.length; i++, j += 4) {
    g[i] = 0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2];
  }
  return g;
}

/**
 * Reduce una imagen RGBA a gris promediando por áreas. Se hace a mano (y no con drawImage)
 * porque el reducido del navegador deja aliasing que estropea el emparejamiento.
 */
export function grayDownsample(rgba, w, h, gw, gh) {
  const out = new Float32Array(gw * gh), cnt = new Uint16Array(gw * gh);
  const xm = new Uint16Array(w);
  for (let x = 0; x < w; x++) xm[x] = Math.min(gw - 1, (x * gw / w) | 0);
  for (let y = 0; y < h; y++) {
    const row = Math.min(gh - 1, (y * gh / h) | 0) * gw;
    let j = y * w * 4;
    for (let x = 0; x < w; x++, j += 4) {
      const k = row + xm[x];
      out[k] += 0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2];
      cnt[k]++;
    }
  }
  for (let k = 0; k < out.length; k++) if (cnt[k]) out[k] /= cnt[k];
  return { data: out, w: gw, h: gh };
}

/**
 * Deforma B al encuadre de A. M = R_bᵀ·R_a (lleva rayos de la cámara A a la cámara B).
 * Los píxeles sin correspondencia quedan a NaN.
 */
export function warpToA(A, KA, B, KB, M) {
  const { w, h } = A;
  const out = new Float32Array(w * h);
  const bw = B.w, bh = B.h, bd = B.data;
  const ifa = 1 / KA.f;
  for (let y = 0; y < h; y++) {
    const ry = -(y - KA.cy) * ifa;
    for (let x = 0; x < w; x++) {
      const rx = (x - KA.cx) * ifa;
      const cz = M[6] * rx + M[7] * ry - M[8];
      let val = NaN;
      if (cz < -1e-6) {
        const iz = -1 / cz;
        const u = KB.cx + KB.f * (M[0] * rx + M[1] * ry - M[2]) * iz;
        const v = KB.cy - KB.f * (M[3] * rx + M[4] * ry - M[5]) * iz;
        if (u >= 0 && v >= 0 && u <= bw - 1 && v <= bh - 1) {
          let u0 = u | 0, v0 = v | 0;
          if (u0 > bw - 2) u0 = bw - 2;
          if (v0 > bh - 2) v0 = bh - 2;
          const fu = u - u0, fv = v - v0, k = v0 * bw + u0;
          val = (bd[k] * (1 - fu) + bd[k + 1] * fu) * (1 - fv) + (bd[k + bw] * (1 - fu) + bd[k + bw + 1] * fu) * fv;
        }
      }
      out[y * w + x] = val;
    }
  }
  return out;
}

/** Proyecta un píxel (posiblemente subpíxel) de A sobre B. */
export function mapAtoB(KA, KB, M, x, y) {
  const rx = (x - KA.cx) / KA.f, ry = -(y - KA.cy) / KA.f;
  const cz = M[6] * rx + M[7] * ry - M[8];
  if (cz > -1e-6) return null;
  const iz = -1 / cz;
  return [
    KB.cx + KB.f * (M[0] * rx + M[1] * ry - M[2]) * iz,
    KB.cy - KB.f * (M[3] * rx + M[4] * ry - M[5]) * iz,
  ];
}

/** Reduce a la mitad promediando 2×2 (los NaN se propagan y marcan zona no válida). */
function halve(data, w, h) {
  const w2 = w >> 1, h2 = h >> 1;
  const out = new Float32Array(w2 * h2);
  for (let y = 0; y < h2; y++) {
    for (let x = 0; x < w2; x++) {
      const k = 2 * y * w + 2 * x;
      out[y * w2 + x] = 0.25 * (data[k] + data[k + 1] + data[k + w] + data[k + w + 1]);
    }
  }
  return { data: out, w: w2, h: h2 };
}

/** Copia el parche centrado en (x, y) restándole la media; devuelve su varianza·n (o -1 si no cabe). */
function template(img, x, y, P, tpl) {
  if (x < P || y < P || x >= img.w - P || y >= img.h - P) return -1;
  const np = (2 * P + 1) * (2 * P + 1);
  let mean = 0, k = 0;
  for (let dy = -P; dy <= P; dy++) {
    const row = (y + dy) * img.w + x;
    for (let dx = -P; dx <= P; dx++) { const v = img.data[row + dx]; tpl[k++] = v; mean += v; }
  }
  mean /= np;
  let va = 0;
  for (k = 0; k < np; k++) { tpl[k] -= mean; va += tpl[k] * tpl[k]; }
  return va;
}

/** ZNCC entre la plantilla y el parche de img centrado en (x, y); -2 si no cabe o toca zona no válida. */
function zncc(tpl, varA, img, x, y, P) {
  if (x < P || y < P || x >= img.w - P || y >= img.h - P) return -2;
  const np = (2 * P + 1) * (2 * P + 1), w = img.w, d = img.data;
  let sum = 0, sum2 = 0, cross = 0, k = 0;
  for (let dy = -P; dy <= P; dy++) {
    const row = (y + dy) * w + x;
    for (let dx = -P; dx <= P; dx++) { const v = d[row + dx]; sum += v; sum2 += v * v; cross += tpl[k++] * v; }
  }
  const varB = sum2 - sum * sum / np;
  const sc = varB > 1e-6 ? cross / Math.sqrt(varA * varB) : -2;
  return sc === sc ? sc : -2; // NaN => zona no válida
}

/**
 * Busca correspondencias entre A y B.
 *
 * 1. B se deforma al encuadre de A con la rotación prevista; sólo la zona donde ambas fotos se
 *    solapan queda válida, y la rejilla de parches se reparte dentro de esa zona.
 * 2. Búsqueda gruesa a media resolución (radio amplio, tolera errores de sensor y de focal).
 * 3. Afinado a resolución completa alrededor del resultado grueso, con precisión subpíxel.
 *
 * @returns {{matches:number[][], overlap:number, meanA:number, meanB:number, samples:number}}
 *   matches: [ax, ay, bx, by, zncc] en píxeles de las imágenes recibidas.
 */
export function matchPair(A, KA, B, KB, M, opts = {}) {
  const P = opts.patch ?? 6;                 // semilado del parche fino (13x13)
  const P2 = opts.patchCoarse ?? 5;          // semilado del parche grueso (11x11 a media resolución)
  const S2 = opts.searchCoarse ?? 12;        // radio de búsqueda grueso (±24 px a resolución completa)
  const G = opts.grid ?? 10;                 // parches por lado
  const minScore = opts.minScore ?? 0.8;
  const minCoarse = opts.minCoarse ?? 0.65;
  const minStd = opts.minStd ?? 5;
  const { w, h } = A;
  const ad = A.data;
  const warped = warpToA(A, KA, B, KB, M);
  const W = { data: warped, w, h };

  // Zona de solape (caja que contiene los píxeles válidos) y estadística fotométrica
  let n = 0, sa = 0, sb = 0, total = 0, x0 = w, x1 = -1, y0 = h, y1 = -1;
  for (let y = 1; y < h; y += 2) {
    for (let x = 1; x < w; x += 2) {
      total++;
      const v = warped[y * w + x];
      if (v === v) {
        n++; sa += ad[y * w + x]; sb += v;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  const result = { matches: [], overlap: n / total, meanA: n ? sa / n : 0, meanB: n ? sb / n : 0, samples: n };
  if (result.overlap < 0.05) return result;
  x0 = Math.max(x0, P); y0 = Math.max(y0, P); x1 = Math.min(x1, w - 1 - P); y1 = Math.min(y1, h - 1 - P);
  if (x1 - x0 < 2 * P || y1 - y0 < 2 * P) return result;

  const A2 = halve(ad, w, h), W2 = halve(warped, w, h);
  const side = 2 * S2 + 1;
  const scores = new Float32Array(side * side);
  const tpl = new Float32Array((2 * P + 1) * (2 * P + 1));
  const tpl2 = new Float32Array((2 * P2 + 1) * (2 * P2 + 1));
  const np = tpl.length, np2 = tpl2.length;
  const fine = new Float32Array(49);
  // rejilla adaptada a la forma del solape (más puntos a lo largo de su lado mayor)
  const aspect = (x1 - x0) / (y1 - y0);
  const gx = Math.max(3, Math.min(3 * G, Math.round(G * Math.sqrt(aspect))));
  const gy = Math.max(3, Math.min(3 * G, Math.round(G / Math.sqrt(aspect))));

  for (let iy = 0; iy < gy; iy++) {
    const y = Math.round(y0 + (y1 - y0) * (iy + 0.5) / gy);
    for (let ix = 0; ix < gx; ix++) {
      const x = Math.round(x0 + (x1 - x0) * (ix + 0.5) / gx);
      if (!(warped[y * w + x] === warped[y * w + x])) continue;
      const varA = template(A, x, y, P, tpl);
      if (varA < 0 || Math.sqrt(varA / np) < minStd) continue;

      // --- búsqueda gruesa ---
      const cx = x >> 1, cy = y >> 1;
      const var2 = template(A2, cx, cy, P2, tpl2);
      if (var2 < 0 || Math.sqrt(var2 / np2) < minStd * 0.6) continue;
      let best = -2, bi = -1;
      for (let oy = -S2; oy <= S2; oy++) {
        for (let ox = -S2; ox <= S2; ox++) {
          const sc = zncc(tpl2, var2, W2, cx + ox, cy + oy, P2);
          const idx = (oy + S2) * side + ox + S2;
          scores[idx] = sc;
          if (sc > best) { best = sc; bi = idx; }
        }
      }
      if (best < minCoarse) continue;
      const bx = bi % side, by = (bi / side) | 0;
      if (bx === 0 || by === 0 || bx === side - 1 || by === side - 1) continue;
      // unicidad: el segundo máximo (fuera del entorno) debe ser claramente peor
      let second = -2;
      for (let j = 0; j < scores.length; j++) {
        const jx = j % side, jy = (j / side) | 0;
        if (Math.abs(jx - bx) <= 2 && Math.abs(jy - by) <= 2) continue;
        if (scores[j] > second) second = scores[j];
      }
      if (second > best - 0.05) continue;

      // --- afinado a resolución completa (±3 px alrededor del resultado grueso) ---
      const ox0 = 2 * (bx - S2), oy0 = 2 * (by - S2);
      let fb = -2, fi = -1;
      for (let j = 0; j < 49; j++) {
        const sc = zncc(tpl, varA, W, x + ox0 + (j % 7) - 3, y + oy0 + ((j / 7) | 0) - 3, P);
        fine[j] = sc;
        if (sc > fb) { fb = sc; fi = j; }
      }
      if (fb < minScore) continue;
      const fx = fi % 7, fy = (fi / 7) | 0;
      if (fx === 0 || fy === 0 || fx === 6 || fy === 6) continue;
      const c = fine[fi], l = fine[fi - 1], r = fine[fi + 1], u = fine[fi - 7], d = fine[fi + 7];
      let sx = 0, sy = 0;
      const dxx = l - 2 * c + r, dyy = u - 2 * c + d;
      if (l > -2 && r > -2 && dxx < -1e-6) sx = Math.max(-0.5, Math.min(0.5, 0.5 * (l - r) / dxx));
      if (u > -2 && d > -2 && dyy < -1e-6) sy = Math.max(-0.5, Math.min(0.5, 0.5 * (u - d) / dyy));
      const pb = mapAtoB(KA, KB, M, x + ox0 + fx - 3 + sx, y + oy0 + fy - 3 + sy);
      if (pb) result.matches.push([x, y, pb[0], pb[1], fb]);
    }
  }
  return result;
}
