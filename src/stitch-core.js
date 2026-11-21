// Núcleo del cosido: análisis (emparejar + refinar + ganancias) y mezcla equirectangular.
// Código puro (sin DOM) para poder ejecutarlo en un Worker y probarlo en Node.
import { mul, transpose, forward } from './math3d.js';
import { matchPair, mapAtoB } from './match.js';
import { refineRotations, solveGains } from './optimize.js';

/** Fracción aproximada de A visible en B. */
function overlapFraction(Fa, Fb) {
  const M = mul(transpose(Fb.R), Fa.R);
  const G = 6;
  let inside = 0;
  for (let gy = 0; gy < G; gy++) {
    for (let gx = 0; gx < G; gx++) {
      const p = mapAtoB(Fa.K, Fb.K, M, (gx + 0.5) / G * Fa.K.w, (gy + 0.5) / G * Fa.K.h);
      if (p && p[0] >= 0 && p[1] >= 0 && p[0] < Fb.K.w && p[1] < Fb.K.h) inside++;
    }
  }
  return inside / (G * G);
}

export function planPairs(frames, minOverlap = 0.15) {
  const pairs = [];
  for (let i = 0; i < frames.length; i++) {
    for (let j = i + 1; j < frames.length; j++) {
      if (overlapFraction(frames[i], frames[j]) >= minOverlap) pairs.push([i, j]);
    }
  }
  return pairs;
}

const scaleK = (K, s, w, h) => ({ w, h, f: K.f * s, cx: (K.cx + 0.5) * s - 0.5, cy: (K.cy + 0.5) * s - 0.5 });

/**
 * @param frames [{R, K}] orientaciones de sensor e intrínsecos a resolución completa.
 * @param grays  [{data:Float32Array, w, h}] versiones reducidas en gris.
 */
export function analyze(frames, grays, opts = {}, onProgress = () => {}) {
  const n = frames.length;
  const identityGains = frames.map(() => 1);
  if (opts.refine === false && opts.gains === false) {
    return { rotations: frames.map((f) => f.R), gains: identityGains, stats: { pairs: 0, matches: 0 } };
  }
  const pairs = planPairs(frames);
  const matches = [], photo = [];
  let done = 0;
  for (const [i, j] of pairs) {
    const si = grays[i].w / frames[i].K.w, sj = grays[j].w / frames[j].K.w;
    const Ki = scaleK(frames[i].K, si, grays[i].w, grays[i].h);
    const Kj = scaleK(frames[j].K, sj, grays[j].w, grays[j].h);
    const M = mul(transpose(frames[j].R), frames[i].R);
    const r = matchPair(grays[i], Ki, grays[j], Kj, M, opts.match);
    for (const m of r.matches) {
      matches.push({
        i, j,
        a: [(m[0] + 0.5) / si - 0.5, (m[1] + 0.5) / si - 0.5],
        b: [(m[2] + 0.5) / sj - 0.5, (m[3] + 0.5) / sj - 0.5],
      });
    }
    if (r.samples > 50) photo.push({ i, j, meanI: r.meanA, meanJ: r.meanB, n: r.samples });
    onProgress(++done / pairs.length);
  }
  let rotations = frames.map((f) => f.R);
  const stats = { pairs: pairs.length, matches: matches.length };
  if (opts.refine !== false && matches.length >= 8) {
    const ref = refineRotations(frames, matches, opts.optimize);
    rotations = ref.rotations;
    Object.assign(stats, {
      rmsBeforeDeg: ref.rmsBefore * 180 / Math.PI, rmsAfterDeg: ref.rmsAfter * 180 / Math.PI,
      medianBeforeDeg: ref.medianBefore * 180 / Math.PI, medianAfterDeg: ref.medianAfter * 180 / Math.PI,
      maxCorrectionDeg: Math.max(...ref.corrections) * 180 / Math.PI, reverted: ref.reverted,
    });
  }
  const gains = opts.gains === false ? identityGains : solveGains(photo, n);
  return { rotations, gains, stats };
}

/** Rango de filas [y0, y1) del equirectangular H que puede tocar una foto. */
export function frameRowRange(R, K, H) {
  const f = forward(R);
  const phi = Math.asin(Math.max(-1, Math.min(1, f[2])));
  const delta = Math.atan(Math.hypot(K.w, K.h) / 2 / K.f);
  const top = phi + delta, bot = phi - delta;
  const y0 = top >= Math.PI / 2 ? 0 : Math.max(0, Math.floor((0.5 - top / Math.PI) * H) - 1);
  const y1 = bot <= -Math.PI / 2 ? H : Math.min(H, Math.ceil((0.5 - bot / Math.PI) * H) + 1);
  return [y0, y1];
}

/**
 * Mezcla por franjas horizontales del equirectangular (para acotar la memoria en móviles).
 * Cada foto se proyecta con su orientación y se acumula con un peso que cae hacia los
 * bordes (feathering elevado a una potencia para reducir fantasmas).
 */
