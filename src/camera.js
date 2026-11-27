// Acceso a la cámara mediante getUserMedia y captura de fotogramas.

export class Camera {
  /** @param sim simulador opcional (modo demostración) */
  constructor(sim = null) {
    this.sim = sim;
    this.stream = null;
    this.video = null;
    this.label = '';
    this.exposureLocked = false;
    this._canvas = document.createElement('canvas');
  }

  static async listDevices() {
    try {
      return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
    } catch { return []; }
  }

  async start(video, { deviceId } = {}) {
    this.stop();
    this.video = video;
    if (this.sim) {
      this.stream = this.sim.startCamera();
      this.label = 'Cámara simulada';
    } else {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('Este navegador no permite acceder a la cámara (se necesita HTTPS o localhost).');
      }
      const base = { width: { ideal: 1920 }, height: { ideal: 1440 } };
      const tries = deviceId
        ? [{ ...base, deviceId: { exact: deviceId } }, { ...base, facingMode: { ideal: 'environment' } }]
        : [{ ...base, facingMode: { ideal: 'environment' } }];
      tries.push(true);
      let err;
      for (const v of tries) {
        try { this.stream = await navigator.mediaDevices.getUserMedia({ video: v, audio: false }); break; } catch (e) { err = e; }
      }
      if (!this.stream) throw err;
      const track = this.stream.getVideoTracks()[0];
      this.label = track.label || 'Cámara';
      this.deviceId = track.getSettings?.().deviceId;
    }
    video.srcObject = this.stream;
    video.muted = true;
    video.playsInline = true;
    await video.play().catch(() => {});
    await new Promise((resolve, reject) => {
      const t0 = performance.now();
      const tick = () => {
        if (video.videoWidth > 0) resolve();
        else if (performance.now() - t0 > 8000) reject(new Error('La cámara no entrega imagen'));
        else setTimeout(tick, 50);
      };
      tick();
    });
  }

  get width() { return this.video?.videoWidth || 0; }
  get height() { return this.video?.videoHeight || 0; }

  /** Intenta fijar exposición y balance de blancos para que todas las fotos sean homogéneas. */
  async lockExposure(lock = true) {
    const track = this.stream?.getVideoTracks?.()[0];
    const caps = track?.getCapabilities?.();
    if (!caps) return false;
    const adv = {};
    const mode = lock ? 'manual' : 'continuous';
    if (caps.exposureMode?.includes(mode)) adv.exposureMode = mode;
    if (caps.whiteBalanceMode?.includes(mode)) adv.whiteBalanceMode = mode;
    if (!Object.keys(adv).length) return false;
    try {
      await track.applyConstraints({ advanced: [adv] });
      this.exposureLocked = lock;
      return true;
    } catch { return false; }
  }

  /** Dibuja el fotograma actual en un canvas (a tamaño completo o reducido). */
  grab(maxLong = 0, canvas = this._canvas) {
    const vw = this.width, vh = this.height;
    const s = maxLong && Math.max(vw, vh) > maxLong ? maxLong / Math.max(vw, vh) : 1;
    canvas.width = Math.round(vw * s); canvas.height = Math.round(vh * s);
    const ctx = canvas.getContext('2d', { willReadFrequently: maxLong > 0 });
    ctx.drawImage(this.video, 0, 0, canvas.width, canvas.height);
    return canvas;
  }

  /** Codifica un canvas como JPEG. */
  async encode(canvas, quality = 0.92) {
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', quality));
    if (!blob) throw new Error('No se pudo codificar la foto');
    return { blob, w: canvas.width, h: canvas.height };
  }

  /** Captura el fotograma actual como JPEG. */
  grabJpeg(quality = 0.92) {
    return this.encode(this.grab(0), quality);
  }

  stop() {
    if (this.sim) this.sim.stopCamera();
    else this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (this.video) this.video.srcObject = null;
  }
}
