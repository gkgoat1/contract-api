import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createDirectContext } from "@gkgo/contract-api";

const ACCOUNT = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const CHAIN = { id: 31337, name: "Anvil" };
const CALL = { to: "0x0000000000000000000000000000000000000001", data: "0x1234", value: 5n };

/** Minimal stubs: the narrow WriteSigner/ReadProvider shapes (ethers-era). */
function stubClients({ revert = false } = {}) {
  const sent = [];
  const signer = {
    getAddress: async () => ACCOUNT,
    sendTransaction: async (args) => {
      sent.push(args);
      return { hash: "0xhash" + sent.length };
    },
  };
  const provider = {
    estimateGas: async () => 21_000n,
    getFeeData: async () => ({ gasPrice: 2_000_000_000n }), // 2 gwei
    waitForTransaction: async (hash) => ({
      transactionHash: hash,
      status: revert ? 0 : 1,
      blockNumber: 1,
    }),
  };
  return { signer, provider, sent };
}

describe("DirectContext", () => {
  it("sends each call and streams prepared/submitted/confirmed", async () => {
    const { signer, provider, sent } = stubClients();
    const context = createDirectContext({ signer, provider, chainId: CHAIN.id });
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
      { to: CALL.to, data: CALL.data, value: CALL.value },
    ]);
  });

  it("reports full support with no blockers", async () => {
    const { signer } = stubClients();
    const context = createDirectContext({ signer, chainId: CHAIN.id });
    const report = await context.supports([CALL]);
    assert.deepEqual(report, { supported: true, blockers: [] });
  });

  it("quotes summed gas and native cost", async () => {
    const { signer, provider } = stubClients();
    const context = createDirectContext({ signer, provider, chainId: CHAIN.id });
    const quote = await context.quote([CALL, CALL]);
    assert.equal(quote.gas, 42_000n);
    assert.equal(quote.nativeCost, 42_000n * 2_000_000_000n);
    assert.equal(quote.contextFees.length, 0);
    assert.match(quote.notes[0], /Public execution/);
  });

  it("yields failed and rethrows when a receipt reverts", async () => {
    const { signer, provider } = stubClients({ revert: true });
    const context = createDirectContext({ signer, provider, chainId: CHAIN.id });
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
