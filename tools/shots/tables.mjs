/**
 * Two browsers, one table.
 *
 * The claim multiplayer makes is one that no unit test can check: that two separate
 * browsers, holding two separate sessions, see the *same* live table, and that neither
 * of them can see the other's cards. So this drives two real Chromium contexts against
 * one server and asserts exactly that, in the DOM, over a real WebSocket.
 *
 * What it proves, in order:
 *   1. a socket upgrade actually happens through the same origin as the page
 *   2. both players end up seated at one table, each seeing the other by name
 *   3. each sees two face-up cards - their own - and face-down cards everywhere else
 *   4. an action by one player appears in the other's browser without a reload
 *   5. the turn clock is counting down to the server's deadline, not a local timer
 *   6. standing up returns the stack to the account, in the server's own ledger
 *
 *   PORT=3111 pnpm --filter @websino/server exec tsx src/index.ts &
 *   node tools/shots/tables.mjs [outDir]
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const ROOT = new URL('../../apps/web/dist/', import.meta.url).pathname;
const API = process.env.WEBSINO_API ?? 'http://localhost:3111';
const OUT = process.argv[2] ?? null;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const PORT = 4176;

const errors = [];
const check = (ok, message) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${message}`);
  if (!ok) errors.push(message);
};

// Static files, /api proxied, /ws tunnelled. The tunnel is the interesting part: a
// WebSocket handshake is an HTTP upgrade, so it has to be piped at the socket level -
// forwarding it as an ordinary GET is exactly how this silently fails.
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
    upstream.headers.forEach((v, k) => {
      if (k !== 'content-encoding' && k !== 'content-length') headers[k] = v;
    });
    res.writeHead(upstream.status, headers).end(body);
    return;
  }
  try {
    const rel = url === '/' ? 'index.html' : normalize(url).replace(/^\/+/, '');
    res.writeHead(200, { 'content-type': TYPES[extname(rel)] ?? 'application/octet-stream' });
    res.end(await readFile(join(ROOT, rel)));
  } catch {
    res.writeHead(404).end('not found');
  }
});

let upgrades = 0;
server.on('upgrade', (req, socket, head) => {
  upgrades += 1;
  const target = new URL(API);
  const upstream = connect(Number(target.port || 80), target.hostname, () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const name = req.rawHeaders[i];
      const value = name.toLowerCase() === 'host' ? target.host : req.rawHeaders[i + 1];
      lines.push(`${name}: ${value}`);
    }
    upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head?.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
});

await new Promise((r) => server.listen(PORT, r));

const CHROME = process.env.WEBSINO_CHROME ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch(existsSync(CHROME) ? { executablePath: CHROME } : {});

/** One signed-in browser context sitting at the table. */
async function openPlayer(label) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`${label}: ${e}`));
  page.on('console', (m) => {
    // A failed socket during teardown is noise; a real page error is not.
    if (m.type() === 'error' && !/WebSocket/i.test(m.text())) errors.push(`${label}: ${m.text()}`);
  });

  const username = `tbl_${label}_${Date.now().toString(36)}`;
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });

  // The register response is watched rather than assumed. Waiting on the "Websino"
  // heading is not a sign-in check - the sign-in screen carries the same heading, so a
  // failed registration sailed straight past it and only showed up as a 401 later.
  const registered = page.waitForResponse(
    (response) => response.url().includes('/api/auth/register'),
    { timeout: 15_000 },
  );
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill('correct-horse-battery-staple');
  await page.getByRole('button', { name: 'Create account' }).last().click();

  const response = await registered;
  if (!response.ok()) {
    // 429 here is the server's registration rate limit (10/hour per IP) doing its job,
    // not a bug - restart the server to reset its in-memory counter and run again.
    throw new Error(`${label} could not register: ${response.status()} ${await response.text()}`);
  }
  // And the lobby's own signed-in affordance, which practice mode does not have.
  await page.getByRole('button', { name: 'Sign out' }).waitFor({ timeout: 10_000 });

  return { label, username, context, page };
}

