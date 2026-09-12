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
const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: Number(process.env.WEBSINO_DPR ?? 2) });

const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

const shot = async (name) => {
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`  wrote ${name}.png`);
};

await page.goto('http://localhost:4173/', { waitUntil: 'networkidle' });
await page.waitForTimeout(400);
console.log('sign in'); await shot('00-signin');

// No server is running behind these screenshots, so take the practice door. Every
// game below therefore runs on the local dealer - the same engine the server uses.
await page.getByRole('button', { name: /practice mode/i }).click();
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

console.log('slots');
await page.getByRole('button', { name: /lobby/i }).click();
await page.waitForTimeout(300);
await page.getByRole('button', { name: /Golden Reels/ }).first().click();
await page.waitForTimeout(300);
await page.getByRole('button', { name: 'Spin', exact: true }).click();
await page.waitForTimeout(900);
await shot('06-slots');

console.log('blackjack');
await page.getByRole('button', { name: /lobby/i }).click();
await page.waitForTimeout(300);
await page.getByRole('button', { name: /Blackjack/ }).first().click();
await page.waitForTimeout(300);
await page.getByRole('button', { name: 'Deal', exact: true }).click();
await page.waitForTimeout(700);
await shot('07-blackjack');

// Play the hand out so a settled table is captured too - and so that a crash in
// settlement fails here rather than in front of a player.
for (let i = 0; i < 6; i += 1) {
  const stand = page.getByRole('button', { name: 'Stand', exact: true });
  const decline = page.getByRole('button', { name: /No thanks/ });
  if (await decline.count()) { await decline.click(); }
  else if (await stand.count()) { await stand.click(); }
  else break;
  await page.waitForTimeout(350);
}
await shot('08-blackjack-settled');

console.log('crash');
await page.getByRole('button', { name: /lobby/i }).click();
await page.waitForTimeout(300);
await page.getByRole('button', { name: /Crash/ }).first().click();
await page.waitForTimeout(300);
await page.getByRole('button', { name: 'Bet', exact: true }).click();
await page.waitForTimeout(900);
await shot('09-crash');
const cashOut = page.getByRole('button', { name: /Cash out/ });
if (await cashOut.count()) { await cashOut.click(); await page.waitForTimeout(500); }
await shot('10-crash-settled');

// Mobile, since the pygame version could never do this at all.
await page.setViewportSize({ width: 402, height: 860 });
await page.waitForTimeout(300);
await shot('11-crash-mobile');
await page.getByRole('button', { name: /lobby/i }).click();
await page.waitForTimeout(300);
await shot('12-lobby-mobile');
await page.getByRole('button', { name: /Blackjack/ }).first().click();
await page.waitForTimeout(300);
await page.getByRole('button', { name: 'Deal', exact: true }).click();
await page.waitForTimeout(700);
await shot('13-blackjack-mobile');

/*
 * Geometry check, not a screenshot: every rank's corners must stay inside the card.
 * The corners used to be grid areas sized by their content, so the two-character "10"
 * pushed the bottom-right corner off the edge - a bug no unit test could see and one
 * that only appeared on tens, at the large size, in a real browser.
 */
console.log('card geometry');
const overflowing = await page.evaluate(() => {
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;inset:0 auto auto 0;display:flex;opacity:0;pointer-events:none';
  for (const rank of ['2','3','4','5','6','7','8','9','10','J','Q','K','A']) {
    host.insertAdjacentHTML('beforeend', `
      <div class="card card--lg card--black"><div class="card__inner">
        <span class="card__corner card__corner--tl"><span class="card__rank">${rank}</span><span class="card__suit">\u2660</span></span>
        <span class="card__pip">\u2660</span>
        <span class="card__corner card__corner--br"><span class="card__rank">${rank}</span><span class="card__suit">\u2660</span></span>
      </div></div>`);
  }
  document.body.appendChild(host);
  const bad = [];
  for (const card of host.querySelectorAll('.card')) {
    const box = card.getBoundingClientRect();
    for (const corner of card.querySelectorAll('.card__corner')) {
      const c = corner.getBoundingClientRect();
      if (c.left < box.left - 0.5 || c.right > box.right + 0.5 ||
          c.top < box.top - 0.5 || c.bottom > box.bottom + 0.5) {
        bad.push(card.querySelector('.card__rank').textContent + (corner.className.includes('br') ? ' (bottom-right)' : ' (top-left)'));
      }
    }
  }
  host.remove();
  return bad;
});
if (overflowing.length) errors.push(`card corners escape the card on: ${overflowing.join(', ')}`);
else console.log('  every rank fits inside its card');

await browser.close();
server.close();

if (errors.length) {
  console.error(`\n${errors.length} console/page error(s):`);
  for (const e of errors.slice(0, 10)) console.error('  ' + e);
  process.exit(1);
}
console.log('\nno console errors');
