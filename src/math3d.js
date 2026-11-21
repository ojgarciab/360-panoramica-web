// Utilidades de álgebra 3D. Las matrices son arrays de 9 números en orden de filas.
//
// Convenciones (se usan en toda la aplicación):
//  - Mundo: X = este, Y = norte, Z = arriba (igual que la especificación W3C DeviceOrientation).
//  - Cámara: x = derecha de la imagen, y = arriba de la imagen, z = hacia el usuario.
//    La cámara trasera mira hacia -z.
//  - R es siempre la rotación cámara -> mundo.
//  - Rumbo (heading): ángulo en sentido horario desde el norte. Elevación (pitch): positivo hacia arriba.
//  - Píxeles: coordenadas de índice (el centro del primer píxel es 0,0), así que cx = (w-1)/2.

export const DEG = Math.PI / 180;
export const TAU = Math.PI * 2;

export const identity = () => [1, 0, 0, 0, 1, 0, 0, 0, 1];

export function mul(a, b) {
  return [
    a[0] * b[0] + a[1] * b[3] + a[2] * b[6], a[0] * b[1] + a[1] * b[4] + a[2] * b[7], a[0] * b[2] + a[1] * b[5] + a[2] * b[8],
    a[3] * b[0] + a[4] * b[3] + a[5] * b[6], a[3] * b[1] + a[4] * b[4] + a[5] * b[7], a[3] * b[2] + a[4] * b[5] + a[5] * b[8],
    a[6] * b[0] + a[7] * b[3] + a[8] * b[6], a[6] * b[1] + a[7] * b[4] + a[8] * b[7], a[6] * b[2] + a[7] * b[5] + a[8] * b[8],
  ];
}

export const transpose = (a) => [a[0], a[3], a[6], a[1], a[4], a[7], a[2], a[5], a[8]];

export const apply = (m, v) => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
  m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
  m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
];

export function rotX(t) { const c = Math.cos(t), s = Math.sin(t); return [1, 0, 0, 0, c, -s, 0, s, c]; }
export function rotY(t) { const c = Math.cos(t), s = Math.sin(t); return [c, 0, s, 0, 1, 0, -s, 0, c]; }
export function rotZ(t) { const c = Math.cos(t), s = Math.sin(t); return [c, -s, 0, s, c, 0, 0, 0, 1]; }

/**
 * Rotación cámara->mundo a partir de los ángulos de DeviceOrientationEvent (grados).
 * Según la especificación W3C la rotación dispositivo->tierra es Rz(alpha)·Rx(beta)·Ry(gamma).
 * El vídeo de getUserMedia llega girado según la orientación de pantalla, por lo que los ejes
 * de la imagen son los de la pantalla: se compensa con Rz(-screenAngle).
 */
export function fromDeviceOrientation(alpha, beta, gamma, screenAngle = 0) {
  const r = mul(mul(rotZ(alpha * DEG), rotX(beta * DEG)), rotY(gamma * DEG));
  return screenAngle ? mul(r, rotZ(-screenAngle * DEG)) : r;
}

/** Inversa de fromDeviceOrientation (con screenAngle = 0). Devuelve grados. */
export function toDeviceOrientation(R) {
  const r20 = R[6], r21 = R[7], r22 = R[8];
  let alpha, beta, gamma;
  if (Math.hypot(r20, r22) < 1e-9) {
    // beta = ±90°: alpha y gamma no son separables; se fija gamma = 0.
    gamma = 0;
    beta = r21 > 0 ? Math.PI / 2 : -Math.PI / 2;
    alpha = Math.atan2(R[3], R[0]);
  } else {
    gamma = r22 >= 0 ? Math.atan2(-r20, r22) : Math.atan2(r20, -r22);
    const cg = Math.cos(gamma), sg = Math.sin(gamma);
    const cb = Math.abs(cg) > 0.5 ? r22 / cg : -r20 / sg;
    beta = Math.atan2(r21, cb);
    alpha = cb > 0 ? Math.atan2(-R[1], R[4]) : Math.atan2(R[1], -R[4]);
  }
  let a = alpha / DEG;
  if (a < 0) a += 360;
  return { alpha: a, beta: beta / DEG, gamma: gamma / DEG };
}

/** Rotación cámara->mundo para rumbo h, elevación p y alabeo r (radianes). */
export function fromHeadingPitchRoll(h, p, r = 0) {
  const sh = Math.sin(h), ch = Math.cos(h), sp = Math.sin(p), cp = Math.cos(p);
  // columnas: derecha, arriba, -adelante
  const r0 = [
    ch, -sh * sp, -sh * cp,
    -sh, -ch * sp, -ch * cp,
    0, cp, -sp,
  ];
  return r ? mul(r0, rotZ(r)) : r0;
}

/** Dirección (unitaria, en mundo) hacia la que mira la cámara. */
export const forward = (R) => [-R[2], -R[5], -R[8]];

