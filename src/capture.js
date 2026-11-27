// Controlador de la pantalla de captura guiada.
import { DEG, intrinsics, fovOf, focal35, toHeadingPitchRoll, toQuaternion, forward, dirFromHP } from './math3d.js';
import { generateTargets, Coverage } from './targets.js';
import { drawOverlay, drawGlobe } from './sphere-view.js';
import { cameraKey, getCalibration, focalRelFor } from './calibration.js';
import { frameMetadata } from './pipeline.js';
import { tagJpegBlob } from './exif.js';
import { sharpness } from './sharpness.js';
import * as db from './db.js';

const $ = (id) => document.getElementById(id);
const ALIGN_TOL = 3 * DEG, ROLL_TOL = 10 * DEG, STEADY = 8, HOLD_MS = 400;
const BURST_SHOTS = 3, BURST_MS = 200;

export class CaptureController {
  constructor(app) {
    this.app = app;
    this.video = $('cap-video');
    this.overlay = $('cap-overlay');
    this.globe = $('cap-globe');
    this.active = false;
    this._loop = this._loop.bind(this);
    $('cap-shutter').onclick = () => this.onShutter();
    $('cap-exit').onclick = () => this.exit();
    $('cap-finish').onclick = () => this.finish();
    this.globe.onclick = () => { $('globe-full').hidden = false; };
    $('globe-close').onclick = () => { $('globe-full').hidden = true; };
  }

  async open() {
    const { camera, sensors, settings } = this.app;
    this.session = null;
    this.targets = null;
    this.coverage = new Coverage(3);
    this.count = 0;
    this.busy = false;
    this.holdStart = 0;
    this.next = -1;
    this.lastRing = 0;
    this.frame = 0;
    this.gps = null;
    $('globe-full').hidden = true;
    $('cap-finish').disabled = true;
    this.setMsg('Iniciando cámara…');
    this.updateHud();

    await sensors.requestPermission();
    sensors.start();
    await camera.start(this.video, { deviceId: settings.cameraId || undefined });
    if (!(await sensors.waitReady())) {
      throw new Error('Este dispositivo no ofrece sensores de orientación. Prueba el modo demostración añadiendo ?demo a la dirección.');
    }
    this.calibKey = cameraKey(camera.label, camera.width, camera.height);
    this.fRel = focalRelFor(this.calibKey);
    this.calibrated = !!getCalibration(this.calibKey);
    if (settings.gps && navigator.geolocation) {
      this.gpsWatch = navigator.geolocation.watchPosition((p) => {
        this.gps = {
          lat: p.coords.latitude, lon: p.coords.longitude, alt: p.coords.altitude ?? undefined,
          accuracy: p.coords.accuracy, time: p.timestamp,
        };
      }, () => {}, { enableHighAccuracy: true });
    }
    try { this.wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* no disponible */ }
    this.active = true;
    this.setMsg(this.calibrated
      ? 'Sujeta el móvil en vertical, apunta al horizonte y pulsa el botón para empezar'
      : 'Cámara sin calibrar (se usa un valor típico). Apunta al horizonte y pulsa el botón para empezar');
    requestAnimationFrame(this._loop);
  }

  get K() {
    const { camera } = this.app;
    return intrinsics(camera.width, camera.height, this.fRel * Math.max(camera.width, camera.height));
  }

  setMsg(t) { if (this._msg !== t) { this._msg = t; $('cap-msg').textContent = t; } }

  updateHud() {
    const total = this.targets?.length;
    $('cap-count').textContent = total ? `${this.count} / ${total} fotos` : `${this.count} fotos`;
    $('cap-cover').textContent = `${Math.round(this.coverage.fraction * 100)} % cubierto`;
    $('cap-finish').disabled = this.count < 2;
    $('globe-full-info').textContent =
      `${Math.round(this.coverage.fraction * 100)} % de la esfera cubierto · ${this.count} fotos${total ? ` de ${total} previstas` : ''}`;
  }

