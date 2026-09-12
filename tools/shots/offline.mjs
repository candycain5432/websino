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

// The offline file is built with VITE_OFFLINE=1 so it lands straight in the lobby.
// If a sign-in form shows up here the build flag has come loose, and every player
// would be staring at a login they can never complete.
const signInVisible = await page.getByRole('button', { name: /practice mode/i }).count();
console.log(`skips the dead-end sign-in       ${signInVisible === 0 ? 'yes' : 'NO'}`);
if (signInVisible !== 0) errors.push('offline build showed a sign-in form');

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
// The three games added since this script was written must work here too - offline is
// not a cut-down build, it is the same engine with a local dealer.
for (const [game, action] of [
  ['Golden Reels', 'Spin'], ['Blackjack', 'Deal'], ['Crash', 'Bet'],
  ['Mines', 'New board'], ['Jacks or Better', 'Deal · 25'],
  ['Plinko', /^Drop for/], ['Wheel of Fortune', /^Spin for/],
  ['Hi-Lo', /^Deal for/], ['Towers', /^Climb for/],
  ["Hold'em", 'Sit down for 500'],
]) {
  await page.getByRole('button', { name: /lobby/i }).click();
  await page.waitForTimeout(250);
  await page.getByRole('button', { name: new RegExp(game) }).first().click();
  await page.waitForTimeout(250);
  /*
   * The nonce, not the balance.
   *
   * A slots spin that returns exactly the stake leaves the balance untouched, and this
   * reported "DID NOT PLAY" for a round that played perfectly well. Every round
   * advances the practice wallet's nonce, so that is the signal that a round actually
   * happened - the offline equivalent of the ledger row the online harness checks.
   */
  const nonceOf = async () => page.evaluate(() => {
    try {
      return JSON.parse(localStorage.getItem('websino.practice.fair.v1') ?? '{}').nonce ?? -1;
    } catch {
      return -1;
    }
  });
  const nonceBefore = await nonceOf();
  const chipsBefore = (await page.locator('.shell__chips').textContent())?.trim();
  await page.getByRole('button', {
    name: action,
    ...(typeof action === 'string' ? { exact: true } : {}),
  }).click();
  await page.waitForTimeout(game === 'Wheel of Fortune' ? 3200 : 900);
  const chipsAfter = (await page.locator('.shell__chips').textContent())?.trim();
  const played = (await nonceOf()) > nonceBefore;
  console.log(
    `${String(game).padEnd(32)} ${played ? `played (${chipsBefore} -> ${chipsAfter})` : 'DID NOT PLAY'}`,
  );
  if (!played) errors.push(`${game} drew no round offline`);
}

await browser.close();

if (!rendered || before === after || errors.length) {
  console.error('FAILED', errors.slice(0, 5));
  process.exit(1);
}
console.log('offline build is genuinely playable, with no console errors');
