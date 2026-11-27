// Prueba de extremo a extremo en modo demostración (requiere Playwright):
// calibra la cámara simulada, captura la esfera completa con el piloto automático,
// cose la panorámica y comprueba el resultado. Uso: npm run e2e [carpeta-de-salida]
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startServer } from './serve.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');
const out = process.argv[2] || 'e2e-salida';
mkdirSync(out, { recursive: true });
const port = 8123;
const server = await startServer(port);
const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const errors = [];
let failed = false;
const check = (ok, text) => { console.log(`${ok ? '✔' : '✘'} ${text}`); if (!ok) failed = true; };

try {
  const ctx = await browser.newContext({ viewport: { width: 412, height: 800 }, deviceScaleFactor: 2, acceptDownloads: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`http://localhost:${port}/?demo=auto&ancho=2048`);
  await page.waitForFunction(() => window.__pano);
  await page.screenshot({ path: join(out, '1-inicio.png') });

  // --- Calibración ---
  await page.click('#btn-calib');
  await page.waitForFunction(() => !document.getElementById('calib-start').disabled && window.__pano.calib.active);
  await page.click('#calib-start');
  await page.waitForSelector('#calib-result:not([hidden])', { timeout: 120000 });
  await page.screenshot({ path: join(out, '2-calibracion.png') });
  const calib = await page.evaluate(() => window.__pano.calib.result);
  console.log('calibración:', JSON.stringify(calib));
  check(Math.abs(calib.fRel - 0.8) < 0.02, `focal relativa estimada ${calib.fRel.toFixed(4)} (real 0.8)`);
  await page.click('#calib-save');
  await page.click('#calib-exit');

  // --- Captura ---
  await page.click('#btn-new');
  await page.waitForFunction(() => window.__pano.capture.active);
  await page.click('#cap-shutter');
  await page.waitForFunction(() => window.__pano.capture.count >= 8, null, { timeout: 120000 });
  await page.screenshot({ path: join(out, '3-captura.png') });
  await page.click('#cap-globe');
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(out, '4-esfera.png') });
  await page.click('#globe-close');
  await page.waitForFunction(() => window.__pano.lastResult, null, { timeout: 600000 });
  const result = await page.evaluate(() => window.__pano.lastResult);
  console.log('resultado:', JSON.stringify(result));
  check(!result.error, 'panorámica generada');
  check(result.coverage > 0.999, `cobertura ${(result.coverage * 100).toFixed(2)} %`);
  check(result.stats.medianAfterDeg < result.stats.medianBeforeDeg, `ajuste fino ${result.stats.medianBeforeDeg.toFixed(3)}° → ${result.stats.medianAfterDeg.toFixed(3)}°`);
  await page.waitForSelector('#view-session.active');
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(out, '5-visor.png') });

  // --- Descargas ---
  const [d1] = await Promise.all([page.waitForEvent('download'), page.click('#ses-dl-pano')]);
  await d1.saveAs(join(out, 'panoramica.jpg'));
  const [d2] = await Promise.all([page.waitForEvent('download'), page.click('#ses-dl-parts')]);
  await d2.saveAs(join(out, 'partes.zip'));
  check(/^pano360_\d{8}_\d{6}\.jpg$/.test(d1.suggestedFilename()), `descarga ${d1.suggestedFilename()}`);
  check(d2.suggestedFilename().endsWith('_partes.zip'), `descarga ${d2.suggestedFilename()}`);

  // --- Importación del ZIP exportado ---
  await page.click('#ses-back');
  await page.setInputFiles('#file-import', join(out, 'partes.zip'));
  await page.waitForFunction(() => document.getElementById('view-session').classList.contains('active')
    && document.getElementById('ses-title').textContent.includes('importada'), null, { timeout: 60000 });
  const parts = await page.locator('#ses-parts li').count();
  check(parts === 49 || parts > 8, `ZIP importado con ${parts} fotos`);
  await page.evaluate(() => { window.__pano.lastResult = null; });
  await page.click('#ses-rebuild');
  await page.waitForFunction(() => window.__pano.lastResult, null, { timeout: 600000 });
  const again = await page.evaluate(() => window.__pano.lastResult);
  check(!again.error && again.coverage > 0.999 && again.stats.matches === result.stats.matches,
    `panorámica regenerada desde el ZIP (${again.stats.matches} coincidencias, igual que la original)`);
  await page.waitForSelector('#view-session.active');
  await page.screenshot({ path: join(out, '7-importada.png') });

  // --- Persistencia y funcionamiento sin conexión ---
  await page.waitForFunction(() => navigator.serviceWorker.controller || navigator.serviceWorker.ready.then(() => true));
  await page.waitForTimeout(1000);
  await ctx.setOffline(true);
  await page.goto(`http://localhost:${port}/`);
  await page.waitForFunction(() => window.__pano);
  const sessions = await page.locator('#session-list li').count();
  check(sessions === 2, 'la captura persiste y la aplicación carga sin conexión');
  await page.screenshot({ path: join(out, '6-sin-conexion.png') });
  writeFileSync(join(out, 'errores.txt'), errors.join('\n'));
  check(errors.length === 0, `sin errores de consola (${errors.length})`);
  if (errors.length) console.log(errors.join('\n'));
} catch (e) {
  console.error(e);
  console.log(errors.join('\n'));
  failed = true;
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
