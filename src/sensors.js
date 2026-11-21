// Lectura de los sensores de orientación y movimiento del móvil.
import { fromDeviceOrientation, toHeadingPitchRoll, angleBetween, DEG, wrapPi } from './math3d.js';

export function screenAngle() {
  const a = screen.orientation?.angle ?? window.orientation ?? 0;
  return ((a % 360) + 360) % 360;
}

export class OrientationSource {
  constructor() {
    this.simulated = false;   // en modo demostración no hay permisos que pedir
    this.R = null;            // rotación cámara->mundo actual
    this.raw = null;          // {alpha, beta, gamma, screenAngle}
    this.speed = 0;           // velocidad angular suavizada (°/s)
    this.compassOffset = null; // rumbo magnético − rumbo relativo (rad), si hay brújula
    this.motion = null;       // última lectura de devicemotion
    this.absolute = false;
    this._lastT = 0;
    this._gotRelative = false;
    this._onRel = (e) => this._orientation(e, false);
    this._onAbs = (e) => this._orientation(e, true);
    this._onMotion = (e) => {
      const v = (o, keys) => (o && o[keys[0]] != null ? keys.map((k) => +o[k].toFixed(4)) : null);
      this.motion = {
        acc: v(e.acceleration, ['x', 'y', 'z']),
        accG: v(e.accelerationIncludingGravity, ['x', 'y', 'z']),
        rot: v(e.rotationRate, ['alpha', 'beta', 'gamma']),
        interval: e.interval,
      };
    };
  }

  /** iOS exige pedir permiso desde un gesto del usuario. */
  async requestPermission() {
    if (this.simulated) return;
    for (const Ev of [globalThis.DeviceOrientationEvent, globalThis.DeviceMotionEvent]) {
      if (typeof Ev?.requestPermission === 'function') {
        const r = await Ev.requestPermission();
        if (r !== 'granted') throw new Error('Permiso de sensores de movimiento denegado');
      }
    }
  }

  start() {
    addEventListener('deviceorientation', this._onRel);
    addEventListener('deviceorientationabsolute', this._onAbs);
    addEventListener('devicemotion', this._onMotion);
  }

  stop() {
    removeEventListener('deviceorientation', this._onRel);
    removeEventListener('deviceorientationabsolute', this._onAbs);
    removeEventListener('devicemotion', this._onMotion);
  }

  _orientation(e, absEvent) {
    if (e.alpha == null || e.beta == null || e.gamma == null) return;
    const angle = screenAngle();
    const R = fromDeviceOrientation(e.alpha, e.beta, e.gamma, angle);
    if (absEvent && this._gotRelative) {
      // Sólo se usa para conocer el norte: la pose se toma del evento relativo, que no sufre
      // los saltos del magnetómetro.
      if (this.R) this.compassOffset = wrapPi(toHeadingPitchRoll(R).h - toHeadingPitchRoll(this.R).h);
      return;
    }
    if (!absEvent) {
      this._gotRelative = true;
      if (e.absolute) this.compassOffset = 0;
      else if (typeof e.webkitCompassHeading === 'number' && e.webkitCompassHeading >= 0) {
        // Safari: alpha es relativo y webkitCompassHeading da el rumbo magnético
        this.compassOffset = wrapPi((e.webkitCompassHeading - (360 - e.alpha)) * DEG);
      }
    } else {
      this.compassOffset = 0;
    }
    const t = e.timeStamp || performance.now();
    if (this.R && t > this._lastT) {
      const inst = angleBetween(this.R, R) / DEG / ((t - this._lastT) / 1000);
      this.speed += 0.25 * (Math.min(inst, 720) - this.speed);
    }
    this._lastT = t;
    this.R = R;
    this.absolute = absEvent || !!e.absolute;
    this.raw = { alpha: e.alpha, beta: e.beta, gamma: e.gamma, screenAngle: angle };
  }

  /** Espera a recibir la primera lectura. */
  waitReady(timeout = 3000) {
    return new Promise((resolve) => {
      const t0 = performance.now();
      const tick = () => {
        if (this.R) resolve(true);
        else if (performance.now() - t0 > timeout) resolve(false);
        else setTimeout(tick, 50);
      };
      tick();
    });
  }

  /** Rumbo magnético (grados, 0..360) de una orientación, o null si no hay brújula. */
  compassHeading(R) {
    if (this.compassOffset == null) return null;
    const d = (toHeadingPitchRoll(R).h + this.compassOffset) / DEG;
    return ((d % 360) + 360) % 360;
  }
}