export class StripBlender {
  constructor(W, H, y0 = 0, y1 = H) {
    this.W = W; this.H = H; this.y0 = y0; this.y1 = y1;
    this.acc = new Float32Array(W * (y1 - y0) * 4);
    this.sinL = new Float32Array(W); this.cosL = new Float32Array(W);
    for (let x = 0; x < W; x++) {
      const l = ((x + 0.5) / W - 0.5) * 2 * Math.PI;
      this.sinL[x] = Math.sin(l); this.cosL[x] = Math.cos(l);
    }
  }

  addFrame(rgba, R, K, gain = 1) {
    const { W, H, acc, sinL, cosL } = this;
    const { w, h, f, cx, cy } = K;
    const [fy0, fy1] = frameRowRange(R, K, H);
    const ya = Math.max(this.y0, fy0), yb = Math.min(this.y1, fy1);
    if (ya >= yb) return;
    const fw = forward(R);
    const phiC = Math.asin(Math.max(-1, Math.min(1, fw[2])));
    const lamC = Math.atan2(fw[0], fw[1]);
    const delta = Math.atan(Math.hypot(w, h) / 2 / f);
    const cosD = Math.cos(delta), sinC = Math.sin(phiC), cosC = Math.cos(phiC);
    const xc = (lamC / (2 * Math.PI) + 0.5) * W;
    const r0 = R[0], r1 = R[1], r2 = R[2], r3 = R[3], r4 = R[4], r5 = R[5], r6 = R[6], r7 = R[7], r8 = R[8];
    const hx = (w - 1) / 2 + 0.5, hy = (h - 1) / 2 + 0.5;

    for (let y = ya; y < yb; y++) {
      const phi = (0.5 - (y + 0.5) / H) * Math.PI;
      const sp = Math.sin(phi), cp = Math.cos(phi);
      // extensión en longitud del casquete que contiene la foto, a esta latitud
      let xs = 0, count = W;
      const den = cp * cosC;
      if (den > 1e-6) {
        const c = (cosD - sp * sinC) / den;
        if (c >= 1) continue;
        if (c > -1) {
          const half = Math.acos(c) / (2 * Math.PI) * W + 2;
          if (2 * half < W) { xs = Math.floor(xc - half); count = Math.ceil(2 * half) + 1; }
        }
      }
      const rowBase = (y - this.y0) * W;
      for (let k = 0; k < count; k++) {
        let x = (xs + k) % W; if (x < 0) x += W;
        const dx = cp * sinL[x], dy = cp * cosL[x];
        const zc = r2 * dx + r5 * dy + r8 * sp;
        if (zc > -1e-4) continue;
        const iz = -f / zc;
        const u = cx + (r0 * dx + r3 * dy + r6 * sp) * iz;
        if (u < 0 || u > w - 1) continue;
        const v = cy - (r1 * dx + r4 * dy + r7 * sp) * iz;
        if (v < 0 || v > h - 1) continue;
        let wx = 1 - Math.abs(u - cx) / hx, wy = 1 - Math.abs(v - cy) / hy;
        let wt = wx * wy; wt = wt * wt * wt + 1e-6;
        let u0 = u | 0, v0 = v | 0;
        if (u0 > w - 2) u0 = w - 2;
        if (v0 > h - 2) v0 = h - 2;
        const fu = u - u0, fv = v - v0;
        const i00 = (v0 * w + u0) * 4, i10 = i00 + w * 4;
        const w00 = (1 - fu) * (1 - fv), w01 = fu * (1 - fv), w10 = (1 - fu) * fv, w11 = fu * fv;
        const o = (rowBase + x) * 4;
        const wg = wt * gain;
        acc[o] += wg * (rgba[i00] * w00 + rgba[i00 + 4] * w01 + rgba[i10] * w10 + rgba[i10 + 4] * w11);
        acc[o + 1] += wg * (rgba[i00 + 1] * w00 + rgba[i00 + 5] * w01 + rgba[i10 + 1] * w10 + rgba[i10 + 5] * w11);
        acc[o + 2] += wg * (rgba[i00 + 2] * w00 + rgba[i00 + 6] * w01 + rgba[i10 + 2] * w10 + rgba[i10 + 6] * w11);
        acc[o + 3] += wt;
      }
    }
  }

  /** Devuelve los píxeles RGBA de la franja y cuántos quedaron sin cubrir. */
  finish(fill = [16, 16, 20]) {
    const acc = this.acc;
    const out = new Uint8ClampedArray(acc.length);
    let empty = 0;
    for (let i = 0; i < acc.length; i += 4) {
      const wt = acc[i + 3];
      if (wt > 0) {
        const k = 1 / wt;
        out[i] = acc[i] * k; out[i + 1] = acc[i + 1] * k; out[i + 2] = acc[i + 2] * k;
      } else {
        out[i] = fill[0]; out[i + 1] = fill[1]; out[i + 2] = fill[2]; empty++;
      }
      out[i + 3] = 255;
    }
    this.acc = null;
    return { rgba: out, empty };
  }
}
