/**
 * Drives the built client against a REAL server, signed in.
 *
 * Separate from capture.mjs on purpose. That script proves the games work on the local
 * dealer; this one proves the HTTP transport is actually wired up - that a round played
 * in the browser moves a balance the *server* owns, in the ledger, not just in React
 * state. Those are different claims and only one of them was true before this ran.
 *
 *   PORT=3111 pnpm --filter @websino/server exec tsx src/index.ts &
 *   node tools/shots/online.mjs [outDir]
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const ROOT = new URL('../../apps/web/dist/', import.meta.url).pathname;
const API = process.env.WEBSINO_API ?? 'http://localhost:3111';
const OUT = process.argv[2] ?? null;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

// Static files, with /api proxied to the real server - the same shape as `pnpm dev`.
const server = createServer(async (req, res) => {
  const url = (req.url ?? '/').split('?')[0];
  if (url.startsWith('/api')) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const upstream = await fetch(API + req.url, {
      method: req.method,
      headers: { ...req.headers, host: new URL(API).host },
      ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
    });
    const body = Buffer.from(await upstream.arrayBuffer());
    const headers = {};
    upstream.headers.forEach((v, k) => { if (k !== 'content-encoding' && k !== 'content-length') headers[k] = v; });
    res.writeHead(upstream.status, headers).end(body);
    return;
  }
  try {
    const rel = url === '/' ? 'index.html' : normalize(url).replace(/^\/+/, '');
    res.writeHead(200, { 'content-type': TYPES[extname(rel)] ?? 'application/octet-stream' });
    res.end(await readFile(join(ROOT, rel)));
  } catch { res.writeHead(404).end('not found'); }
});
await new Promise((r) => server.listen(4175, r));

const CHROME = process.env.WEBSINO_CHROME ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch(existsSync(CHROME) ? { executablePath: CHROME } : {});
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });

const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

const chips = async () => Number(((await page.locator('.shell__chips, .lobby__balance').first().textContent()) ?? '0').replace(/[^0-9]/g, ''));

await page.goto('http://localhost:4175/', { waitUntil: 'networkidle' });

const username = `probe_${Date.now().toString(36)}`;
await page.getByRole('button', { name: 'Create account' }).click();
await page.getByLabel('Username').fill(username);
await page.getByLabel('Password').fill('correct-horse-battery-staple');
await page.getByRole('button', { name: 'Create account' }).last().click();
await page.waitForTimeout(900);

const signedIn = await page.getByRole('heading', { name: 'Websino' }).isVisible();
console.log(`signed in as ${username}       ${signedIn ? 'yes' : 'NO'}`);
if (!signedIn) errors.push('did not reach the lobby after registering');
console.log(`starting balance                 ${await chips()}`);
if (OUT) await page.screenshot({ path: `${OUT}/online-lobby.png` });

/**
 * A balance that does not move is not proof of failure - a round can legitimately break
 * even. What cannot be faked is the *ledger*: every real round appends at least a wager
 * row server-side, so that is what this asserts.
 */
