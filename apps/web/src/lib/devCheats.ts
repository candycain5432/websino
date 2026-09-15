/**
 * The console half of the developer chip grant. Temporary, and built to be deleted.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 *  TO REMOVE THIS ENTIRELY, delete four things:
 *    1. this file
 *    2. apps/server/src/dev/cheats.ts
 *    3. the `registerDevCheats(...)` call and its import in apps/server/src/index.ts
 *    4. the `installDevCheats(...)` block and its import in apps/web/src/App.tsx
 * ──────────────────────────────────────────────────────────────────────────────
 *
 * Open devtools and type:
 *
 *     websino.chips(50000)   grant yourself chips
 *     websino.balance()      what the server thinks you have
 *     websino.help()         this, again
 *
 * **This half is always in the bundle; the server half is not.** That looks backwards
 * until you consider who each side is protecting. A function sitting on `window` grants
 * nothing - it posts a request that a normal deployment answers with 404, and it says so
 * plainly. Gating the client as well would mean either a separate build to use it (so you
 * cannot top yourself up on the deployment where you actually need to) or a flag shipped
 * to the browser, which protects nothing since the browser is the attacker's machine.
 * The enforcement belongs on the server, and it is there.
 */

export interface DevCheatHooks {
  /** Called with the new balance after a grant, so the UI updates without a reload. */
  onBalance(balance: number): void;
  /** Practice chips are already unlimited via Top up, so a cheat there is pointless. */
  practice: boolean;
}

interface DevCheatApi {
  chips(amount: number): Promise<void>;
  balance(): Promise<void>;
  help(): void;
}

const HELP = [
  'websino — developer console',
  '',
  '  websino.chips(50000)   grant yourself chips (needs WEBSINO_DEV_CHEATS=1 on the server)',
  '  websino.balance()      what the server thinks you have',
  '  websino.help()         this',
].join('\n');

export function installDevCheats(hooks: DevCheatHooks): void {
  const api: DevCheatApi = {
    help() {
      console.log(HELP);
    },

    async balance() {
      const response = await fetch('/api/me', { credentials: 'same-origin' });
      if (!response.ok) {
        console.warn('not signed in');
        return;
      }
      const me = (await response.json()) as { balance: number };
      console.log(`balance: ${me.balance.toLocaleString('en-US')}`);
      hooks.onBalance(me.balance);
    },

    async chips(amount: number) {
      if (hooks.practice) {
        console.warn(
          'practice mode has no account — its chips are already unlimited, use "Top up".',
        );
        return;
      }
      if (!Number.isInteger(amount) || amount < 1) {
        console.warn('websino.chips(n) — n must be a whole number of chips, 1 or more');
        return;
      }

      const response = await fetch('/api/dev/grant', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ amount }),
      });

      if (response.status === 404) {
        // The normal answer on a deployment, so say what it means rather than "404".
        console.warn(
          'the server has developer cheats switched off.\n' +
          'Start it with WEBSINO_DEV_CHEATS=1 to enable /api/dev/grant.',
        );
        return;
      }
      if (!response.ok) {
        const detail = (await response.json().catch(() => ({}))) as { error?: string };
        console.warn(detail.error ?? `grant failed (${response.status})`);
        return;
      }

      const { granted, balance } = (await response.json()) as {
        granted: number;
        balance: number;
      };
      console.log(
        `granted ${granted.toLocaleString('en-US')} — balance ${balance.toLocaleString('en-US')}`,
      );
      hooks.onBalance(balance);
    },
  };

  (window as unknown as { websino: DevCheatApi }).websino = api;
  console.log('%cwebsino.help()%c for the developer console', 'font-weight:700', '');
}
