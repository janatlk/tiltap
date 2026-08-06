import { describe, it } from "node:test";
import assert from "node:assert";
import { ConcurrencyGate } from "../services/concurrencyGate";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Run a job through the gate, recording when it started and finished.
 * `owner` is what makes the queue fair, so most tests care about it.
 */
async function job(
  gate: ConcurrencyGate,
  id: string,
  log: string[],
  owner?: string,
  ms = 5
): Promise<void> {
  const ticket = gate.take(owner);
  await ticket.wait();
  log.push(id);
  await sleep(ms);
  ticket.release();
}

describe("ConcurrencyGate", () => {
  it("never runs more than the limit at once", async () => {
    const gate = new ConcurrencyGate(3, "test");
    let live = 0;
    let peak = 0;

    await Promise.all(
      Array.from({ length: 12 }, async () => {
        const ticket = gate.take();
        await ticket.wait();
        live += 1;
        peak = Math.max(peak, live);
        await sleep(5);
        live -= 1;
        ticket.release();
      })
    );

    assert.strictEqual(peak, 3, `expected peak of 3, got ${peak}`);
    assert.deepStrictEqual(gate.stats, { running: 0, waiting: 0, limit: 3 });
  });

  it("serves one owner's jobs in the order they arrived", async () => {
    const gate = new ConcurrencyGate(1, "test");
    const log: string[] = [];
    const block = gate.take("solo");
    await block.wait();

    const pending = ["a", "b", "c"].map((id) => job(gate, id, log, "solo"));
    block.release();
    await Promise.all(pending);

    assert.deepStrictEqual(log, ["a", "b", "c"]);
  });

  it("does not let one owner's batch block everyone else", async () => {
    // The case this whole mechanism exists for: someone submits five jobs just
    // before five other people each submit one. Plain FIFO would make all five
    // of them wait out the batch.
    const gate = new ConcurrencyGate(1, "test");
    const log: string[] = [];
    const block = gate.take("blocker");
    await block.wait();

    const pending = [
      ...[1, 2, 3, 4, 5].map((n) => job(gate, `batch${n}`, log, "batcher")),
      ...["ann", "bob", "cid", "dee", "eve"].map((who) => job(gate, who, log, who)),
    ];
    block.release();
    await Promise.all(pending);

    const lastSingle = Math.max(...["ann", "bob", "cid", "dee", "eve"].map((w) => log.indexOf(w)));
    assert.ok(
      lastSingle < log.length - 1,
      `single-job users should not all be last; order was ${log.join(",")}`
    );
    assert.strictEqual(log[0], "batch1", "the batch still gets the first slot it queued for");
    assert.strictEqual(
      log.filter((e) => e.startsWith("batch")).length,
      5,
      "every batch job must still run — this shares the queue, it does not drop work"
    );
  });

  it("does not let an idle owner bank credit and jump the queue", async () => {
    // Without clamping to the current round, an owner who queued nothing for a
    // while would keep a low counter and leapfrog everyone on their return.
    const gate = new ConcurrencyGate(1, "test");
    const log: string[] = [];
    const block = gate.take("blocker");
    await block.wait();

    const early = [1, 2, 3].map((n) => job(gate, `early${n}`, log, "early"));
    block.release();
    await Promise.all(early);

    const block2 = gate.take("blocker");
    await block2.wait();
    const late = [
      job(gate, "newcomer", log, "newcomer"),
      job(gate, "early4", log, "early"),
    ];
    block2.release();
    await Promise.all(late);

    assert.strictEqual(
      log.indexOf("newcomer"),
      log.indexOf("early4") - 1,
      `newcomer should not be pushed behind a returning owner; order was ${log.join(",")}`
    );
  });

  it("reports a position that counts down to zero", async () => {
    const gate = new ConcurrencyGate(1, "test");
    const block = gate.take("blocker");
    await block.wait();

    const first = gate.take("x");
    const second = gate.take("y");
    const seen: number[] = [];
    second.onMove((p) => seen.push(p));

    assert.strictEqual(second.position(), 2);
    const running = [first.wait().then(() => first.release()), second.wait()];

    block.release();
    await Promise.all(running);

    assert.strictEqual(second.position(), 0, "a running job is at position 0");
    assert.ok(seen.includes(1), `expected to be told it moved to 1, saw ${seen.join(",")}`);
    second.release();
  });

  it("frees the slot when a queued job is aborted", async () => {
    const gate = new ConcurrencyGate(1, "test");
    const held = gate.take("a");
    await held.wait();

    const controller = new AbortController();
    const aborted = gate.take("b");
    const abortedResult = aborted.wait(controller.signal).then(
      () => "admitted",
      (err: Error) => err.message
    );

    const next = gate.take("c");
    const nextRan = next.wait();

    controller.abort();
    assert.strictEqual(await abortedResult, "Aborted while queued");

    held.release();
    await nextRan; // would hang if the abort had wedged the queue
    next.release();

    assert.deepStrictEqual(gate.stats, { running: 0, waiting: 0, limit: 1 });
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const gate = new ConcurrencyGate(1, "test");
    const ticket = gate.take("a");
    await assert.rejects(() => ticket.wait(AbortSignal.abort()), /Aborted while queued/);
    assert.deepStrictEqual(gate.stats, { running: 0, waiting: 0, limit: 1 });
  });

  it("ignores a double release rather than freeing an extra slot", async () => {
    const gate = new ConcurrencyGate(1, "test");
    const ticket = gate.take("a");
    await ticket.wait();
    ticket.release();
    ticket.release();

    assert.deepStrictEqual(gate.stats, { running: 0, waiting: 0, limit: 1 });
  });

  it("keeps the slot when a job throws", async () => {
    const gate = new ConcurrencyGate(1, "test");
    const log: string[] = [];

    const failing = (async () => {
      const ticket = gate.take("a");
      await ticket.wait();
      try {
        throw new Error("boom");
      } finally {
        ticket.release();
      }
    })();

    await assert.rejects(() => failing, /boom/);
    await job(gate, "after", log, "b");
    assert.deepStrictEqual(log, ["after"], "the queue keeps moving after a failure");
  });

  it("counts queued jobs per owner and nobody else's", async () => {
    const gate = new ConcurrencyGate(1, "test");
    const held = gate.take("x");
    await held.wait();

    const tickets = [1, 2, 3].map(() => {
      const t = gate.take("x");
      void t.wait().catch(() => {});
      return t;
    });

    assert.strictEqual(gate.queuedFor("x"), 3, "running jobs are not counted, only waiting ones");
    assert.strictEqual(gate.queuedFor("y"), 0);

    held.release();
    await sleep(20);
    tickets.forEach((t) => t.release());
  });

  it("treats jobs without an owner as separate users", async () => {
    const gate = new ConcurrencyGate(1, "test");
    const log: string[] = [];
    const block = gate.take();
    await block.wait();

    const pending = [
      job(gate, "anon1", log),
      job(gate, "anon2", log),
      job(gate, "named", log, "named"),
    ];
    block.release();
    await Promise.all(pending);

    assert.strictEqual(log.length, 3);
    assert.ok(log.includes("named"));
  });
});