/** Vector unitario de mundo para rumbo h y elevación p (radianes). */
export const dirFromHP = (h, p) => [Math.sin(h) * Math.cos(p), Math.cos(h) * Math.cos(p), Math.sin(p)];

export function toHeadingPitchRoll(R) {
  const fx = -R[2], fy = -R[5], fz = -R[8];
  const h = Math.atan2(fx, fy);
  const p = Math.asin(Math.max(-1, Math.min(1, fz)));
  const sh = Math.sin(h), ch = Math.cos(h), sp = Math.sin(p), cp = Math.cos(p);
  const rx = R[0], ry = R[3], rz = R[6];
  const roll = Math.atan2(rx * -sh * sp + ry * -ch * sp + rz * cp, rx * ch - ry * sh);
  return { h, p, r: roll };
}

/** Exponencial de so(3) (fórmula de Rodrigues): vector de rotación -> matriz. */
export function expSO3(w) {
  const t = Math.hypot(w[0], w[1], w[2]);
  if (t < 1e-12) return [1, -w[2], w[1], w[2], 1, -w[0], -w[1], w[0], 1];
  const x = w[0] / t, y = w[1] / t, z = w[2] / t;
  const c = Math.cos(t), s = Math.sin(t), k = 1 - c;
  return [
    c + x * x * k, x * y * k - z * s, x * z * k + y * s,
    y * x * k + z * s, c + y * y * k, y * z * k - x * s,
    z * x * k - y * s, z * y * k + x * s, c + z * z * k,
  ];
}

/** Ángulo (radianes) de la rotación relativa entre A y B. */
export function angleBetween(A, B) {
  // traza(Aᵀ·B) = suma de productos elemento a elemento
  let tr = 0;
  for (let i = 0; i < 9; i++) tr += A[i] * B[i];
  return Math.acos(Math.max(-1, Math.min(1, (tr - 1) / 2)));
}

/** Reortonormaliza una matriz de rotación (Gram-Schmidt sobre columnas). */
export function orthonormalize(R) {
  let ax = R[0], ay = R[3], az = R[6];
  let n = Math.hypot(ax, ay, az); ax /= n; ay /= n; az /= n;
  let bx = R[1], by = R[4], bz = R[7];
  const d = ax * bx + ay * by + az * bz;
  bx -= d * ax; by -= d * ay; bz -= d * az;
  n = Math.hypot(bx, by, bz); bx /= n; by /= n; bz /= n;
  const cx = ay * bz - az * by, cy = az * bx - ax * bz, cz = ax * by - ay * bx;
  return [ax, bx, cx, ay, by, cy, az, bz, cz];
}

/** Cuaternión [w, x, y, z] de una matriz de rotación. */
export function toQuaternion(R) {
  const tr = R[0] + R[4] + R[8];
  let w, x, y, z;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    w = s / 4; x = (R[7] - R[5]) / s; y = (R[2] - R[6]) / s; z = (R[3] - R[1]) / s;
  } else if (R[0] > R[4] && R[0] > R[8]) {
    const s = Math.sqrt(1 + R[0] - R[4] - R[8]) * 2;
    w = (R[7] - R[5]) / s; x = s / 4; y = (R[1] + R[3]) / s; z = (R[2] + R[6]) / s;
  } else if (R[4] > R[8]) {
    const s = Math.sqrt(1 + R[4] - R[0] - R[8]) * 2;
    w = (R[2] - R[6]) / s; x = (R[1] + R[3]) / s; y = s / 4; z = (R[5] + R[7]) / s;
  } else {
    const s = Math.sqrt(1 + R[8] - R[0] - R[4]) * 2;
    w = (R[3] - R[1]) / s; x = (R[2] + R[6]) / s; y = (R[5] + R[7]) / s; z = s / 4;
  }
  return [w, x, y, z];
}

/** Diferencia angular con signo a-b reducida a (-π, π]. */
export function wrapPi(a) {
  a = a % TAU;
  if (a > Math.PI) a -= TAU;
  else if (a <= -Math.PI) a += TAU;
  return a;
}

/** Intrínsecos de una cámara estenopeica ideal con punto principal centrado. */
export function intrinsics(w, h, f) {
  return { w, h, f, cx: (w - 1) / 2, cy: (h - 1) / 2 };
}

/** Focal (px) por defecto si no hay calibración: ~26 mm equivalentes en un sensor 4:3. */
export const defaultFocalRel = 0.751;

export function fovOf(K) {
  return {
    h: 2 * Math.atan(K.w / 2 / K.f),
    v: 2 * Math.atan(K.h / 2 / K.f),
  };
}

/** Focal equivalente en 35 mm (por diagonal, 43,27 mm). */
export const focal35 = (K) => (K.f / Math.hypot(K.w, K.h)) * 43.27;
