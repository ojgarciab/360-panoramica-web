// Escritor mínimo de metadatos para JPEG: EXIF (TIFF little-endian) y XMP (GPano).
// Sin dependencias; inserta los segmentos APP1 tras la cabecera JFIF.

const T = { BYTE: 1, ASCII: 2, SHORT: 3, LONG: 4, RATIONAL: 5, UNDEFINED: 7, SRATIONAL: 10 };
const SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 10: 8 };
const enc = new TextEncoder();

const ascii = (tag, s) => ({ tag, type: T.ASCII, data: enc.encode(String(s).replace(/[^\x20-\x7e]/g, '?') + '\0') });
const short = (tag, ...v) => ({ tag, type: T.SHORT, values: v });
const long = (tag, ...v) => ({ tag, type: T.LONG, values: v });
const bytes = (tag, ...v) => ({ tag, type: T.BYTE, data: Uint8Array.from(v) });
const undef = (tag, data) => ({ tag, type: T.UNDEFINED, data });
const rational = (tag, ...v) => ({ tag, type: T.RATIONAL, values: v.map(toRational) });
const srational = (tag, ...v) => ({ tag, type: T.SRATIONAL, values: v.map(toRational) });

function toRational(x) {
  if (Array.isArray(x)) return x;
  if (!Number.isFinite(x)) return [0, 1];
  let den = 1000000;
  while (Math.abs(x) * den > 2147483647 && den > 1) den /= 10;
  return [Math.round(x * den), den];
}

function entryBytes(e) {
  if (e.data) return e.data;
  const count = e.values.length;
  const buf = new ArrayBuffer(count * SIZE[e.type]);
  const dv = new DataView(buf);
  e.values.forEach((v, i) => {
    if (e.type === T.SHORT) dv.setUint16(i * 2, v, true);
    else if (e.type === T.LONG) dv.setUint32(i * 4, v, true);
    else if (e.type === T.RATIONAL) { dv.setUint32(i * 8, v[0], true); dv.setUint32(i * 8 + 4, v[1], true); }
    else if (e.type === T.SRATIONAL) { dv.setInt32(i * 8, v[0], true); dv.setInt32(i * 8 + 4, v[1], true); }
  });
  return new Uint8Array(buf);
}

function ifdSize(entries) {
  let s = 2 + entries.length * 12 + 4;
  for (const e of entries) {
    const n = (e._bytes ??= entryBytes(e)).length;
    if (n > 4) s += n + (n & 1);
  }
  return s;
}

function writeIfd(out, dv, offset, entries) {
  entries.sort((a, b) => a.tag - b.tag);
  dv.setUint16(offset, entries.length, true);
  let p = offset + 2;
  let dataOff = offset + 2 + entries.length * 12 + 4;
  for (const e of entries) {
    const b = e._bytes ??= entryBytes(e);
    dv.setUint16(p, e.tag, true);
    dv.setUint16(p + 2, e.type, true);
    dv.setUint32(p + 4, b.length / SIZE[e.type], true);
    if (b.length <= 4) out.set(b, p + 8);
    else { dv.setUint32(p + 8, dataOff, true); out.set(b, dataOff); dataOff += b.length + (b.length & 1); }
    p += 12;
  }
  dv.setUint32(p, 0, true);
}

const pad = (n, l = 2) => String(n).padStart(l, '0');

