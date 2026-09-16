/**
 * The theme follows the account, not the browser.
 *
 * The one thing about themes that cannot be checked by looking at a screenshot. A theme
 * is stored in three places - the account, this browser's cache, and the default - and
 * the whole feature rests on getting their order of authority right. A bug here does not
 * look like a bug: the machine you developed on has the right value cached, so it is
 * correct everywhere you would notice and wrong on every machine you would not.
 *
 * So this runs two *separate browser profiles* against one server. One signs up and picks
 * a room; the other signs in cold, with a cache that demonstrably says something else,
 * and has to be wearing what the account says before it has been anywhere near the
 * settings screen.
 *
 *   pnpm build && pnpm start &
 *   node tools/shots/theme.mjs
 */
import { chromium } from 'playwright';
const BASE = 'http://localhost:4173';
const API = process.env.WEBSINO_API ?? 'http://localhost:3111';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
const ROOT = new URL('../../apps/web/dist/', import.meta.url).pathname;
const T = { '.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml' };
const server = createServer(async (req, res) => {
  const url = (req.url ?? '/').split('?')[0];
  if (url.startsWith('/api')) {
    const upstream = await fetch(`${API}${req.url}`, {
      method: req.method,
      headers: { ...req.headers, host: new URL(API).host },
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : await new Promise((r) => {
        const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => r(Buffer.concat(c)));
      }),
      redirect: 'manual',
    });
    res.writeHead(upstream.status, Object.fromEntries(upstream.headers));
    res.end(Buffer.from(await upstream.arrayBuffer()));
    return;
  }
  try {
    const rel = url === '/' ? 'index.html' : normalize(url).replace(/^\/+/, '');
    const b = await readFile(join(ROOT, rel));
    res.writeHead(200, { 'content-type': T[extname(rel)] ?? 'application/octet-stream' }); res.end(b);
  } catch { res.writeHead(404).end('x'); }
});
await new Promise((r) => server.listen(4173, r));

const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const check = (ok, m) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${m}`); if (!ok) process.exitCode = 1; };
const name = `t${Date.now().toString(36)}`;

// Browser one: sign up, pick Royal.
const one = await br.newContext();
const a = await one.newPage();
a.on('pageerror', (e) => console.log('ERR', String(e)));
await a.goto(BASE, { waitUntil: 'networkidle' });
await a.getByRole('button', { name: 'Create account', exact: true }).first().click();
await a.getByLabel(/username/i).fill(name);
await a.getByLabel(/password/i).first().fill('correct horse battery');
await a.locator('button[type="submit"]').click();
await a.waitForTimeout(1500);
await a.getByRole('button', { name: 'Settings', exact: true }).click();
await a.waitForTimeout(400);
await a.getByRole('radio', { name: /Royal/ }).click();
await a.waitForTimeout(600);
check(await a.evaluate(() => document.documentElement.dataset.theme) === 'royal',
  'browser one is wearing Royal');

// Browser two: a clean profile, so localStorage cannot be the thing carrying it.
const two = await br.newContext();
const b = await two.newPage();
b.on('pageerror', (e) => console.log('ERR', String(e)));
await b.goto(BASE, { waitUntil: 'networkidle' });
/*
 * Checked before signing in, not after.
 *
 * Signing in is precisely what makes the app fetch the account's theme and write it to
 * this browser's cache - so asking afterwards proves nothing, and the first version of
 * this check failed for exactly that reason. What it needs to establish is that there
 * was nothing here to read *beforehand*.
 */
/*
 * `emerald`, not absent: booting writes the default back to the cache on its way past.
 *
 * Which is the point of the check either way - this browser's cache says green while the
 * account says Royal, so whatever puts Royal on the page below cannot have come from
 * here. The first two versions of this line asserted the wrong thing at the wrong time:
 * `!== 'royal'` *after* signing in, when signing in is exactly what caches it.
 */
check(await b.evaluate(() => window.localStorage.getItem('websino.theme')) === 'emerald',
  'browser two\'s cache says green, not Royal');
await b.getByLabel(/username/i).fill(name);
await b.getByLabel(/password/i).first().fill('correct horse battery');
await b.locator('button[type="submit"]').click();
await b.waitForTimeout(1500);
// The lobby itself, without going near the settings screen.
const worn = await b.evaluate(() => document.documentElement.dataset.theme);
check(worn === 'royal', `browser two's lobby picked Royal up from the account (${worn})`);
check(await b.getByRole('button', { name: 'Settings', exact: true }).count() === 1,
  'and there is a settings tab to change it from');
await b.screenshot({ path: '/tmp/claude-0/v/theme-account.png' });
await br.close(); server.close();
console.log(process.exitCode ? '\nFAILED' : '\nthe theme follows the account');
