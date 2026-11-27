# Panorámica 360 Web

Aplicación web **100 % offline** para tomar fotos esféricas (360° × 180°) con la cámara y los
sensores del móvil. Todo ocurre en el dispositivo: captura, calibración, cosido y almacenamiento.
No hay servidor, ni dependencias externas, ni paso de compilación.

## Funciones

- **Captura guiada** con puntos guía sobre el vídeo y disparo automático al alinear y quedarse quieto.
- **Esfera de cobertura**: velo rojizo sobre las zonas sin fotografiar y una esfera (delante / detrás)
  que muestra en verde lo cubierto y en rojo lo pendiente.
- **Calibración de la cámara** girando el móvil (asistida por sensores) o manual, guardada en local.
  Estudio de métodos en [docs/calibracion.md](docs/calibracion.md).
- **Cosido en el dispositivo** (Web Worker): alineación fina por imagen que corrige la deriva de los
  sensores, compensación de exposición y mezcla equirectangular en dos bandas de hasta 8192 × 4096.
  En Ajustes se puede limitar el emparejamiento a las fotos contiguas, elegir el tamaño de la zona
  de emparejamiento y desactivar la mezcla en dos bandas.
- **Guardado local** (IndexedDB) y **descarga** de la panorámica y, opcionalmente, de las fotos
  individuales en un ZIP con `metadatos.json`.
- **Importación** de ese ZIP para recuperar una captura en otro dispositivo y volver a coserla.
- **Metadatos**: EXIF (fecha, focal equivalente, rumbo y GPS opcional, lecturas de sensores en
  `UserComment`) y XMP (`GPano` para que los visores reconozcan la panorámica; pose de cada foto).
- **Visor 360°** integrado y **PWA instalable** que funciona sin conexión.

## Uso

La cámara y los sensores exigen un contexto seguro: **HTTPS** o `localhost`.

```bash
npm start          # sirve en http://localhost:8080
```

Para usarla en el móvil hay que publicarla por HTTPS; al ser estática vale cualquier alojamiento,
por ejemplo GitHub Pages (Settings → Pages → *Deploy from a branch* → raíz del repositorio).
Tras la primera visita queda en caché y se puede instalar («Añadir a pantalla de inicio»).

1. **Calibrar cámara** (recomendado, una vez por cámara): apunta a una escena lejana con detalle,
   pulsa «Calibrar» y gira despacio hacia un lado y luego hacia arriba, sin desplazarte.
2. **Nueva captura**: con el móvil en vertical, pulsa el botón para fijar el punto de partida y lleva
   el círculo central a cada punto amarillo. Gira sobre el móvil, no sobre ti, para reducir el paralaje.
3. **Terminar** para coser. Después puedes ver, descargar, regenerar o borrar la captura.

### Modo demostración (sin móvil)

`http://localhost:8080/?demo` simula cámara y sensores con una escena sintética; se gira arrastrando
o con las flechas. `?demo=auto` añade un piloto automático que completa la calibración y la captura.

## Pruebas

```bash
npm test           # núcleo: geometría, cobertura, cosido, calibración, EXIF, ZIP (Node ≥ 20)
npm run e2e        # extremo a extremo en Chromium con el modo demostración (requiere Playwright)
```

## Estado y limitaciones

- Verificado con datos simulados, en Chromium de escritorio y con una captura real de un móvil
  Android (52 fotos) reprocesada desde su ZIP. No se ha probado en iOS.
- El rumbo de los sensores puede acumular 15–20° de error por vuelta en algunos móviles. El cosido
  lo corrige con la brújula y las propias fotos; **sin brújula** los anillos de fotos pueden quedar
  girados entre sí (véase [docs/calibracion.md](docs/calibracion.md)).
- Las fotos son fotogramas del vídeo (típicamente 1920 × 1440), no fotos a resolución completa del sensor.
- **Paralaje:** si la cámara se desplaza entre fotos (por ejemplo, al girar con el brazo extendido),
  los objetos a 1–2 m no pueden encajar con los lejanos: quedarán cortados o desplazados en las
  costuras. Hay que girar el móvil sobre sí mismo, manteniendo la cámara en el mismo punto.
- En iOS el lienzo limita la panorámica a unos 16 Mpx (usa 4096 × 2048).
- Al cambiar archivos hay que incrementar `VERSION` en `sw.js` para que los clientes se actualicen.

## Estructura

| Archivo | Contenido |
|---|---|
| `src/math3d.js` | Rotaciones y convenciones de ejes |
| `src/sensors.js`, `src/camera.js` | Orientación del dispositivo y `getUserMedia` |
| `src/targets.js`, `src/sphere-view.js` | Plan de disparos, cobertura y dibujo de la guía y la esfera |
| `src/capture.js`, `src/calib-ui.js` | Pantallas de captura y calibración |
| `src/match.js`, `src/optimize.js` | Emparejamiento ZNCC, ajuste de rotaciones, focal y ganancias |
| `src/stitch-core.js`, `src/stitch-engine.js`, `src/stitch-worker.js`, `src/pipeline.js` | Cosido |
| `src/calibration.js` | Autocalibración y almacenamiento de calibraciones |
| `src/exif.js`, `src/zip.js`, `src/db.js` | EXIF/XMP, ZIP e IndexedDB |
| `src/sim.js`, `src/scene.js` | Modo demostración |
| `sw.js`, `manifest.webmanifest` | PWA offline |

## Licencia

GPL-3.0 (véase [LICENSE](LICENSE)).
