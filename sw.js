// Service worker: guarda toda la aplicación en caché para funcionar 100 % sin conexión.
// Al cambiar cualquier archivo hay que incrementar VERSION para que los clientes se actualicen.
const VERSION = 'pano360-v1';
const ASSETS = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png',
  'src/main.js', 'src/math3d.js', 'src/sensors.js', 'src/camera.js', 'src/capture.js',
  'src/calib-ui.js', 'src/calibration.js', 'src/targets.js', 'src/sphere-view.js',
  'src/match.js', 'src/optimize.js', 'src/stitch-core.js', 'src/stitch-engine.js',
  'src/stitch-worker.js', 'src/pipeline.js', 'src/viewer.js', 'src/exif.js', 'src/zip.js',
  'src/db.js', 'src/sim.js', 'src/scene.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request)),
  );
});
