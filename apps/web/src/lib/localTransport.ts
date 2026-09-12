/**
 * The offline dealer.
 *
 * Runs the same `@websino/engine` rules the server runs, against a locally generated
 * seed, with chips in localStorage. Practice chips are deliberately a separate wallet
 * that never syncs to an account: the client owns this machine, so any "sync my offline
 * winnings" scheme is just an invitation to edit localStorage and press upload.
 */

import { commit, createCasualSource, FairStream } from '@websino/fair';
import {
  blackjack, crash, dice, holdem, limbo, mines, plinko, roulette, shuffleShoe, slots,
  videopoker, wheel,
  type BlackjackView, type CrashView, type HoldemSeatView, type HoldemView,
  type MinesView, type ShoeState, type VideoPokerView,
} from '@websino/engine';
import type { RoundGame } from '@websino/engine';

import type {
  BlackjackAction, BlackjackApi, CrashApi, FairnessState, GameTransport, HoldemAction,
  HoldemApi, MinesApi, PlayRequest, PlayResponse, VideoPokerApi,
} from './transport.js';

const WALLET_KEY = 'websino.practice.wallet.v1';
const FAIR_KEY = 'websino.practice.fair.v1';
const PRACTICE_STARTING_CHIPS = 10_000;

const GAMES: Record<string, RoundGame<never, unknown>> = {
  dice: dice as unknown as RoundGame<never, unknown>,
  limbo: limbo as unknown as RoundGame<never, unknown>,
  slots: slots as unknown as RoundGame<never, unknown>,
  roulette: roulette as unknown as RoundGame<never, unknown>,
  plinko: plinko as unknown as RoundGame<never, unknown>,
  wheel: wheel as unknown as RoundGame<never, unknown>,
};

interface StoredFair {
  serverSeed: string;
  clientSeed: string;
  nonce: number;
  previous?: FairnessState['previous'];
}

/**
 * Offline blackjack and crash keep the same state the server keeps, in the same shape,
 * because they run the same engine functions. The difference is only who owns the
 * secrets - and offline, the player owns the machine anyway, which is exactly why
 * practice chips never sync.
 */
interface StoredTables {
  blackjack: {
    shoe: ShoeState;
    round: blackjack.BlackjackRound | null;
    nonce: number;
    /** Whether the finished round's payout has already been credited. */
    settled: boolean;
  } | null;
  crash: { round: crash.CrashRound; startedAt: number } | null;
  mines: { round: mines.MinesRound; nonce: number } | null;
  videopoker: { round: videopoker.VideoPokerRound; nonce: number } | null;
  holdem: {
    table: holdem.HoldemTable;
    you: number;
    buyIn: number;
    botSeed: number;
    nonce: number;
  } | null;
}

const TABLES_KEY = 'websino.practice.tables.v1';

function randomSeedHex(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    // Private windows, cleared storage, blocked cookies - all end up here and all
    // mean the same thing: start fresh rather than crash.
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full or blocked; the round still played, it just will not persist */
  }
}

export class LocalTransport implements GameTransport {
  readonly mode = 'practice' as const;

  #balance: number;
  #fair: StoredFair;
  #tables: StoredTables;