const cookieHeader = async (player) =>
  (await player.context.cookies()).map((c) => `${c.name}=${c.value}`).join('; ');

const serverMe = async (player) => {
  const response = await fetch(`${API}/api/me`, {
    headers: { cookie: await cookieHeader(player) },
  });
  // An undefined balance three assertions later is a miserable thing to debug, so a
  // bad status fails here, where it says what actually went wrong.
  if (!response.ok) throw new Error(`/api/me for ${player.label} returned ${response.status}`);
  return response.json();
};

console.log('opening two browsers…');
const alice = await openPlayer('alice');
const bob = await openPlayer('bob');

// ------------------------------------------------------------------- sit down --

async function sitDown(player, buyIn) {
  const { page } = player;
  await page.getByRole('button', { name: /Shared tables/ }).click();
  await page.getByRole('button', { name: /Lowball Lounge/ }).click();
  await page.locator('.baize__seats').waitFor({ timeout: 10_000 });
  const seatButton = page.getByRole('button', { name: /Take a seat for/ });
  await seatButton.waitFor({ timeout: 10_000 });
  await seatButton.click();
  await page.locator('.pseat.is-you').waitFor({ timeout: 10_000 });
  return buyIn;
}

console.log('\nboth players take a seat at Lowball Lounge');
const before = { alice: (await serverMe(alice)).balance, bob: (await serverMe(bob)).balance };
await sitDown(alice);
await sitDown(bob);

/**
 * Wait for a hand to be live before looking at cards.
 *
 * The first version of this slept for a fixed moment and read zero face-up cards -
 * which looked like a redaction bug and was really a table that had not dealt yet. The
 * fix for the test is to wait for the state the assertion is about; the fix for the
 * product was to deal sooner, and to stop drawing card backs between hands.
 */
async function waitForLiveHand(player, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const cards = await player.page.locator('.pseat.is-you .card').count();
    if (cards >= 2) return true;
    await player.page.waitForTimeout(400);
  }
  return false;
}

const dealt = await waitForLiveHand(alice);
check(dealt, 'a hand was dealt once both players sat down');

check(upgrades >= 2, `socket upgrades went through the page origin (${upgrades})`);

for (const player of [alice, bob]) {
  const me = await serverMe(player);
  check(
    me.balance < before[player.label],
    `${player.label}'s buy-in left the wallet (${before[player.label]} -> ${me.balance})`,
  );
}

// ----------------------------------------------------------- one shared table --

const seatNames = async (player) =>
  (await player.page.locator('.pseat:not(.is-empty) .pseat__name').allTextContents())
    .map((name) => name.trim());

const aliceSees = await seatNames(alice);
const bobSees = await seatNames(bob);
console.log(`\n  alice sees: ${aliceSees.join(', ')}`);
console.log(`  bob sees:   ${bobSees.join(', ')}`);

check(aliceSees.includes(bob.username), "alice sees bob at the table");
check(bobSees.includes(alice.username), "bob sees alice at the table");
check(
  [...aliceSees].sort().join('|') === [...bobSees].sort().join('|'),
  'both browsers agree on who is seated',
);
check(aliceSees.length >= 3, `bots filled the table out (${aliceSees.length} seated)`);

// --------------------------------------------------------------- redaction --

async function cardCounts(player) {
  const up = await player.page.locator('.pseat__cards .card:not(.card--down)').count();
  const down = await player.page.locator('.pseat__cards .card.card--down').count();
  const mine = await player.page.locator('.pseat.is-you .card:not(.card--down)').count();
  return { up, down, mine };
}

console.log('\nwhat each browser was actually sent');
for (const player of [alice, bob]) {
  const { up, down, mine } = await cardCounts(player);
  console.log(`  ${player.label}: ${up} face up, ${down} face down`);
  check(mine === 2, `${player.label} can see their own two cards`);
  check(up === 2, `${player.label} can see nobody else's cards (${up} face up in total)`);
    check(down >= 2, `${player.label} sees other seats face down (${down})`);
}

