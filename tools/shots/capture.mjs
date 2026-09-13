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
await page.getByRole('button', { name: /^Slots\b/ }).first().click();
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

console.log('roulette');
await page.getByRole('button', { name: /lobby/i }).click();
await page.waitForTimeout(300);
await page.getByRole('button', { name: /Roulette/ }).first().click();
await page.waitForTimeout(300);
// Put chips on a spread of bet types, then spin.
// Number spots are labelled by the number itself, so match exactly. Every click here
// is guarded: a selector that silently waits 30s for an element that never appears
// turns a verification step into a coin flip.
await page.locator('.felt').waitFor({ timeout: 10_000 });
for (const name of ['17', '23']) {
  const spot = page.getByRole('button', { name, exact: true });
  if (await spot.count()) await spot.first().click();
}
for (const label of [/^Red$/, /^25–36$/]) {
  const spot = page.getByRole('button', { name: label });
  if (await spot.count()) await spot.first().click();
}
await shot('14-roulette-bets');
await page.getByRole('button', { name: 'Spin', exact: true }).click();
await page.waitForTimeout(800);
await shot('15-roulette');

console.log('mines');
await page.getByRole('button', { name: /lobby/i }).click();
await page.waitForTimeout(300);
await page.getByRole('button', { name: /Mines/ }).first().click();
await page.waitForTimeout(300);
await page.locator('.mines__grid').waitFor({ timeout: 10_000 });
await page.getByRole('button', { name: 'New board', exact: true }).click();
await page.waitForTimeout(400);
// Reveal a few tiles; stop as soon as the board ends.
//
// `count()` alone is not enough: hitting a mine settles the board and disables every
// remaining tile, which stays in the DOM. Clicking one then waits the full thirty
// seconds for an element that will never become actionable.
for (let i = 0; i < 4; i += 1) {
  const tile = page.getByRole('button', { name: `tile ${i + 1}`, exact: true });
  if (!(await tile.count()) || !(await tile.isEnabled())) break;
  await tile.click();
  await page.waitForTimeout(300);
}
await shot('16-mines');
const cashMines = page.getByRole('button', { name: /Cash out/ });
if (await cashMines.count()) { await cashMines.click(); await page.waitForTimeout(500); }
await shot('17-mines-settled');

console.log('video poker');
await page.getByRole('button', { name: /lobby/i }).click();
await page.waitForTimeout(300);
await page.getByRole('button', { name: /Jacks or Better/ }).first().click();
await page.waitForTimeout(300);
await page.locator('.vp__hand').waitFor({ timeout: 10_000 });
await page.getByRole('button', { name: /^Deal/ }).click();
await page.waitForTimeout(500);
const vpHint = page.getByRole('button', { name: /best play/ });
if (await vpHint.count()) { await vpHint.click(); await page.waitForTimeout(500); }
await shot('18-videopoker-holds');
await page.getByRole('button', { name: 'Draw', exact: true }).click();
await page.waitForTimeout(600);
await shot('19-videopoker');

console.log('plinko');
await page.getByRole('button', { name: /lobby/i }).click();
await page.waitForTimeout(300);
await page.getByRole('button', { name: /Plinko/ }).first().click();
await page.locator('.bucket').first().waitFor({ timeout: 10_000 });
await shot('25-plinko');
await page.getByRole('button', { name: /^Drop for/ }).click();
// Sixteen rows at 90ms each, plus the landing beat.
await page.waitForTimeout(1_800);
await shot('26-plinko-landed');

console.log('wheel');
await page.getByRole('button', { name: /lobby/i }).click();
await page.waitForTimeout(300);
await page.getByRole('button', { name: /Wheel of Fortune/ }).first().click();
await page.locator('.wof__wheel').waitFor({ timeout: 10_000 });
await shot('27-wheel');
await page.getByRole('button', { name: /^Spin for/ }).click();
await page.waitForTimeout(3_200);
await shot('28-wheel-settled');

console.log('hi-lo');
await page.getByRole('button', { name: /lobby/i }).click();
await page.waitForTimeout(300);
await page.getByRole('button', { name: /Hi-Lo/ }).first().click();
await page.locator('.hilo').waitFor({ timeout: 10_000 });
await page.getByRole('button', { name: /^Deal for/ }).click();
await page.waitForTimeout(500);
await shot('29-hilo');
for (let i = 0; i < 3; i += 1) {
  const higher = page.getByRole('button', { name: /Higher or same/ });
  if (!(await higher.count()) || !(await higher.isEnabled())) break;
  await higher.click();
  await page.waitForTimeout(450);
}
await shot('30-hilo-played');

