# Estudio: calibración de la cámara del móvil para panorámicas 360°

Este documento resume los métodos y proyectos de código abierto que se estudiaron para calibrar
la cámara, qué se eligió implementar y por qué, y qué queda como mejora futura.

## 1. Qué hay que calibrar

Para proyectar cada foto sobre la esfera hace falta saber qué dirección del espacio corresponde
a cada píxel. Con el modelo estenopeico eso son los **intrínsecos**:

| Parámetro | Significado | Importancia para panorámicas |
|---|---|---|
| Focal `f` (px) | Equivale al campo de visión: `FOV = 2·atan(lado / 2f)` | **Crítica.** Un 3 % de error ya produce costuras visibles y un plan de disparos incorrecto |
| Punto principal `cx, cy` | Dónde corta el eje óptico al sensor | Baja: en móviles está a pocos píxeles del centro |
| Distorsión radial `k1, k2…` | Curvatura de las líneas rectas | Baja en la cámara principal: el vídeo que entrega el navegador ya viene corregido por el fabricante. Relevante en ultra gran angulares |
| Desfase temporal sensor–cámara | Retardo entre el giroscopio y el fotograma | Relevante sólo si se dispara en movimiento |
| Alineación sensor–cámara | Rotación entre los ejes del giroscopio y los de la cámara | Fracciones de grado; la absorbe el ajuste fino del cosido |

El navegador no expone la focal: `MediaTrackSettings` no la incluye y el vídeo de `getUserMedia`
recorta el sensor de forma distinta según la resolución. Por eso la calibración se guarda **por
cámara y por resolución de vídeo**.

## 2. Métodos estudiados

### 2.1 Patrón plano (método de Zhang)