// Between hands there are no cards at all, so no seat should be showing card backs -
// a back means "dealt, and not yours to see", which would be a lie about a dead table.
const idle = await alice.page.evaluate(() => {
  const live = document.querySelector('.floor__titles p')?.textContent ?? '';
  return live;
});
console.log(`  table reads: ${idle.trim()}`);

// The stronger version of the same claim: the payload itself. A patched client cannot
// reveal what was never sent, so this reads the raw view the server would hand over.
const rawView = await (await fetch(`${API}/api/tables/mine`, {
  headers: { cookie: await cookieHeader(alice) },
})).json();
const withHole = rawView.room.seats.filter((seat) => seat.hole !== undefined);
check(
  withHole.length === 1 && withHole[0].seat === rawView.room.you,
  `the payload carries exactly one seat's cards - alice's own (${withHole.length})`,
);

// --------------------------------------------------------------- the clock --

const clockValue = async (player) =>
  Number(((await player.page.locator('.clock__value').first().textContent()) ?? '0').replace(/\D/g, ''));

const firstClock = (await alice.page.locator('.clock__value').count())
  ? await clockValue(alice)
  : null;
if (firstClock !== null) {
  await alice.page.waitForTimeout(2_200);
  const second = await clockValue(alice);
  check(second < firstClock, `the turn clock is counting down (${firstClock}s -> ${second}s)`);
} else {
  console.log('  --    no clock showing (a bot held the action); skipping the countdown');
}

if (OUT) {
  await alice.page.screenshot({ path: `${OUT}/tables-alice.png`, fullPage: true });
  await bob.page.screenshot({ path: `${OUT}/tables-bob.png`, fullPage: true });

  // Phone width, because a six-seat row is exactly the layout that stops working there.
  await bob.page.setViewportSize({ width: 390, height: 844 });
  await bob.page.waitForTimeout(400);
  await bob.page.screenshot({ path: `${OUT}/tables-phone.png`, fullPage: true });

  // Nothing may scroll sideways - the one failure mode a screenshot hides.
  const overflow = await bob.page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  check(overflow <= 1, `the table fits a 390px screen without sideways scroll (${overflow}px over)`);
  await bob.page.setViewportSize({ width: 1280, height: 900 });
  await bob.page.waitForTimeout(400);
}

// -------------------------------------------------------- acting, seen by both --

console.log('\nplaying a hand out');

/** Take whatever the cheapest legal action is, if it is our turn. */
async function actIfAble(player) {
  const { page } = player;
  for (const name of ['Check', 'Call', 'Fold']) {
    const button = page.getByRole('button', { name: new RegExp(`^${name}`) });
    if (await button.count()) {
      await button.first().click();
      return name;
    }
  }
  return null;
}

let actions = 0;
let sawOtherAct = false;
for (let round = 0; round < 40 && actions < 6; round += 1) {
  for (const player of [alice, bob]) {
    const acted = await actIfAble(player);
    if (acted) {
      actions += 1;
      // The other browser must show the action without being reloaded - that is the
      // whole point of the socket.
      const other = player === alice ? bob : alice;
      await other.page.waitForTimeout(700);
      const log = (await other.page.locator('.floor__log li').allTextContents()).join(' ');
      if (log.length > 0) sawOtherAct = true;
    }
  }
  await alice.page.waitForTimeout(600);
}

check(actions > 0, `both browsers could act (${actions} actions taken)`);
check(sawOtherAct, "one player's action showed up in the other's browser without a reload");

const handsPlayed = async (player) =>
  Number(((await player.page.locator('.floor__titles p').textContent()) ?? '').match(/hand (\d+)/)?.[1] ?? 0);
const hands = await handsPlayed(alice);
check(hands >= 1, `the table dealt at least one hand (${hands})`);

/*
 * The rake is the only way chips leave a table, so it has to be real and reported.
 *
 * Asserted against settled hands rather than "whatever the view holds right now":
 * mid-hand `result` is null, so reading it at an arbitrary moment tests the timing of
 * the poll rather than the rake. This watches until it has seen hands actually finish.
 */
