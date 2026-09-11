/**
 * Renders the built client headlessly and saves screenshots.
 * Doubles as a smoke test: a crash in any screen fails here rather than in front
 * of a player.  Usage: node tools/shots/capture.mjs <outDir>
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const ROOT = new URL('../../apps/web/dist/', import.meta.url).pathname;
const OUT = process.argv[2] ?? 'shots';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

const server = createServer(async (req, res) => {
  try {
    const url = (req.url ?? '/').split('?')[0];
    const rel = url === '/' ? 'index.html' : normalize(url).replace(/^\/+/, '');
    const body = await readFile(join(ROOT, rel));
    res.writeHead(200, { 'content-type': TYPES[extname(rel)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise((r) => server.listen(4173, r));

// This sandbox ships a pinned Chromium that may not match the Playwright build
// number, so use the installed binary rather than trying to download one.
const CHROME = process.env.WEBSINO_CHROME ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch(
  existsSync(CHROME) ? { executablePath: CHROME } : {},
);
const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2 });

const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

const shot = async (name) => {
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`  wrote ${name}.png`);
};

await page.goto('http://localhost:4173/', { waitUntil: 'networkidle' });
await page.waitForTimeout(400);
console.log('lobby'); await shot('01-lobby');

console.log('dice');
await page.getByRole('button', { name: /Dice/ }).first().click();
await page.waitForTimeout(300);
await shot('02-dice');
await page.getByRole('button', { name: 'Roll', exact: true }).click();
await page.waitForTimeout(600);
await shot('03-dice-rolled');

// Open the fairness drawer - the thing that has to actually work, not just exist.
await page.getByRole('button', { name: /Provably fair/ }).click();
await page.waitForTimeout(300);
await shot('04-fairness');

console.log('limbo');
await page.getByRole('button', { name: /lobby/i }).click();
await page.waitForTimeout(300);
await page.getByRole('button', { name: /Limbo/ }).first().click();
await page.waitForTimeout(300);
await page.getByRole('button', { name: 'Play', exact: true }).click();
await page.waitForTimeout(600);
await shot('05-limbo');

// Mobile, since the pygame version could never do this at all.
await page.setViewportSize({ width: 402, height: 860 });
await page.waitForTimeout(300);
await shot('06-limbo-mobile');
await page.getByRole('button', { name: /lobby/i }).click();
await page.waitForTimeout(300);
await shot('07-lobby-mobile');

await browser.close();
server.close();

if (errors.length) {
  console.error(`\n${errors.length} console/page error(s):`);
  for (const e of errors.slice(0, 10)) console.error('  ' + e);
  process.exit(1);
}
console.log('\nno console errors');
