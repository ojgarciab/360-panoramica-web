// Genera los iconos PNG a partir de icons/icon.svg (requiere Playwright).
import { createRequire } from 'node:module';
// require() respeta NODE_PATH, útil si Playwright está instalado globalmente
const { chromium } = createRequire(import.meta.url)('playwright');
import { readFile } from 'node:fs/promises';

const svg = await readFile(new URL('../icons/icon.svg', import.meta.url), 'utf8');
const browser = await chromium.launch();
for (const [name, size, pad] of [['icon-192', 192, 0], ['icon-512', 512, 0], ['icon-maskable-512', 512, 0.12]]) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  const inner = Math.round(size * (1 - 2 * pad));
  await page.setContent(`<body style="margin:0;background:${pad ? '#101418' : 'transparent'};display:grid;place-items:center;height:100vh">
    <div style="width:${inner}px;height:${inner}px">${svg}</div></body>`);
  await page.screenshot({ path: new URL(`../icons/${name}.png`, import.meta.url).pathname, omitBackground: !pad });
  await page.close();
}
await browser.close();
