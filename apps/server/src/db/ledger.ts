/**
 * The only place in the codebase permitted to change a chip balance.
 *
 * pysino shipped a bug where hold'em refunded a table buy-in that had never been
 * debited, minting 4,918 chips out of nothing. It was hard to spot because chips were
 * mutated from several places and nothing reconciled them.
 *
 * Here every movement is an append-only `ledger` row, `wallets.chips` is only ever a
 * cache of `SUM(ledger.delta)`, and `auditBalances()` asserts the two agree. A bug of
 * that shape becomes a failing audit instead of a silent gift.
 */

import type { Db } from './index.js';

export type LedgerReason =
  | 'signup'
  | 'wager'
  | 'payout'
  | 'daily_bonus'
  | 'bailout'
  | 'adjustment';

export interface LedgerEntry {
  delta: number;
  reason: LedgerReason;
  roundId?: string | undefined;
}

export class InsufficientChipsError extends Error {
  constructor() {
    super('not enough chips');
    this.name = 'InsufficientChipsError';
  }
}

export function getBalance(db: Db, userId: string): number {
  const row = db.prepare('SELECT chips FROM wallets WHERE user_id = ?').get(userId) as
    | { chips: number }
    | undefined;
  return row?.chips ?? 0;
}

/**
 * Apply a set of movements atomically. Either every entry lands or none does.
 * Returns the balance afterwards.
 */
export function applyLedger(db: Db, userId: string, entries: LedgerEntry[]): number {
  if (entries.length === 0) return getBalance(db, userId);

  const run = db.transaction((): number => {
    const wallet = db
      .prepare('SELECT chips, peak_chips FROM wallets WHERE user_id = ?')
      .get(userId) as { chips: number; peak_chips: number } | undefined;
    if (!wallet) throw new Error(`no wallet for user ${userId}`);

    let balance = wallet.chips;
    const now = Date.now();
    const insert = db.prepare(
      `INSERT INTO ledger (user_id, delta, balance_after, reason, round_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );

    for (const entry of entries) {
      if (!Number.isInteger(entry.delta)) throw new Error('ledger deltas must be integers');
      balance += entry.delta;
      if (balance < 0) throw new InsufficientChipsError();
      insert.run(userId, entry.delta, balance, entry.reason, entry.roundId ?? null, now);
    }

    db.prepare(
      'UPDATE wallets SET chips = ?, peak_chips = MAX(peak_chips, ?), updated_at = ? WHERE user_id = ?',
    ).run(balance, balance, now, userId);

    return balance;
  });

  return run();
}

export interface BalanceDiscrepancy {
  userId: string;
  walletChips: number;
  ledgerSum: number;
}

/**
 * Every wallet must equal the sum of its ledger. Run in tests and at start-up:
 * a non-empty result means chips were created or destroyed outside `applyLedger`.
 */
export function auditBalances(db: Db): BalanceDiscrepancy[] {
  const rows = db
    .prepare(
      `SELECT w.user_id AS userId,
              w.chips   AS walletChips,
              COALESCE((SELECT SUM(delta) FROM ledger l WHERE l.user_id = w.user_id), 0) AS ledgerSum
       FROM wallets w`,
    )
    .all() as BalanceDiscrepancy[];
  return rows.filter((row) => row.walletChips !== row.ledgerSum);
}

export function recentLedger(db: Db, userId: string, limit = 50): Array<{
  delta: number;
  balanceAfter: number;
  reason: string;
  createdAt: number;
}> {
  return db
    .prepare(
      `SELECT delta, balance_after AS balanceAfter, reason, created_at AS createdAt
       FROM ledger WHERE user_id = ? ORDER BY id DESC LIMIT ?`,
    )
    .all(userId, limit) as Array<{
    delta: number;
    balanceAfter: number;
    reason: string;
    createdAt: number;
  }>;
}
