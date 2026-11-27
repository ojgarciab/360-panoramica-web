// Optimización: refinamiento global de orientaciones, estimación de focal y ganancias.
import { mul, transpose, expSO3, orthonormalize, angleBetween } from './math3d.js';

/** Resuelve A·x = b (A densa n×n en Float64Array por filas) con pivotaje parcial. */
export function solveLinear(A, b, n) {
  for (let c = 0; c < n; c++) {
    let p = c, max = Math.abs(A[c * n + c]);
    for (let r = c + 1; r < n; r++) {
      const v = Math.abs(A[r * n + c]);
      if (v > max) { max = v; p = r; }
    }
    if (max < 1e-14) continue;
    if (p !== c) {
      for (let k = c; k < n; k++) { const t = A[c * n + k]; A[c * n + k] = A[p * n + k]; A[p * n + k] = t; }
      const t = b[c]; b[c] = b[p]; b[p] = t;
    }
    const inv = 1 / A[c * n + c];
    for (let r = c + 1; r < n; r++) {
      const f = A[r * n + c] * inv;
      if (f === 0) continue;
      for (let k = c; k < n; k++) A[r * n + k] -= f * A[c * n + k];
      b[r] -= f * b[c];
    }
  }
  const x = new Float64Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let k = r + 1; k < n; k++) s -= A[r * n + k] * x[k];
    const d = A[r * n + r];
    x[r] = Math.abs(d) < 1e-14 ? 0 : s / d;
  }
  return x;
}

function ray(K, x, y) {
  const rx = (x - K.cx) / K.f, ry = -(y - K.cy) / K.f;
  const n = 1 / Math.hypot(rx, ry, 1);
  return [rx * n, ry * n, -n];
}

/**
 * Ajuste global de orientaciones (bundle adjustment sólo de rotaciones).
 * Minimiza Σ ρ(|R_i·a − R_j·b|²) sobre correcciones pequeñas de cada R, con un término de
 * confianza en los sensores (fuerte en inclinación —la gravedad se mide bien— y débil en
 * rumbo, que es donde deriva el giroscopio).
 *
 * @param frames [{R, K}]   @param matches [{i, j, a:[x,y], b:[x,y]}]
 */