  async begin() {
    const { sensors, camera, settings } = this.app;
    const K = this.K, fov = fovOf(K);
    const h0 = toHeadingPitchRoll(sensors.R).h;
    this.targets = generateTargets(fov.h, fov.v, settings.overlap, h0).map((t) => ({ ...t, done: false }));
    const now = new Date();
    this.session = {
      id: `s${now.getTime()}`, created: now.getTime(),
      name: `Panorámica ${now.toLocaleDateString('es-ES')} ${now.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}`,
      status: 'capturando', frameCount: 0, h0, camera: camera.label, calibKey: this.calibKey,
      fRel: this.fRel, calibrated: this.calibrated, planned: this.targets.length,
    };
    await db.putSession(this.session);
    db.requestPersistence();
    if (settings.lockExposure) camera.lockExposure(true);
    this.updateHud();
  }

  async onShutter() {
    if (!this.active || this.busy) return;
    if (!this.session) { this.busy = true; try { await this.begin(); } finally { this.busy = false; } return; }
    // disparo manual: cuenta para el punto guía más cercano si está razonablemente alineado
    const { idx, angle } = this.nearestPending();
    await this.shoot(angle < 8 * DEG ? idx : -1);
  }

  nearestPending() {
    const f = forward(this.app.sensors.R);
    let best = -1, bestCost = Infinity, bestAngle = Infinity;
    this.targets.forEach((t, i) => {
      if (t.done) return;
      const d = dirFromHP(t.h, t.p);
      const angle = Math.acos(Math.max(-1, Math.min(1, d[0] * f[0] + d[1] * f[1] + d[2] * f[2])));
      // se prefiere terminar el anillo actual antes de cambiar de altura
      const cost = angle + (t.ring !== this.lastRing ? 0.6 : 0);
      if (cost < bestCost) { bestCost = cost; best = i; bestAngle = angle; }
    });
    return { idx: best, angle: bestAngle };
  }

  async shoot(targetIdx) {
    const { camera, sensors, settings } = this.app;
    this.busy = true;
    try {
      // Ráfaga opcional: varias tomas seguidas y se guarda la más nítida, cada una con la
      // lectura de sensores de su instante
      const shots = settings.burst ? BURST_SHOTS : 1;
      this.burstCanvases ??= [];
      const takes = [];
      for (let k = 0; k < shots; k++) {
        if (k) await new Promise((res) => setTimeout(res, BURST_MS));
        const canvas = camera.grab(0, this.burstCanvases[k] ??= document.createElement('canvas'));
        const take = { canvas, R: sensors.R.slice(), raw: { ...sensors.raw }, speed: sensors.speed, motion: sensors.motion, time: Date.now() };
        if (shots > 1) {
          const img = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
          take.score = sharpness(img.data, canvas.width, canvas.height);
        }
        takes.push(take);
      }
      let chosen = 0;
      takes.forEach((t, k) => { if (t.score > takes[chosen].score) chosen = k; });
      const { R, raw, speed } = takes[chosen];
      const { blob, w, h } = await camera.encode(takes[chosen].canvas, 0.92);
      const K = intrinsics(w, h, this.fRel * Math.max(w, h));
      const target = this.targets[targetIdx];
      const r3 = (v) => +v.toFixed(3);
      const meta = {
        idx: this.count, time: takes[chosen].time, w, h, f: K.f, focal35: focal35(K),
        R, q: toQuaternion(R).map((v) => +v.toFixed(6)),
        alpha: r3(raw.alpha), beta: r3(raw.beta), gamma: r3(raw.gamma), screenAngle: raw.screenAngle,
        compassHeading: sensors.compassHeading(R) != null ? r3(sensors.compassHeading(R)) : null,
        speed, motion: takes[chosen].motion, gps: settings.gps ? this.gps : null,
        calibrated: this.calibrated, camera: camera.label,
        burst: shots > 1 ? { chosen, scores: takes.map((t) => +t.score.toFixed(1)) } : null,
        target: target ? { h: r3(target.h / DEG), p: r3(target.p / DEG) } : null,
      };
      const tagged = await tagJpegBlob(blob, frameMetadata(meta));
      await db.addFrame({ sessionId: this.session.id, blob: tagged, meta });
      this.coverage.addFrame(R, K);
      if (target) { target.done = true; this.lastRing = target.ring; }
      this.count++;
      this.session.frameCount = this.count;
      await db.putSession(this.session);
      navigator.vibrate?.(30);
      const fl = $('cap-flash');
      fl.classList.add('on');
      requestAnimationFrame(() => requestAnimationFrame(() => fl.classList.remove('on')));
      this.updateHud();
      if (this.targets.every((t) => t.done)) {
        this.setMsg('¡Esfera completa! Pulsa «Terminar» para generar la panorámica');
        if (this.app.sim?.autopilot) setTimeout(() => this.finish(), 300);
      }
    } catch (e) {
      this.app.toast(`No se pudo guardar la foto: ${e.message}`);
    } finally {
      this.busy = false;
      this.holdStart = 0;
    }
  }

