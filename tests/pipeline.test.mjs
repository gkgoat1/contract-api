import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runPipeline } from "@gkgo/contract-api";
import { MockContext } from "@gkgo/contract-api/testing";

const CALL = { to: "0x0000000000000000000000000000000000000001", data: "0x" };

describe("runPipeline", () => {
  it("runs stages in order, feeding prior results forward", async () => {
    const fund = new MockContext({ kind: "railgun", result: { txHashes: ["0xfund"], receipts: [] } });
    const deploy = new MockContext({ kind: "direct" });
    const seenBySecondStage = [];

    const events = [];
    const iterator = runPipeline([
      { name: "fund", context: fund, calls: async () => [CALL] },
      {
        name: "deploy",
        context: deploy,
        calls: async (prev) => {
          seenBySecondStage.push(...prev);
          return [CALL, CALL];
        },
      },
    ]);
    let step = await iterator.next();
    while (!step.done) {
      events.push(step.value);
      step = await iterator.next();
    }

    assert.equal(seenBySecondStage.length, 1);
    assert.equal(seenBySecondStage[0].stage, "fund");
    assert.deepEqual(seenBySecondStage[0].result.txHashes, ["0xfund"]);
    assert.equal(fund.executed.length, 1);
    assert.deepEqual(deploy.executed, [[CALL, CALL]]);
    assert.deepEqual(
      events.map((e) => e.type),
      [
        "stage-started",
        "stage-event",
        "stage-event",
        "stage-event",
        "stage-finished",
        "stage-started",
        "stage-event",
        "stage-event",
        "stage-event",
        "stage-finished",
      ],
    );
    assert.equal(step.value.stages.length, 2);
  });

  it("aborts the pipeline when a stage fails", async () => {
    const failing = new MockContext({
      kind: "failing",
      events: [{ phase: "prepared" }, { phase: "failed", error: new Error("boom") }],
    });
    const never = new MockContext({ kind: "never" });
    await assert.rejects(async () => {
      for await (const _event of runPipeline([
        { name: "bad", context: failing, calls: async () => [CALL] },
        { name: "never", context: never, calls: async () => [CALL] },
      ])) {
        // drain
      }
    }, /boom/);
    assert.equal(never.executed.length, 0, "later stages must not run after a failure");
  });
});
