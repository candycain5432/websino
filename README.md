# Websino

A play-money casino for the browser. Provably fair, works offline, and there is no way
to spend or win real money anywhere in it.

![The lobby](docs/screenshots/lobby.png)

It is a ground-up TypeScript rewrite of [pysino](https://github.com/candycain5432/pysino),
a Python/pygame desktop casino. The rules and the tuning carried over — they were the
valuable part — and everything else was rebuilt for the web: real accounts, a server that
deals the cards, a design system instead of a blitted canvas, and a build you can open
from a file on a plane.

---

## Quick start

```bash
pnpm install
pnpm dev          # client on :5173, server on :3000
```

Then open <http://localhost:5173>. You can play immediately in practice mode without an
account.

```bash
pnpm test         # 149 tests
pnpm -r typecheck
pnpm build        # static client bundle
```

Node 22+ and pnpm 10+.

---

## What's here

| | |
|---|---|
| **Games** | Dice, Limbo |
| **Accounts** | Username + password, argon2id, server-authoritative chips |
| **Fairness** | HMAC-SHA256 commit/reveal with an in-app verifier |
| **Offline** | Practice mode with a local wallet; a single-file build that runs from `file://` |
| **Tests** | 149, covering payout maths, chip conservation and seed secrecy |

Blackjack, slots, crash, roulette, video poker, mines and hold'em tables are next — see
[Roadmap](#roadmap).

---

## The games

### Dice

![Dice](docs/screenshots/dice.png)

Roll `0.00`–`99.99`, bet on over or under a target you choose. The payout is always
`0.99 / winChance`, so **every target has identical expected value** — picking a 2% shot
instead of a 90% one changes your variance, not the house's edge. The tests assert that
exactly rather than statistically.

### Limbo

A multiplier is drawn; you win if it reaches your target. The draw satisfies
`P(result ≥ x) = 0.99 / x`, which is the same distribution Crash uses — Limbo is simply
Crash without the waiting, which made it the ideal game to prove the whole pipeline with.

---

## Provably fair

![The fairness panel](docs/screenshots/provably-fair.png)

Every outcome comes from three strings:

```
block(i) = HMAC-SHA256(serverSeed, `${clientSeed}:${nonce}:${i}`)
```

Before you bet, the house publishes `sha256(serverSeed)` — a commitment it cannot wriggle
out of afterwards. You pick the `clientSeed`, which is mixed into every draw, so the house
cannot pre-screen server seeds that happen to be bad for you. Rotating the seed reveals
the old one, and any past round can then be recomputed and checked.

The full scheme is in [`packages/fair/SPEC.md`](packages/fair/SPEC.md) — about 40 lines of
rules, with frozen golden vectors so a refactor cannot silently change what players would
have won.

**Being straight about the limits.** This is play money on a server the operator runs. It
proves the seed was not swapped after seeing your bet, and it makes every round exactly
reproducible — genuinely useful for auditing and for debugging a hand that "should have
won". It is not a defence against an operator who modified the server before committing.
Treat it as craft, not as a guarantee.

---

## Offline

![On a phone](docs/screenshots/mobile.png)

Two ways to play with no network:

```bash
pnpm --filter @websino/web build:offline   # one 188 KB HTML file
```

The result is a single `dist-offline/index.html` you can double-click. (A normal bundle
cannot do this: Chrome blocks ES module imports over `file://` via CORS, which is why the
single-file build exists. `tools/shots/offline.mjs` verifies it actually plays, because
that is exactly the kind of thing that fails silently.)

**Practice chips never sync.** They live in this browser and never reach an account.
There is no cryptographic fix for "play offline, edit localStorage, press upload" — the
client owns the machine — so offline exists to let you play on a plane, not to farm
currency. Achievements and leaderboards will only ever count online play.

---

## How it fits together

```
packages/
  fair/      the provably-fair primitives + the normative SPEC.md
  engine/    pure rules. No I/O, no randomness source. Runs on server AND client.
apps/
  server/    Fastify + SQLite. The only thing that deals.
  web/       Vite + React. DOM and CSS, canvas reserved for effects.
tools/
  sim/       long-run RTP simulation with sigma error bars
  shots/     headless screenshots, doubling as a smoke test
```

Three decisions carry most of the weight:

**The engine ships to both sides, the secrets do not.** `packages/engine` holds rules —
payout maths, legal-move validation, hand evaluation. It holds no randomness and no
authority. The server owns the seed and computes every outcome; the client re-uses the
same rules to render and to grey out illegal buttons, and the server re-validates
everything regardless. Cheating is prevented by redaction, not by obfuscation.

**One transport interface, two implementations.** Game screens talk to a `GameTransport`
and never learn whether it is an authoritative server or the local dealer in this tab.
That is what stops offline mode from becoming a second, drifting copy of the casino.

**Chips move through exactly one function.** `applyLedger` writes append-only rows;
`wallets.chips` is only ever a cache of `SUM(ledger.delta)`, and `auditBalances()` asserts
they agree. pysino shipped a bug where hold'em refunded a buy-in that had never been
debited, minting 4,918 chips from nothing — this makes that class of bug a failing audit
instead of a silent gift.

---

## Testing

```bash
pnpm test                         # everything
npx tsx tools/sim/rtp.ts 500000   # long-run RTP, run when changing payout maths
```

The interesting tests are the invariants, not the line coverage:

- **Payout maths** — dice and limbo return ~0.99 at every target over 60k rounds each, and
  the EV identity is asserted exactly, not just statistically.
- **No modulo bias** — a chi-square test over `randBelow(37)`, the exact place where naive
  `uint32 % n` develops measurable bias.
- **Shuffle spread** — every card must reach every position, which catches the classic
  Fisher-Yates off-by-one that leaves one index under-mixed.
- **Chip conservation** — 200 rounds, then assert wallet equals ledger sum; plus a check
  that a failed multi-entry round leaves nothing behind.
- **Seed secrecy** — every client-bound payload is searched for the active server seed.
- **Independent replay** — a finished round is recomputed from the revealed seed the way
  the verifier does, and must match what the house reported.
- **Frozen vectors** — fixed seeds produce pinned outputs forever, so changing outcomes
  has to be deliberate.

---

## Roadmap

- [x] Fairness core, engine, accounts, ledger, design system, Dice + Limbo, offline
- [ ] Blackjack, slots, crash, mines, video poker, solo roulette
- [ ] Plinko, Hi-Lo, Towers, Wheel of Fortune, slots variety pack
- [ ] Multiplayer: hold'em tables with bots, shared blackjack and roulette
- [ ] Leaderboards, profiles, achievements, XP and levels
- [ ] PWA install, sound, animation pass

---

## Licence

MIT. The chips are not real, cannot be bought, and are worth exactly nothing.
