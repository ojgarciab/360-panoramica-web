// Núcleo del cosido: análisis (emparejar + refinar + ganancias) y mezcla equirectangular.
// Código puro (sin DOM) para poder ejecutarlo en un Worker y probarlo en Node.
import { mul, transpose, forward } from './math3d.js';
import { matchPair, mapAtoB } from './match.js';
import { refineRotations, solveGains, fitPair, estimateFocal, pixelRay } from './optimize.js';

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

/**
 * Elige qué pares de fotos emparejar según el solape previsto por los sensores.
 * Con adjacentOnly sólo se usan las fotos contiguas: las de mayor solape de cada una
 * (vecinas del mismo anillo y de los anillos de arriba y abajo).
 */
export function planPairs(frames, { minOverlap = 0.15, adjacentOnly = false, neighbours = 6 } = {}) {
  const n = frames.length;
  const cand = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const ov = Math.min(overlapFraction(frames[i], frames[j]), overlapFraction(frames[j], frames[i]));
      if (ov >= (adjacentOnly ? Math.max(minOverlap, 0.2) : minOverlap)) cand.push({ i, j, ov });
    }
  }
  if (!adjacentOnly) return cand.map((c) => [c.i, c.j]);
  const keep = new Set();
  for (let i = 0; i < n; i++) {
    cand.filter((c) => c.i === i || c.j === i).sort((x, y) => y.ov - x.ov).slice(0, neighbours)
      .forEach((c) => keep.add(c));
  }
  return cand.filter((c) => keep.has(c)).map((c) => [c.i, c.j]);
}

const scaleK = (K, s, w, h) => ({ w, h, f: K.f * s, cx: (K.cx + 0.5) * s - 0.5, cy: (K.cy + 0.5) * s - 0.5 });

/**
 * Análisis previo al cosido: empareja las fotos, comprueba cada par, ajusta las orientaciones
 * y calcula las ganancias de exposición.
 * @param frames [{R, K}] orientaciones de sensor e intrínsecos a resolución completa.
 * @param grays  [{data:Float32Array, w, h}] versiones reducidas en gris.
 * @param opts {refine, gains, adjacentOnly, autoFocal}
 * @returns {rotations, gains, focalScale, stats}
 */
