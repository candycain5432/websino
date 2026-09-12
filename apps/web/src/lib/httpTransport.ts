/**
 * The house transport: the same interface, backed by the server.
 *
 * Nothing here decides anything. It posts intents and renders whatever comes back - no
 * local copy of the balance, no optimistic settlement, no client-side idea of what a
 * hand is worth. Every response carries the authoritative balance precisely so the UI
 * never has to guess and then be wrong.
 *
 * The session cookie is httpOnly, so `credentials: 'include'` is the whole of the auth
 * story on this side: the token is never readable from JavaScript, which is the point.
 */

import type {
  BlackjackAction, BlackjackApi, BlackjackView, CrashApi, CrashView,
  FairnessState, GameTransport, HiLoApi, HiLoView, HoldemAction, HoldemApi, HoldemView,
  MinesApi, MinesView, PlayRequest, PlayResponse, TowersApi, TowersView, VideoPokerApi,
  VideoPokerView,
} from './transport.js';

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function call<T>(path: string, method: 'GET' | 'POST' = 'GET', body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      credentials: 'include',
      ...(body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
  } catch {
    // A failed fetch is almost always "the server is not there", which for this app is
    // a normal state rather than an error - practice mode exists for exactly this.
    throw new ApiError(0, 'Cannot reach the server');
  }

  if (!response.ok) {
    const detail = (await response.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(response.status, detail.error ?? `Request failed (${response.status})`);
  }
  return (await response.json()) as T;
}

export interface Account {
  id: string;
  username: string;
}

export const api = {
  register: (username: string, password: string) =>
    call<{ user: Account; balance: number }>('/api/auth/register', 'POST', { username, password }),
  login: (username: string, password: string) =>
    call<{ user: Account; balance: number }>('/api/auth/login', 'POST', { username, password }),
  logout: () => call<{ ok: true }>('/api/auth/logout', 'POST', {}),
  me: () => call<{ user: Account; balance: number }>('/api/me'),
};

export class HttpTransport implements GameTransport {
  readonly mode = 'house' as const;

  async getBalance(): Promise<number> {
    return (await api.me()).balance;
  }

  async play(request: PlayRequest): Promise<PlayResponse> {
    return call<PlayResponse>('/api/round', 'POST', request);
  }

  async getFairness(): Promise<FairnessState> {
    return call<FairnessState>('/api/fair');
  }

  async setClientSeed(clientSeed: string): Promise<FairnessState> {
    return call<FairnessState>('/api/fair/client-seed', 'POST', { clientSeed });
  }

  async rotateServerSeed(): Promise<FairnessState> {
    return call<FairnessState>('/api/fair/rotate', 'POST', {});
  }

  readonly blackjack: BlackjackApi = {
    status: () => call<BlackjackView | null>('/api/blackjack'),
    deal: (bet) => call<BlackjackView>('/api/blackjack/deal', 'POST', { bet }),
    act: (action: BlackjackAction) =>
      call<BlackjackView>('/api/blackjack/action', 'POST', { action }),
    insurance: (buy) => call<BlackjackView>('/api/blackjack/insurance', 'POST', { buy }),
  };

  readonly crash: CrashApi = {
    status: () => call<CrashView | null>('/api/crash'),
    start: (bet, autoCashOut) => call<CrashView>('/api/crash/start', 'POST', { bet, autoCashOut }),
    cashOut: () => call<CrashView>('/api/crash/cashout', 'POST', {}),
  };

  readonly mines: MinesApi = {
    status: () => call<MinesView | null>('/api/mines'),
    start: (bet, mines) => call<MinesView>('/api/mines/start', 'POST', { bet, mines }),
    reveal: (position) => call<MinesView>('/api/mines/reveal', 'POST', { position }),
    cashOut: () => call<MinesView>('/api/mines/cashout', 'POST', {}),
  };

  readonly hilo: HiLoApi = {
    status: () => call<HiLoView | null>('/api/hilo'),
    start: (bet) => call<HiLoView>('/api/hilo/start', 'POST', { bet }),
    guess: (choice) => call<HiLoView>('/api/hilo/guess', 'POST', { guess: choice }),
    cashOut: () => call<HiLoView>('/api/hilo/cashout', 'POST', {}),
  };

  readonly towers: TowersApi = {
    status: () => call<TowersView | null>('/api/towers'),
    start: (bet, difficulty) =>
      call<TowersView>('/api/towers/start', 'POST', { bet, difficulty }),
    climb: (tile) => call<TowersView>('/api/towers/climb', 'POST', { tile }),
    cashOut: () => call<TowersView>('/api/towers/cashout', 'POST', {}),
  };

  readonly videopoker: VideoPokerApi = {
    status: () => call<VideoPokerView | null>('/api/videopoker'),
    deal: (coins, coinValue) =>
      call<VideoPokerView>('/api/videopoker/deal', 'POST', { coins, coinValue }),
    draw: (held) => call<VideoPokerView>('/api/videopoker/draw', 'POST', { held }),
  };

  readonly holdem: HoldemApi = {
    status: () => call<HoldemView | null>('/api/holdem'),
    sit: (buyIn) => call<HoldemView>('/api/holdem/sit', 'POST', { buyIn }),
    deal: () => call<HoldemView>('/api/holdem/deal', 'POST', {}),
    act: (action: HoldemAction, amount: number) =>
      call<HoldemView>('/api/holdem/act', 'POST', { action, amount }),
    leave: () =>
      call<{ balance: number; cashedOut: number }>('/api/holdem/leave', 'POST', {}),
  };
}
