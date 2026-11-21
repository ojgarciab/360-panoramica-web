// Visor 360° sencillo en WebGL para revisar la panorámica generada.

const VS = 'attribute vec2 p; varying vec2 v; void main(){ v = p; gl_Position = vec4(p, 0.0, 1.0); }';
const FS = `precision highp float;
varying vec2 v; uniform sampler2D tex; uniform mat3 rot; uniform vec2 scale;
const float PI = 3.141592653589793;
void main(){
  vec3 d = rot * normalize(vec3(v.x * scale.x, v.y * scale.y, -1.0));
  float lon = atan(d.x, d.y), lat = asin(clamp(d.z, -1.0, 1.0));
  gl_FragColor = texture2D(tex, vec2(lon / (2.0 * PI) + 0.5, 0.5 - lat / PI));
}`;

export class PanoViewer {
  constructor(canvas) {
    this.canvas = canvas;
    this.yaw = 0; this.pitch = 0; this.fov = 80 * Math.PI / 180;
    this.gl = canvas.getContext('webgl', { antialias: false, preserveDrawingBuffer: true });
    if (!this.gl) return;
    const gl = this.gl;
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
    const prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    gl.useProgram(prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    this.uRot = gl.getUniformLocation(prog, 'rot');
    this.uScale = gl.getUniformLocation(prog, 'scale');
    this.texture = gl.createTexture();
    this._bind();
  }

  get supported() { return !!this.gl; }

  _bind() {
    const el = this.canvas;
    const pts = new Map();
    let pinch = 0;
    el.addEventListener('pointerdown', (e) => { pts.set(e.pointerId, [e.clientX, e.clientY]); el.setPointerCapture?.(e.pointerId); });
    el.addEventListener('pointermove', (e) => {
      const prev = pts.get(e.pointerId);
      if (!prev) return;
      pts.set(e.pointerId, [e.clientX, e.clientY]);
      if (pts.size === 1) {
        const k = this.fov / el.clientHeight;
        this.yaw -= (e.clientX - prev[0]) * k;
        this.pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, this.pitch + (e.clientY - prev[1]) * k));
      } else if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
        if (pinch) this.zoom(pinch / d);
        pinch = d;
      }
      this.draw();
    });
    const up = (e) => { pts.delete(e.pointerId); pinch = 0; };
    el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
    el.addEventListener('wheel', (e) => { e.preventDefault(); this.zoom(Math.exp(e.deltaY * 0.001)); this.draw(); }, { passive: false });
  }

  zoom(k) { this.fov = Math.max(25 * Math.PI / 180, Math.min(120 * Math.PI / 180, this.fov * k)); }

  /** Carga un Blob con la imagen equirectangular. */
  async load(blob) {
    const gl = this.gl;
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      const max = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), 8192);
      let src = img;
      if (img.naturalWidth > max) {
        src = document.createElement('canvas');
        src.width = max; src.height = max / 2;
        src.getContext('2d').drawImage(img, 0, 0, src.width, src.height);
      }
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, src);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    } finally { URL.revokeObjectURL(url); }
    this.yaw = 0; this.pitch = 0;
    this.draw();
  }

  draw() {
    const gl = this.gl, c = this.canvas;
    const dpr = Math.min(2, devicePixelRatio || 1);
    const w = Math.round(c.clientWidth * dpr), h = Math.round(c.clientHeight * dpr);
    if (!w || !h) return;
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    gl.viewport(0, 0, w, h);
    const t = Math.tan(this.fov / 2);
    gl.uniform2f(this.uScale, t * w / h, t);
    // rotación cámara->mundo (columnas: derecha, arriba, -adelante), en orden de columnas
    const sh = Math.sin(this.yaw), ch = Math.cos(this.yaw), sp = Math.sin(this.pitch), cp = Math.cos(this.pitch);
    gl.uniformMatrix3fv(this.uRot, false, [ch, -sh, 0, -sh * sp, -ch * sp, cp, -sh * cp, -ch * cp, -sp]);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
