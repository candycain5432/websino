/**
 * The lobby's lifetime figures, on both transports.
 *
 * Worth a browser test rather than a unit test because the claim spans three layers that
 * are implemented twice: the counters, the transport that serves them, and the strip that
 * renders them. The house aggregates its own audit log; practice keeps its own counters
 * in localStorage. Either could quietly report zero, or count the same round twice, and
 * nothing else in the suite would notice.
 *
 * The two subtle cases are the point:
 *   - a blackjack hand is ONE round, not one per stake. A double, a split and an
 *     insurance bet are all more chips on the same hand.
 *   - topping up is not a win. `net` is measured against everything the house has handed
 *     over, so pressing the button must not move it.
 *
 *   PORT=3111 pnpm --filter @websino/server exec tsx src/index.ts &
 *   node tools/shots/stats.mjs
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
const ROOT = new URL('../../apps/web/dist/', import.meta.url).pathname;
const API = 'http://localhost:3111';
const TYPES = { '.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.woff2':'font/woff2' };
const server = createServer(async (req,res)=>{
  const url=(req.url??'/').split('?')[0].split('#')[0];
  if (url.startsWith('/api')) {
    const chunks=[]; for await (const c of req) chunks.push(c);
    const up = await fetch(API+req.url,{method:req.method,headers:{...req.headers,host:new URL(API).host},...(chunks.length?{body:Buffer.concat(chunks)}:{})});
    const body=Buffer.from(await up.arrayBuffer()); const h={};
    up.headers.forEach((v,k)=>{ if(k!=='content-encoding'&&k!=='content-length') h[k]=v; });
    res.writeHead(up.status,h).end(body); return;
  }
  try { const rel = url==='/'?'index.html':normalize(url).replace(/^\/+/,'');
    res.writeHead(200,{'content-type':TYPES[extname(rel)]??'application/octet-stream'});
    res.end(await readFile(join(ROOT,rel)));
  } catch { res.writeHead(404).end('nf'); }
});
await new Promise(r=>server.listen(4183,r));
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const errors = [];
const check = (ok,m)=>{ console.log(`  ${ok?'ok  ':'FAIL'}  ${m}`); if(!ok) errors.push(m); };

const readLedger = async (page) => {
  const values = await page.locator('.lobby__figure-value').allTextContents();
  const labels = await page.locator('.lobby__figure-label').allTextContents();
  return Object.fromEntries(labels.map((l,i)=>[l.trim(), values[i].trim()]));
};

// ---- practice ----
console.log('practice mode');
let page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on('pageerror', e => errors.push('practice: '+e));
await page.goto('http://localhost:4183/', { waitUntil: 'networkidle' });
await page.getByRole('button', { name: /practice mode/i }).click();
await page.waitForTimeout(400);
const before = await readLedger(page);
console.log('  start:', JSON.stringify(before));
check(before['Rounds played'] === '0', 'a fresh browser starts at zero rounds');

for (let i = 0; i < 3; i += 1) {
  await page.getByRole('button', { name: /^Dice/ }).first().click();
  await page.waitForTimeout(250);
  await page.getByRole('button', { name: 'Roll', exact: true }).click();
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: /lobby/i }).click();
  await page.waitForTimeout(350);
}
const after = await readLedger(page);
console.log('  after 3 dice rolls:', JSON.stringify(after));
check(after['Rounds played'] === '3', `three rounds counted (${after['Rounds played']})`);
check(after['Lifetime wagered'] !== '0', `wagered moved (${after['Lifetime wagered']})`);
check(after['Peak stack'] !== '0', `peak recorded (${after['Peak stack']})`);

// A blackjack hand is one round, not one per card.
await page.getByRole('button', { name: /^Blackjack/ }).first().click();
await page.waitForTimeout(250);
await page.getByRole('button', { name: 'Deal', exact: true }).click();
await page.waitForTimeout(600);
for (const name of ['Stand','No thanks']) {
  const b = page.getByRole('button', { name, exact: true });
  if (await b.count()) { await b.first().click(); await page.waitForTimeout(500); }
}
await page.getByRole('button', { name: /lobby/i }).click();
await page.waitForTimeout(400);
const afterBj = await readLedger(page);
console.log('  after a blackjack hand:', JSON.stringify(afterBj));
check(afterBj['Rounds played'] === '4', `a hand is one round (${afterBj['Rounds played']})`);

/*
 * Topping up must not read as profit - which is a claim about the *change*, not the sign.
 *
 * This used to assert that `Net` was not positive after the top-up, and that is a
 * different claim entirely: four rounds of dice and blackjack leave the player ahead
 * about as often as behind, so the check failed on luck and passed on luck, which is
 * worse than not having it. What it is actually for is that ten thousand chips arriving
 * from the house move `Net` by nothing at all.
 */
const netBefore = afterBj['Net'];
await page.getByRole('button', { name: 'Top up' }).click();
await page.waitForTimeout(500);
const afterTop = await readLedger(page);
console.log('  after a top-up:', JSON.stringify(afterTop));
check(
  afterTop['Net'] === netBefore,
  `topping up left net where it was (${netBefore} -> ${afterTop['Net']})`,
);
await page.close();

// ---- house ----
console.log('\nhouse mode');
page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on('pageerror', e => errors.push('house: '+e));
await page.goto('http://localhost:4183/', { waitUntil: 'networkidle' });
const reg = page.waitForResponse(r => r.url().includes('/api/auth/register'), { timeout: 15000 });
await page.getByRole('button', { name: 'Create account' }).click();
await page.getByLabel('Username').fill(`stat_${Date.now().toString(36)}`);
await page.getByLabel('Password').fill('correct-horse-battery-staple');
await page.getByRole('button', { name: 'Create account' }).last().click();
const r = await reg;
if (!r.ok()) throw new Error(`register ${r.status()} ${await r.text()}`);
await page.getByRole('button', { name: 'Sign out' }).waitFor({ timeout: 10000 });
await page.waitForTimeout(400);
const houseStart = await readLedger(page);
console.log('  start:', JSON.stringify(houseStart));
check(houseStart['Rounds played'] === '0', 'a new account starts at zero rounds');
check(houseStart['Net'] === '0', `starting chips are not profit (net ${houseStart['Net']})`);

for (let i = 0; i < 2; i += 1) {
  await page.getByRole('button', { name: /^Dice/ }).first().click();
  await page.waitForTimeout(250);
  await page.getByRole('button', { name: 'Roll', exact: true }).click();
  await page.waitForTimeout(600);
  await page.getByRole('button', { name: /lobby/i }).click();
  await page.waitForTimeout(450);
}
const houseAfter = await readLedger(page);
console.log('  after 2 dice rolls:', JSON.stringify(houseAfter));
check(houseAfter['Rounds played'] === '2', `the server counted two rounds (${houseAfter['Rounds played']})`);
check(houseAfter['Lifetime wagered'] !== '0', `server wagered moved (${houseAfter['Lifetime wagered']})`);

await browser.close(); server.close();
console.log(`\n${errors.length===0?'stats are real on both transports':`${errors.length} FAILED`}`);
for (const e of errors) console.log('  - '+e);
process.exit(errors.length===0?0:1);