function exifDate(d) {
  return `${d.getFullYear()}:${pad(d.getMonth() + 1)}:${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function exifOffset(d) {
  const o = -d.getTimezoneOffset();
  return `${o < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(o) / 60))}:${pad(Math.abs(o) % 60)}`;
}
function dms(v) {
  v = Math.abs(v);
  const d = Math.floor(v), m = Math.floor((v - d) * 60);
  return [[d, 1], [m, 1], [Math.round(((v - d) * 60 - m) * 60 * 10000), 10000]];
}

/**
 * Construye el bloque TIFF de EXIF.
 * @param m {date, width, height, description, software, make, model, focal35, heading, gps:{lat,lon,alt,time}, comment}
 */
export function buildExif(m) {
  const date = m.date ?? new Date();
  const ifd0 = [
    ascii(0x0131, m.software ?? 'Panoramica 360 Web'),
    ascii(0x0132, exifDate(date)),
    short(0x0112, 1),
  ];
  if (m.description) ifd0.push(ascii(0x010e, m.description));
  if (m.make) ifd0.push(ascii(0x010f, m.make));
  if (m.model) ifd0.push(ascii(0x0110, m.model));

  const exif = [
    undef(0x9000, enc.encode('0232')),
    ascii(0x9003, exifDate(date)),
    ascii(0x9004, exifDate(date)),
    ascii(0x9011, exifOffset(date)),
    ascii(0x9291, pad(date.getMilliseconds(), 3)),
    short(0xa001, 1),
  ];
  if (m.width) exif.push(long(0xa002, m.width), long(0xa003, m.height));
  if (m.focal35) exif.push(short(0xa405, Math.max(1, Math.min(65535, Math.round(m.focal35)))));
  if (m.comment) {
    const txt = enc.encode(m.comment.replace(/[^\x20-\x7e]/g, '?'));
    const uc = new Uint8Array(8 + txt.length);
    uc.set(enc.encode('ASCII\0\0\0')); uc.set(txt, 8);
    exif.push(undef(0x9286, uc));
  }

  const gps = [];
  const g = m.gps;
  if (g || m.heading != null) gps.push(bytes(0x0000, 2, 3, 0, 0));
  if (g && Number.isFinite(g.lat) && Number.isFinite(g.lon)) {
    gps.push(ascii(0x0001, g.lat >= 0 ? 'N' : 'S'), rational(0x0002, ...dms(g.lat)));
    gps.push(ascii(0x0003, g.lon >= 0 ? 'E' : 'W'), rational(0x0004, ...dms(g.lon)));
    if (Number.isFinite(g.alt)) gps.push(bytes(0x0005, g.alt < 0 ? 1 : 0), rational(0x0006, Math.abs(g.alt)));
    if (g.time) {
      const t = new Date(g.time);
      gps.push(rational(0x0007, [t.getUTCHours(), 1], [t.getUTCMinutes(), 1], [t.getUTCSeconds(), 1]));
      gps.push(ascii(0x001d, `${t.getUTCFullYear()}:${pad(t.getUTCMonth() + 1)}:${pad(t.getUTCDate())}`));
    }
    if (Number.isFinite(g.accuracy)) gps.push(rational(0x001f, g.accuracy));
  }
  if (m.heading != null) {
    gps.push(ascii(0x0010, 'M'), rational(0x0011, ((m.heading % 360) + 360) % 360));
  }

  const exifPtr = long(0x8769, 0);
  ifd0.push(exifPtr);
  let gpsPtr = null;
  if (gps.length) { gpsPtr = long(0x8825, 0); ifd0.push(gpsPtr); }

  const off0 = 8, offExif = off0 + ifdSize(ifd0), offGps = offExif + ifdSize(exif);
  const total = offGps + (gps.length ? ifdSize(gps) : 0);
  exifPtr.values[0] = offExif; delete exifPtr._bytes;
  if (gpsPtr) { gpsPtr.values[0] = offGps; delete gpsPtr._bytes; }

  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  out.set([0x49, 0x49, 0x2a, 0x00]);
  dv.setUint32(4, 8, true);
  writeIfd(out, dv, off0, ifd0);
  writeIfd(out, dv, offExif, exif);
  if (gps.length) writeIfd(out, dv, offGps, gps);
  return out;
}

const xmlEsc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Paquete XMP. `gpano` y `sensor` son objetos planos clave -> valor. */
export function buildXmp({ gpano = {}, sensor = {} }) {
  const attrs = [];
  for (const [k, v] of Object.entries(gpano)) if (v != null) attrs.push(`GPano:${k}="${xmlEsc(v)}"`);
  for (const [k, v] of Object.entries(sensor)) if (v != null) attrs.push(`pano360:${k}="${xmlEsc(v)}"`);
  return '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>'
    + '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
    + '<rdf:Description rdf:about="" xmlns:GPano="http://ns.google.com/photos/1.0/panorama/"'
    + ' xmlns:pano360="https://github.com/ojgarciab/360-panoramica-web/ns/1.0/" '
    + attrs.join(' ') + '/></rdf:RDF></x:xmpmeta><?xpacket end="w"?>';
}

function app1(header, payload) {
  const len = 2 + header.length + payload.length;
  if (len > 65535) throw new Error('Segmento de metadatos demasiado grande');
  const seg = new Uint8Array(2 + len);
  seg[0] = 0xff; seg[1] = 0xe1; seg[2] = len >> 8; seg[3] = len & 255;
  seg.set(header, 4); seg.set(payload, 4 + header.length);
  return seg;
}

/**
 * Inserta EXIF y/o XMP en un JPEG (sustituye los APP1 que hubiera).
 * @param jpeg Uint8Array   @returns Uint8Array
 */
export function insertMetadata(jpeg, { exif, xmp }) {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error('No es un JPEG');
  const keep = [];
  let p = 2, insertAt = 2;
  // Recorre los segmentos de cabecera hasta SOS, descartando APP1 previos.
  while (p + 4 <= jpeg.length && jpeg[p] === 0xff) {
    const marker = jpeg[p + 1];
    if (marker === 0xda || marker === 0xd9) break;
    const len = (jpeg[p + 2] << 8) | jpeg[p + 3];
    const seg = jpeg.subarray(p, p + 2 + len);
    if (marker !== 0xe1) keep.push(seg);
    p += 2 + len;
  }
  const head = [];
  let jfif = 0;
  if (keep.length && keep[0][1] === 0xe0) { head.push(keep[0]); jfif = 1; }
  if (exif) head.push(app1(enc.encode('Exif\0\0'), exif));
  if (xmp) head.push(app1(enc.encode('http://ns.adobe.com/xap/1.0/\0'), enc.encode(xmp)));
  for (let i = jfif; i < keep.length; i++) head.push(keep[i]);
  const rest = jpeg.subarray(p);
  const total = insertAt + head.reduce((s, b) => s + b.length, 0) + rest.length;
  const out = new Uint8Array(total);
  out[0] = 0xff; out[1] = 0xd8;
  let o = 2;
  for (const b of head) { out.set(b, o); o += b.length; }
  out.set(rest, o);
  return out;
}

/** Añade metadatos a un Blob JPEG y devuelve otro Blob. */
export async function tagJpegBlob(blob, meta) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return new Blob([insertMetadata(bytes, meta)], { type: 'image/jpeg' });
}
