// Pantalla de calibración de la cámara.
import { DEG, angleBetween, defaultFocalRel } from './math3d.js';
import { grayFromRGBA } from './match.js';
import {
  cameraKey, getCalibration, saveCalibration, deleteCalibration, calibrateFromSweep,
} from './calibration.js';

const $ = (id) => document.getElementById(id);
const SAMPLES = 12, STEP = 7 * DEG, MAX_SPEED = 10;
// Recorrido del piloto automático en modo demostración (grados de rumbo y elevación)
const DEMO_PATH = [[0, 0], [7, 1], [14, 0], [21, 2], [28, 0], [35, 1], [30, 8], [26, 15], [22, 22], [15, 20], [8, 16], [2, 10]];

export const fovFromRel = (fRel) => 2 * Math.atan(0.5 / fRel) / DEG;
export const relFromFov = (deg) => 0.5 / Math.tan(deg * DEG / 2);

export class CalibrationController {
  constructor(app) {
    this.app = app;
    this.video = $('calib-video');
    this.active = false;
    this._loop = this._loop.bind(this);
    $('calib-exit').onclick = () => this.exit();
    $('calib-start').onclick = () => this.startSweep();
    $('calib-save').onclick = () => this.save();
    $('calib-delete').onclick = () => { deleteCalibration(this.key); this.result = null; this.refresh(); this.app.toast('Calibración borrada'); };
    $('calib-manual-btn').onclick = () => { $('calib-manual').hidden = !$('calib-manual').hidden; };
    $('calib-fov').oninput = () => { $('calib-fov-val').textContent = `${(+$('calib-fov').value).toFixed(1)}°`; };
    $('calib-manual-save').onclick = () => {
      saveCalibration(this.key, { fRel: relFromFov(+$('calib-fov').value), method: 'manual', quality: 'manual' });
      $('calib-manual').hidden = true;
      this.refresh();
      this.app.toast('Calibración manual guardada');
    };
  }

  async open() {
    const { camera, sensors, settings } = this.app;
    this.samples = null;
    this.result = null;
    this.setMsg('Iniciando cámara…');
    $('calib-result').hidden = true; $('calib-progress').hidden = true; $('calib-manual').hidden = true;
    await sensors.requestPermission();
    sensors.start();
    await camera.start(this.video, { deviceId: settings.cameraId || undefined });
    this.key = cameraKey(camera.label, camera.width, camera.height);
    $('calib-cam').textContent = `${camera.label} · ${camera.width}×${camera.height}`;
    this.hasSensors = await sensors.waitReady();
    this.refresh();
    this.setMsg(this.hasSensors
      ? 'Apunta a una escena lejana con detalle y pulsa «Calibrar»'
      : 'Sin sensores de orientación: sólo es posible el ajuste manual');
    $('calib-start').disabled = !this.hasSensors;
    this.active = true;
    requestAnimationFrame(this._loop);
  }

  refresh() {
    const c = getCalibration(this.key);
    const fRel = c?.fRel ?? defaultFocalRel;
    $('calib-current').textContent = c
      ? `Calibrada (${c.method}, ${c.quality}): ${fovFromRel(c.fRel).toFixed(1)}° lado largo`
      : `Sin calibrar: se asume ${fovFromRel(defaultFocalRel).toFixed(1)}°`;
    $('calib-fov').value = fovFromRel(fRel).toFixed(1);
    $('calib-fov').oninput();
    $('calib-delete').disabled = !c;
    $('calib-save').hidden = !this.result;
    $('calib-start').hidden = !!this.result;
  }

  setMsg(t) { $('calib-msg').textContent = t; }

  setProgress(p) {
    $('calib-progress').hidden = false;
    $('calib-progress').firstElementChild.style.width = `${Math.round(p * 100)}%`;
  }

  startSweep() {
    this.samples = [];
    this.result = null;
    $('calib-result').hidden = true;
    $('calib-start').disabled = true;
    this.setProgress(0);
    this.setMsg('Gira despacio el móvil sobre sí mismo: primero hacia un lado y después hacia arriba. No te desplaces.');
  }

  _loop() {
    if (!this.active) return;
    requestAnimationFrame(this._loop);
    const { sensors, camera, sim } = this.app;
    if (!this.samples || this.computing || !sensors.R) return;
    const n = this.samples.length;
    if (sim?.autopilot) {
      const [h, p] = DEMO_PATH[Math.min(n, DEMO_PATH.length - 1)];
      sim.setGoal((this.h0 ??= sim.h) + h * DEG, p * DEG);
    }
    const last = this.samples[n - 1];
    if (last && angleBetween(last.R, sensors.R) < STEP) return;
    if (sensors.speed > MAX_SPEED) { if (last) this.setMsg('Más despacio…'); return; }
    // muestra: fotograma reducido en gris + orientación del sensor
    const R = sensors.R.slice();
    const c = camera.grab(360);
    const img = c.getContext('2d').getImageData(0, 0, c.width, c.height);
    this.samples.push({ R, gray: { data: grayFromRGBA(img.data, c.width, c.height), w: c.width, h: c.height } });
    navigator.vibrate?.(15);
    this.setProgress(0.5 * this.samples.length / SAMPLES);
    this.setMsg(`Muestra ${this.samples.length} de ${SAMPLES}. Sigue girando despacio…`);
    if (this.samples.length >= SAMPLES) this.compute();
  }

  async compute() {
    this.computing = true;
    this.setMsg('Calculando…');
    try {
      const current = getCalibration(this.key)?.fRel ?? defaultFocalRel;
      const res = await calibrateFromSweep(this.samples, current, (p) => this.setProgress(0.5 + 0.5 * p));
      this.result = res;
      const { camera } = this.app;
      const long = Math.max(camera.width, camera.height), short = Math.min(camera.width, camera.height);
      const f = res.fRel * long;
      const f35 = f / Math.hypot(long, short) * 43.27;
      $('calib-result').innerHTML =
        `Focal: <b>${f.toFixed(0)} px</b> · campo de visión <b>${fovFromRel(res.fRel).toFixed(1)}° × ${(2 * Math.atan(short / 2 / f) / DEG).toFixed(1)}°</b>`
        + ` · equivalente a <b>${f35.toFixed(1)} mm</b><br>Calidad <b>${res.quality}</b>: error ${(res.rmsRel * long).toFixed(2)} px,`
        + ` ${res.inliers} de ${res.matches} coincidencias en ${res.pairs} pares`;
      $('calib-result').hidden = false;
      this.setMsg(res.quality === 'baja'
        ? 'Calidad baja: repite con una escena con más detalle y girando más despacio'
        : 'Calibración calculada. Pulsa «Guardar» para usarla');
    } catch (e) {
      this.setMsg(e.message);
    } finally {
      this.computing = false;
      this.samples = null;
      this.h0 = undefined;
      $('calib-progress').hidden = true;
      $('calib-start').disabled = false;
      this.refresh();
    }
  }

  save() {
    saveCalibration(this.key, this.result);
    this.result = null;
    this.refresh();
    this.app.toast('Calibración guardada en este dispositivo');
    this.setMsg('Calibración guardada');
  }

  exit() {
    this.active = false;
    this.samples = null;
    this.app.camera.stop();
    this.app.sensors.stop();
    this.app.showHome();
  }
}
