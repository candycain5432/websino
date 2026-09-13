/**
 * Two browsers, one ball sequence.
 *
 * Bingo's whole premise is a claim no unit test can make: that two separate browsers,
 * holding two separate sessions, watch the *same* balls come out of the same drum, in
 * step, without either of them seeing the other's cards. So this drives two real Chromium
 * contexts against one server and checks exactly that, in the DOM, over a real WebSocket.
 *
 * What it proves, in order:
 *   1. a socket upgrade actually happens through the same origin as the page
 *   2. both players get into the same round, each holding their own cards
 *   3. the balls on one screen are the balls on the other - the shared-round claim
 *   4. a card's marks are the balls that were actually called, not a hopeful guess
 *   5. the round runs buying -> drawing -> results -> buying on the server's clock
 *   6. the stake leaves the wallet at the buy and the payout matches the card's own tier
 *   7. the payload carries one player's cards and nobody else's
 *   8. a hall with seventy-five numbers and four cards on it still fits a 390px screen
 *
 *   PORT=3111 pnpm --filter @websino/server exec tsx src/index.ts &
 *   node tools/shots/bingo.mjs [outDir]
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
const PORT = 4177;

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

async function openPlayer(label) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`${label}: ${e}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/WebSocket/i.test(m.text())) errors.push(`${label}: ${m.text()}`);
  });

  const username = `bgo_${label}_${Date.now().toString(36)}`;
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });

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
    // 429 here is the registration rate limit (10/hour per IP) doing its job, not a bug.
    throw new Error(`${label} could not register: ${response.status()} ${await response.text()}`);
  }
  await page.getByRole('button', { name: 'Sign out' }).waitFor({ timeout: 10_000 });
  return { label, username, context, page };
}

const cookieHeader = async (player) =>
  (await player.context.cookies()).map((c) => `${c.name}=${c.value}`).join('; ');

const serverMe = async (player) => {
  const response = await fetch(`${API}/api/me`, { headers: { cookie: await cookieHeader(player) } });
  if (!response.ok) throw new Error(`/api/me for ${player.label} returned ${response.status}`);
  return response.json();
};

const mine = async (player) => {
  const response = await fetch(`${API}/api/bingo/mine`, {
    headers: { cookie: await cookieHeader(player) },
  });
  if (!response.ok) throw new Error(`/api/bingo/mine for ${player.label} returned ${response.status}`);
  return response.json();
};

const hallSummary = async () => (await (await fetch(`${API}/api/bingo`)).json()).halls[0];

console.log('opening two browsers…');
const alice = await openPlayer('alice');
const bob = await openPlayer('bob');

// --------------------------------------------------------------- into the hall --

for (const player of [alice, bob]) {
  await player.page.getByRole('button', { name: /^Bingo/ }).click();
  await player.page.locator('.caller__board').waitFor({ timeout: 15_000 });
}
check(upgrades >= 2, `socket upgrades went through the page origin (${upgrades})`);

/**
 * Buy both players into one round.
 *
 * Retried as a pair rather than one at a time: the buy window is finite, so a run that
 * caught the tail of one could put Alice in round 7 and Bob in round 8 - and then every
 * assertion about a *shared* sequence would be comparing two different draws and passing
 * or failing on the coincidence.
 */
async function buyBothIntoOneRound(cards) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    // Start early in a window, so two buys comfortably fit inside it.
    const opened = await waitForPhase('buying', 60_000);
    if (!opened) break;
    const left = opened.deadline - Date.now();
    if (left < 6_000) {
      await alice.page.waitForTimeout(left + 500);
      continue;
    }

    const round = opened.round;
    for (const player of [alice, bob]) {
      const button = player.page.getByRole('button', { name: /^Buy \d+ for/ });
      if (!(await button.count())) continue;
      await button.first().click();
    }
    await alice.page.waitForTimeout(1_200);

    const views = { alice: await mine(alice), bob: await mine(bob) };
    if (
      views.alice.round === round && views.bob.round === round &&
      views.alice.cards.length === cards && views.bob.cards.length === cards
    ) {
      return { round, views };
    }
  }
  return null;
}

/** Poll the hall until it is in a phase. Returns the summary, or null on timeout. */
async function waitForPhase(phase, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const summary = await hallSummary();
    if (summary.phase === phase) {
      // The summary has no deadline on it, so take the player-facing one.
      const view = await mine(alice);
      return { ...summary, deadline: view.deadline, round: view.round };
    }
    await alice.page.waitForTimeout(400);
  }
  return null;
}

console.log('\nboth players buy into one round');
const before = { alice: (await serverMe(alice)).balance, bob: (await serverMe(bob)).balance };

