/**
 * Verifies the offline build is genuinely playable from a `file://` URL.
 *
 * Worth its own check because this is exactly the thing that fails silently: a normal
 * multi-file bundle looks fine over http and then dies on `file://`, where Chrome
 * blocks ES module imports via CORS. The single-file build exists to dodge that, and
 * this proves it worked.
 *
 *   node tools/shots/offline.mjs
 */
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';

const FILE = new URL('../../apps/web/dist-offline/index.html', import.meta.url).pathname;
if (!existsSync(FILE)) {
  console.error(`missing ${FILE} - run: pnpm --filter @websino/web build:offline`);
  process.exit(1);
}

const CHROME = process.env.WEBSINO_CHROME ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch(existsSync(CHROME) ? { executablePath: CHROME } : {});
const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2 });

const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

await page.goto(`file://${FILE}`);
await page.waitForTimeout(600);

const rendered = await page.getByRole('heading', { name: 'Websino' }).isVisible();
console.log(`rendered from file://            ${rendered ? 'yes' : 'NO'}`);

// Rendering is not enough - it has to actually deal.
await page.getByRole('button', { name: /Dice/ }).first().click();
await page.waitForTimeout(300);
const before = (await page.locator('.shell__chips').textContent())?.trim();
await page.getByRole('button', { name: 'Roll', exact: true }).click();
await page.waitForTimeout(700);
const after = (await page.locator('.shell__chips').textContent())?.trim();
console.log(`balance moved on a real round    ${before} -> ${after}`);

const out = process.argv[2];
if (out) await page.screenshot({ path: `${out}/offline.png` });
await browser.close();

if (!rendered || before === after || errors.length) {
  console.error('FAILED', errors.slice(0, 5));
  process.exit(1);
}
console.log('offline build is genuinely playable, with no console errors');