  _loop(now) {
    if (!this.active) return;
    requestAnimationFrame(this._loop);
    const { sensors, camera, settings, sim } = this.app;
    const R = sensors.R;
    if (!R || !camera.width) return;
    const K = this.K;
    this.frame++;

    // Lógica de guiado y disparo automático
    let hold = 0;
    if (this.session && !this.busy) {
      const { idx, angle } = this.nearestPending();
      this.next = idx;
      if (idx >= 0) {
        const t = this.targets[idx];
        if (sim?.autopilot) sim.setGoal(t.h, t.p);
        const roll = Math.abs(toHeadingPitchRoll(R).r);
        const rollOk = t.pole || roll < ROLL_TOL;
        if (angle < ALIGN_TOL && rollOk && sensors.speed < STEADY) {
          if (!this.holdStart) this.holdStart = now;
          hold = Math.min(1, (now - this.holdStart) / HOLD_MS);
          this.setMsg('Mantén el móvil quieto…');
          if (hold >= 1 && settings.autoCapture) this.shoot(idx);
          else if (hold >= 1) this.setMsg('Alineado: pulsa el botón');
        } else {
          this.holdStart = 0;
          if (angle >= ALIGN_TOL) this.setMsg('Lleva el círculo central hasta el punto amarillo');
          else if (!rollOk) this.setMsg('Endereza el móvil');
          else this.setMsg('Más despacio…');
        }
      }
    }

    // Superposición
    const dpr = Math.min(2, devicePixelRatio || 1);
    const cw = this.overlay.clientWidth, ch = this.overlay.clientHeight;
    if (this.overlay.width !== Math.round(cw * dpr) || this.overlay.height !== Math.round(ch * dpr)) {
      this.overlay.width = Math.round(cw * dpr); this.overlay.height = Math.round(ch * dpr);
    }
    const ctx = this.overlay.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawOverlay(ctx, cw, ch, R, K, { coverage: this.coverage, targets: this.targets, next: this.next, hold, started: !!this.session });

    // Esfera de cobertura (más despacio que el vídeo: es más costosa)
    const full = !$('globe-full').hidden;
    const opts = { K, targets: this.targets, next: this.next };
    if (full) {
      if (this.frame % 4 === 0) {
        drawGlobe($('globe-front'), R, this.coverage, opts);
        drawGlobe($('globe-back'), R, this.coverage, { ...opts, back: true });
      }
    } else if (this.frame % 3 === 0) {
      drawGlobe(this.globe, R, this.coverage, opts);
    }
  }

  close() {
    this.active = false;
    const { camera, sensors } = this.app;
    camera.lockExposure(false).catch(() => {});
    camera.stop();
    sensors.stop();
    if (this.gpsWatch != null) navigator.geolocation.clearWatch(this.gpsWatch);
    this.gpsWatch = null;
    this.wakeLock?.release?.().catch(() => {});
    this.wakeLock = null;
  }

  async exit() {
    if (this.busy) return;
    const s = this.session;
    this.close();
    if (s && this.count === 0) await db.deleteSession(s.id);
    else if (s) { s.status = 'capturada'; await db.putSession(s); }
    this.app.showHome();
  }

  async finish() {
    if (this.busy || !this.session || this.count < 2) return;
    const s = this.session;
    this.close();
    s.status = 'capturada';
    s.coverage = this.coverage.fraction;
    await db.putSession(s);
    this.app.processSession(s.id);
  }
}