// Two cards each, at whatever the slider defaults to.
const bought = await buyBothIntoOneRound(2);
check(bought !== null, 'both players got into the same round with cards in hand');
if (bought === null) {
  console.error('\ncould not seat both players in one round - stopping');
  await browser.close();
  server.close();
  process.exit(1);
}

console.log(`  round ${bought.round}: alice ${bought.views.alice.yourStake}, bob ${bought.views.bob.yourStake}`);

for (const player of [alice, bob]) {
  const me = await serverMe(player);
  check(
    me.balance < before[player.label],
    `${player.label}'s stake left the wallet (${before[player.label]} -> ${me.balance})`,
  );
  const shown = await player.page.locator('.bcard').count();
  check(shown === 2, `${player.label} has two cards on screen (${shown})`);
}

// ------------------------------------------------------------------ redaction --

console.log('\nwhat each browser was actually sent');
const aliceNumbers = bought.views.alice.cards.flatMap((c) => c.numbers.flat().filter((v) => v !== null));
const bobNumbers = bought.views.bob.cards.flatMap((c) => c.numbers.flat().filter((v) => v !== null));

check(
  bought.views.alice.cards.length === 2 && bought.views.bob.cards.length === 2,
  "each payload carries exactly its own player's two cards",
);
check(bought.views.alice.players === 2, `both payloads say two players are in (${bought.views.alice.players})`);
check(
  JSON.stringify(bought.views.alice.cards) !== JSON.stringify(bought.views.bob.cards),
  'the two players hold different cards',
);
// The grids themselves must not appear in the other player's payload under any name.
check(
  !JSON.stringify(bought.views.alice).includes(JSON.stringify(bought.views.bob.cards[0].numbers)),
  "alice's payload does not contain bob's card",
);
console.log(`  alice holds ${aliceNumbers.length} squares, bob ${bobNumbers.length}`);

/*
 * The round's real length is its outcome, so it must not be derivable.
 *
 * The draw stops as soon as every card is settled, which makes "how many balls will this
 * round call" the same information as "which band does my card land in". The deadline is
 * broadcast, so it is the field that could be subtracted to recover it - it therefore
 * advertises the full fifty and the phase just ends early.
 */
const nominal = bought.views.alice.ballsDrawn * bought.views.alice.ballMs;
check(
  !JSON.stringify(bought.views.alice).includes('ballsToCall'),
  'the payload does not carry how many balls the round will really call',
);

// --------------------------------------------------------- the shared sequence --

console.log('\nwatching the same drum');
const drawing = await waitForPhase('drawing', 30_000);
check(drawing !== null, 'the round started drawing on the server\'s own clock');

/*
 * The deadline as advertised *during the draw*, which is the only moment it could leak.
 *
 * Read here rather than at the buy, where `deadline` is the end of the buy window and has
 * nothing to do with the draw's length - the first version of this compared the two and
 * failed on a difference that was never the claim.
 */
const advertised = (await mine(alice)).deadline - Date.now();

const calledOnScreen = async (player) =>
  (await player.page.locator('.caller__cell.is-called').allTextContents())
    .map((text) => Number(text.trim()));

const latestOnScreen = async (player) => {
  const cell = player.page.locator('.caller__number');
  return (await cell.count()) ? Number(((await cell.textContent()) ?? '').trim()) : null;
};

// Let a handful of balls out, then compare the two screens.
await alice.page.waitForTimeout(bought.views.alice.ballMs * 8);
const [aliceBalls, bobBalls] = await Promise.all([calledOnScreen(alice), calledOnScreen(bob)]);
const [aliceLatest, bobLatest] = await Promise.all([latestOnScreen(alice), latestOnScreen(bob)]);

console.log(`  alice sees ${aliceBalls.length} called, latest ${aliceLatest}`);
console.log(`  bob sees   ${bobBalls.length} called, latest ${bobLatest}`);

check(aliceBalls.length > 0 && bobBalls.length > 0, 'balls are coming out in both browsers');
// One browser can legitimately be a ball ahead of the other; the *numbers* cannot differ.
const small = aliceBalls.length <= bobBalls.length ? aliceBalls : bobBalls;
const large = aliceBalls.length <= bobBalls.length ? bobBalls : aliceBalls;
const setLarge = new Set(large);
check(
  small.every((ball) => setLarge.has(ball)),
  'every ball on one screen is on the other - one sequence, not two',
);
check(
  large.length - small.length <= 2,
  `the two screens are in step (${aliceBalls.length} vs ${bobBalls.length})`,
);

// --------------------------------------------------- marks match called balls --

const markedNumbers = async (player) =>
  (await player.page.locator('.bcard__cell.is-marked').allTextContents())
    .map((text) => Number(text.trim()));