export function analyze(frames, grays, opts = {}, onProgress = () => {}) {
  const n = frames.length;
  const identityGains = frames.map(() => 1);
  if (opts.refine === false && opts.gains === false) {
    return { rotations: frames.map((f) => f.R), gains: identityGains, focalScale: 1, stats: { pairs: 0, matches: 0 } };
  }
  const pairs = planPairs(frames, { adjacentOnly: !!opts.adjacentOnly });
  let focalScale = 1;
  let groups = [], photo = [];
  const rounds = opts.autoFocal ? 2 : 1;
  const stats = { planned: pairs.length };
  for (let round = 0; round < rounds; round++) {
    const F = frames.map((f) => ({ R: f.R, K: { ...f.K, f: f.K.f * focalScale } }));
    groups = []; photo = [];
    let done = 0;
    for (const [i, j] of pairs) {
      const si = grays[i].w / F[i].K.w, sj = grays[j].w / F[j].K.w;
      const M = mul(transpose(F[j].R), F[i].R);
      const r = matchPair(grays[i], scaleK(F[i].K, si, grays[i].w, grays[i].h), grays[j], scaleK(F[j].K, sj, grays[j].w, grays[j].h), M, opts.match);
      const pts = r.matches.map((m) => [(m[0] + 0.5) / si - 0.5, (m[1] + 0.5) / si - 0.5, (m[2] + 0.5) / sj - 0.5, (m[3] + 0.5) / sj - 0.5]);
      if (pts.length >= 6) groups.push({ i, j, M, pts, scale: si });
      if (r.samples > 50) photo.push({ i, j, meanI: r.meanA, meanJ: r.meanB, n: r.samples });
      onProgress((round + ++done / pairs.length) / rounds);
    }
    if (round === rounds - 1) break;
    // Autocalibración de la focal con las propias fotos, apoyada en los giros que miden los
    // sensores (igual que la pantalla de calibración); si cambia, se vuelve a emparejar.
    const total = groups.reduce((s, g) => s + g.pts.length, 0);
    if (groups.length < 8 || total < 150) break;
    const K0 = frames[0].K, long = Math.max(K0.w, K0.h);
    const est = estimateFocal(groups.map((g) => ({ Ra: frames[g.i].R, Rb: frames[g.j].R, pts: g.pts })), K0.w, K0.h,
      { tau: 0.025 * long, minRel: 0.7 * K0.f / long, maxRel: 1.4 * K0.f / long });
    if (est.inliers < 100 || est.inliers < 0.5 * est.total) break;
    const sc = est.f / K0.f;
    if (sc < 0.72 || sc > 1.36 || Math.abs(sc - 1) < 0.015) break;
    stats.focalInliers = est.inliers;
    focalScale = sc;
  }
  const F = frames.map((f) => ({ R: f.R, K: { ...f.K, f: f.K.f * focalScale } }));

  // Verificación por pares: las coincidencias de un par deben ser coherentes con un único giro
  const matches = [];
  let raw = 0, verified = 0;
  for (const g of groups) {
    raw += g.pts.length;
    const Ki = F[g.i].K, Kj = F[g.j].K;
    const as = g.pts.map((p) => pixelRay(Ki, p[0], p[1])), bs = g.pts.map((p) => pixelRay(Kj, p[2], p[3]));
    const { res } = fitPair(as, bs, g.M);
    const thr = (opts.pairTolerance ?? 2) / (g.scale * Ki.f);
    const inl = [];
    for (let k = 0; k < res.length; k++) if (res[k] < thr) inl.push(k);
    if (inl.length < 6 || inl.length < 0.4 * g.pts.length) continue;
    verified++;
    for (const k of inl) matches.push({ i: g.i, j: g.j, a: [g.pts[k][0], g.pts[k][1]], b: [g.pts[k][2], g.pts[k][3]] });
  }
  Object.assign(stats, { pairs: verified, matches: matches.length, rawMatches: raw, focalScale });

  let rotations = frames.map((f) => f.R);
  if (opts.refine !== false && matches.length >= 8) {
    const ref = refineRotations(F, matches, opts.optimize);
    rotations = ref.rotations;
    Object.assign(stats, {
      rmsBeforeDeg: ref.rmsBefore * 180 / Math.PI, rmsAfterDeg: ref.rmsAfter * 180 / Math.PI,
      medianBeforeDeg: ref.medianBefore * 180 / Math.PI, medianAfterDeg: ref.medianAfter * 180 / Math.PI,
      maxCorrectionDeg: Math.max(...ref.corrections) * 180 / Math.PI, reverted: ref.reverted,
    });
  }
  const gains = opts.gains === false ? identityGains : solveGains(photo, n);
  return { rotations, gains, focalScale, stats };
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

/** Desenfoque de caja separable (dos pasadas ≈ gaussiano) de una imagen RGBA. */
export function blurRGBA(src, w, h, r) {
  const a = new Uint8ClampedArray(src.length), b = new Uint8ClampedArray(src.length);
  const pass = (from, to, n, lines, step, lineStep) => {
    for (let l = 0; l < lines; l++) {
      const base = l * lineStep;
      for (let c = 0; c < 3; c++) {
        let sum = 0, count = 0;
        for (let i = 0; i <= r && i < n; i++) { sum += from[base + i * step + c]; count++; }
        for (let i = 0; i < n; i++) {
          to[base + i * step + c] = sum / count;
          const add = i + r + 1, rem = i - r;
          if (add < n) { sum += from[base + add * step + c]; count++; }
          if (rem >= 0) { sum -= from[base + rem * step + c]; count--; }
        }
      }
    }
  };
  pass(src, a, w, h, 4, 4 * w); pass(a, b, h, w, 4 * w, 4);
  pass(b, a, w, h, 4, 4 * w); pass(a, b, h, w, 4 * w, 4);
  return b;
}

/**
 * Mezcla por franjas horizontales del equirectangular (para acotar la memoria en móviles).
 *
 * Mezcla en dos bandas (Brown y Lowe): cada foto se separa en una imagen suave (colores y
 * luces) y otra de detalle. La suave se funde gradualmente entre fotos para que no se noten
 * los cambios de exposición; el detalle se toma casi por completo de una sola foto en cada
 * punto, de modo que los objetos cercanos no aparecen dobles aunque no encajen exactamente.
 * Con twoBand = false se hace la media ponderada simple.
 */
export class StripBlender {
  constructor(W, H, y0 = 0, y1 = H, { twoBand = true, lowPow = 4, highPow = 16, blurDiv = 40 } = {}) {
    this.lowPow = lowPow; this.highPow = highPow; this.blurDiv = blurDiv;
    this.W = W; this.H = H; this.y0 = y0; this.y1 = y1;
    this.twoBand = twoBand;
    this.ch = twoBand ? 8 : 4;
    this.acc = new Float32Array(W * (y1 - y0) * this.ch);
    this.sinL = new Float32Array(W); this.cosL = new Float32Array(W);
    for (let x = 0; x < W; x++) {
      const l = ((x + 0.5) / W - 0.5) * 2 * Math.PI;
      this.sinL[x] = Math.sin(l); this.cosL[x] = Math.cos(l);
    }
  }

  addFrame(rgba, R, K, gain = 1) {
    const { W, H, acc, sinL, cosL, twoBand, ch, lowPow, highPow } = this;
    const { w, h, f, cx, cy } = K;
    const [fy0, fy1] = frameRowRange(R, K, H);
    const ya = Math.max(this.y0, fy0), yb = Math.min(this.y1, fy1);
    if (ya >= yb) return;
    // radio de la banda suave: ~1/40 del lado largo de la foto
    const low = twoBand ? blurRGBA(rgba, w, h, Math.max(2, Math.round(Math.max(w, h) / this.blurDiv))) : null;
    const fw = forward(R);
    const phiC = Math.asin(Math.max(-1, Math.min(1, fw[2])));
    const lamC = Math.atan2(fw[0], fw[1]);
    const delta = Math.atan(Math.hypot(w, h) / 2 / f);
    const cosD = Math.cos(delta), sinC = Math.sin(phiC), cosC = Math.cos(phiC);
    const xc = (lamC / (2 * Math.PI) + 0.5) * W;
    const r0 = R[0], r1 = R[1], r2 = R[2], r3 = R[3], r4 = R[4], r5 = R[5], r6 = R[6], r7 = R[7], r8 = R[8];
    // el peso depende del ángulo al eje de la foto, igual en ambos ejes: así la costura entre
    // dos fotos cae a mitad de camino entre sus centros
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
        const wx = 1 - Math.abs(u - cx) / hx, wy = 1 - Math.abs(v - cy) / hy;
        const wb = wx * wy;
        let u0 = u | 0, v0 = v | 0;
        if (u0 > w - 2) u0 = w - 2;
        if (v0 > h - 2) v0 = h - 2;
        const fu = u - u0, fv = v - v0;
        const i00 = (v0 * w + u0) * 4, i10 = i00 + w * 4;
        const w00 = (1 - fu) * (1 - fv), w01 = fu * (1 - fv), w10 = (1 - fu) * fv, w11 = fu * fv;
        const o = (rowBase + x) * ch;
        const cr = rgba[i00] * w00 + rgba[i00 + 4] * w01 + rgba[i10] * w10 + rgba[i10 + 4] * w11;
        const cg = rgba[i00 + 1] * w00 + rgba[i00 + 5] * w01 + rgba[i10 + 1] * w10 + rgba[i10 + 5] * w11;
        const cb = rgba[i00 + 2] * w00 + rgba[i00 + 6] * w01 + rgba[i10 + 2] * w10 + rgba[i10 + 6] * w11;
        if (!twoBand) {
          const wt = wb * wb * wb + 1e-6, wg = wt * gain;
          acc[o] += wg * cr; acc[o + 1] += wg * cg; acc[o + 2] += wg * cb; acc[o + 3] += wt;
          continue;
        }
        const lr = low[i00] * w00 + low[i00 + 4] * w01 + low[i10] * w10 + low[i10 + 4] * w11;
        const lg = low[i00 + 1] * w00 + low[i00 + 5] * w01 + low[i10 + 1] * w10 + low[i10 + 5] * w11;
        const lb = low[i00 + 2] * w00 + low[i00 + 6] * w01 + low[i10 + 2] * w10 + low[i10 + 6] * w11;
        // banda suave: transición moderada; banda de detalle: casi "gana la foto más centrada"
        const wl = Math.pow(wb, lowPow) + 1e-30, wh = Math.pow(wb, highPow) + 1e-30;
        const gl = wl * gain, gh = wh * gain;
        acc[o] += gl * lr; acc[o + 1] += gl * lg; acc[o + 2] += gl * lb; acc[o + 3] += wl;
        acc[o + 4] += gh * (cr - lr); acc[o + 5] += gh * (cg - lg); acc[o + 6] += gh * (cb - lb); acc[o + 7] += wh;
      }
    }
  }

  /** Devuelve los píxeles RGBA de la franja y cuántos quedaron sin cubrir. */
  finish(fill = [16, 16, 20]) {
    const acc = this.acc, ch = this.ch;
    const n = acc.length / ch;
    const out = new Uint8ClampedArray(n * 4);
    let empty = 0;
    for (let p = 0; p < n; p++) {
      const i = p * ch, o = p * 4;
      const wt = acc[i + 3];
      if (wt > 0) {
        const k = 1 / wt;
        if (ch === 8) {
          const kh = 1 / acc[i + 7];
          out[o] = acc[i] * k + acc[i + 4] * kh; out[o + 1] = acc[i + 1] * k + acc[i + 5] * kh; out[o + 2] = acc[i + 2] * k + acc[i + 6] * kh;
        } else {
          out[o] = acc[i] * k; out[o + 1] = acc[i + 1] * k; out[o + 2] = acc[i + 2] * k;
        }
      } else {
        out[o] = fill[0]; out[o + 1] = fill[1]; out[o + 2] = fill[2]; empty++;
      }
      out[o + 3] = 255;
    }
    this.acc = null;
    return { rgba: out, empty };
  }
}
