import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createDirectContext } from "@gkgo/contract-api";

const ACCOUNT = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const CHAIN = { id: 31337, name: "Anvil" };
const CALL = { to: "0x0000000000000000000000000000000000000001", data: "0x1234", value: 5n };

/** Minimal stub clients: just the methods DirectContext touches. */
function stubClients({ revert = false } = {}) {
  const sent = [];
  const walletClient = {
    sendTransaction: async (args) => {
      sent.push(args);
      return "0xhash" + sent.length;
    },
  };
  const publicClient = {
    estimateGas: async () => 21_000n,
    getGasPrice: async () => 2_000_000_000n, // 2 gwei
    waitForTransactionReceipt: async ({ hash }) => ({
      transactionHash: hash,
      status: revert ? "reverted" : "success",
    }),
  };
  return { walletClient, publicClient, sent };
}

describe("DirectContext", () => {
  it("sends each call and streams prepared/submitted/confirmed", async () => {
    const { walletClient, publicClient, sent } = stubClients();
    const context = createDirectContext({ walletClient, publicClient, account: ACCOUNT, chain: CHAIN });
    assert.equal(context.kind, "direct");
    assert.equal(context.chainId, 31337);

    const events = [];
    const iterator = context.execute([CALL]);
    let step = await iterator.next();
    while (!step.done) {
      events.push(step.value);
      step = await iterator.next();
    }
    assert.deepEqual(
      events.map((e) => e.phase),
      ["prepared", "submitted", "confirmed"],
    );
    assert.deepEqual(step.value.txHashes, ["0xhash1"]);
    assert.equal(step.value.receipts.length, 1);
    assert.deepEqual(sent, [
      { account: ACCOUNT, chain: CHAIN, to: CALL.to, data: CALL.data, value: CALL.value },
    ]);
  });

  it("reports full support with no blockers", async () => {
    const { walletClient } = stubClients();
    const context = createDirectContext({ walletClient, account: ACCOUNT, chain: CHAIN });
    const report = await context.supports([CALL]);
    assert.deepEqual(report, { supported: true, blockers: [] });
  });

  it("quotes summed gas and native cost", async () => {
    const { walletClient, publicClient } = stubClients();
    const context = createDirectContext({ walletClient, publicClient, account: ACCOUNT, chain: CHAIN });
    const quote = await context.quote([CALL, CALL]);
    assert.equal(quote.gas, 42_000n);
    assert.equal(quote.nativeCost, 42_000n * 2_000_000_000n);
    assert.equal(quote.contextFees.length, 0);
    assert.match(quote.notes[0], /Public execution/);
  });

  it("yields failed and rethrows when a receipt reverts", async () => {
    const { walletClient, publicClient } = stubClients({ revert: true });
    const context = createDirectContext({ walletClient, publicClient, account: ACCOUNT, chain: CHAIN });
    const events = [];
    await assert.rejects(async () => {
      for await (const event of context.execute([CALL])) {
        events.push(event);
      }
    }, /reverted/);
    assert.deepEqual(
      events.map((e) => e.phase),
      ["prepared", "submitted", "failed"],
    );
  });
});
