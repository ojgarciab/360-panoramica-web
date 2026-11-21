// Modo demostración: simula el "hardware" (cámara + sensores) para probar la aplicación en
// un ordenador. Genera eventos deviceorientation sintéticos y un vídeo renderizado a partir de
// una escena procedural, de modo que el resto de la aplicación funciona sin cambios.
import { renderEquirect, renderView } from './scene.js';
import { fromHeadingPitchRoll, toDeviceOrientation, mul, rotZ, intrinsics, wrapPi, DEG } from './math3d.js';
import { screenAngle } from './sensors.js';

export class Simulator {
  constructor({ autopilot = false, drift = true } = {}) {
    this.h = 0; this.p = 0; this.r = 0;
    this.goal = null;
    this.autopilot = autopilot;
    this.drift = drift;
    this.driftYaw = 0;
    this.eq = null;
    this.canvas = null;
    this.K = null;
    this._dirty = 5;
    this._last = performance.now();
    this._running = false;
    this._loop = this._loop.bind(this);
  }

  /** Genera la escena (tarda ~1 s). */
  async init() {
    const W = 2048, H = 1024;
    await new Promise((r) => setTimeout(r, 30));
    const data = renderEquirect(W, H);
    // Rótulos de orientación para que la escena sea reconocible
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.putImageData(new ImageData(data, W, H), 0, 0);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = 'bold 64px sans-serif';
    ctx.lineWidth = 6; ctx.strokeStyle = 'rgba(0,0,0,.8)'; ctx.fillStyle = '#fff';
    const names = ['S', 'SO', 'O', 'NO', 'N', 'NE', 'E', 'SE'];
    names.forEach((n, i) => {
      const x = (i / 8) * W + (i === 0 ? 40 : 0);
      ctx.strokeText(n, x, H / 2); ctx.fillText(n, x, H / 2);
    });
    ctx.font = 'bold 40px sans-serif';
    for (let i = 0; i < 12; i++) {
      for (const [lat, txt] of [[45, 'arriba'], [-45, 'abajo']]) {
        const x = (i + 0.5) / 12 * W, y = (0.5 - lat / 180) * H;
        ctx.strokeText(`${txt} ${i + 1}`, x, y); ctx.fillText(`${txt} ${i + 1}`, x, y);
      }
    }
    this.eq = { data: ctx.getImageData(0, 0, W, H).data, w: W, h: H };
  }

  get R() { return fromHeadingPitchRoll(this.h, this.p, this.r); }

  startCamera() {
    const portrait = innerHeight >= innerWidth;
    const w = portrait ? 540 : 720, h = portrait ? 720 : 540;
    this.canvas = document.createElement('canvas');
    this.canvas.width = w; this.canvas.height = h;
    this.ctx = this.canvas.getContext('2d');
    this.K = intrinsics(w, h, 0.8 * 720);
    this.image = new ImageData(w, h);
    this._dirty = 5;
    this.start();
    this._render();
    return this.canvas.captureStream(30);
  }

  stopCamera() { this.canvas = null; }

  start() {
    if (this._running) return;
    this._running = true;
    this._last = performance.now();
    requestAnimationFrame(this._loop);
  }

  setGoal(h, p) { this.goal = { h, p }; }

  /** Arrastre con ratón/dedo y teclado para girar el móvil virtual. */
  attachControls(el) {
    let last = null;
    el.addEventListener('pointerdown', (e) => { last = [e.clientX, e.clientY]; el.setPointerCapture?.(e.pointerId); });
    el.addEventListener('pointermove', (e) => {
      if (!last || this.autopilot) return;
      const k = 0.15 * DEG;
      this.rotate(-(e.clientX - last[0]) * k, (e.clientY - last[1]) * k);
      last = [e.clientX, e.clientY];
    });
    const end = () => { last = null; };
    el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
    addEventListener('keydown', (e) => {
      if (this.autopilot) return;
      const s = 2 * DEG;
      if (e.key === 'ArrowLeft') this.rotate(-s, 0);
      else if (e.key === 'ArrowRight') this.rotate(s, 0);
      else if (e.key === 'ArrowUp') this.rotate(0, s);
      else if (e.key === 'ArrowDown') this.rotate(0, -s);
    });
  }

  rotate(dh, dp) {
    this.h = wrapPi(this.h + dh);
    this.p = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, this.p + dp));
    this._dirty = 2;
  }

  _loop(now) {
    if (!this._running) return;
    const dt = Math.min(0.1, (now - this._last) / 1000);
    this._last = now;
    if (this.autopilot && this.goal) {
      const dh = wrapPi(this.goal.h - this.h), dp = this.goal.p - this.p;
      const dist = Math.hypot(dh * Math.cos(this.p), dp);
      // en los polos el rumbo es irrelevante: se salta directamente
      if (dist > 1e-4 || Math.abs(dh) > 1e-4) {
        const step = Math.min(1, (120 * DEG * dt) / Math.max(dist, Math.abs(dp), 1e-6));
        this.rotate(dh * step, dp * step);
      }
    }
    if (this.drift) this.driftYaw += 0.03 * DEG * dt;
    this._emit();
    if (this._dirty > 0 && this.canvas) { this._render(); this._dirty--; }
    requestAnimationFrame(this._loop);
  }

  _emit() {
    // Pose "medida": la real más la deriva de rumbo típica de un giroscopio
    const Rm = mul(mul(rotZ(this.driftYaw), this.R), rotZ(screenAngle() * DEG));
    const e = toDeviceOrientation(Rm);
    const ev = new Event('deviceorientation');
    Object.defineProperties(ev, {
      alpha: { value: e.alpha }, beta: { value: e.beta }, gamma: { value: e.gamma }, absolute: { value: false },
    });
    dispatchEvent(ev);
  }

  _render() {
    renderView(this.eq, this.R, this.K, this.image.data);
    this.ctx.putImageData(this.image, 0, 0);
  }
}
