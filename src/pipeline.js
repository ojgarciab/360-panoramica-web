// Orquestación del cosido: decodifica las fotos guardadas, las analiza y las mezcla por
// franjas en un Worker, y codifica el JPEG final con sus metadatos.
import { createEngineClient } from './stitch-engine.js';
import { frameRowRange } from './stitch-core.js';
import { grayDownsample } from './match.js';
import { mul, rotZ, toHeadingPitchRoll, DEG } from './math3d.js';
import { buildExif, buildXmp, tagJpegBlob } from './exif.js';

export const APP_NAME = 'Panorámica 360 Web';
const SOFTWARE = 'Panoramica 360 Web 1.0';

async function decode(blob) {
  if (globalThis.createImageBitmap) {
    try { return await createImageBitmap(blob); } catch { /* alternativa abajo */ }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally { URL.revokeObjectURL(url); }
}

const scratch = document.createElement('canvas');
async function pixels(blob, w, h) {
  const bmp = await decode(blob);
  scratch.width = w; scratch.height = h;
  const ctx = scratch.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close?.();
  return ctx.getImageData(0, 0, w, h);
}

export const canvasBlob = (canvas, type, q) => new Promise((res) => canvas.toBlob(res, type, q));

/**
 * @param session registro de sesión   @param frames [{blob, meta}]
 * @param settings {panoWidth, refine, jpegQuality}
 * @param onProgress (fracción 0..1, texto)
 * @returns {blob, thumb, width, height, stats, coverage}
 */
export async function buildPanorama(session, frames, settings, onProgress = () => {}) {
  const n = frames.length;
  if (n < 1) throw new Error('No hay fotos en esta captura');
  let phase = 'Preparando…', base = 0, span = 0.1;
  const engine = await createEngineClient((p) => onProgress(base + span * p, phase));
  try {
    // El centro de la panorámica es el rumbo de la primera foto
    const h0 = session.h0 ?? toHeadingPitchRoll(frames[0].meta.R).h;
    const align = rotZ(h0);
    const metas = frames.map((f) => ({
      R: mul(align, f.meta.R),
      K: { w: f.meta.w, h: f.meta.h, f: f.meta.f, cx: (f.meta.w - 1) / 2, cy: (f.meta.h - 1) / 2 },
    }));

    // 1. Versiones reducidas en gris para emparejar
    phase = 'Analizando fotos…';
    for (let i = 0; i < n; i++) {
      const { w, h } = frames[i].meta;
      const s = 360 / Math.max(w, h);
      const img = await pixels(frames[i].blob, w, h);
      const g = grayDownsample(img.data, w, h, Math.round(w * s), Math.round(h * s));
      await engine.call('gray', { i, data: g.data, w: g.w, h: g.h }, [g.data.buffer]);
      onProgress(0.1 * (i + 1) / n, phase);
    }

    // 2. Emparejado + ajuste de orientaciones + ganancias
    phase = 'Alineando con precisión…'; base = 0.1; span = 0.25;
    const an = await engine.call('analyze', {
      frames: metas,
      options: {
        refine: settings.refine !== false,
        adjacentOnly: settings.adjacentOnly !== false,
        // tamaño del parche: el grueso (a media resolución) crece en proporción al fino
        match: { patch: settings.matchPatch || 6, patchCoarse: Math.round((settings.matchPatch || 6) * 0.75) + 1 },
        // sin calibración previa, la focal se estima con las propias fotos
        autoFocal: !session.calibrated,
      },
    });
    for (const m of metas) m.K.f *= an.focalScale;

    // 3. Mezcla por franjas
    phase = 'Componiendo la panorámica…';
    const W = settings.panoWidth, H = W / 2;
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('El navegador no admite un lienzo de este tamaño. Elige una resolución menor.');
    const twoBand = settings.twoBand !== false;
    const rows = Math.max(64, Math.floor((twoBand ? 2.1e6 : 4.2e6) / W));
    const ranges = an.rotations.map((R, i) => frameRowRange(R, metas[i].K, H));
    let empty = 0;
    const work = [];
    for (let y0 = 0; y0 < H; y0 += rows) {
      const y1 = Math.min(H, y0 + rows);
      work.push({ y0, y1, idx: ranges.map((r, i) => (r[1] > y0 && r[0] < y1 ? i : -1)).filter((i) => i >= 0) });
    }
    const totalWork = work.reduce((s, w) => s + w.idx.length, 0) || 1;
    let doneWork = 0;
    for (const { y0, y1, idx } of work) {
      await engine.call('beginStrip', { W, H, y0, y1, twoBand });
      for (const i of idx) {
        const img = await pixels(frames[i].blob, frames[i].meta.w, frames[i].meta.h);
        await engine.call('addFrame', { i, data: img.data }, [img.data.buffer]);
        onProgress(0.35 + 0.55 * (++doneWork / totalWork), phase);
      }
      const strip = await engine.call('endStrip');
      empty += strip.empty;
      ctx.putImageData(new ImageData(strip.rgba, W, y1 - y0), 0, y0);
    }

    // 4. Codificación y metadatos
    phase = 'Guardando…';
    onProgress(0.92, phase);
    let blob = await canvasBlob(canvas, 'image/jpeg', settings.jpegQuality ?? 0.92);
    if (!blob) throw new Error('No se pudo codificar la panorámica. Elige una resolución menor.');
    const first = frames[0].meta, last = frames[n - 1].meta;
    const heading = first.compassHeading;
    const date = new Date(first.time);
    const exif = buildExif({
      date, width: W, height: H, software: SOFTWARE,
      description: `Panoramica 360 (${n} fotos)`,
      heading, gps: first.gps,
      comment: JSON.stringify({ app: SOFTWARE, fotos: n, cobertura: +(1 - empty / (W * H)).toFixed(4), ajuste: an.stats }),
    });
    const xmp = buildXmp({
      gpano: {
        UsePanoramaViewer: 'True', ProjectionType: 'equirectangular',
        CaptureSoftware: SOFTWARE, StitchingSoftware: SOFTWARE,
        FullPanoWidthPixels: W, FullPanoHeightPixels: H,
        CroppedAreaImageWidthPixels: W, CroppedAreaImageHeightPixels: H,
        CroppedAreaLeftPixels: 0, CroppedAreaTopPixels: 0,
        PoseHeadingDegrees: heading != null ? heading.toFixed(2) : null,
        InitialViewHeadingDegrees: 0, InitialViewPitchDegrees: 0, InitialHorizontalFOVDegrees: 75,
        SourcePhotosCount: n,
        FirstPhotoDate: new Date(first.time).toISOString(), LastPhotoDate: new Date(last.time).toISOString(),
      },
    });
    blob = await tagJpegBlob(blob, { exif, xmp });

    const tc = document.createElement('canvas');
    tc.width = 640; tc.height = 320;
    tc.getContext('2d').drawImage(canvas, 0, 0, 640, 320);
    const thumb = await canvasBlob(tc, 'image/jpeg', 0.75);
    canvas.width = canvas.height = 0;
    onProgress(1, 'Listo');
    return { blob, thumb, width: W, height: H, stats: an.stats, coverage: 1 - empty / (W * H), threaded: engine.threaded };
  } finally {
    engine.close();
  }
}

/** Metadatos EXIF/XMP de una foto individual a partir de la lectura de sensores. */
export function frameMetadata(meta) {
  const hpr = toHeadingPitchRoll(meta.R);
  const deg = (r) => +(r / DEG).toFixed(3);
  const sensor = {
    rumboRelativo: deg(hpr.h), elevacion: deg(hpr.p), alabeo: deg(hpr.r),
    alpha: meta.alpha, beta: meta.beta, gamma: meta.gamma, orientacionPantalla: meta.screenAngle,
    rumboMagnetico: meta.compassHeading,
    cuaternion: meta.q, matriz: meta.R.map((v) => +v.toFixed(6)),
    velocidadAngular: +meta.speed.toFixed(2),
    aceleracion: meta.motion?.acc, aceleracionConGravedad: meta.motion?.accG, giroscopio: meta.motion?.rot,
    focalPx: +meta.f.toFixed(2), calibrada: meta.calibrated, camara: meta.camera,
    gps: meta.gps,
  };
  const exif = buildExif({
    date: new Date(meta.time), width: meta.w, height: meta.h, software: SOFTWARE,
    description: `Foto ${meta.idx + 1} de panoramica 360`,
    focal35: meta.focal35, heading: meta.compassHeading, gps: meta.gps,
    comment: JSON.stringify(sensor),
  });
  const xmp = buildXmp({
    gpano: {
      PoseHeadingDegrees: (meta.compassHeading ?? ((deg(hpr.h) % 360) + 360) % 360).toFixed(2),
      PosePitchDegrees: deg(hpr.p), PoseRollDegrees: deg(hpr.r),
    },
    sensor: {
      Alpha: meta.alpha, Beta: meta.beta, Gamma: meta.gamma, ScreenAngle: meta.screenAngle,
      Quaternion: meta.q.join(','), FocalLengthPixels: +meta.f.toFixed(2),
      HeadingReference: meta.compassHeading != null ? 'magnetic' : 'relative',
      AccelerationIncludingGravity: meta.motion?.accG?.join(','), RotationRate: meta.motion?.rot?.join(','),
    },
  });
  return { exif, xmp };
}