const cookieHeader = async () =>
  (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join('; ');
const ledgerCount = async () => {
  const me = await (await fetch(`${API}/api/me`, { headers: { cookie: await cookieHeader() } })).json();
  return me.ledger.length;
};

// A string action is matched exactly; a RegExp is matched as written - plinko and the
// wheel put the stake in their button label, so the exact text moves with the bet.
for (const [game, action] of [
  ['Golden Reels', 'Spin'], ['Blackjack', 'Deal'], ['Crash', 'Bet'], ['Dice', 'Roll'],
  ['Mines', 'New board'], ['Jacks or Better', 'Deal · 25'],
  ['Plinko', /^Drop for/], ['Wheel of Fortune', /^Spin for/],
  ["Hold'em", 'Sit down for 500'],
]) {
  await page.getByRole('button', { name: new RegExp(game) }).first().click();
  await page.waitForTimeout(300);
  const before = await chips();
  const ledgerBefore = await ledgerCount();
  await page.getByRole('button', {
    name: action,
    ...(typeof action === 'string' ? { exact: true } : {}),
  }).click();
  // The wheel spins for 2.6s before it settles; everything else resolves at once.
  await page.waitForTimeout(game === 'Wheel of Fortune' ? 3200 : 1100);

  // Mines needs a tile before it can be cashed out, so play it to a finish.
  if (game === 'Mines') {
    const tile = page.getByRole('button', { name: 'tile 1', exact: true });
    if (await tile.count()) { await tile.click(); await page.waitForTimeout(500); }
  }
  // Hold'em: play the hand out, then stand up - the cash-out is the half of the
  // buy-in/refund pair that pysino got wrong, so it has to be exercised here.
  if (game === "Hold'em") {
    for (let i = 0; i < 12; i += 1) {
      const check = page.getByRole('button', { name: 'Check', exact: true });
      const call = page.getByRole('button', { name: /^Call/ });
      const fold = page.getByRole('button', { name: 'Fold', exact: true });
      if (await check.count()) await check.click();
      else if (await call.count()) await call.first().click();
      else if (await fold.count()) await fold.click();
      else break;
      await page.waitForTimeout(400);
    }
  }
  // Settle anything still open so the next game starts clean.
  for (const name of ['Stand up with', 'Stand', 'Cash out ', 'No thanks', 'Draw']) {
    const button = page.getByRole('button', { name: new RegExp(name) });
    if (await button.count()) { await button.first().click(); await page.waitForTimeout(600); }
  }

  const after = await chips();
  const wrote = (await ledgerCount()) - ledgerBefore;
  console.log(`${game.padEnd(32)} ${before} -> ${after}   ${wrote} ledger row(s)`);
  if (wrote < 1) errors.push(`${game} wrote nothing to the ledger`);

  if (OUT && game === 'Blackjack') await page.screenshot({ path: `${OUT}/online-blackjack.png` });
  await page.getByRole('button', { name: /lobby/i }).click();
  await page.waitForTimeout(300);
}

// Roulette separately: it is the only game whose UI posts a structured config rather
// than a single number, so a shape mismatch between client and server shows up here.
{
  await page.getByRole('button', { name: /Roulette/ }).first().click();
  await page.waitForTimeout(300);
  const before = await chips();
  const ledgerBefore = await ledgerCount();
  await page.getByRole('button', { name: '17', exact: true }).first().click();
  await page.getByRole('button', { name: /^Red$/ }).first().click();
  await page.getByRole('button', { name: 'Spin', exact: true }).click();
  await page.waitForTimeout(1100);
  const wrote = (await ledgerCount()) - ledgerBefore;
  console.log(`${'Roulette'.padEnd(32)} ${before} -> ${await chips()}   ${wrote} ledger row(s)`);
  if (wrote < 1) errors.push('Roulette wrote nothing to the ledger');
  if (OUT) await page.screenshot({ path: `${OUT}/online-roulette.png` });
  await page.getByRole('button', { name: /lobby/i }).click();
  await page.waitForTimeout(300);
}

// The real proof: the server's own ledger, not the number React is showing.
const me = await (await fetch(`${API}/api/me`, { headers: { cookie: (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join('; ') } })).json();
console.log(`\nserver-side balance              ${me.balance}`);
console.log(`ledger entries                   ${me.ledger.length}`);
const browserBalance = await chips();
if (me.balance !== browserBalance) errors.push(`browser shows ${browserBalance}, server says ${me.balance}`);
else console.log(`browser and server agree         yes (${me.balance})`);

await browser.close();
server.close();

if (errors.length) {
  console.error(`\n${errors.length} problem(s):`);
  for (const e of errors.slice(0, 10)) console.error('  ' + e);
  process.exit(1);
}
console.log('\nthe client genuinely plays against the server');
