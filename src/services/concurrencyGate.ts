import { logger } from "../utils/logger";

/**
 * A gate that lets at most `limit` jobs run at once, shares the queue fairly
 * between users, and can tell a waiting job where it stands in line.
 *
 * Two things make this more than a semaphore:
 *
 * The queue position, because heavy work here takes tens of seconds and under
 * load someone is going to wait minutes — and a wait with a visible end is
 * tolerable in a way that a silent one is not.
 *
 * Fair ordering, because plain FIFO lets one person with twenty long videos
 * block twenty people with one short clip each. Waiting jobs are served by
 * round: everyone's first job, then everyone's second, and so on. Nobody is
 * refused and no job is dropped — a batch still finishes, it just stops
 * monopolising the queue while it does.
 */
export interface GateTicket {
  /** 0 while running, 1 for next in line, and so on. */
  position(): number;
  /** Resolves when a slot is free. Rejects if the caller aborts first. */
  wait(abortSignal?: AbortSignal): Promise<void>;
  /** Must be called when the work is done, including on failure. */
  release(): void;
  /** Called with the new position whenever the queue moves. */
  onMove(listener: (position: number) => void): void;
}

interface Waiter {
  admit: () => void;
  reject: (err: Error) => void;
  listener?: (position: number) => void;
  /** Who submitted this. Jobs without an owner are each treated as their own. */
  owner?: string;
  /**
   * Which round this job belongs to: an owner's first queued job goes in the
   * current round, their second in the next, and so on. Assigned once at
   * enqueue time — deriving it from the current queue instead would reset an
   * owner's count every time one of their jobs left, which collapses the whole
   * scheme back into plain FIFO.
   */
  round: number;
  /** Arrival sequence, breaking ties inside a round. */
  arrival: number;
  /** True once wait() has been called and there is a promise to resolve. */
  ready: boolean;
  admitted: boolean;
  released: boolean;
}

export class ConcurrencyGate {
  private running = 0;
  /** Arrival order. Service order is computed from it by `fairOrder()`. */
  private waiting: Waiter[] = [];

  constructor(
    private readonly limit: number,
    private readonly name: string
  ) {}

  get stats(): { running: number; waiting: number; limit: number } {
    return { running: this.running, waiting: this.waiting.length, limit: this.limit };
  }

  /** How many jobs this owner already has waiting. Used to cap runaway batches. */
  queuedFor(owner: string): number {
    return this.waiting.filter((w) => w.owner === owner).length;
  }

  /** Round of the job most recently admitted. Nobody may queue behind it. */
  private currentRound = 0;
  /** Round each owner's next job will land in. */
  private nextRoundOf = new Map<string, number>();
  private arrivals = 0;

  /**
   * Assign the round a newly queued job belongs to.
   *
   * An owner's jobs go into consecutive rounds, so their second job competes
   * with everyone else's second, not with everyone else's first. Clamping to
   * the current round stops someone who has been idle from banking credit and
   * then jumping the whole queue with a burst.
   */
  private assignRound(owner: string): number {
    const round = Math.max(this.currentRound, this.nextRoundOf.get(owner) ?? 0);
    this.nextRoundOf.set(owner, round + 1);
    return round;
  }

  /**
   * Service order: everyone's first queued job, then everyone's second, and so
   * on, with arrival order breaking ties inside a round.
   */
  private fairOrder(): Waiter[] {
    return [...this.waiting].sort((a, b) => a.round - b.round || a.arrival - b.arrival);
  }

  /** Forget owners who have nothing queued and no claim on a future round. */
  private pruneOwners(): void {
    if (this.nextRoundOf.size < 256) return;
    const active = new Set(this.waiting.map((w) => w.owner).filter(Boolean));
    for (const [owner, round] of this.nextRoundOf) {
      if (!active.has(owner) && round <= this.currentRound) this.nextRoundOf.delete(owner);
    }
  }

