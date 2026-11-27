// Punto de entrada: navegación entre vistas, lista de capturas, ajustes y descargas.
import { OrientationSource } from './sensors.js';
import { Camera } from './camera.js';
import { CaptureController } from './capture.js';
import { CalibrationController } from './calib-ui.js';
import { buildPanorama } from './pipeline.js';
import { PanoViewer } from './viewer.js';
import { loadCalibrations } from './calibration.js';
import { makeZip } from './zip.js';
import { importExport } from './import.js';
import * as db from './db.js';

const $ = (id) => document.getElementById(id);
const SETTINGS_KEY = 'pano360.ajustes.v1';
const DEFAULTS = {
  panoWidth: 4096, overlap: 0.3, autoCapture: true, refine: true, lockExposure: true,
  gps: false, keepParts: true, cameraId: '',
};

const params = new URLSearchParams(location.search);
const demo = params.get('demo');

const app = {
  settings: { ...DEFAULTS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') },
  sensors: new OrientationSource(),
  sim: null,
  camera: null,
  toast,
  showHome,
  processSession,
};
if (params.get('ancho')) app.settings.panoWidth = +params.get('ancho');

let toastTimer;
function toast(text, ms = 3500) {
  const el = $('toast');
  el.textContent = text; el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

function show(view) {
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));
  app.view = view;
}

const urls = [];
function objectUrl(blob) { const u = URL.createObjectURL(blob); urls.push(u); return u; }
function releaseUrls() { urls.splice(0).forEach((u) => URL.revokeObjectURL(u)); }

const fmtBytes = (b) => (b > 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b > 1e7 ? `${(b / 1e6).toFixed(0)} MB` : `${(b / 1e6).toFixed(1)} MB`);

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

