// Motor de cosido con estado. Se ejecuta dentro de un Worker (o en el hilo principal si el
// navegador no admite Workers de tipo módulo).
import { analyze, StripBlender } from './stitch-core.js';

export class StitchEngine {
  constructor(onProgress = () => {}) {
    this.onProgress = onProgress;
    this.grays = [];
    this.frames = null;
    this.rotations = null;
    this.gains = null;
    this.blender = null;
  }

  gray({ i, data, w, h }) { this.grays[i] = { data, w, h }; }

  analyze({ frames, options }) {
    this.frames = frames;
    const res = analyze(frames, this.grays, options, this.onProgress);
    this.rotations = res.rotations;
    this.gains = res.gains;
    // la focal puede haberse corregido con las propias fotos
    this.frames = frames.map((f) => ({ ...f, K: { ...f.K, f: f.K.f * res.focalScale } }));
    this.grays = [];
    return { result: res };
  }

  beginStrip({ W, H, y0, y1, twoBand }) { this.blender = new StripBlender(W, H, y0, y1, { twoBand: twoBand !== false }); }

  addFrame({ i, data }) {
    this.blender.addFrame(data, this.rotations[i], this.frames[i].K, this.gains[i]);
  }

  endStrip() {
    const r = this.blender.finish();
    this.blender = null;
    return { result: r, transfer: [r.rgba.buffer] };
  }
}

/** Crea un cliente del motor: Worker si es posible, o ejecución directa como alternativa. */
export async function createEngineClient(onProgress) {
  try {
    const worker = new Worker(new URL('./stitch-worker.js', import.meta.url), { type: 'module' });
    let seq = 0;
    const pending = new Map();
    let failed = null;
    worker.onmessage = (e) => {
      if (e.data.progress != null) return onProgress(e.data.progress);
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      if (e.data.error) p.reject(new Error(e.data.error)); else p.resolve(e.data.result);
    };
    worker.onerror = (e) => {
      failed = new Error(e.message || 'Fallo del Worker de cosido');
      for (const p of pending.values()) p.reject(failed);
      pending.clear();
    };
    const call = (method, args, transfer = []) => new Promise((resolve, reject) => {
      if (failed) return reject(failed);
      const id = ++seq;
      pending.set(id, { resolve, reject });
      worker.postMessage({ id, method, args }, transfer);
    });
    // comprobación de vida: si el módulo no carga, se usa la alternativa en línea
    await Promise.race([
      call('beginStrip', { W: 2, H: 1, y0: 0, y1: 1 }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('sin respuesta')), 4000)),
    ]);
    return { call, close: () => worker.terminate(), threaded: true };
  } catch {
    const engine = new StitchEngine(onProgress);
    return {
      call: async (method, args) => {
        await new Promise((r) => setTimeout(r, 0));
        return engine[method](args)?.result;
      },
      close: () => {},
      threaded: false,
    };
  }
}