  take(owner?: string): GateTicket {
    const arrival = this.arrivals++;
    // An anonymous job gets a key nobody else shares, so it competes as if it
    // were its own user rather than pooling with every other anonymous one.
    const key = owner ?? `anon:${arrival}`;
    const waiter: Waiter = {
      admit: () => {},
      reject: () => {},
      owner,
      round: this.assignRound(key),
      arrival,
      ready: false,
      admitted: false,
      released: false,
    };
    this.waiting.push(waiter);

    const position = (): number => {
      if (waiter.admitted) return 0;
      const idx = this.fairOrder().indexOf(waiter);
      // Everyone ahead of us must finish, but `limit` of them are already
      // running rather than queued, so they do not add to our wait.
      return idx < 0 ? 0 : idx + 1;
    };

    return {
      position,
      onMove: (listener) => {
        waiter.listener = listener;
      },
      wait: (abortSignal?: AbortSignal) =>
        new Promise<void>((resolve, reject) => {
          waiter.admit = resolve;
          waiter.reject = reject;
          waiter.ready = true;

          if (abortSignal) {
            if (abortSignal.aborted) {
              this.drop(waiter);
              reject(new Error("Aborted while queued"));
              return;
            }
            abortSignal.addEventListener(
              "abort",
              () => {
                if (waiter.admitted) return; // already running; the job handles its own abort
                this.drop(waiter);
                reject(new Error("Aborted while queued"));
              },
              { once: true }
            );
          }

          this.pump();
        }),
      release: () => {
        // Guard against a double release turning into an extra free slot.
        if (waiter.released) return;
        waiter.released = true;
        if (waiter.admitted) {
          this.running -= 1;
        } else {
          this.drop(waiter);
        }
        this.pump();
      },
    };
  }

  private drop(waiter: Waiter): void {
    const idx = this.waiting.indexOf(waiter);
    if (idx >= 0) this.waiting.splice(idx, 1);
    this.notifyMoved();
  }

  private pump(): void {
    while (this.running < this.limit && this.waiting.length > 0) {
      const next = this.fairOrder()[0];
      // The head holds a ticket but has not called wait() yet, so there is no
      // promise to resolve. Stop rather than skip past it — wait() calls pump()
      // again as soon as it is called, which is on the very next line at every
      // call site.
      if (!next.ready) break;
      this.waiting.splice(this.waiting.indexOf(next), 1);
      next.admitted = true;
      // Everyone still queued is now measured against this round, so an owner
      // who has been away cannot use an old, low counter to jump the line.
      this.currentRound = next.round;
      this.running += 1;
      next.admit();
    }
    this.pruneOwners();
    this.notifyMoved();
  }

  private notifyMoved(): void {
    this.fairOrder().forEach((waiter, idx) => {
      waiter.listener?.(idx + 1);
    });
  }

  /** Log a line when a job actually had to wait, so load is visible after the fact. */
  logWait(waitedMs: number, label: string): void {
    if (waitedMs < 1000) return;
    logger.info("Queued before running", {
      gate: this.name,
      label,
      waitedMs,
      ...this.stats,
    });
  }
}

// One heavy transcription at a time. GigaAM already saturates every core, so a
// second concurrent job does not finish sooner — measured on the server, two in
// parallel took 13.1s against 14.3s sequentially, i.e. no real gain — and it
// risks the two of them tripping the worker's HTTP timeout.
export const sttGate = new ConcurrencyGate(1, "stt");

// Downloads are network-bound, so several can overlap usefully. The cap exists
// because each one also spawns ffmpeg, and unbounded ffmpeg processes starve
// the transcription that is doing the actual work.
export const downloadGate = new ConcurrencyGate(4, "download");

/**
 * How many jobs one person may have waiting before we ask them to hold off.
 * This is a count, not a duration or a length limit: hour-long videos must keep
 * working, and fair ordering already stops a batch from blocking everyone else.
 * The cap only exists to catch a runaway — a pasted folder of links, a looping
 * client — and admins are exempt so batch runs stay possible.
 */
export const MAX_QUEUED_PER_USER = 5;

/**
 * Jobs accepted but not yet finished, per owner.
 *
 * Counting the transcription queue instead does not work: a job only reaches
 * that queue after its download finishes, so at the moment a request is
 * accepted the count is always zero and the cap never fires. Measured — eight
 * submissions in a row were all accepted against a cap of five.
 */
const inFlight = new Map<string, number>();

export function beginJob(owner: string): void {
  inFlight.set(owner, (inFlight.get(owner) ?? 0) + 1);
}

export function endJob(owner: string): void {
  const left = (inFlight.get(owner) ?? 0) - 1;
  if (left > 0) inFlight.set(owner, left);
  else inFlight.delete(owner);
}

export function inFlightFor(owner: string): number {
  return inFlight.get(owner) ?? 0;
}

export function isQueueFull(owner: string): boolean {
  return inFlightFor(owner) >= MAX_QUEUED_PER_USER;
}
