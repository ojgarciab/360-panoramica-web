// Escena sintética procedural sobre la esfera. Se usa en el modo demostración (cámara
// simulada) y en las pruebas automáticas, para validar captura, calibración y cosido sin móvil.

function hash(x, y, z, s) {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 2147483647) ^ Math.imul(s, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function noise3(x, y, z, seed) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  let fx = x - xi, fy = y - yi, fz = z - zi;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy); fz = fz * fz * (3 - 2 * fz);
  const l = (a, b, t) => a + (b - a) * t;
  return l(
    l(l(hash(xi, yi, zi, seed), hash(xi + 1, yi, zi, seed), fx), l(hash(xi, yi + 1, zi, seed), hash(xi + 1, yi + 1, zi, seed), fx), fy),
    l(l(hash(xi, yi, zi + 1, seed), hash(xi + 1, yi, zi + 1, seed), fx), l(hash(xi, yi + 1, zi + 1, seed), hash(xi + 1, yi + 1, zi + 1, seed), fx), fy),
    fz);
}

/** Color [r,g,b] (0..255) de la escena en la dirección unitaria (x=este, y=norte, z=arriba). */
export function sceneColor(x, y, z) {
  const big = noise3(x * 2.5 + 7, y * 2.5 + 7, z * 2.5 + 7, 1);
  const mid = noise3(x * 9 + 3, y * 9 + 3, z * 9 + 3, 2);
  const fine = noise3(x * 30, y * 30, z * 30, 3);
  const tiny = noise3(x * 90, y * 90, z * 90, 4);
  const blobs = mid > 0.55 ? 1 : 0;
  const lum = 0.35 * big + 0.25 * mid + 0.2 * fine + 0.12 * tiny + 0.18 * blobs;
  const sky = Math.max(0, Math.min(1, z * 1.5 + 0.5));
  const hue = noise3(x * 4 + 11, y * 4 + 11, z * 4 + 11, 5);
  const r = (0.75 - 0.45 * sky + 0.3 * hue) * lum;
  const g = (0.55 + 0.1 * sky + 0.2 * (1 - hue)) * lum;
  const b = (0.3 + 0.6 * sky) * lum;
  return [Math.min(255, r * 330), Math.min(255, g * 330), Math.min(255, b * 330)];
}

/** Renderiza la escena como equirectangular RGBA (centro = norte). */
export function renderEquirect(W, H) {
  const out = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    const phi = (0.5 - (y + 0.5) / H) * Math.PI;
    const sp = Math.sin(phi), cp = Math.cos(phi);
    for (let x = 0; x < W; x++) {
      const lam = ((x + 0.5) / W - 0.5) * 2 * Math.PI;
      const c = sceneColor(cp * Math.sin(lam), cp * Math.cos(lam), sp);
      const o = (y * W + x) * 4;
      out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2]; out[o + 3] = 255;
    }
  }
  return out;
}

/**
 * Vista en perspectiva de un equirectangular (cámara simulada).
 * @param eq {data, w, h} equirectangular RGBA   @param R cámara->mundo   @param K intrínsecos
 */
export function renderView(eq, R, K, out) {
  const { w, h, f, cx, cy } = K;
  const ew = eq.w, eh = eq.h, ed = eq.data;
  for (let y = 0; y < h; y++) {
    const ry = -(y - cy) / f;
    for (let x = 0; x < w; x++) {
      const rx = (x - cx) / f;
      const dx = R[0] * rx + R[1] * ry - R[2];
      const dy = R[3] * rx + R[4] * ry - R[5];
      const dz = R[6] * rx + R[7] * ry - R[8];
      const lam = Math.atan2(dx, dy);
      const phi = Math.atan2(dz, Math.sqrt(dx * dx + dy * dy));
      let u = (lam / (2 * Math.PI) + 0.5) * ew - 0.5;
      let v = (0.5 - phi / Math.PI) * eh - 0.5;
      if (v < 0) v = 0; else if (v > eh - 1.001) v = eh - 1.001;
      if (u < 0) u += ew;
      const u0 = u | 0, v0 = v | 0, fu = u - u0, fv = v - v0;
      const u1 = u0 + 1 >= ew ? 0 : u0 + 1;
      const a = (v0 * ew + u0) * 4, b = (v0 * ew + u1) * 4, c = a + ew * 4, d = b + ew * 4;
      const w00 = (1 - fu) * (1 - fv), w01 = fu * (1 - fv), w10 = (1 - fu) * fv, w11 = fu * fv;
      const o = (y * w + x) * 4;
      out[o] = ed[a] * w00 + ed[b] * w01 + ed[c] * w10 + ed[d] * w11;
      out[o + 1] = ed[a + 1] * w00 + ed[b + 1] * w01 + ed[c + 1] * w10 + ed[d + 1] * w11;
      out[o + 2] = ed[a + 2] * w00 + ed[b + 2] * w01 + ed[c + 2] * w10 + ed[d + 2] * w11;
      out[o + 3] = 255;
    }
  }
  return out;
}