const marks = await markedNumbers(alice);
const aliceNow = new Set(await calledOnScreen(alice));
console.log(`\n  alice has ${marks.length} squares marked`);
check(
  marks.every((number) => aliceNow.has(number)),
  'every marked square is a ball that was actually called',
);
check(
  marks.every((number) => aliceNumbers.includes(number)),
  "every marked square is a number on alice's own card",
);

if (OUT) {
  await alice.page.screenshot({ path: `${OUT}/bingo-alice.png`, fullPage: true });
  await bob.page.screenshot({ path: `${OUT}/bingo-bob.png`, fullPage: true });

  // Phone width: seventy-five numbers plus two 5x5 grids is the layout that breaks here.
  await bob.page.setViewportSize({ width: 390, height: 844 });
  await bob.page.waitForTimeout(500);
  await bob.page.screenshot({ path: `${OUT}/bingo-phone.png`, fullPage: true });
  const overflow = await bob.page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  check(overflow <= 1, `the hall fits a 390px screen without sideways scroll (${overflow}px over)`);
  await bob.page.setViewportSize({ width: 1280, height: 1000 });
  await bob.page.waitForTimeout(400);
}

// ----------------------------------------------------------------- settlement --

console.log('\nsettling up');
const results = await waitForPhase('results', nominal + 20_000);
check(results !== null, 'the round settled');

const settled = { alice: await mine(alice), bob: await mine(bob) };
// The draw is allowed to have stopped short of fifty - that is the early stop working.
check(
  settled.alice.called.length <= settled.alice.ballsDrawn,
  `the draw called ${settled.alice.called.length} of ${settled.alice.ballsDrawn} balls`,
);
check(
  advertised > settled.alice.called.length * settled.alice.ballMs - 2_000,
  `the advertised deadline was the nominal round, not the real one (${Math.round(advertised)}ms)`,
);

for (const player of [alice, bob]) {
  const view = settled[player.label];
  const wallet = (await serverMe(player)).balance;

  const fromCards = view.cards.reduce((sum, card) => sum + card.payout, 0);
  check(view.yourPayout === fromCards, `${player.label}'s payout is the sum of their cards (${fromCards})`);
  check(
    wallet === before[player.label] - view.yourStake + view.yourPayout,
    `${player.label}'s wallet moved by exactly payout - stake ` +
      `(${before[player.label]} - ${view.yourStake} + ${view.yourPayout} = ${wallet})`,
  );

  // Every completed card must be paid at the tier its completion ball falls in.
  for (const card of view.cards) {
    if (card.completedOn === null) {
      check(card.payout === 0, `${player.label}: a card with no line paid nothing`);
      continue;
    }
    const tier = view.tiers.find((t) => card.completedOn <= t.upTo);
    check(
      tier !== undefined && card.multiplier === tier.multiplier,
      `${player.label}: a line on ball ${card.completedOn} paid ${card.multiplier}x, ` +
        `the table says ${tier?.multiplier}x`,
    );
    // And the winning line is really a line the server can point at.
    check(card.line.length === 5, `${player.label}: the winning line has five squares (${card.line.length})`);
  }
}

/*
 * The ledger, which is where a chip movement is actually true.
 *
 * Exactly one wager row per player per round - the stake, taken once - and a payout row
 * only if the round paid. A second wager row would mean the buy was applied twice.
 */
for (const player of [alice, bob]) {
  const rows = (await serverMe(player)).ledger ?? [];
  const wagers = rows.filter((row) => row.reason === 'wager');
  const payouts = rows.filter((row) => row.reason === 'payout');
  check(wagers.length === 1, `${player.label} was debited exactly once (${wagers.length} wager rows)`);
  check(
    payouts.length === (settled[player.label].yourPayout > 0 ? 1 : 0),
    `${player.label}'s payout rows match what the round paid (${payouts.length})`,
  );
  check(
    wagers[0]?.delta === -settled[player.label].yourStake,
    `${player.label}'s wager row is the stake (${wagers[0]?.delta})`,
  );
}

// ------------------------------------------------------------- the next round --

const reopened = await waitForPhase('buying', 30_000);
check(reopened !== null, 'the hall opened the next buy window');
if (reopened) {
  check(reopened.round === bought.round + 1, `the round counter advanced (${bought.round} -> ${reopened.round})`);
  const cardsLeft = await alice.page.locator('.bcard').count();
  check(cardsLeft === 0, `last round's cards left the screen (${cardsLeft} still showing)`);
}

// ----------------------------------------------------------------------- done --

await browser.close();
server.close();

console.log(`\n${errors.length === 0 ? 'all checks passed' : `${errors.length} FAILED`}`);
for (const message of errors) console.log(`  - ${message}`);
process.exit(errors.length === 0 ? 0 : 1);
