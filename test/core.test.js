import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as m from '../src/math3d.js';
import { renderEquirect, renderView } from '../src/scene.js';
import { grayFromRGBA } from '../src/match.js';
import { analyze, StripBlender, frameRowRange, planPairs, blurRGBA } from '../src/stitch-core.js';
import { generateTargets, Coverage } from '../src/targets.js';
import { calibrateFromSweep } from '../src/calibration.js';
import { buildExif, buildXmp, insertMetadata } from '../src/exif.js';
import { makeZip, crc32, readZip } from '../src/zip.js';
import { validFrameMeta } from '../src/import.js';

const D = m.DEG;
const close = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg ?? ''} ${a} vs ${b}`);

// Generador pseudoaleatorio determinista
function rng(seed) { return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296); }

test('orientación del dispositivo: móvil vertical mira al norte y alpha gira a la izquierda', () => {
  const R = m.fromDeviceOrientation(0, 90, 0);
  const f = m.forward(R);
  close(f[0], 0, 1e-9); close(f[1], 1, 1e-9); close(f[2], 0, 1e-9);
  // arriba de la imagen = arriba del mundo
  close(R[7], 1, 1e-9);
  const hpr = m.toHeadingPitchRoll(m.fromDeviceOrientation(30, 90, 0));
  close(hpr.h / D, -30, 1e-6, 'rumbo');
  // apaisado (pantalla girada 90°): la derecha de la imagen sigue siendo horizontal
  const L = m.fromDeviceOrientation(0, 0, -90, 90);
  const hl = m.toHeadingPitchRoll(L);
  close(hl.p / D, 0, 1e-6, 'elevación apaisado'); close(hl.r / D, 0, 1e-6, 'alabeo apaisado');
});

test('ida y vuelta rumbo/elevación/alabeo y ángulos de dispositivo', () => {
  const rand = rng(7);
  for (let k = 0; k < 200; k++) {
    const h = (rand() - 0.5) * 360 * D, p = (rand() - 0.5) * 170 * D, r = (rand() - 0.5) * 300 * D;
    const R = m.fromHeadingPitchRoll(h, p, r);
    const o = m.toHeadingPitchRoll(R);
    close(m.wrapPi(o.h - h), 0, 1e-9); close(o.p, p, 1e-9); close(m.wrapPi(o.r - r), 0, 1e-9);
    const e = m.toDeviceOrientation(R);
    assert.ok(m.angleBetween(R, m.fromDeviceOrientation(e.alpha, e.beta, e.gamma)) < 1e-6);
    assert.ok(e.gamma >= -90 && e.gamma <= 90 && e.alpha >= 0 && e.alpha < 360);
  }
  // caso degenerado: móvil exactamente vertical
  const R = m.fromHeadingPitchRoll(1, 0, 0);
  const e = m.toDeviceOrientation(R);
  assert.ok(m.angleBetween(R, m.fromDeviceOrientation(e.alpha, e.beta, e.gamma)) < 1e-6);
});

test('el plan de disparos cubre toda la esfera', () => {
  for (const [hf, vf, ov] of [[50, 65, 0.3], [40, 66, 0.25], [66, 40, 0.3], [60, 45, 0.4]]) {
    const K = m.intrinsics(Math.round(2 * 500 * Math.tan(hf * D / 2)), Math.round(2 * 500 * Math.tan(vf * D / 2)), 500);
    const targets = generateTargets(hf * D, vf * D, ov, 0.3);
    const cov = new Coverage(3);
    for (const t of targets) cov.addFrame(m.fromHeadingPitchRoll(t.h, t.p, 0), K);
    assert.ok(cov.fraction > 0.9999, `cobertura ${cov.fraction} con ${targets.length} fotos (${hf}x${vf})`);
    assert.ok(targets.length < 90);
  }
});

// --- Escena sintética compartida por las pruebas de cosido y calibración ---
const EW = 2048, EH = 1024;
const eq = { data: renderEquirect(EW, EH), w: EW, h: EH };

function shoot(R, K) {
  const rgba = renderView(eq, R, K, new Uint8ClampedArray(K.w * K.h * 4));
  return rgba;
}
function small(rgba, K, s) {
  const w = Math.round(K.w * s), h = Math.round(K.h * s);
  const out = new Float32Array(w * h);
  const g = grayFromRGBA(rgba, K.w, K.h);
  const inv = K.w / w;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // media de área (como hace drawImage al reducir)
      let sum = 0, n = 0;
      for (let yy = Math.floor(y * inv); yy < Math.min(K.h, Math.floor((y + 1) * inv)); yy++) {
        for (let xx = Math.floor(x * inv); xx < Math.min(K.w, Math.floor((x + 1) * inv)); xx++) { sum += g[yy * K.w + xx]; n++; }
      }
      out[y * w + x] = sum / n;
    }
  }
  return { data: out, w, h };
}

test('cosido: el refinamiento corrige la deriva del sensor y reconstruye la escena', () => {
  const K = m.intrinsics(360, 480, 420);          // retrato, ~46°x59°
  const fov = m.fovOf(K);
  const targets = generateTargets(fov.h, fov.v, 0.3, 0);
  const rand = rng(42);
  const truth = targets.map((t) => m.fromHeadingPitchRoll(t.h, t.p, (rand() - 0.5) * 4 * D));
  // error de sensor: deriva de rumbo creciente + ruido pequeño de inclinación
  const sensed = truth.map((R, i) => m.mul(m.expSO3([(rand() - 0.5) * 0.4 * D, (rand() - 0.5) * 0.4 * D, (i / truth.length) * 2.0 * D + (rand() - 0.5) * 0.8 * D]), R));
  const images = truth.map((R) => shoot(R, K));
  const gains = truth.map(() => 0.85 + rand() * 0.3);
  images.forEach((img, i) => { for (let k = 0; k < img.length; k += 4) { img[k] *= gains[i]; img[k + 1] *= gains[i]; img[k + 2] *= gains[i]; } });
  const grays = images.map((img) => small(img, K, 2 / 3));
  const frames = sensed.map((R) => ({ R, K }));

  const res = analyze(frames, grays, {});
  assert.ok(res.stats.matches > 500, `coincidencias: ${res.stats.matches}`);
  assert.ok(res.stats.medianAfterDeg < res.stats.medianBeforeDeg * 0.3, JSON.stringify(res.stats));
  assert.ok(res.stats.medianAfterDeg < 0.08, JSON.stringify(res.stats));

  // Error relativo entre fotos vecinas respecto a la verdad (la rotación global es libre)
  const rel = (Rs, i, j) => m.mul(m.transpose(Rs[i]), Rs[j]);
  let errBefore = 0, errAfter = 0;
  for (let i = 1; i < truth.length; i++) {
    errBefore = Math.max(errBefore, m.angleBetween(rel(truth, 0, i), rel(sensed, 0, i)));
    errAfter = Math.max(errAfter, m.angleBetween(rel(truth, 0, i), rel(res.rotations, 0, i)));
  }
  assert.ok(errAfter < errBefore * 0.4, `antes ${errBefore / D}° después ${errAfter / D}°`);

  // Las ganancias estimadas deben igualar la exposición (producto ~constante)
  const prod = res.gains.map((g, i) => g * gains[i]);
  const mean = prod.reduce((a, b) => a + b) / prod.length;
  for (const p of prod) close(p / mean, 1, 0.06, 'ganancia');

  // Mezcla por franjas y comparación con la escena original
  const W = 1024, H = 512;
  const out = new Uint8ClampedArray(W * H * 4);
  let empty = 0;
  for (const [y0, y1] of [[0, 200], [200, 512]]) {
    const b = new StripBlender(W, H, y0, y1);
    res.rotations.forEach((R, i) => {
      const [a, c] = frameRowRange(R, K, H);
      if (c > y0 && a < y1) b.addFrame(images[i], R, K, 1 / gains[i]);
    });
    const r = b.finish();
    out.set(r.rgba, y0 * W * 4); empty += r.empty;
  }
  assert.equal(empty, 0, 'sin huecos');
  // La rotación global del resultado respecto a la verdad es la de la foto 0
  const G = m.mul(truth[0], m.transpose(res.rotations[0]));
  const ref = renderEquirect(W, H);
  let sum = 0, n = 0;
  for (let y = 8; y < H - 8; y += 3) {
    const phi = (0.5 - (y + 0.5) / H) * Math.PI;
    for (let x = 0; x < W; x += 3) {
      const lam = ((x + 0.5) / W - 0.5) * 2 * Math.PI;
      const d = m.apply(G, m.dirFromHP(lam, phi));
      const u = Math.floor(((Math.atan2(d[0], d[1]) / (2 * Math.PI) + 0.5) * W + W) % W);
      const v = Math.min(H - 1, Math.max(0, Math.floor((0.5 - Math.asin(d[2]) / Math.PI) * H)));
      sum += Math.abs(out[(y * W + x) * 4 + 1] - ref[(v * W + u) * 4 + 1]); n++;
    }
  }
  assert.ok(sum / n < 9, `error medio de reconstrucción ${sum / n}`);
});

test('calibración por giro: recupera la focal real partiendo de una estimación errónea', async () => {
  for (const fTrue of [380, 520]) {
    const K = m.intrinsics(480, 360, fTrue);
    const rand = rng(fTrue);
    const poses = [];
    for (let i = 0; i < 6; i++) poses.push([i * 7 - 17, 2 * Math.sin(i)]);
    for (let i = 0; i < 6; i++) poses.push([3 * Math.cos(i), i * 6 - 15]);
    const samples = poses.map(([h, p]) => {
      const R = m.fromHeadingPitchRoll(h * D, p * D, (rand() - 0.5) * 3 * D);
      const gray = small(shoot(R, K), K, 2 / 3);
      // ruido de sensor de 0,15°
      const Rs = m.mul(m.expSO3([(rand() - 0.5) * 0.3 * D, (rand() - 0.5) * 0.3 * D, (rand() - 0.5) * 0.3 * D]), R);
      return { gray, R: Rs };
    });
    const res = await calibrateFromSweep(samples, 0.751);
    close(res.fRel, fTrue / 480, 0.02 * fTrue / 480, `focal relativa (${res.quality}, ${res.inliers}/${res.matches})`);
  }
});

test('EXIF y XMP: estructura válida y legible', () => {
  // JPEG mínimo: SOI + APP0 JFIF + SOS falso + EOI
  const jfif = [0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const jpeg = Uint8Array.from([0xff, 0xd8, ...jfif, 0xff, 0xda, 0, 2, 1, 2, 3, 0xff, 0xd9]);
  const date = new Date(2026, 10, 21, 12, 34, 56, 789);
  const exif = buildExif({
    date, width: 4096, height: 2048, description: 'Prueba', focal35: 26.4, heading: 123.456,
    gps: { lat: 40.4168, lon: -3.7038, alt: 667.5, time: date.getTime(), accuracy: 5 },
    comment: JSON.stringify({ yaw: 1.5 }),
  });
  const xmp = buildXmp({ gpano: { ProjectionType: 'equirectangular', FullPanoWidthPixels: 4096 }, sensor: { Alpha: 12.5 } });
  const out = insertMetadata(jpeg, { exif, xmp });
  // idempotente: reinsertar no duplica segmentos
  const again = insertMetadata(out, { exif, xmp });
  assert.equal(again.length, out.length);
  assert.deepEqual([...out.subarray(0, 4)], [0xff, 0xd8, 0xff, 0xe0]);
  assert.deepEqual([...out.subarray(out.length - 9)], [0xff, 0xda, 0, 2, 1, 2, 3, 0xff, 0xd9]);

  // Analizador TIFF independiente
  const start = 2 + jfif.length;
  assert.equal(String.fromCharCode(...out.subarray(start + 4, start + 8)), 'Exif');
  const tiff = out.subarray(start + 10);
  const dv = new DataView(tiff.buffer, tiff.byteOffset, exif.length);
  const readIfd = (off) => {
    const n = dv.getUint16(off, true), tags = {};
    let prev = -1;
    for (let i = 0; i < n; i++) {
      const p = off + 2 + i * 12;
      const tag = dv.getUint16(p, true), type = dv.getUint16(p + 2, true), count = dv.getUint32(p + 4, true);
      assert.ok(tag > prev, 'etiquetas ordenadas'); prev = tag;
      const size = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 10: 8 }[type] * count;
      const vo = size <= 4 ? p + 8 : dv.getUint32(p + 8, true);
      assert.ok(vo + size <= exif.length, 'datos dentro del bloque');
      if (type === 2) tags[tag] = String.fromCharCode(...tiff.subarray(vo, vo + count - 1));
      else if (type === 3) tags[tag] = dv.getUint16(vo, true);
      else if (type === 4) tags[tag] = dv.getUint32(vo, true);
      else if (type === 5) tags[tag] = Array.from({ length: count }, (_, k) => dv.getUint32(vo + k * 8, true) / dv.getUint32(vo + k * 8 + 4, true));
      else tags[tag] = tiff.subarray(vo, vo + count);
    }
    return tags;
  };
  const ifd0 = readIfd(dv.getUint32(4, true));
  assert.equal(ifd0[0x010e], 'Prueba');
  const ex = readIfd(ifd0[0x8769]);
  assert.equal(ex[0x9003], '2026:11:21 12:34:56');
  assert.equal(ex[0x9291], '789');
  assert.equal(ex[0xa002], 4096);
  assert.equal(ex[0xa405], 26);
  assert.equal(String.fromCharCode(...ex[0x9286].subarray(8)), '{"yaw":1.5}');
  const gps = readIfd(ifd0[0x8825]);
  assert.equal(gps[1], 'N'); assert.equal(gps[3], 'W');
  close(gps[2][0] + gps[2][1] / 60 + gps[2][2] / 3600, 40.4168, 1e-6);
  close(gps[4][0] + gps[4][1] / 60 + gps[4][2] / 3600, 3.7038, 1e-6);
  close(gps[6][0], 667.5, 1e-6); close(gps[0x11][0], 123.456, 1e-5);
  assert.ok(new TextDecoder().decode(out).includes('GPano:ProjectionType="equirectangular"'));
});

test('ZIP: lo extrae la herramienta unzip del sistema', async () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  const files = [
    { name: 'parte_001.jpg', data: Uint8Array.from([1, 2, 3, 4, 5]) },
    { name: 'metadatos ñ.json', data: new TextEncoder().encode('{"a":1}') },
  ];
  const blob = makeZip(files);
  const dir = mkdtempSync(join(tmpdir(), 'zip-'));
  const path = join(dir, 't.zip');
  writeFileSync(path, Buffer.from(await blob.arrayBuffer()));
  const listing = execFileSync('unzip', ['-t', path]).toString();
  assert.match(listing, /No errors detected/);
  assert.equal(execFileSync('unzip', ['-p', path, 'metadatos ñ.json']).toString(), '{"a":1}');
});

test('ZIP: lectura de lo exportado y de un ZIP comprimido con otra herramienta', async () => {
  const big = new Uint8Array(50000).map((_, i) => (i * 7) % 251);
  const files = [
    { name: 'parte_001.jpg', data: big },
    { name: 'metadatos.json', data: new TextEncoder().encode('{"fotos":[]}') },
  ];
  const own = await readZip(makeZip(files));
  assert.deepEqual(own.map((e) => e.name), ['parte_001.jpg', 'metadatos.json']);
  assert.deepEqual(new Uint8Array(await (await own[0].blob()).arrayBuffer()), big);
  assert.equal(await (await own[1].blob()).text(), '{"fotos":[]}');

  // rehecho con `zip` del sistema: Deflate y dentro de una carpeta
  const dir = mkdtempSync(join(tmpdir(), 'zipr-'));
  mkdirSync(join(dir, 'carpeta'));
  writeFileSync(join(dir, 'carpeta', 'parte_001.jpg'), big);
  writeFileSync(join(dir, 'carpeta', 'metadatos.json'), '{"fotos":[]}');
  execFileSync('zip', ['-q', '-r', 'otro.zip', 'carpeta'], { cwd: dir });
  const other = await readZip(new Blob([readFileSync(join(dir, 'otro.zip'))]));
  const part = other.find((e) => e.name === 'carpeta/parte_001.jpg');
  assert.deepEqual(new Uint8Array(await (await part.blob()).arrayBuffer()), big);

  await assert.rejects(readZip(new Blob([big])), /ZIP válido/);
});

test('importación: validación de metadatos de foto', () => {
  const ok = { idx: 0, R: [1, 0, 0, 0, 1, 0, 0, 0, 1], w: 540, h: 720, f: 576, time: 5 };
  assert.equal(validFrameMeta(ok).speed, 0);
  assert.equal(validFrameMeta({ ...ok, R: [1, 2] }), null);
  assert.equal(validFrameMeta({ ...ok, f: 'x' }), null);
  assert.equal(validFrameMeta({ ...ok, idx: -1 }), null);
  assert.equal(validFrameMeta(null), null);
});

test('cosido: focal errónea sin calibrar y sensores imprecisos; sólo fotos contiguas', () => {
  const K = m.intrinsics(360, 480, 420);
  const fov = m.fovOf(K);
  const targets = generateTargets(fov.h, fov.v, 0.3, 0);
  const rand = rng(11);
  const truth = targets.map((t) => m.fromHeadingPitchRoll(t.h, t.p, (rand() - 0.5) * 4 * D));
  // sensores con 1,5° de ruido de rumbo y cámara con la focal mal supuesta (+10 %)
  const sensed = truth.map((R) => m.mul(m.expSO3([(rand() - 0.5) * D, (rand() - 0.5) * D, (rand() - 0.5) * 3 * D]), R));
  const grays = truth.map((R) => small(shoot(R, K), K, 2 / 3));
  const wrong = { ...K, f: K.f * 1.1 };
  const frames = sensed.map((R) => ({ R, K: wrong }));

  const all = planPairs(frames), adj = planPairs(frames, { adjacentOnly: true });
  assert.ok(adj.length < all.length && adj.length >= frames.length, `pares: ${adj.length} contiguos de ${all.length}`);
  const used = new Set(adj.flat());
  assert.equal(used.size, frames.length, 'todas las fotos tienen vecinas');

  const res = analyze(frames, grays, { adjacentOnly: true, autoFocal: true });
  close(res.focalScale * 1.1, 1, 0.015, 'focal corregida');
  assert.ok(res.stats.medianAfterDeg < 0.08, JSON.stringify(res.stats));
  const rel = (Rs, i, j) => m.mul(m.transpose(Rs[i]), Rs[j]);
  let err = 0;
  for (let i = 1; i < truth.length; i++) err = Math.max(err, m.angleBetween(rel(truth, 0, i), rel(res.rotations, 0, i)));
  assert.ok(err < 0.4 * D, `error máximo ${err / D}°`);

  // sin autocalibrar, la focal errónea no debe empeorar la orientación de los sensores
  const plain = analyze(frames, grays, { adjacentOnly: true });
  assert.equal(plain.focalScale, 1);
});

test('mezcla: el desenfoque conserva una imagen uniforme y ambas mezclas dan lo mismo sin solapes conflictivos', () => {
  const w = 40, h = 30;
  const flat = new Uint8ClampedArray(w * h * 4).fill(120);
  assert.ok(blurRGBA(flat, w, h, 4).every((v, i) => i % 4 === 3 || v === 120));
  const K = m.intrinsics(w, h, 30);
  for (const twoBand of [true, false]) {
    const b = new StripBlender(64, 32, 0, 32, { twoBand });
    b.addFrame(flat, m.fromHeadingPitchRoll(0, 0, 0), K, 1);
    b.addFrame(flat, m.fromHeadingPitchRoll(0.3, 0.1, 0), K, 1);
    const out = b.finish().rgba;
    let covered = 0;
    for (let i = 0; i < out.length; i += 4) if (out[i] !== 16) { covered++; assert.ok(Math.abs(out[i] - 120) <= 1, `valor ${out[i]}`); }
    assert.ok(covered > 50);
  }
});