export function refineRotations(frames, matches, opts = {}) {
  const n = frames.length;
  const iters = opts.iters ?? 8;
  const priorTilt = opts.priorTilt ?? 2;
  const priorYaw = opts.priorYaw ?? 0.05;
  const maxCorr = opts.maxCorrection ?? 8 * Math.PI / 180;
  const R = frames.map((f) => f.R.slice());
  const corr = Array.from({ length: n }, () => [0, 0, 0]);
  const obs = matches.map((m) => ({ i: m.i, j: m.j, a: ray(frames[m.i].K, m.a[0], m.a[1]), b: ray(frames[m.j].K, m.b[0], m.b[1]) }));
  const N = 3 * n;

  const residuals = () => obs.map((o) => {
    const Ri = R[o.i], Rj = R[o.j], a = o.a, b = o.b;
    const p = [Ri[0] * a[0] + Ri[1] * a[1] + Ri[2] * a[2], Ri[3] * a[0] + Ri[4] * a[1] + Ri[5] * a[2], Ri[6] * a[0] + Ri[7] * a[1] + Ri[8] * a[2]];
    const q = [Rj[0] * b[0] + Rj[1] * b[1] + Rj[2] * b[2], Rj[3] * b[0] + Rj[4] * b[1] + Rj[5] * b[2], Rj[6] * b[0] + Rj[7] * b[1] + Rj[8] * b[2]];
    return { p, q, e: Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) };
  });
  const median = (arr) => { if (!arr.length) return 0; const s = arr.slice().sort((x, y) => x - y); return s[s.length >> 1]; };
  const rms = (res) => (res.length ? Math.sqrt(res.reduce((s, r) => s + r.e * r.e, 0) / res.length) : 0);

  let res = residuals();
  const rmsBefore = rms(res), medBefore = median(res.map((r) => r.e));
  if (!obs.length) return { rotations: R, rmsBefore: 0, rmsAfter: 0, medianBefore: 0, medianAfter: 0, corrections: corr.map(() => 0) };

  for (let it = 0; it < iters; it++) {
    const H = new Float64Array(N * N), g = new Float64Array(N);
    const thr = Math.max(1.5 * median(res.map((r) => r.e)), 5e-4);
    for (let k = 0; k < obs.length; k++) {
      const { i, j } = obs[k];
      const { p, q, e } = res[k];
      const wgt = e <= thr ? 1 : thr / e; // Huber
      const r = [p[0] - q[0], p[1] - q[1], p[2] - q[2]];
      // d r / dω_i = -[p]x ; d r / dω_j = +[q]x
      const Ji = [0, p[2], -p[1], -p[2], 0, p[0], p[1], -p[0], 0];
      const Jj = [0, -q[2], q[1], q[2], 0, -q[0], -q[1], q[0], 0];
      const blocks = [[i, Ji], [j, Jj]];
      for (const [bi, Jb] of blocks) {
        for (let c = 0; c < 3; c++) {
          g[3 * bi + c] += wgt * (Jb[c] * r[0] + Jb[3 + c] * r[1] + Jb[6 + c] * r[2]);
        }
        for (const [bj, Jc] of blocks) {
          for (let c = 0; c < 3; c++) {
            for (let d = 0; d < 3; d++) {
              H[(3 * bi + c) * N + 3 * bj + d] += wgt * (Jb[c] * Jc[d] + Jb[3 + c] * Jc[3 + d] + Jb[6 + c] * Jc[6 + d]);
            }
          }
        }
      }
    }
    for (let i = 0; i < n; i++) {
      const lam = [priorTilt, priorTilt, priorYaw];
      for (let c = 0; c < 3; c++) {
        H[(3 * i + c) * N + 3 * i + c] += lam[c] + 1e-9;
        g[3 * i + c] += lam[c] * corr[i][c];
      }
    }
    for (let k = 0; k < N; k++) g[k] = -g[k];
    const delta = solveLinear(H, g, N);
    let maxStep = 0;
    for (let i = 0; i < n; i++) {
      const w = [delta[3 * i], delta[3 * i + 1], delta[3 * i + 2]];
      maxStep = Math.max(maxStep, Math.hypot(w[0], w[1], w[2]));
      R[i] = orthonormalize(mul(expSO3(w), R[i]));
      corr[i][0] += w[0]; corr[i][1] += w[1]; corr[i][2] += w[2];
    }
    res = residuals();
    if (maxStep < 1e-6) break;
  }

  // Salvaguarda: una corrección enorme indica emparejamientos falsos; se vuelve al sensor.
  const corrections = frames.map((f, i) => angleBetween(f.R, R[i]));
  let reverted = 0;
  for (let i = 0; i < n; i++) {
    if (corrections[i] > maxCorr) { R[i] = frames[i].R.slice(); corrections[i] = 0; reverted++; }
  }
  if (reverted) res = residuals();
  // coste robusto (residuo truncado a tau) para comparar ajustes con distintas focales
  const tau = opts.tau ?? 0.6 * Math.PI / 180;
  const cost = res.reduce((s, r) => s + Math.min(r.e * r.e, tau * tau), 0) / (res.length * tau * tau);
  return {
    cost,
    rotations: R, rmsBefore, rmsAfter: rms(res), medianBefore: medBefore,
    medianAfter: median(res.map((r) => r.e)), corrections, reverted,
  };
}

/**
 * Estima la focal (px) con rotaciones conocidas (dadas por los sensores).
 * pairs: [{Ra, Rb, pts:[[ax,ay,bx,by],...]}], todas las imágenes con los mismos intrínsecos.
 * Se minimiza el error de reproyección truncado con un barrido logarítmico + sección áurea.
 */
export function estimateFocal(pairs, w, h, opts = {}) {
  const long = Math.max(w, h);
  const cx = (w - 1) / 2, cy = (h - 1) / 2;
  const tau = opts.tau ?? 0.006 * long;
  const tau2 = tau * tau;
  const prepared = pairs.map((p) => ({ M: mul(transpose(p.Rb), p.Ra), pts: p.pts }));
  const total = prepared.reduce((s, p) => s + p.pts.length, 0);

  const evalF = (f, detail) => {
    let cost = 0, inl = 0, sq = 0;
    for (const { M, pts } of prepared) {
      for (const pt of pts) {
        const rx = (pt[0] - cx) / f, ry = -(pt[1] - cy) / f;
        const cz = M[6] * rx + M[7] * ry - M[8];
        let e2 = tau2;
        if (cz < -1e-6) {
          const iz = -1 / cz;
          const du = cx + f * (M[0] * rx + M[1] * ry - M[2]) * iz - pt[2];
          const dv = cy - f * (M[3] * rx + M[4] * ry - M[5]) * iz - pt[3];
          e2 = du * du + dv * dv;
        }
        if (e2 < tau2) { inl++; sq += e2; cost += e2; } else cost += tau2;
      }
    }
    return detail ? { cost, inliers: inl, rms: inl ? Math.sqrt(sq / inl) : Infinity } : cost;
  };

  const lo = Math.log((opts.minRel ?? 0.35) * long), hi = Math.log((opts.maxRel ?? 3) * long);
  const steps = 80;
  let bestK = 0, bestC = Infinity;
  for (let k = 0; k <= steps; k++) {
    const c = evalF(Math.exp(lo + (hi - lo) * k / steps));
    if (c < bestC) { bestC = c; bestK = k; }
  }
  let a = lo + (hi - lo) * Math.max(0, bestK - 1) / steps;
  let b = lo + (hi - lo) * Math.min(steps, bestK + 1) / steps;
  const phi = (Math.sqrt(5) - 1) / 2;
  let c = b - phi * (b - a), d = a + phi * (b - a);
  let fc = evalF(Math.exp(c)), fd = evalF(Math.exp(d));
  for (let it = 0; it < 40; it++) {
    if (fc < fd) { b = d; d = c; fd = fc; c = b - phi * (b - a); fc = evalF(Math.exp(c)); }
    else { a = c; c = d; fc = fd; d = a + phi * (b - a); fd = evalF(Math.exp(d)); }
  }
  const f = Math.exp((a + b) / 2);
  const det = evalF(f, true);
  return { f, rms: det.rms, inliers: det.inliers, total };
}

