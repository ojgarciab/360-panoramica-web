// Calibración de cámara: almacenamiento local y autocalibración por giro asistida por sensores.
//
// Método implementado ("giro con sensores"): se toman varias fotos girando el móvil sobre sí
// mismo. Los sensores dan la rotación entre fotos; el desplazamiento de la imagen que produce
// una rotación conocida depende sólo de la focal, así que se busca la focal que mejor explica
// las correspondencias medidas. Véase docs/calibracion.md para el estudio de alternativas.
import { mul, transpose, forward, defaultFocalRel } from './math3d.js';
import { matchPair } from './match.js';
import { estimateFocal } from './optimize.js';

const STORE_KEY = 'pano360.calibraciones.v1';

export function cameraKey(label, w, h) {
  const long = Math.max(w, h), short = Math.min(w, h);
  return `${label || 'camara'}|${long}x${short}`;
}

export function loadCalibrations() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch { return {}; }
}

export function getCalibration(key) { return loadCalibrations()[key] || null; }

export function saveCalibration(key, calib) {
  const all = loadCalibrations();
  all[key] = { ...calib, date: new Date().toISOString() };
  localStorage.setItem(STORE_KEY, JSON.stringify(all));
  return all[key];
}

export function deleteCalibration(key) {
  const all = loadCalibrations();
  delete all[key];
  localStorage.setItem(STORE_KEY, JSON.stringify(all));
}

/** Focal relativa (focal en px / lado largo) a usar para una cámara. */
export function focalRelFor(key) {
  return getCalibration(key)?.fRel ?? defaultFocalRel;
}

/**
 * Autocalibración a partir de un barrido.
 * @param samples [{gray:{data,w,h}, R}] fotos reducidas en gris con la orientación del sensor
 * @param fRelGuess focal relativa inicial
 * @returns {fRel, rmsRel, matches, inliers, pairs, quality}
 */
export async function calibrateFromSweep(samples, fRelGuess = defaultFocalRel, onProgress = () => {}) {
  const { w, h } = samples[0].gray;
  const long = Math.max(w, h);
  let f = fRelGuess * long;
  let result = null;
  const rounds = 3;
  for (let round = 0; round < rounds; round++) {
    const K = { w, h, f, cx: (w - 1) / 2, cy: (h - 1) / 2 };
    const maxAngle = 0.75 * 2 * Math.atan(Math.min(w, h) / 2 / f);
    const pairs = [];
    for (let i = 0; i < samples.length; i++) {
      for (let j = i + 1; j < samples.length; j++) {
        const a = forward(samples[i].R), b = forward(samples[j].R);
        const ang = Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));
        if (ang > 0.03 && ang < maxAngle) pairs.push([i, j]);
      }
    }
    const data = [];
    let k = 0;
    for (const [i, j] of pairs) {
      const M = mul(transpose(samples[j].R), samples[i].R);
      // radio de búsqueda amplio en la primera ronda: la focal inicial puede estar lejos
      const r = matchPair(samples[i].gray, K, samples[j].gray, K, M, { search: round === 0 ? 16 : 8, grid: 9 });
      if (r.matches.length >= 6) data.push({ Ra: samples[i].R, Rb: samples[j].R, pts: r.matches });
      onProgress((round + ++k / pairs.length) / rounds);
      if (k % 4 === 0) await new Promise((res) => setTimeout(res, 0));
    }
    const total = data.reduce((s, d) => s + d.pts.length, 0);
    if (total < 20) {
      if (result) break;
      throw new Error('No se encontraron suficientes coincidencias. Apunta a una escena con detalle y gira despacio.');
    }
    const est = estimateFocal(data, w, h);
    result = { ...est, pairs: data.length };
    f = est.f;
  }
  const fRel = result.f / long;
  const rmsRel = result.rms / long;
  const ratio = result.inliers / result.total;
  const quality = ratio > 0.7 && rmsRel < 0.004 && result.inliers >= 60 ? 'buena'
    : ratio > 0.5 && rmsRel < 0.006 && result.inliers >= 30 ? 'aceptable' : 'baja';
  return { fRel, rmsRel, matches: result.total, inliers: result.inliers, pairs: result.pairs, quality, method: 'giro-sensores' };
}
