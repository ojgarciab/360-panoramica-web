// Plan de disparos (puntos guía sobre la esfera) y mapa de cobertura.
import { DEG, dirFromHP } from './math3d.js';

/**
 * Genera los puntos a fotografiar para cubrir toda la esfera.
 * @param hfov,vfov campo de visión (rad) tal como se sostiene el móvil
 * @param overlap solape deseado entre fotos vecinas (0..1)
 * @param h0 rumbo de la primera foto (rad)
 * @returns [{h, p, ring}] ordenados: ecuador, anillos superiores, inferiores, cénit y nadir.
 */
export function generateTargets(hfov, vfov, overlap = 0.3, h0 = 0) {
  const stepV = vfov * (1 - overlap), stepH = hfov * (1 - overlap);
  const P = Math.PI / 2 - vfov / 2;
  const K = P > 0 ? Math.max(1, Math.ceil(P / stepV)) : 0;
  const pitches = [0];
  for (let k = 1; k <= K; k++) pitches.push(k * P / K);
  for (let k = 1; k <= K; k++) pitches.push(-k * P / K);
  const out = [];
  pitches.forEach((p, ring) => {
    const eff = Math.cos(Math.max(0, Math.abs(p) - vfov / 4));
    const n = Math.max(3, Math.ceil(2 * Math.PI * eff / stepH));
    for (let i = 0; i < n; i++) out.push({ h: h0 + i * 2 * Math.PI / n, p, ring });
  });
  out.push({ h: h0, p: Math.PI / 2, ring: pitches.length, pole: true });
  out.push({ h: h0, p: -Math.PI / 2, ring: pitches.length + 1, pole: true });
  return out;
}

/** Rejilla latitud/longitud que registra qué zonas de la esfera ya tienen foto. */
export class Coverage {
  constructor(stepDeg = 3) {
    this.step = stepDeg * DEG;
    this.nLon = Math.round(360 / stepDeg);
    this.nLat = Math.round(180 / stepDeg);
    this.cells = new Uint8Array(this.nLon * this.nLat);
    this.dirs = new Float32Array(this.cells.length * 3);
    this.weights = new Float32Array(this.nLat);
    this.totalWeight = 0;
    for (let j = 0; j < this.nLat; j++) {
      const p = Math.PI / 2 - (j + 0.5) * this.step;
      this.weights[j] = Math.cos(p);
      this.totalWeight += this.weights[j] * this.nLon;
      for (let i = 0; i < this.nLon; i++) {
        const d = dirFromHP(-Math.PI + (i + 0.5) * this.step, p);
        this.dirs.set(d, (j * this.nLon + i) * 3);
      }
    }
    this.covered = 0;
  }

  /** Marca las celdas que caen dentro del encuadre (reducido un margen de seguridad). */
  addFrame(R, K, margin = 0.04) {
    const { dirs, cells } = this;
    const tx = (K.w / 2) * (1 - margin) / K.f, ty = (K.h / 2) * (1 - margin) / K.f;
    for (let c = 0; c < cells.length; c++) {
      if (cells[c]) continue;
      const dx = dirs[c * 3], dy = dirs[c * 3 + 1], dz = dirs[c * 3 + 2];
      const z = R[2] * dx + R[5] * dy + R[8] * dz;
      if (z > -1e-3) continue;
      const x = (R[0] * dx + R[3] * dy + R[6] * dz) / -z;
      if (x < -tx || x > tx) continue;
      const y = (R[1] * dx + R[4] * dy + R[7] * dz) / -z;
      if (y < -ty || y > ty) continue;
      cells[c] = 1;
      this.covered += this.weights[(c / this.nLon) | 0];
    }
  }

  get fraction() { return this.covered / this.totalWeight; }

  /** ¿Está cubierta la dirección de mundo (x, y, z)? */
  isCovered(x, y, z) {
    const h = Math.atan2(x, y), p = Math.asin(Math.max(-1, Math.min(1, z)));
    let i = Math.floor((h + Math.PI) / this.step); if (i >= this.nLon) i = this.nLon - 1; if (i < 0) i = 0;
    let j = Math.floor((Math.PI / 2 - p) / this.step); if (j >= this.nLat) j = this.nLat - 1; if (j < 0) j = 0;
    return this.cells[j * this.nLon + i] === 1;
  }
}
