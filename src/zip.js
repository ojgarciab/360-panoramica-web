// Generador ZIP mínimo (método "store", sin compresión: los JPEG ya están comprimidos).

let table = null;
export function crc32(bytes) {
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = table[(crc ^ bytes[i]) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * @param files [{name:string, data:Uint8Array, date?:Date}]
 * @returns Blob application/zip
 */
export function makeZip(files) {
  const enc = new TextEncoder();
  const parts = [], central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const d = f.date ?? new Date();
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const date = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    const crc = crc32(f.data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // nombres UTF-8
    local.setUint16(8, 0, true);
    local.setUint16(10, time, true); local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, f.data.length, true); local.setUint32(22, f.data.length, true);
    local.setUint16(26, name.length, true); local.setUint16(28, 0, true);
    parts.push(local.buffer, name, f.data);

    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true);
    cen.setUint16(4, 20, true); cen.setUint16(6, 20, true);
    cen.setUint16(8, 0x0800, true); cen.setUint16(10, 0, true);
    cen.setUint16(12, time, true); cen.setUint16(14, date, true);
    cen.setUint32(16, crc, true);
    cen.setUint32(20, f.data.length, true); cen.setUint32(24, f.data.length, true);
    cen.setUint16(28, name.length, true);
    cen.setUint32(42, offset, true);
    central.push(cen.buffer, name);
    offset += 30 + name.length + f.data.length;
  }
  const cenSize = central.reduce((s, b) => s + b.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cenSize, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
}

/**
 * Lee un ZIP desde un Blob/File sin cargarlo entero en memoria.
 * Admite entradas sin comprimir y con Deflate (por si el ZIP se rehízo con otra herramienta).
 * @returns [{name, size, blob(): Promise<Blob>}]
 */
export async function readZip(file) {
  const view = async (start, end) => new DataView(await file.slice(start, end).arrayBuffer());
  const tailStart = Math.max(0, file.size - 65557);
  const tail = await view(tailStart, file.size);
  let e = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === 0x06054b50) { e = i; break; }
  }
  if (e < 0) throw new Error('El archivo no es un ZIP válido');
  const count = tail.getUint16(e + 10, true);
  const cenSize = tail.getUint32(e + 12, true), cenOff = tail.getUint32(e + 16, true);
  if (count === 0xffff || cenOff === 0xffffffff) throw new Error('No se admiten archivos ZIP64');
  const cen = await view(cenOff, cenOff + cenSize);
  const dec = new TextDecoder();
  const entries = [];
  let p = 0;
  for (let k = 0; k < count; k++) {
    if (p + 46 > cen.byteLength || cen.getUint32(p, true) !== 0x02014b50) throw new Error('Directorio del ZIP dañado');
    const flags = cen.getUint16(p + 8, true), method = cen.getUint16(p + 10, true);
    const csize = cen.getUint32(p + 20, true), size = cen.getUint32(p + 24, true);
    const nameLen = cen.getUint16(p + 28, true), extraLen = cen.getUint16(p + 30, true), commentLen = cen.getUint16(p + 32, true);
    const offset = cen.getUint32(p + 42, true);
    const name = dec.decode(new Uint8Array(cen.buffer, p + 46, nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    entries.push({
      name, size,
      async blob(type = '') {
        if (flags & 1) throw new Error('No se admiten ZIP cifrados');
        const lh = await view(offset, offset + 30);
        if (lh.getUint32(0, true) !== 0x04034b50) throw new Error(`Entrada dañada: ${name}`);
        const start = offset + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
        const raw = file.slice(start, start + csize);
        if (method === 0) return new Blob([raw], { type });
        if (method !== 8 || !globalThis.DecompressionStream) throw new Error(`Compresión no admitida en ${name}`);
        const out = await new Response(raw.stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer();
        return new Blob([out], { type });
      },
    });
  }
  return entries;
}