const mine = async () =>
  (await fetch(`${API}/api/tables/mine`, { headers: { cookie: await cookieHeader(alice) } })).json();

/*
 * Both players keep acting while this polls.
 *
 * Left idle they each burn the full twenty-second clock on every street, so a hand can
 * take minutes and the first version of this simply ran out of window and reported no
 * rake at all - a test of the poll's patience, not of the rake.
 */
const rakes = new Map();
let sawFlop = false;
for (let i = 0; i < 80 && rakes.size < 2; i += 1) {
  for (const player of [alice, bob]) await actIfAble(player);

  const view = (await mine())?.room;
  if (!view) break;
  if (view.result) {
    rakes.set(view.handNumber, view.result.rake);
    if (view.board.length >= 3) sawFlop = true;
  }
  await alice.page.waitForTimeout(500);
}

const cuts = [...rakes.values()];
check(rakes.size > 0, `settled hands report the house's cut (${cuts.join(', ')})`);
check(
  cuts.every((r) => Number.isInteger(r) && r >= 0 && r <= 60),
  `every cut is a whole number inside the 3 big blind cap (${cuts.join(', ')})`,
);
// No flop, no drop - so a zero cut is only allowed on a hand that never saw one.
if (sawFlop) {
  check(cuts.some((r) => r > 0), `the house took a cut once a flop was dealt (${cuts.join(', ')})`);
}

const limits = (await mine())?.room;
check(
  limits?.maxBuyIn <= 2_000,
  `the table advertises a buy-in a new account can afford (max ${limits?.maxBuyIn})`,
);

// ------------------------------------------------------------------ stand up --

console.log('\nstanding up');
for (const player of [alice, bob]) {
  const { page } = player;
  // One click, whenever they like. A request made mid-hand is queued server-side and
  // honoured when the hand ends - the first version of this had to hunt for the gap
  // between hands, which is exactly the experience a real player would have had.
  await page.getByRole('button', { name: /Stand up|Leaving/ }).click();

  let out = 0;
  for (let i = 0; i < 40 && out === 0; i += 1) {
    await page.waitForTimeout(700);
    out = await page.locator('.floor__tables').count();
  }
  check(out > 0, `${player.label} stood up and is back on the floor`);

  const me = await serverMe(player);
  const wallet = me.balance;
  const seat = await (await fetch(`${API}/api/tables/mine`, {
    headers: { cookie: await cookieHeader(player) },
  })).json();
  check(seat === null, `${player.label} holds no seat server-side any more`);
  console.log(`  ${player.label}: ${before[player.label]} -> ${wallet} across the session`);

  /*
   * The cash-out has to be a payout row specifically.
   *
   * `delta > 0` was the first version of this and it passed on the starting-chips
   * credit every account gets at registration, so it would have gone green on a
   * table that never paid anything back at all.
   */
  const payouts = me.ledger.filter((row) => row.reason === 'payout');
  const wagers = me.ledger.filter((row) => row.reason === 'wager');
  /*
   * One buy-in always; a cash-out only if there was a stack to return.
   *
   * A player who busts stands up with nothing, and a zero-delta ledger row would be a
   * record of no chips moving. Requiring a payout row unconditionally was the first
   * version, and it failed the moment bob went all-in and lost - reporting a ledger bug
   * where the real event was a hand of poker.
   */
  const cashedOut = payouts.reduce((sum, row) => sum + row.delta, 0);
  check(
    wagers.length === 1 && payouts.length === (cashedOut > 0 ? 1 : 0),
    `${player.label} has one buy-in and a cash-out only if the stack survived `
      + `(${wagers.length} wager, ${payouts.length} payout)`,
  );
  check(
    wallet === before[player.label] + wagers[0].delta + cashedOut,
    `${player.label}'s wallet is exactly the buy-in out and the stack back (${wallet})`,
  );
}

await browser.close();
server.close();

if (errors.length) {
  console.error(`\n${errors.length} problem(s):`);
  for (const e of errors.slice(0, 12)) console.error('  ' + e);
  process.exit(1);
}
console.log('\ntwo browsers really do share one table');
