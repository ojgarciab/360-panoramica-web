// Worker de cosido: mantiene el estado pesado fuera del hilo de la interfaz.
import { StitchEngine } from './stitch-engine.js';

const engine = new StitchEngine((p) => postMessage({ progress: p }));

onmessage = (e) => {
  const { id, method, args } = e.data;
  try {
    const { result, transfer } = engine[method](args) ?? {};
    postMessage({ id, result }, transfer ?? []);
  } catch (err) {
    postMessage({ id, error: String(err?.message || err) });
  }
};
