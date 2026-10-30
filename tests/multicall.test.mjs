import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createMulticallContext,
  multicallContextFactory,
  MULTICALL3_ADDRESS,
  registerContext,
  resetContexts,
  resolveContext,
} from "@gkgo/contract-api";
import { Interface } from "ethers";

const ACCOUNT = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const CHAIN = { id: 31337, name: "Anvil" };
const CALL_A = { to: "0x1111111111111111111111111111111111111111", data: "0xaa" };
const CALL_B = { to: "0x2222222222222222222222222222222222222222", data: "0xbbcc" };

function stubClients() {
  const sent = [];
  return {
    sent,
    signer: {
      getAddress: async () => ACCOUNT,
      sendTransaction: async (args) => {
        sent.push(args);
        return { hash: "0xbatchhash" };
      },
    },
    provider: {
      estimateGas: async () => 120_000n,
      getFeeData: async () => ({ gasPrice: 1_000_000_000n }),
      waitForTransaction: async (hash) => ({ transactionHash: hash, status: 1, blockNumber: 1 }),
    },
  };
}

describe("MulticallContext", () => {
  it("batches all calls into one aggregate3 transaction to Multicall3", async () => {
    const { signer, provider, sent } = stubClients();
    const context = createMulticallContext({ signer, provider, chainId: CHAIN.id });

    const events = [];
    const iterator = context.execute([CALL_A, CALL_B]);
    let step = await iterator.next();
    while (!step.done) {
      events.push(step.value);
      step = await iterator.next();
    }

    assert.deepEqual(events.map((e) => e.phase), ["prepared", "submitted", "confirmed"]);
    assert.equal(sent.length, 1, "one transaction for the whole batch");
    assert.equal(sent[0].to, MULTICALL3_ADDRESS);
    const decoded = new Interface([
      "function aggregate3((address target, bool allowFailure, bytes callData)[] calls)",
    ]).parseTransaction({ data: sent[0].data });
    assert.deepEqual(
      decoded.args[0].map((c) => [c.target, c.allowFailure, c.callData]),
      [[CALL_A.to, false, CALL_A.data], [CALL_B.to, false, CALL_B.data]],
    );
    assert.deepEqual(step.value.txHashes, ["0xbatchhash"]);
  });

  it("blocks value-carrying calls", async () => {
    const { signer } = stubClients();
    const context = createMulticallContext({ signer, chainId: CHAIN.id });
    const report = await context.supports([{ ...CALL_A, value: 1n }]);
    assert.equal(report.supported, false);
    assert.match(report.blockers[0].reason, /native value/);
  });

  it("quotes a single batched transaction", async () => {
    const { signer, provider } = stubClients();
    const context = createMulticallContext({ signer, provider, chainId: CHAIN.id });
    const quote = await context.quote([CALL_A, CALL_B]);
    assert.equal(quote.gas, 120_000n);
    assert.equal(quote.nativeCost, 120_000n * 1_000_000_000n);
    assert.ok(quote.notes.some((n) => n.includes("Atomic batch")));
  });

  it("registers and resolves through the public registry like any context", async () => {
    resetContexts();
    registerContext(multicallContextFactory);
    const context = await resolveContext("multicall", 10, {
      signer: stubClients().signer,
      chainId: 10,
    });
    assert.equal(context.kind, "multicall");
    assert.equal(context.chainId, 10);
    resetContexts();
  });
});