- **Referencia:** Z. Zhang, *A Flexible New Technique for Camera Calibration* (2000).
- **Código abierto:** `calibrateCamera` de [OpenCV](https://github.com/opencv/opencv) (módulo `calib3d`),
  con tableros de ajedrez, rejillas de círculos o ChArUco; también disponible en OpenCV.js.
  La *Camera Calibration Toolbox* de Bouguet es la implementación histórica de referencia.
- **Cómo funciona:** varias vistas de un patrón plano de geometría conocida dan homografías de las
  que se despejan los intrínsecos; después se refinan con Levenberg–Marquardt junto con la distorsión.
- **Ventajas:** es el método más preciso; estima también punto principal y distorsión.
- **Inconvenientes aquí:** obliga a imprimir (o mostrar en otra pantalla) un patrón, y OpenCV.js pesa
  varios megabytes de WebAssembly. Excesivo cuando lo único crítico es la focal.

### 2.2 Autocalibración por rotación pura

- **Referencias:** R. Hartley, *Self-Calibration of Stationary Cameras* (1997); M. Brown y D. Lowe,
  *Automatic Panoramic Image Stitching using Invariant Features* (2007); R. Szeliski,
  *Image Alignment and Stitching: A Tutorial* (2006).
- **Código abierto:** el módulo `stitching` de OpenCV (estimadores de focal a partir de homografías y
  *bundle adjustment*), [Hugin](https://hugin.sourceforge.io/) / Panorama Tools (optimiza el campo de
  visión `v` y la distorsión `a, b, c` a partir de los puntos de control) y
  [OpenPano](https://github.com/ppwwyyxx/OpenPano).
- **Cómo funciona:** si la cámara sólo gira, dos fotos se relacionan por `H = K·R·K⁻¹`. De las
  correspondencias entre fotos se despejan a la vez las rotaciones y la focal, sin patrón alguno.
- **Ventajas:** usa las mismas fotos de la panorámica; no necesita nada más.
- **Inconvenientes:** con rotaciones desconocidas la focal queda débilmente determinada si los giros
  son pequeños o sobre un solo eje, y es sensible al paralaje.

### 2.3 Rotación conocida por giroscopio (método elegido)

- **Referencias:** es la idea de fondo de la calibración cámara–IMU (por ejemplo
  [Kalibr](https://github.com/ethz-asl/kalibr)) y de la estabilización de vídeo con giroscopio
  (Karpenko et al., *Digital Video Stabilization and Rolling Shutter Correction using Gyroscopes*, 2011),
  reducida al caso más simple.
- **Cómo funciona:** los sensores del móvil ya dan la rotación `R` entre dos fotos. Con `R` conocida,
  el desplazamiento que sufre la imagen depende **sólo de la focal**: un giro de `θ` desplaza el centro
  `f·tan θ` píxeles. Basta medir ese desplazamiento y buscar la `f` que mejor lo explica.
- **Ventajas:** problema unidimensional y muy bien condicionado; sin patrón; se hace en segundos;
  cabe en unas decenas de líneas sin dependencias.
- **Inconvenientes:** no estima punto principal ni distorsión; depende de la calidad del giroscopio
  (muy buena en giros de pocos segundos) y de girar sin desplazarse.

### 2.4 Métodos manuales

- Introducir el campo de visión conocido del modelo de móvil, o ajustar un deslizador hasta que una
  panorámica de prueba encaje. Sirve de respaldo cuando no hay sensores o la escena no tiene textura.

### 2.5 Calibración del resto de sensores

- **Brújula:** el magnetómetro sufre saltos e interferencias. La aplicación toma la pose del evento
  `deviceorientation` relativo (acelerómetro + giroscopio) y usa la brújula únicamente para anotar el
  norte en los metadatos.
- **Deriva del giroscopio:** se corrige en el cosido (apartado 4), no en la calibración.

## 3. Lo implementado

### 3.1 Calibración «giro con sensores» (`src/calibration.js`)

1. El usuario gira despacio el móvil sobre sí mismo, primero hacia un lado y luego hacia arriba (hay
   que mover los dos ejes: girar sobre el eje óptico no aporta información). La aplicación guarda 12
   muestras, una cada 7° de giro y sólo cuando la velocidad angular es menor de 10°/s, para limitar el
   desenfoque y el efecto del retardo sensor–cámara.
2. Cada muestra es el fotograma reducido en gris más la orientación del sensor.
3. Para cada par de muestras solapadas, la segunda se deforma al encuadre de la primera con la
   homografía `K·R·K⁻¹` usando la focal actual, y se mide el desplazamiento residual de una rejilla de
   parches por correlación cruzada normalizada (ZNCC) con refinamiento subpíxel (`src/match.js`).
4. Con todas las correspondencias y las rotaciones del sensor fijas se minimiza el error de
   reproyección (truncado, para tolerar falsos emparejamientos) en función de `f`: barrido logarítmico
   seguido de búsqueda por sección áurea (`estimateFocal` en `src/optimize.js`).
5. Se repite tres veces desde el paso 3 con la focal mejorada.
6. Se informa de la focal, el campo de visión, la focal equivalente en 35 mm, el error RMS en píxeles
   y la proporción de coincidencias válidas, con una calificación (buena / aceptable / baja).

### 3.2 Ajuste manual

Deslizador del campo de visión del lado largo de la imagen.

### 3.3 Almacenamiento local

Las calibraciones se guardan en `localStorage` (clave `pano360.calibraciones.v1`), indexadas por
`etiqueta de la cámara | resolución`, como focal relativa al lado largo (`fRel = f / lado largo`):

```json
{ "camera2 0, facing back|1920x1440": { "fRel": 0.742, "method": "giro-sensores",
    "quality": "buena", "rmsRel": 0.0007, "inliers": 2870, "date": "2026-11-21T13:23:41Z" } }
```

Sin calibración se asume `fRel = 0,751` (unos 26 mm equivalentes, 67° en el lado largo), típico de la
cámara principal de un móvil.

### 3.4 Validación

`npm test` genera fotos sintéticas de una escena conocida con focales de 380 y 520 px, añade ruido de
0,15° a las orientaciones y parte de una estimación inicial errónea (hasta un 44 %): la focal se
recupera con un error menor del 2 %. La prueba de extremo a extremo (`npm run e2e`) hace lo mismo
dentro del navegador con la cámara simulada (focal relativa real 0,8; estimada 0,7999).

**Pendiente de validar en dispositivos reales:** estas pruebas usan datos simulados. La precisión
real dependerá del giroscopio de cada móvil y de la escena.

## 4. Relación con el cosido

Aunque la focal esté bien calibrada, el rumbo de los sensores deriva. Al coser (`src/stitch-core.js`):

- se emparejan las fotos que los sensores dicen que se solapan (opcionalmente sólo las contiguas),
  con una búsqueda en dos escalas limitada a la zona de solape;
- cada par se verifica: sus coincidencias deben ser coherentes con un único giro, y las que no lo
  son se descartan;
- si la cámara **no está calibrada**, la focal se estima con las propias fotos de la captura usando
  el mismo método del apartado 3.1 (giros de los sensores) y se vuelve a emparejar;
- un *bundle adjustment* sólo de rotaciones (Gauss–Newton con pesos de Huber) corrige cada
  orientación, con un término de confianza en el sensor fuerte en inclinación (la gravedad se mide
  bien) y débil en rumbo (donde deriva el giroscopio);
- se compensa la exposición con una ganancia por foto y se mezcla en dos bandas (Brown y Lowe).

Se probó también la autocalibración sin sensores (apartado 2.2) dentro del cosido y se descartó: con
una captura real hecha a pulso estimaba una focal un 13 % menor que la correcta, porque el
desplazamiento de la cámara (paralaje) con suelo cercano se confunde con un cambio de escala. La
estimación apoyada en los sensores recuperó sobre esas mismas fotos la focal calibrada con un
error inferior al 2 % partiendo de valores un 10 % erróneos.

## 5. Mejoras futuras

- Estimar distorsión radial `k1` y punto principal junto con la focal (como hace Hugin), útil para
  ultra gran angulares.
- Estimar el retardo sensor–cámara para poder disparar en movimiento.
- Calibración con ChArUco mediante OpenCV.js como opción de máxima precisión.
- Búsqueda de costuras y deformación local para disimular el paralaje de objetos cercanos.
