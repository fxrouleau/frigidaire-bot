// Follow-ups that arrive while the bot is answering someone. People write in bursts ("bot", then the real
// question 0.7 s later; three lines ten seconds apart), and every routed message used to queue a turn of its
// own: the bot answered each line separately, each reply trailing further behind the conversation (a turn
// takes ~25 s). Now a routed message from the person whose turn is running is handed to that turn instead
// (steered, like a message typed into Claude Code or Hermes mid-turn) and folded in at the next safe point:
//   - a model call in flight is cancelled and made again with everything said since; what it answered,
//     even a finished reply, is dropped (nothing was posted or run);
//   - a running tool is never cancelled (it may have set a reminder): the follow-up goes in before the
//     next model call;
//   - once the answer is final (it is being posted), a follow-up queues as its own turn, as before, and
//     sees this one's reply.
// Cancelled calls are capped per turn, and so are the follow-ups one turn takes; past the cap a follow-up
// waits for the next safe point, or for its own turn. Someone else's message never steers another person's
// turn: it waits for its own.
import type { Message } from 'discord.js';
import { canonicalUserId, isSamePerson } from '../linkedAccounts';
import { attributeMessage } from '../relay';

/** Model calls one turn may cancel for follow-ups; past it a call runs to the end (it may be the answer). */
export const MAX_STEER_RESTARTS = 3;
/** Follow-ups one turn takes; more queue as their own turn. */
export const MAX_STEERED_MESSAGES = 8;

/** A request for a turn: the message, its options, and the caller waiting on it. */
export type TurnRequest<Options> = {
  message: Message;
  opts: Options;
  /** The member the turn answers (main account id), undefined for anything that isn't a member's message. */
  person: string | undefined;
  resolve: () => void;
  reject: (error: unknown) => void;
};

/** Who a message is from, for steering: its real author's main account (relays count as their author). */
export function steeringPerson(message: Message): string | undefined {
  const authorId = attributeMessage(message)?.authorId;
  return authorId ? canonicalUserId(authorId) : undefined;
}

/** Snowflake order (agent.ts's compareSnowflakes: decimal ids without leading zeros, so length first). */
function isNewer(id: string, than: string): boolean {
  return id.length !== than.length ? id.length > than.length : id > than;
}

/** One running turn and the follow-ups handed to it. */
export class SteerableTurn<Options> {
  readonly person: string | undefined;
  private inbox: Array<TurnRequest<Options>> = [];
  private readonly taken: Array<TurnRequest<Options>> = [];
  private closed = false;
  private restartCount = 0;
  private inFlight: AbortController | undefined;
  /** The newest message id the model has been shown in this turn. */
  private shownUpTo: string;

  constructor(
    readonly first: TurnRequest<Options>,
    private readonly limits = { restarts: MAX_STEER_RESTARTS, messages: MAX_STEERED_MESSAGES },
  ) {
    this.person = first.person;
    this.shownUpTo = first.message.id;
  }

  /** Follow-ups folded into this turn so far. */
  get steered(): number {
    return this.taken.length;
  }

  /** Model calls cancelled so far. */
  get restarts(): number {
    return this.restartCount;
  }

  /**
   * Hands a request to this turn. False when it must wait for a turn of its own: someone else's message, a
   * turn that is posting its answer already, or one that took all the follow-ups it may. A message older
   * than the turn's own (routed late, or Ask Fridge on an old one) isn't a follow-up either: its own turn
   * knows what to do with a message the window already shows (agent.ts, LATE_MESSAGE_NOTE).
   */
  offer(request: TurnRequest<Options>): boolean {
    if (this.closed || !this.person || !request.person || !isSamePerson(this.person, request.person)) return false;
    if (!isNewer(request.message.id, this.first.message.id)) return false;
    if (this.taken.length + this.inbox.length >= this.limits.messages) return false;
    this.inbox.push(request);
    // Only something the model hasn't seen restarts a call (a message routed late, out of order, is already
    // in view: it just settles with the turn).
    if (this.inFlight && isNewer(request.message.id, this.shownUpTo) && this.restartCount < this.limits.restarts) {
      this.restartCount++;
      this.inFlight.abort();
      this.inFlight = undefined;
    }
    return true;
  }

  /** The follow-ups that arrived since the last call, now part of the turn (oldest message first). */
  take(): Array<TurnRequest<Options>> {
    const arrived = this.inbox.sort((a, b) => (isNewer(a.message.id, b.message.id) ? 1 : -1));
    this.inbox = [];
    this.taken.push(...arrived);
    return arrived;
  }

  /** The newest message the model has been shown in this turn. */
  get lastShown(): string {
    return this.shownUpTo;
  }

  /** The model has now been shown everything up to this message. */
  shown(messageId: string): void {
    if (isNewer(messageId, this.shownUpTo)) this.shownUpTo = messageId;
  }

  /** A model call starts: a follow-up cancels it through this signal. */
  callStarted(): AbortSignal {
    this.inFlight = new AbortController();
    return this.inFlight.signal;
  }

  callEnded(): void {
    this.inFlight = undefined;
  }

  /**
   * The answer is final: nothing more is taken (a later message queues). Follow-ups waiting that the model
   * saw anyway (in the stretch a fold showed) are answered by it, and returned; the others are leftovers.
   */
  close(): Array<TurnRequest<Options>> {
    this.closed = true;
    const seen = this.inbox.filter((request) => !isNewer(request.message.id, this.shownUpTo));
    this.inbox = this.inbox.filter((request) => isNewer(request.message.id, this.shownUpTo));
    this.taken.push(...seen);
    return seen;
  }

  /** The turn is over: follow-ups it never got to (it failed, or stopped calling the model before them). */
  leftovers(): Array<TurnRequest<Options>> {
    this.closed = true;
    const left = this.inbox;
    this.inbox = [];
    return left;
  }

  /** Settles the first request and every follow-up folded in with the turn's outcome. */
  settle(outcome: { ok: true } | { ok: false; error: unknown }): void {
    for (const request of [this.first, ...this.taken]) {
      if (outcome.ok) request.resolve();
      else request.reject(outcome.error);
    }
  }
}
