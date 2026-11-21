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

/**
 * Busca correspondencias entre A y B.
 * @returns {{matches:number[][], overlap:number, meanA:number, meanB:number}}
 *   matches: [ax, ay, bx, by, zncc] en píxeles de las imágenes recibidas.
 */
export function matchPair(A, KA, B, KB, M, opts = {}) {
  const P = opts.patch ?? 6;        // semilado del parche (13x13)
  const S = opts.search ?? 12;      // radio de búsqueda
  const G = opts.grid ?? 10;        // parches por lado
  const minScore = opts.minScore ?? 0.8;
  const minStd = opts.minStd ?? 5;
  const { w, h } = A;
  const ad = A.data;
  const warped = warpToA(A, KA, B, KB, M);

  // Estadística fotométrica del solape (para compensar ganancias)
  let n = 0, sa = 0, sb = 0, total = 0;
  for (let y = 1; y < h; y += 2) {
    for (let x = 1; x < w; x += 2) {
      total++;
      const v = warped[y * w + x];
      if (v === v) { n++; sa += ad[y * w + x]; sb += v; }
    }
  }
  const result = { matches: [], overlap: n / total, meanA: n ? sa / n : 0, meanB: n ? sb / n : 0, samples: n };
  if (result.overlap < 0.08) return result;

  const margin = P + S;
  const side = 2 * S + 1;
  const scores = new Float32Array(side * side);
  const np = (2 * P + 1) * (2 * P + 1);
  const tpl = new Float32Array(np);

  for (let gy = 0; gy < G; gy++) {
    const y = Math.round(margin + (h - 1 - 2 * margin) * (gy + 0.5) / G);
    for (let gx = 0; gx < G; gx++) {
      const x = Math.round(margin + (w - 1 - 2 * margin) * (gx + 0.5) / G);
      if (!(warped[y * w + x] === warped[y * w + x])) continue;
      // plantilla de A con media cero
      let mean = 0, k = 0;
      for (let dy = -P; dy <= P; dy++) {
        const row = (y + dy) * w + x;
        for (let dx = -P; dx <= P; dx++) { const v = ad[row + dx]; tpl[k++] = v; mean += v; }
      }
      mean /= np;
      let varA = 0;
      for (k = 0; k < np; k++) { tpl[k] -= mean; varA += tpl[k] * tpl[k]; }
      if (Math.sqrt(varA / np) < minStd) continue;

      let best = -2, bi = -1;
      for (let oy = -S; oy <= S; oy++) {
        for (let ox = -S; ox <= S; ox++) {
          let sum = 0, sum2 = 0, cross = 0;
          k = 0;
          for (let dy = -P; dy <= P; dy++) {
            const row = (y + oy + dy) * w + x + ox;
            for (let dx = -P; dx <= P; dx++) {
              const v = warped[row + dx];
              sum += v; sum2 += v * v; cross += tpl[k++] * v;
            }
          }
          // Si hay NaN en la ventana todo queda NaN y la comparación falla (se descarta sola)
          const varB = sum2 - sum * sum / np;
          const sc = varB > 1e-6 ? cross / Math.sqrt(varA * varB) : -2;
          const idx = (oy + S) * side + ox + S;
          scores[idx] = sc === sc ? sc : -2;
          if (sc > best) { best = sc; bi = idx; }
        }
      }
      if (best < minScore) continue;
      const bx = bi % side, by = (bi / side) | 0;
      if (bx === 0 || by === 0 || bx === side - 1 || by === side - 1) continue;
      // unicidad: el segundo máximo (fuera del entorno) debe ser claramente peor
      let second = -2;
      for (let j = 0; j < scores.length; j++) {
        const jx = j % side, jy = (j / side) | 0;
        if (Math.abs(jx - bx) <= 2 && Math.abs(jy - by) <= 2) continue;
        if (scores[j] > second) second = scores[j];
      }
      if (second > best - 0.04) continue;
      // refinamiento subpíxel parabólico
      const c = scores[bi];
      const l = scores[bi - 1], r = scores[bi + 1], u = scores[bi - side], d = scores[bi + side];
      let sx = 0, sy = 0;
      const dxx = l - 2 * c + r, dyy = u - 2 * c + d;
      if (l > -2 && r > -2 && dxx < -1e-6) sx = Math.max(-0.5, Math.min(0.5, 0.5 * (l - r) / dxx));
      if (u > -2 && d > -2 && dyy < -1e-6) sy = Math.max(-0.5, Math.min(0.5, 0.5 * (u - d) / dyy));
      const pb = mapAtoB(KA, KB, M, x + bx - S + sx, y + by - S + sy);
      if (pb) result.matches.push([x, y, pb[0], pb[1], best]);
    }
  }
  return result;
}
