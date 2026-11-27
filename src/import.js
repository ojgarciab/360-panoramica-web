// Importación de un ZIP de partes exportado anteriormente («Descargar partes»).
// Recrea la captura (fotos + lecturas de sensores) para poder volver a coserla.
import { readZip } from './zip.js';
import * as db from './db.js';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** Comprueba y normaliza los metadatos de una foto; devuelve null si no son utilizables. */
export function validFrameMeta(m) {
  if (!m || !Number.isInteger(m.idx) || m.idx < 0) return null;
  if (!Array.isArray(m.R) || m.R.length !== 9 || !m.R.every(isNum)) return null;
  if (!(isNum(m.w) && isNum(m.h) && isNum(m.f) && m.w > 0 && m.h > 0 && m.f > 0)) return null;
  return { ...m, time: isNum(m.time) ? m.time : Date.now(), speed: isNum(m.speed) ? m.speed : 0 };
}

/**
 * Lee el ZIP y empareja cada foto con sus metadatos.
 * @returns {{session:object, frames:[{blob, meta}], missing:number}}
 */
export async function parseExport(file) {
  const entries = await readZip(file);
  const base = (n) => n.split('/').pop();
  const metaEntry = entries.find((e) => base(e.name) === 'metadatos.json');
  if (!metaEntry) throw new Error('El ZIP no contiene metadatos.json: no es una exportación de esta aplicación');
  let data;
  try { data = JSON.parse(await (await metaEntry.blob()).text()); } catch { throw new Error('metadatos.json está dañado'); }
  if (!Array.isArray(data?.fotos)) throw new Error('metadatos.json no tiene la lista de fotos');
  const byName = new Map(entries.map((e) => [base(e.name).toLowerCase(), e]));
  const frames = [];
  let missing = 0;
  for (const raw of data.fotos) {
    const meta = validFrameMeta(raw);
    const entry = meta && byName.get(`parte_${String(meta.idx + 1).padStart(3, '0')}.jpg`);
    if (!entry) { missing++; continue; }
    const blob = await entry.blob('image/jpeg');
    const head = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
    if (head[0] !== 0xff || head[1] !== 0xd8) { missing++; continue; }
    frames.push({ blob, meta });
  }
  if (!frames.length) throw new Error('El ZIP no contiene fotos utilizables');
  frames.sort((a, b) => a.meta.idx - b.meta.idx);
  return { session: data.sesion && typeof data.sesion === 'object' ? data.sesion : {}, frames, missing };
}

/** Importa el ZIP como una captura nueva (sin panorámica generada). Devuelve su id. */
export async function importExport(file) {
  const { session: old, frames, missing } = await parseExport(file);
  const now = Date.now();
  const id = `s${now}`;
  const created = isNum(old.created) ? old.created : frames[0].meta.time;
  const session = {
    id, created, imported: now,
    name: `${typeof old.name === 'string' && old.name ? old.name : 'Panorámica'} (importada)`,
    status: 'capturada', frameCount: frames.length,
    h0: isNum(old.h0) ? old.h0 : undefined,
    camera: old.camera, calibKey: old.calibKey, fRel: old.fRel,
    calibrated: !!(old.calibrated ?? frames[0].meta.calibrated), planned: old.planned, coverage: old.coverage,
  };
  await db.putSession(session);
  try {
    for (const f of frames) await db.addFrame({ sessionId: id, blob: f.blob, meta: f.meta });
  } catch (e) {
    await db.deleteSession(id);
    throw e;
  }
  return { id, count: frames.length, missing };
}
