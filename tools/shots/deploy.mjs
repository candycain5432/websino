/**
 * The deployed shape, exercised as one origin.
 *
 * Every other harness here serves the client itself and proxies /api and /ws to the
 * server, which is the *development* shape. In production one Fastify process serves
 * both, and that is a different thing to get wrong: static files and the SPA fallback
 * have to coexist with the API's 404s, and the WebSocket upgrade has to survive being
 * registered alongside a static plugin.
 *
 * So this one points a real browser straight at the server, with nothing in front, and
 * plays through it. It is the only test that runs the app the way Render runs it.
 *
 *   pnpm build
 *   NODE_ENV=production PORT=3111 pnpm start &
 *   node tools/shots/deploy.mjs [outDir]
 */
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';

const BASE = process.env.WEBSINO_BASE ?? 'http://localhost:3111';
const OUT = process.argv[2] ?? null;
const errors = [];
const check = (ok, message) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${message}`);
  if (!ok) errors.push(message);
};

const CHROME = process.env.WEBSINO_CHROME ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch(existsSync(CHROME) ? { executablePath: CHROME } : {});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error' && !/WebSocket/i.test(m.text())) errors.push(m.text());
});

// Sockets are the thing a static plugin most easily breaks, so watch for a real upgrade.
let socketOpened = false;
page.on('websocket', (ws) => { socketOpened = true; console.log(`  socket: ${ws.url()}`); });

console.log('serving the client and the API from one origin');
/*
 * Watch the asset requests, not the lobby.
 *
 * A cold load with no session lands on the sign-in screen, not the floor - so asserting
 * on a lobby selector here tests whether you happen to be signed in, which was the first
 * version of this check and duly failed against a perfectly working server. What is
 * actually being claimed is narrower: the hashed bundle and stylesheet the built
 * `index.html` asks for were served by this origin, and React mounted.
 */
const assets = [];
page.on('response', (r) => {
  if (r.url().includes('/assets/')) assets.push([r.url().split('/').pop(), r.status()]);
});

await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
check(await page.locator('#root > *').count() > 0, 'the client mounted');
check(assets.length >= 2, `the origin served the hashed assets (${assets.length})`);
check(assets.every(([, status]) => status === 200), `every asset came back 200 (${assets.map(([n, s]) => `${n} ${s}`).join(', ')})`);

// A deep link must reach the app rather than a 404 - that is the SPA fallback.
const deep = await page.goto(`${BASE}/deck`, { waitUntil: 'networkidle' });
check(deep.status() === 200, `a client route falls back to the app (${deep.status()})`);
await page.goBack({ waitUntil: 'networkidle' });

console.log('\nsigning up and playing against the same origin');
const username = `dep_${Date.now().toString(36)}`;
const registered = page.waitForResponse((r) => r.url().includes('/api/auth/register'), { timeout: 15_000 });
await page.getByRole('button', { name: 'Create account' }).click();
await page.getByLabel('Username').fill(username);
await page.getByLabel('Password').fill('correct-horse-battery-staple');
await page.getByRole('button', { name: 'Create account' }).last().click();
const response = await registered;
check(response.ok(), `the account was created through the same origin (${response.status()})`);
await page.getByRole('button', { name: 'Sign out' }).waitFor({ timeout: 10_000 });

// The cookie is SameSite=Lax and, in production, Secure - which is why one origin matters.
const cookie = (await page.context().cookies()).find((c) => c.name === 'websino_session');
check(cookie !== undefined, 'the session cookie was set and kept');
check(cookie?.httpOnly === true, 'the session cookie is httpOnly');

const balanceOf = async () =>
  Number(((await page.locator('.lobby__balance').textContent()) ?? '0').replace(/\D/g, ''));
const before = await balanceOf();

await page.getByRole('button', { name: /^Dice/ }).first().click();
await page.waitForTimeout(300);
await page.getByRole('button', { name: 'Roll', exact: true }).click();
await page.waitForTimeout(700);
await page.getByRole('button', { name: /lobby/i }).click();
await page.waitForTimeout(600);
const after = await balanceOf();
check(after !== before, `a round settled against the server (${before} -> ${after})`);

console.log('\nthe websocket, on the same origin as the page');
await page.getByRole('button', { name: /^Bingo/ }).first().click();
await page.locator('.caller__board').waitFor({ timeout: 15_000 });
await page.waitForTimeout(1_200);
check(socketOpened, 'a websocket upgrade went through the static handler');
check(
  await page.locator('.hall__status--open').count() > 0,
  'the hall reports a live connection',
);

if (OUT) await page.screenshot({ path: `${OUT}/deploy.png`, fullPage: true });

await browser.close();
console.log(`\n${errors.length === 0 ? 'the production shape works' : `${errors.length} FAILED`}`);
for (const message of errors) console.log(`  - ${message}`);
process.exit(errors.length === 0 ? 0 : 1);
