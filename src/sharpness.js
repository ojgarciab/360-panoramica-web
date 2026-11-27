// Medida de nitidez de una foto: energía del laplaciano de la luminancia.
// Una imagen movida o desenfocada pierde bordes finos, así que su laplaciano (la segunda
// derivada) tiene mucha menos energía. Sirve para comparar tomas de la misma escena.

/**
 * @param rgba píxeles RGBA   @param w,h tamaño
 * @param step separación entre muestras (2 = uno de cada cuatro píxeles, suficiente y rápido)
 * @returns número mayor cuanto más nítida es la imagen (sólo comparable entre tomas de la misma escena)
 */
export function sharpness(rgba, w, h, step = 2) {
  // zona central (80 %): los bordes aportan poco y suelen tener más viñeteo
  const x0 = Math.max(1, Math.round(w * 0.1)), x1 = Math.min(w - 1, Math.round(w * 0.9));
  const y0 = Math.max(1, Math.round(h * 0.1)), y1 = Math.min(h - 1, Math.round(h * 0.9));
  const lum = (i) => 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
  const row = w * 4;
  let sum = 0, n = 0;
  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      const i = y * row + x * 4;
      const l = 4 * lum(i) - lum(i - 4) - lum(i + 4) - lum(i - row) - lum(i + row);
      sum += l * l; n++;
    }
  }
  return n ? sum / n : 0;
}
