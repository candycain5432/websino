/**
 * A developer chip grant. Temporary, and built to be deleted.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 *  TO REMOVE THIS ENTIRELY, delete four things:
 *    1. this file
 *    2. apps/web/src/lib/devCheats.ts
 *    3. the `registerDevCheats(...)` call and its import in apps/server/src/index.ts
 *    4. the `installDevCheats(...)` block and its import in apps/web/src/App.tsx
 *  Nothing else in the codebase refers to any of it. `pnpm -r typecheck` will
 *  confirm in one command.
 * ──────────────────────────────────────────────────────────────────────────────
 *
 * **Off unless `WEBSINO_DEV_CHEATS=1`.** Not merely refusing when disabled - the route
 * is never registered at all, so on a normal deployment `/api/dev/grant` is a 404 with
 * no code behind it. An endpoint that mints chips is the one thing in a casino that must
 * not be a config mistake away from being live, and "disabled by a flag that defaults to
 * on in one environment" is exactly how that happens. It also logs loudly at boot,
 * because the failure worth catching is leaving it on and forgetting.
 *
 * **It goes through `applyLedger` like everything else.** A cheat that wrote to
 * `wallets.chips` directly would be chips created outside the ledger, which is precisely
 * what `auditBalances()` exists to catch - the audit would start failing and the tool
 * meant to detect real corruption would be permanently red. Granted chips are an
 * `adjustment` row: visible, attributable, and excluded from `net` on the lobby's record,
 * so cheated chips never read as winnings.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { SESSION_COOKIE, resolveSession } from '../auth/index.js';
import type { Db } from '../db/index.js';
import { applyLedger, getBalance } from '../db/ledger.js';

/** One call cannot mint more than this. A typo should not be worth 10^12 chips. */
const MAX_GRANT = 1_000_000;

const grantBody = z.object({
  amount: z.number().int().min(1).max(MAX_GRANT),
});

export const DEV_CHEATS_ENABLED = process.env.WEBSINO_DEV_CHEATS === '1';

export function registerDevCheats(app: FastifyInstance, db: Db): void {
  if (!DEV_CHEATS_ENABLED) return;

  console.warn(
    '\n  ⚠  WEBSINO_DEV_CHEATS=1 - POST /api/dev/grant can mint chips for any signed-in\n' +
    '     account. Fine locally; never leave this set on a deployment.\n',
  );

  app.post('/api/dev/grant', async (request, reply) => {
    const user = resolveSession(db, request.cookies[SESSION_COOKIE]);
    // Grants go to *you*, so there has to be a you. No user id is accepted from the
    // client - otherwise the cheat would also be a way to move chips into a stranger's
    // account, which is a different and much worse thing than a self top-up.
    if (!user) return reply.code(401).send({ error: 'sign in first' });

    const { amount } = grantBody.parse(request.body);
    applyLedger(db, user.id, [{ delta: amount, reason: 'adjustment' }]);

    const balance = getBalance(db, user.id);
    console.warn(`  ⚠  dev grant: ${amount} chips to ${user.username} (now ${balance})`);
    return { granted: amount, balance };
  });
}