/**
 * Compensación de ganancia (Brown y Lowe, 2007): una ganancia por imagen que iguala el
 * brillo medio en los solapes, con un término que las mantiene cerca de 1.
 * stats: [{i, j, meanI, meanJ, n}]
 */
export function solveGains(stats, n, opts = {}) {
  const sigmaN = opts.sigmaN ?? 10, sigmaG = opts.sigmaG ?? 0.1;
  const A = new Float64Array(n * n), b = new Float64Array(n);
  for (const s of stats) {
    if (!s.n) continue;
    const k = s.n / (sigmaN * sigmaN);
    A[s.i * n + s.i] += k * s.meanI * s.meanI;
    A[s.j * n + s.j] += k * s.meanJ * s.meanJ;
    A[s.i * n + s.j] -= k * s.meanI * s.meanJ;
    A[s.j * n + s.i] -= k * s.meanI * s.meanJ;
    const p = s.n / (sigmaG * sigmaG) * 0.5;
    A[s.i * n + s.i] += p; b[s.i] += p;
    A[s.j * n + s.j] += p; b[s.j] += p;
  }
  for (let i = 0; i < n; i++) if (A[i * n + i] === 0) { A[i * n + i] = 1; b[i] = 1; }
  const g = Array.from(solveLinear(A, b, n));
  return g.map((v) => Math.max(0.5, Math.min(2, v)));
}

const unit = (K, x, y) => ray(K, x, y);

/**
 * Ajusta la rotación de un par (parte de M = R_bᵀ·R_a) a sus correspondencias y devuelve el
 * residuo angular de cada una. Sirve para comprobar que las coincidencias de un par son
 * coherentes con un único giro y descartar las falsas.
 * @param as,bs rayos unitarios en la cámara A y en la cámara B
 */
export function fitPair(as, bs, M0, iters = 4) {
  let M = M0;
  const n = as.length;
  const res = new Float64Array(n);
  const P = new Float64Array(n * 3);
  const evalRes = () => {
    for (let k = 0; k < n; k++) {
      const a = as[k], b = bs[k];
      const px = M[0] * a[0] + M[1] * a[1] + M[2] * a[2];
      const py = M[3] * a[0] + M[4] * a[1] + M[5] * a[2];
      const pz = M[6] * a[0] + M[7] * a[1] + M[8] * a[2];
      P[3 * k] = px; P[3 * k + 1] = py; P[3 * k + 2] = pz;
      res[k] = Math.hypot(px - b[0], py - b[1], pz - b[2]);
    }
  };
  evalRes();
  for (let it = 0; it < iters; it++) {
    const sorted = Array.from(res).sort((x, y) => x - y);
    const thr = Math.max(1.5 * sorted[n >> 1], 1e-4);
    const H = new Float64Array(9), g = new Float64Array(3);
    for (let k = 0; k < n; k++) {
      const wgt = res[k] <= thr ? 1 : thr / res[k];
      const px = P[3 * k], py = P[3 * k + 1], pz = P[3 * k + 2], b = bs[k];
      const r = [px - b[0], py - b[1], pz - b[2]];
      const J = [0, pz, -py, -pz, 0, px, py, -px, 0];
      for (let c = 0; c < 3; c++) {
        g[c] -= wgt * (J[c] * r[0] + J[3 + c] * r[1] + J[6 + c] * r[2]);
        for (let d = 0; d < 3; d++) H[c * 3 + d] += wgt * (J[c] * J[d] + J[3 + c] * J[3 + d] + J[6 + c] * J[6 + d]);
      }
    }
    for (let c = 0; c < 3; c++) H[c * 4] += 1e-9;
    const wv = solveLinear(H, g, 3);
    M = orthonormalize(mul(expSO3([wv[0], wv[1], wv[2]]), M));
    evalRes();
  }
  return { M, res };
}

export { ray as pixelRay };
