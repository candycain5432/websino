# Websino provably-fair specification

**Version 1** (`fairVersion = 1`)

This document is normative. `packages/fair/src/` implements exactly this and nothing
else, and the in-browser verifier runs that same code. If the two ever disagree, the
implementation is wrong.

## What this does and does not prove

Every outcome is derived from three strings. Before you bet, the house publishes
`sha256(serverSeed)` — a commitment it cannot wriggle out of afterwards. You choose the
`clientSeed`, which is mixed into every draw, so the house cannot pre-screen server seeds
that happen to be bad for you. When the seed is rotated the original is revealed and any
past round can be recomputed and checked against the commitment.

Being honest about the limits: Websino is play money on a server the operator controls.
This scheme proves the operator did not *change the seed after seeing your bet*, and it
makes every round exactly reproducible — which is genuinely useful for auditing and for
debugging a hand that "should have won". It is not a defence against an operator who
modifies the server before committing. Treat it as craft, not as a guarantee.

## Inputs

| Input | Type | Notes |
|---|---|---|
| `serverSeed` | 64 lowercase hex chars (32 bytes) | Secret until revealed. Never leaves the server before rotation. |
| `clientSeed` | UTF-8 string, 1–256 chars | Chosen by the player. Editable at any time; editing resets `nonce` to 0. |
| `nonce` | unsigned 32-bit integer | Increments once per round on a seed pair. |
| `block` | unsigned 32-bit integer | Extends the byte stream within one round. Starts at 0. |

## The byte stream

```
block(i) = HMAC-SHA256(key = serverSeed, message = `${clientSeed}:${nonce}:${i}`)
```

The key is the **hex string** of the server seed encoded as UTF-8 (not the decoded
32 bytes). The message is UTF-8. Each block yields 32 bytes. Bytes are consumed in order;
when a block is exhausted, `i` increments.

HMAC-SHA256 comes from `@noble/hashes`, which is synchronous in both Node and the browser.
(WebCrypto's `subtle.sign` is async and cannot back a synchronous draw API.)

## Deriving values

All multi-byte reads are **big-endian**.

### `nextUint32()`
Consume 4 bytes `b0 b1 b2 b3` → `b0·2²⁴ + b1·2¹⁶ + b2·2⁸ + b3`.

### `nextFloat()` → `[0, 1)`
Consume 4 bytes and compute:

```
b0/256 + b1/256² + b2/256³ + b3/256⁴
```

This is exactly `nextUint32() / 2³²`, which is representable without loss in a double
(2³² < 2⁵³). No BigInt is required anywhere in this spec.

### `randBelow(n)` → `[0, n)`, uniform
Rejection sampling, so there is no modulo bias:

```
limit = floor(2³² / n) · n
repeat: r = nextUint32()  until r < limit
return r mod n
```

`n` must satisfy `1 ≤ n ≤ 2³²`. The number of bytes consumed is therefore **variable**;
a verifier must replay the rejection loop rather than assume 4 bytes per draw.

### `shuffle(items)`
Fisher–Yates, descending, in place on a copy:

```
for i = length-1 down to 1:
    j = randBelow(i + 1)
    swap(items[i], items[j])
```

### `sample(items, k)`
Defined as `shuffle(copy(items)).slice(0, k)`. One code path, no size heuristics.

### `pick(items)`
`items[randBelow(items.length)]`.

## Cards

A card is an integer `0–51`, computed as `rank · 4 + suit`, where rank `0–12` is
`2,3,…,10,J,Q,K,A` and suit `0–3` is `♠,♥,♦,♣`. A 52-card deck is `[0…51]` shuffled by
the rule above. Multi-deck shoes concatenate `decks` copies before shuffling.

## Per-game draw order

Each game documents its own draw order in `packages/engine/src/games/<game>/fairness.ts`,
which also exports the `verify()` used by the verifier UI — so the documentation and the
implementation are the same file and cannot drift.

| Game | Draws, in order |
|---|---|
| Dice | one `nextFloat()` → roll = `floor(f · 10001) / 100` (0.00–100.00) |
| Limbo | one `nextFloat()` → crash multiplier (see `limbo/fairness.ts`) |
| Crash | one `nextFloat()` → crash point in basis points |
| Slots | one `randBelow(stripLength)` per reel, reels left to right |
| Mines | `sample(range(25), mineCount)` at board creation |
| Roulette | one `randBelow(37)` → index into the physical wheel order |
| Blackjack | one `shuffle` of the whole shoe, per shoe (**not** per round) |
| Video poker | one `shuffle` of a 52-card deck at deal; the draw reuses that order |

Blackjack commits per **shoe** because a single shuffle covers many rounds: the commitment
is published when the shoe is shuffled and revealed when it is replaced.

At a shared table the client seed is `sha256(seat0Seed + "|" + seat1Seed + …)` over the
seated players in seat order, so no single player controls the input.

## Commit and reveal

- `commitment = sha256(serverSeed)`, published before the first round on a seed pair.
- Rotation is player-initiated at any time, and reveals the retired `serverSeed`.
- A revealed seed verifies iff `sha256(revealed) === commitment`.
- `fairVersion` is recorded on every seed pair and every round, so a future revision of
  this document cannot invalidate old proofs.

## Golden vectors

`test/vectors.json` pins the output of this spec for fixed inputs. Any change that moves a
vector is a breaking change to `fairVersion` and must be deliberate.