console.log('towers');
await page.getByRole('button', { name: /lobby/i }).click();
await page.waitForTimeout(300);
await page.getByRole('button', { name: /Towers/ }).first().click();
await page.locator('.towers').waitFor({ timeout: 10_000 });
await page.getByRole('button', { name: /^Climb for/ }).click();
await page.waitForTimeout(500);
await shot('31-towers');
for (let i = 0; i < 4; i += 1) {
  // Always the first tile of whichever row is live; a trap ends it, which is a
  // perfectly good screenshot too.
  const tile = page.locator('.rung.is-active .rung__tile').first();
  if (!(await tile.count()) || !(await tile.isEnabled())) break;
  await tile.click();
  await page.waitForTimeout(450);
}
await shot('32-towers-played');

console.log("hold'em");
await page.getByRole('button', { name: /lobby/i }).click();
await page.waitForTimeout(300);
await page.getByRole('button', { name: /Hold'em/ }).first().click();
await page.waitForTimeout(300);
await shot('21-holdem-empty');
await page.getByRole('button', { name: /^Sit down/ }).click();
await page.waitForTimeout(900);
await shot('22-holdem');

// Play a few decisions so a mid-hand table and a settled one both get captured.
for (let i = 0; i < 8; i += 1) {
  const check = page.getByRole('button', { name: 'Check', exact: true });
  const call = page.getByRole('button', { name: /^Call/ });
  if (await check.count()) await check.click();
  else if (await call.count()) await call.first().click();
  else break;
  await page.waitForTimeout(450);
}
await shot('23-holdem-played');

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
await page.getByRole('button', { name: /lobby/i }).click();
await page.waitForTimeout(300);
await page.getByRole('button', { name: /Roulette/ }).first().click();
await page.waitForTimeout(400);
await shot('20-roulette-mobile');
await page.getByRole('button', { name: /lobby/i }).click();
await page.waitForTimeout(300);
await page.getByRole('button', { name: /Hold'em/ }).first().click();
await page.waitForTimeout(500);
await shot('24-holdem-mobile');

/*
 * Geometry check, not a screenshot: nothing on a card may escape the card.
 *
 * Measured on `#deck`, the design sheet, which renders all fifty-two through the real
 * component. It used to build card markup by hand inside the browser instead - and when
 * the component was rewritten, that markup stopped matching anything the app renders, so
 * the check went on passing against elements that no longer existed. A check that cannot
 * fail is worse than no check, because it is still on the list.
 *
 * The two-character "10" is what this exists for: the indices used to be grid areas sized
 * by their content, so a ten pushed the bottom-right index off the edge - a bug no unit
 * test could see, and one that only appeared on tens, at the large size, in a real browser.
 */
console.log('card geometry');
await page.goto('http://localhost:4173/#deck', { waitUntil: 'networkidle' });
await page.waitForSelector('.deck .card', { timeout: 10_000 });

const geometry = await page.evaluate(() => {
  const bad = [];
  const cards = [...document.querySelectorAll('.deck .card')];
  for (const card of cards) {
    const box = card.getBoundingClientRect();
    const rank = card.getAttribute('aria-label') ?? '?';
    for (const part of card.querySelectorAll('.card__index, .card__pip, .card__court, .card__ace')) {
      const p = part.getBoundingClientRect();
      if (p.left < box.left - 0.5 || p.right > box.right + 0.5 ||
          p.top < box.top - 0.5 || p.bottom > box.bottom + 0.5) {
        bad.push(`${rank} (${part.className.split(' ')[0]})`);
      }
    }
  }
  return { bad, count: cards.length };
});

if (geometry.count < 52) {
  errors.push(`the deck sheet rendered ${geometry.count} cards, expected at least 52`);
} else if (geometry.bad.length) {
  errors.push(`card parts escape the card on: ${[...new Set(geometry.bad)].join(', ')}`);
} else {
  console.log(`  nothing escapes its card, across all ${geometry.count}`);
}

await page.screenshot({ path: `${OUT}/50-deck.png`, fullPage: true });
console.log('  wrote 50-deck.png');

await browser.close();
server.close();

if (errors.length) {
  console.error(`\n${errors.length} console/page error(s):`);
  for (const e of errors.slice(0, 10)) console.error('  ' + e);
  process.exit(1);
}
console.log('\nno console errors');