function fileStamp(ms) {
  const d = new Date(ms), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// ---------- Inicio ----------
async function showHome() {
  show('home');
  releaseUrls();
  const sessions = await db.listSessions();
  const list = $('session-list');
  list.replaceChildren();
  $('empty-list').hidden = sessions.length > 0;
  for (const s of sessions) {
    const li = document.createElement('li');
    if (s.thumb) {
      const img = document.createElement('img');
      img.src = objectUrl(s.thumb); img.alt = s.name;
      li.append(img);
    } else {
      const ph = document.createElement('div');
      ph.className = 'ph'; ph.textContent = 'Sin generar: toca para coser';
      li.append(ph);
    }
    const meta = document.createElement('div');
    meta.className = 'meta';
    const a = document.createElement('span'); a.textContent = s.name;
    const b = document.createElement('span'); b.className = 'muted'; b.textContent = `${s.frameCount} fotos`;
    meta.append(a, b);
    li.append(meta);
    li.onclick = () => showSession(s.id);
    list.append(li);
  }
  const n = Object.keys(loadCalibrations()).length;
  $('calib-status').textContent = n
    ? `${n} calibración${n > 1 ? 'es' : ''} de cámara guardada${n > 1 ? 's' : ''} en este dispositivo.`
    : 'Cámara sin calibrar: se usará un campo de visión típico. Calibrar mejora el encaje de las fotos.';
  const est = await db.storageEstimate();
  $('storage-info').textContent = est?.quota ? `Almacenamiento local: ${fmtBytes(est.usage)} de ${fmtBytes(est.quota)}` : '';
}

async function openStage(controller, view) {
  show(view);
  try {
    await controller.open();
  } catch (e) {
    controller.close?.();
    app.camera.stop(); app.sensors.stop();
    const msg = e.name === 'NotAllowedError' ? 'Permiso de cámara denegado. Actívalo en los ajustes del navegador.' : e.message;
    toast(msg, 7000);
    showHome();
  }
}

// ---------- Procesado ----------
async function processSession(id) {
  show('process');
  const setProgress = (p, text) => {
    $('proc-bar').style.width = `${Math.round(p * 100)}%`;
    $('proc-text').textContent = text || '';
  };
  setProgress(0, 'Preparando…');
  try {
    const session = await db.getSession(id);
    const frames = await db.getFrames(id);
    const t0 = performance.now();
    const res = await buildPanorama(session, frames, app.settings, setProgress);
    await db.putPano({ sessionId: id, blob: res.blob });
    Object.assign(session, {
      status: 'lista', thumb: res.thumb, pano: { w: res.width, h: res.height, bytes: res.blob.size },
      stats: res.stats, panoCoverage: res.coverage, seconds: (performance.now() - t0) / 1000,
    });
    await db.putSession(session);
    if (!app.settings.keepParts) { await db.deleteFrames(id); session.partsDeleted = true; await db.putSession(session); }
    app.lastResult = { id, stats: res.stats, coverage: res.coverage, seconds: session.seconds, threaded: res.threaded };
  } catch (e) {
    console.error(e);
    toast(`No se pudo generar la panorámica: ${e.message}`, 8000);
    app.lastResult = { id, error: e.message };
  }
  showSession(id);
}

// ---------- Sesión ----------
let viewer = null;
let current = null;

async function showSession(id) {
  show('session');
  releaseUrls();
  const session = await db.getSession(id);
  if (!session) return showHome();
  const pano = await db.getPano(id);
  const frames = session.partsDeleted ? [] : await db.getFrames(id);
  current = { session, pano, frames };
  $('ses-title').textContent = session.name;
  const stats = session.stats;
  const info = [`${session.frameCount} fotos`];
  if (session.pano) info.push(`${session.pano.w}×${session.pano.h} px`, fmtBytes(session.pano.bytes));
  if (session.panoCoverage != null) info.push(`${Math.round(session.panoCoverage * 100)} % de la esfera`);
  if (stats?.medianAfterDeg != null) info.push(`ajuste fino: ${stats.medianBeforeDeg.toFixed(2)}° → ${stats.medianAfterDeg.toFixed(2)}°`);
  info.push(session.calibrated ? 'cámara calibrada' : 'cámara sin calibrar');
  $('ses-info').textContent = info.join(' · ');

  const hasPano = !!pano;
  $('ses-nopano').hidden = hasPano;
  $('ses-dl-pano').disabled = !hasPano;
  $('ses-toggle').disabled = !hasPano;
  $('ses-dl-parts').disabled = !frames.length;
  $('ses-rebuild').disabled = frames.length < 1;
  $('ses-rebuild').textContent = hasPano ? 'Volver a generar' : 'Generar panorámica';
  $('ses-flat').hidden = true;
  $('ses-viewer').hidden = !hasPano;
  if (hasPano) {
    $('ses-flat').src = objectUrl(pano.blob);
    viewer ??= new PanoViewer($('ses-viewer'));
    if (viewer.supported) await viewer.load(pano.blob);
    else { $('ses-flat').hidden = false; $('ses-viewer').hidden = true; }
  }
  const parts = $('ses-parts');
  parts.replaceChildren();
  for (const f of frames) {
    const li = document.createElement('li');
    const img = document.createElement('img');
    img.loading = 'lazy'; img.src = objectUrl(f.blob); img.alt = `Parte ${f.meta.idx + 1}`;
    li.append(img);
    li.onclick = () => download(f.blob, `parte_${String(f.meta.idx + 1).padStart(3, '0')}.jpg`);
    parts.append(li);
  }
}

async function downloadParts() {
  const { session, frames } = current;
  toast('Preparando ZIP…');
  const files = [];
  for (const f of frames) {
    files.push({
      name: `parte_${String(f.meta.idx + 1).padStart(3, '0')}.jpg`,
      data: new Uint8Array(await f.blob.arrayBuffer()), date: new Date(f.meta.time),
    });
  }
  const { thumb, ...plain } = session;
  const json = JSON.stringify({ sesion: plain, fotos: frames.map((f) => f.meta) }, null, 1);
  files.push({ name: 'metadatos.json', data: new TextEncoder().encode(json) });
  download(makeZip(files), `pano360_${fileStamp(session.created)}_partes.zip`);
}

// ---------- Ajustes ----------
async function openSettings() {
  const s = app.settings;
  $('set-width').value = String(s.panoWidth);
  $('set-overlap').value = String(Math.round(s.overlap * 100));
  $('set-overlap-val').textContent = `${Math.round(s.overlap * 100)} %`;
  for (const [id, key] of [['set-auto', 'autoCapture'], ['set-refine', 'refine'], ['set-lock', 'lockExposure'], ['set-gps', 'gps'], ['set-keep', 'keepParts']]) {
    $(id).checked = !!s[key];
  }
  const sel = $('set-camera');
  sel.length = 1;
  (await Camera.listDevices()).forEach((d, i) => sel.add(new Option(d.label || `Cámara ${i + 1}`, d.deviceId)));
  sel.value = s.cameraId || '';
  $('dlg-settings').showModal();
}

function saveSettings() {
  const s = app.settings;
  s.panoWidth = +$('set-width').value;
  s.overlap = +$('set-overlap').value / 100;
  s.autoCapture = $('set-auto').checked; s.refine = $('set-refine').checked;
  s.lockExposure = $('set-lock').checked; s.gps = $('set-gps').checked; s.keepParts = $('set-keep').checked;
  s.cameraId = $('set-camera').value;
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

// ---------- Arranque ----------
async function init() {
  if (demo !== null) {
    const { Simulator } = await import('./sim.js');
    app.sim = new Simulator({ autopilot: demo === 'auto', drift: params.get('deriva') !== '0' });
    $('demo-banner').hidden = false;
    $('demo-banner').textContent = 'Modo demostración: preparando la escena simulada…';
    app.sensors.simulated = true;
    await app.sim.init();
    app.sim.start();
    app.sim.attachControls($('cap-overlay'));
    app.sim.attachControls($('calib-video'));
    $('demo-banner').textContent = 'Modo demostración: cámara y sensores simulados. Arrastra o usa las flechas del teclado para girar el móvil virtual.';
  }
  app.camera = new Camera(app.sim);
  const capture = new CaptureController(app);
  const calib = new CalibrationController(app);
  app.capture = capture; app.calib = calib;

  $('btn-new').onclick = () => openStage(capture, 'capture');
  $('btn-calib').onclick = () => openStage(calib, 'calib');
  $('btn-import').onclick = () => $('file-import').click();
  $('file-import').onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    toast('Importando…', 60000);
    try {
      const r = await importExport(file);
      toast(`Importadas ${r.count} fotos${r.missing ? ` (${r.missing} omitidas por faltar o estar dañadas)` : ''}. Pulsa «Generar panorámica».`, 6000);
      showSession(r.id);
    } catch (err) {
      toast(`No se pudo importar: ${err.message}`, 8000);
    }
  };
  $('btn-settings').onclick = openSettings;
  $('dlg-settings').addEventListener('close', saveSettings);
  $('set-overlap').oninput = () => { $('set-overlap-val').textContent = `${$('set-overlap').value} %`; };

  $('ses-back').onclick = showHome;
  $('ses-dl-pano').onclick = () => download(current.pano.blob, `pano360_${fileStamp(current.session.created)}.jpg`);
  $('ses-dl-parts').onclick = downloadParts;
  $('ses-rebuild').onclick = () => processSession(current.session.id);
  $('ses-toggle').onclick = () => {
    const flat = $('ses-flat').hidden;
    $('ses-flat').hidden = !flat;
    $('ses-toggle').textContent = flat ? 'Ver en 360°' : 'Ver plana';
  };
  $('ses-delete').onclick = async () => {
    if (!confirm('¿Borrar esta captura y todas sus fotos de este dispositivo?')) return;
    await db.deleteSession(current.session.id);
    showHome();
  };
  addEventListener('resize', () => { if (app.view === 'session' && viewer?.supported) viewer.draw(); });

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').then(() => navigator.serviceWorker.ready).then(() => {
      $('offline-info').textContent = 'Lista para usarse sin conexión.';
    }).catch(() => {});
  }
  if (!window.isSecureContext) toast('La cámara y los sensores sólo funcionan sobre HTTPS o localhost.', 8000);
  await showHome();
  window.__pano = app; // para depuración y pruebas automáticas
}

init().catch((e) => { console.error(e); toast(`Error al iniciar: ${e.message}`, 10000); });