  constructor() {
    this.#balance = read<number>(WALLET_KEY, PRACTICE_STARTING_CHIPS);
    this.#fair = read<StoredFair>(FAIR_KEY, {
      serverSeed: randomSeedHex(),
      clientSeed: 'practice',
      nonce: 0,
    });
    this.#tables = read<StoredTables>(TABLES_KEY, {
      blackjack: null, crash: null, mines: null, videopoker: null, holdem: null,
    });
    this.#persist();
  }

  #persist(): void {
    write(WALLET_KEY, this.#balance);
    write(FAIR_KEY, this.#fair);
    write(TABLES_KEY, this.#tables);
  }

  /** A stream on the current seed, consuming one nonce - exactly as the server does. */
  #takeStream(): { stream: FairStream; nonce: number } {
    const nonce = this.#fair.nonce;
    const stream = new FairStream({
      serverSeed: this.#fair.serverSeed,
      clientSeed: this.#fair.clientSeed,
      nonce,
    });
    this.#fair.nonce += 1;
    return { stream, nonce };
  }

  #proofFor(nonce: number): { serverSeedHash: string; nonce: number } {
    return { serverSeedHash: commit(this.#fair.serverSeed), nonce };
  }

  #blackjackView(): BlackjackView {
    const table = this.#tables.blackjack;
    if (!table) throw new Error('no blackjack table');
    const round = table.round;
    const proof = this.#proofFor(table.nonce);
    const cardsRemaining = table.shoe.cards.length - table.shoe.position;

    if (!round) {
      return {
        phase: 'done', hands: [], dealer: [], dealerTotal: null, holeHidden: false,
        activeIndex: 0, actions: [], insuranceOffered: false, insuranceCost: 0,
        insuranceBet: 0, insurancePayout: 0, staked: 0, returned: 0,
        balance: this.#balance, cardsRemaining, proof,
      };
    }

    return {
      phase: round.phase,
      hands: round.hands.map((hand) => ({
        cards: [...hand.cards],
        bet: hand.bet,
        doubled: hand.doubled,
        fromSplit: hand.fromSplit,
        label: blackjack.handLabel(hand),
        total: blackjack.totalOf(hand.cards),
        outcome: hand.outcome,
        payout: hand.payout,
      })),
      dealer: round.holeHidden ? round.dealer.slice(0, 1) : [...round.dealer],
      dealerTotal: round.holeHidden ? null : blackjack.dealerTotal(round),
      holeHidden: round.holeHidden,
      activeIndex: round.activeIndex,
      actions: blackjack.availableActions(round),
      insuranceOffered: round.phase === 'insurance',
      insuranceCost: blackjack.insuranceCost(round),
      insuranceBet: round.insuranceBet,
      insurancePayout: round.insurancePayout,
      staked: round.staked,
      returned: round.returned,
      balance: this.#balance,
      cardsRemaining,
      proof,
    };
  }

  /**
   * Pay out a finished hand exactly once.
   *
   * Every action calls this, and several of them can finish the hand, so the guard has
   * to be explicit state rather than "we only call it in the right place". Paying twice
   * is precisely the shape of bug that minted 4,918 chips in pysino.
   */
  #settleBlackjackIfDone(): void {
    const table = this.#tables.blackjack;
    const round = table?.round;
    if (!table || !round || round.phase !== 'done' || table.settled) return;
    table.settled = true;
    if (round.returned > 0) this.#balance += round.returned;
  }

  readonly blackjack: BlackjackApi = {
    status: async (): Promise<BlackjackView | null> =>
      this.#tables.blackjack ? this.#blackjackView() : null,

    deal: async (bet: number): Promise<BlackjackView> => {
      if (!Number.isInteger(bet) || bet < 1) throw new Error('invalid bet');
      if (bet > this.#balance) throw new Error('not enough practice chips');

      let table = this.#tables.blackjack;
      if (!table || blackjack.roundNeedsShuffle(table.shoe)) {
        // A new shoe means a new commitment, same as the server.
        const { stream, nonce } = this.#takeStream();
        table = { shoe: shuffleShoe(stream, 6, 0.75), round: null, nonce, settled: true };
        this.#tables.blackjack = table;
      }
      if (table.round && table.round.phase !== 'done') {
        throw new Error('finish the hand in progress first');
      }

      this.#balance -= bet;
      table.settled = false;
      table.round = blackjack.deal(table.shoe, bet);
      this.#settleBlackjackIfDone();
      this.#persist();
      return this.#blackjackView();
    },

    act: async (action: BlackjackAction): Promise<BlackjackView> => {
      const table = this.#tables.blackjack;
      if (!table?.round) throw new Error('no blackjack round in progress');
      const before = table.round.staked;
      table.round = blackjack.act(table.round, action, table.shoe);
      const extra = table.round.staked - before;
      if (extra > 0) {
        if (extra > this.#balance) throw new Error('not enough practice chips');
        this.#balance -= extra;
      }
      this.#settleBlackjackIfDone();
      this.#persist();
      return this.#blackjackView();
    },

    insurance: async (buy: boolean): Promise<BlackjackView> => {
      const table = this.#tables.blackjack;
      if (!table?.round) throw new Error('no blackjack round in progress');
      const cost = blackjack.insuranceCost(table.round);
      if (buy && cost > this.#balance) throw new Error('not enough practice chips');
      table.round = blackjack.takeInsurance(table.round, buy);
      if (buy) this.#balance -= cost;
      this.#settleBlackjackIfDone();
      this.#persist();
      return this.#blackjackView();
    },
  };

  #crashView(reveal: boolean): CrashView {
    const table = this.#tables.crash;
    if (!table) throw new Error('no crash round');
    const base: CrashView = {
      state: table.round.state,
      bet: table.round.bet,
      autoCashOut: table.round.autoCashOut,
      startedAt: table.startedAt,
      tickMs: crash.TICK_MS,
      balance: this.#balance,
    };
    if (!reveal) return base;
    return {
      ...base,
      crashPoint: table.round.crashPoint,
      cashedMultiplier: table.round.cashedMultiplier,
      payout: crash.settle(table.round).payout,
    };
  }

  #finishCrash(): CrashView {
    const table = this.#tables.crash;
    if (!table) throw new Error('no crash round');
    const payout = crash.settle(table.round).payout;
    if (payout > 0) this.#balance += payout;
    const view = this.#crashView(true);
    this.#tables.crash = null;
    this.#persist();
    return view;
  }

  #crashTick(): number {
    const table = this.#tables.crash;
    if (!table) return 0;
    return Math.max(0, Math.floor((Date.now() - table.startedAt) / crash.TICK_MS));
  }

  readonly crash: CrashApi = {
    status: async (): Promise<CrashView | null> => {
      const table = this.#tables.crash;
      if (!table) return null;
      table.round = crash.resolveAt(table.round, this.#crashTick());
      if (table.round.state !== 'running') return this.#finishCrash();
      this.#persist();
      return this.#crashView(false);
    },

    start: async (bet: number, autoCashOut: number | null): Promise<CrashView> => {
      const existing = this.#tables.crash;
      if (existing) {
        // Settle anything that already ran its course rather than refusing forever.
        existing.round = crash.resolveAt(existing.round, this.#crashTick());
        if (existing.round.state !== 'running') this.#finishCrash();
        else throw new Error('a crash round is already running');
      }
      if (!Number.isInteger(bet) || bet < 1) throw new Error('invalid bet');
      if (bet > this.#balance) throw new Error('not enough practice chips');

      const { stream } = this.#takeStream();
      this.#balance -= bet;
      this.#tables.crash = {
        round: crash.startCrash(bet, stream, autoCashOut),
        startedAt: Date.now(),
      };
      this.#persist();
      return this.#crashView(false);
    },

    cashOut: async (): Promise<CrashView> => {
      const table = this.#tables.crash;
      if (!table) throw new Error('no crash round in progress');
      table.round = crash.cashOutAt(table.round, this.#crashTick());
      return this.#finishCrash();
    },
  };

  #minesView(): MinesView {
    const table = this.#tables.mines;
    if (!table) throw new Error('no mines board');
    const round = table.round;
    const view: MinesView = {
      state: round.state,
      bet: round.bet,
      mines: round.mines,
      revealed: [...round.revealed],
      picks: round.revealed.length,
      multiplier: mines.currentMultiplier(round),
      payout: mines.currentPayout(round),
      nextMultiplier: mines.nextMultiplier(round),
      balance: this.#balance,
      proof: this.#proofFor(table.nonce),
    };
    if (round.state === 'playing') return view;
    return { ...view, minePositions: [...round.minePositions], hitPosition: round.hitPosition };
  }

  #finishMines(): MinesView {
    const table = this.#tables.mines;
    if (!table) throw new Error('no mines board');
    this.#balance += mines.currentPayout(table.round);
    const view = this.#minesView();
    this.#tables.mines = null;
    this.#persist();
    return view;
  }

  readonly mines: MinesApi = {
    status: async (): Promise<MinesView | null> =>
      this.#tables.mines ? this.#minesView() : null,

    start: async (bet: number, mineCount: number): Promise<MinesView> => {
      if (this.#tables.mines) throw new Error('finish the board in progress first');
      if (!Number.isInteger(bet) || bet < 1) throw new Error('invalid bet');
      if (bet > this.#balance) throw new Error('not enough practice chips');

      const { stream, nonce } = this.#takeStream();
      this.#balance -= bet;
      this.#tables.mines = { round: mines.startMines(bet, mineCount, stream), nonce };
      this.#persist();
      return this.#minesView();
    },

    reveal: async (position: number): Promise<MinesView> => {
      const table = this.#tables.mines;
      if (!table) throw new Error('no mines board in progress');
      table.round = mines.reveal(table.round, position);
      if (table.round.state !== 'playing') return this.#finishMines();
      this.#persist();
      return this.#minesView();
    },

    cashOut: async (): Promise<MinesView> => {
      const table = this.#tables.mines;
      if (!table) throw new Error('no mines board in progress');
      table.round = mines.cashOut(table.round);
      return this.#finishMines();
    },
  };

  #videoPokerView(): VideoPokerView {
    const table = this.#tables.videopoker;
    if (!table) throw new Error('no video poker hand');
    const round = table.round;
    return {
      phase: round.phase,
      cards: [...round.cards],
      held: [...round.held],
      coins: round.coins,
      coinValue: round.coinValue,
      bet: videopoker.betFor(round.coins, round.coinValue),
      drawn: [...round.drawn],
      result: round.result,
      resultName: round.result ? videopoker.HAND_NAMES[round.result] : null,
      payout: round.payout,
      balance: this.#balance,
      proof: this.#proofFor(table.nonce),
    };
  }

  readonly videopoker: VideoPokerApi = {
    status: async (): Promise<VideoPokerView | null> =>
      this.#tables.videopoker ? this.#videoPokerView() : null,

    deal: async (coins: number, coinValue: number): Promise<VideoPokerView> => {
      if (this.#tables.videopoker) throw new Error('finish the hand in progress first');
      const bet = videopoker.betFor(coins, coinValue);
      if (!Number.isInteger(bet) || bet < 1) throw new Error('invalid bet');
      if (bet > this.#balance) throw new Error('not enough practice chips');

      const { stream, nonce } = this.#takeStream();
      this.#balance -= bet;
      this.#tables.videopoker = { round: videopoker.deal(coins, coinValue, stream), nonce };
      this.#persist();
      return this.#videoPokerView();
    },

    draw: async (held: boolean[]): Promise<VideoPokerView> => {
      const table = this.#tables.videopoker;
      if (!table) throw new Error('no video poker hand in progress');
      table.round = videopoker.drawCards(videopoker.setHolds(table.round, held));
      this.#balance += table.round.payout;
      const view = this.#videoPokerView();
      this.#tables.videopoker = null;
      this.#persist();
      return view;
    },
  };

  #holdemView(): HoldemView {
    const entry = this.#tables.holdem;
    if (!entry) throw new Error('no hold em table');
    const t = entry.table;
    const showdown = t.result?.wentToShowdown === true;
    const descriptions = new Map((t.result?.entries ?? []).map((e) => [e.seat, e.description]));

    const seats: HoldemSeatView[] = t.players.map((p) => {
      const reveal = p.seat === entry.you || (showdown && holdem.inHand(p));
      return {
        seat: p.seat,
        name: p.name,
        chips: p.chips,
        isBot: p.isBot,
        style: p.profile?.name ?? null,
        ...(reveal && p.hole.length > 0 ? { hole: [...p.hole] } : {}),
        bet: p.bet,
        committed: p.committed,
        folded: p.folded,
        allIn: p.allIn,
        sittingOut: p.sittingOut,
        lastAction: p.lastAction,
        wonLast: p.wonLast,
        isButton: p.seat === t.button,
        isTurn: t.toAct === p.seat,
        ...(showdown ? { handDescription: descriptions.get(p.seat) ?? null } : {}),
      };
    });

    const you = t.players[entry.you] as holdem.HoldemPlayer;
    const yourTurn = t.toAct === entry.you && !holdem.isHandOver(t);

    return {
      street: t.street,
      board: [...t.board],
      pot: holdem.potOf(t),
      currentBet: t.currentBet,
      seats,
      you: entry.you,
      toAct: t.toAct,
      yourTurn,
      actions: yourTurn ? holdem.legalActions(t, you) : [],
      toCall: holdem.toCall(t, you),
      minRaiseTo: holdem.minRaiseTo(t, you),
      maxRaiseTo: holdem.maxRaiseTo(t, you),
      handInProgress: t.handInProgress,
      handNumber: t.handNumber,
      log: [...t.log],
      result: t.result
        ? {
            wentToShowdown: t.result.wentToShowdown,
            winners: t.result.winners,
            pots: t.result.pots,
            rake: t.result.rake,
          }
        : null,
      balance: this.#balance,
      proof: this.#proofFor(entry.nonce),
    };
  }

  /** Bots act until it is the human's turn again, or the hand ends. */
  #runBots(): void {
    const entry = this.#tables.holdem;
    if (!entry) return;
    const random = createCasualSource(entry.botSeed);
    entry.botSeed = (entry.botSeed * 1_103_515_245 + 12_345) >>> 0;

    for (let guard = 0; guard < 200; guard += 1) {
      const t = entry.table;
      if (holdem.isHandOver(t) || t.toAct === null || t.toAct === entry.you) return;
      holdem.playBotTurn(t, random);
    }
    throw new Error('hold em table failed to settle');
  }

  readonly holdem: HoldemApi = {
    status: async (): Promise<HoldemView | null> =>
      this.#tables.holdem ? this.#holdemView() : null,

    sit: async (buyIn: number): Promise<HoldemView> => {
      if (this.#tables.holdem) throw new Error('you are already sitting at a table');
      if (!Number.isInteger(buyIn) || buyIn < 1) throw new Error('invalid buy-in');
      if (buyIn > this.#balance) throw new Error('not enough practice chips');

      const { stream, nonce } = this.#takeStream();
      const botSeed = (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0;
      const players = holdem.makeTable(createCasualSource(botSeed), buyIn, 3, 2000);
      this.#balance -= buyIn;
      this.#tables.holdem = {
        table: holdem.createTable(players),
        you: 0,
        buyIn,
        botSeed,
        nonce,
      };
      holdem.dealHand(this.#tables.holdem.table, stream);
      this.#runBots();
      this.#persist();
      return this.#holdemView();
    },

    deal: async (): Promise<HoldemView> => {
      const entry = this.#tables.holdem;
      if (!entry) throw new Error('no hold em table');
      if (entry.table.handInProgress) throw new Error('finish the hand first');
      if ((entry.table.players[entry.you] as holdem.HoldemPlayer).chips <= 0) {
        throw new Error('you are out of chips at this table');
      }
      const { stream, nonce } = this.#takeStream();
      entry.nonce = nonce;
      holdem.dealHand(entry.table, stream);
      this.#runBots();
      this.#persist();
      return this.#holdemView();
    },

    act: async (action: HoldemAction, amount: number): Promise<HoldemView> => {
      const entry = this.#tables.holdem;
      if (!entry) throw new Error('no hold em table');
      if (entry.table.toAct !== entry.you) throw new Error('it is not your turn');
      holdem.act(entry.table, action, amount);
      this.#runBots();
      this.#persist();
      return this.#holdemView();
    },

    leave: async (): Promise<{ balance: number; cashedOut: number }> => {
      const entry = this.#tables.holdem;
      if (!entry) throw new Error('no hold em table');
      if (entry.table.handInProgress) throw new Error('finish the hand before you stand up');
      const stack = (entry.table.players[entry.you] as holdem.HoldemPlayer).chips;
      this.#balance += stack;
      this.#tables.holdem = null;
      this.#persist();
      return { balance: this.#balance, cashedOut: stack };
    },
  };

  async getBalance(): Promise<number> {
    return this.#balance;
  }

  async topUp(): Promise<number> {
    // Practice chips are worthless by design, so a top-up is free and unlimited.
    if (this.#balance < PRACTICE_STARTING_CHIPS) this.#balance = PRACTICE_STARTING_CHIPS;
    this.#persist();
    return this.#balance;
  }

  async play(request: PlayRequest): Promise<PlayResponse> {
    const game = GAMES[request.game];
    if (!game) throw new Error(`unknown game: ${request.game}`);
    if (!Number.isInteger(request.bet) || request.bet < 1) throw new Error('invalid bet');
    if (request.bet > this.#balance) throw new Error('not enough practice chips');

    const stream = new FairStream({
      serverSeed: this.#fair.serverSeed,
      clientSeed: this.#fair.clientSeed,
      nonce: this.#fair.nonce,
    });

    const outcome = game.play(request.config as never, request.bet, stream);
    this.#balance = this.#balance - request.bet + outcome.payout;

    const proof = {
      serverSeedHash: commit(this.#fair.serverSeed),
      clientSeed: this.#fair.clientSeed,
      nonce: this.#fair.nonce,
      fairVersion: 1,
    };

    this.#fair.nonce += 1;
    this.#persist();

    return {
      payout: outcome.payout,
      multiplier: outcome.multiplier,
      detail: outcome.detail,
      balance: this.#balance,
      proof,
    };
  }

  async getFairness(): Promise<FairnessState> {
    return {
      serverSeedHash: commit(this.#fair.serverSeed),
      clientSeed: this.#fair.clientSeed,
      nonce: this.#fair.nonce,
      fairVersion: 1,
      ...(this.#fair.previous ? { previous: this.#fair.previous } : {}),
    };
  }

  async setClientSeed(clientSeed: string): Promise<FairnessState> {
    const trimmed = clientSeed.trim() || 'practice';
    this.#fair.clientSeed = trimmed.slice(0, 256);
    this.#fair.nonce = 0;
    this.#persist();
    return this.getFairness();
  }

  async rotateServerSeed(): Promise<FairnessState> {
    this.#fair.previous = {
      serverSeed: this.#fair.serverSeed,
      serverSeedHash: commit(this.#fair.serverSeed),
      clientSeed: this.#fair.clientSeed,
      rounds: this.#fair.nonce,
    };
    this.#fair.serverSeed = randomSeedHex();
    this.#fair.nonce = 0;
    this.#persist();
    return this.getFairness();
  }
}
