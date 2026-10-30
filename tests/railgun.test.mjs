import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createRailgunContext,
  railgunContextFactory,
  RAILGUN_CHAIN_IDS,
  networkNameForChain,
  unshieldFeeBpsForChain,
} from "@gkgo/contract-api/railgun";

const TOKEN_A = "0x1111111111111111111111111111111111111111";
const TOKEN_B = "0x2222222222222222222222222222222222222222";
const RAILGUN_ADDRESS = "0zk1qtest";

const baseCall = {
  to: "0x3333333333333333333333333333333333333333",
  data: "0xabcdef",
  tokens: {
    spends: [{ token: TOKEN_A, amount: 100n }],
    receives: [{ token: TOKEN_B }],
  },
};

function mockSdk({ gasEstimate = 500_000n } = {}) {
  const calls = { estimates: [], proofs: [], populates: [] };
  return {
    calls,
    estimateCrossContractCalls: async (input) => {
      calls.estimates.push(input);
      return gasEstimate;
    },
    proveCrossContractCalls: async (input, onProgress) => {
      calls.proofs.push(input);
      onProgress(0.5);
      onProgress(1);
    },
    populateCrossContractCalls: async (input) => {
      calls.populates.push(input);
      return { to: "0x9999999999999999999999999999999999999999", data: "0xfeed", value: 0n };
    },
  };
}

function makeDeps(overrides = {}) {
  return {
    chainId: 8453,
    railgunAddress: RAILGUN_ADDRESS,
    sdk: mockSdk(),
    publicClient: {
      waitForTransaction: async (hash) => ({ hash, status: 1, blockNumber: 1 }),
    },
    unshieldFeeBps: 25n,
    selfSubmit: async () => "0xselfsigned",
    ...overrides,
  };
}

describe("network mapping", () => {
  it("covers mainnet, arbitrum, base, hardhat — not optimism", () => {
    assert.deepEqual([...RAILGUN_CHAIN_IDS].sort((a, b) => a - b), [1, 56, 137, 8453, 31337, 42161]);
    assert.equal(networkNameForChain(1), "Ethereum");
    assert.equal(networkNameForChain(8453), "Base");
    assert.equal(networkNameForChain(42161), "Arbitrum");
    assert.equal(networkNameForChain(10), undefined);
  });

  it("defaults the unshield fee to 25bps", () => {
    assert.equal(unshieldFeeBpsForChain(1), 25n);
  });
});

describe("RailgunContext", () => {
  it("rejects unsupported chains and missing submission paths", () => {
    const deps = makeDeps();
    assert.throws(() => createRailgunContext({ ...deps, chainId: 10 }), /not available on chain 10/);
    const noSubmit = { ...deps };
    delete noSubmit.selfSubmit;
    delete noSubmit.broadcaster;
    assert.throws(() => createRailgunContext(noSubmit), /broadcaster client or a selfSubmit/);
  });

  it("blocks calls with undeclared token flows or native value", async () => {
    const context = createRailgunContext(makeDeps());
    const undeclared = { to: baseCall.to, data: baseCall.data };
    const native = { ...baseCall, value: 1n };
    const report = await context.supports([undeclared, native, baseCall]);
    assert.equal(report.supported, false);
    assert.equal(report.blockers.length, 2, "one per offending call");
    assert.match(report.blockers[0].reason, /undeclared/);
    assert.match(report.blockers[1].reason, /[Nn]ative value/);
    assert.equal((await context.supports([baseCall])).supported, true);
  });

  it("pads unshield amounts for the 0.25% fee and re-shields declared outputs", async () => {
    const sdk = mockSdk();
    const context = createRailgunContext(makeDeps({ sdk }));
    await context.quote([baseCall, { ...baseCall, tokens: { spends: [{ token: TOKEN_A, amount: 50n }], receives: [] } }]);
    const input = sdk.calls.estimates[0];
    // 150n needed post-fee → ceil(150 × 10000 / 9975) = 151n unshielded.
    assert.deepEqual(input.unshieldAmounts, [{ tokenAddress: TOKEN_A, amount: 151n }]);
    assert.deepEqual(input.shieldRecipients, [{ tokenAddress: TOKEN_B, recipientAddress: RAILGUN_ADDRESS }]);
    assert.equal(input.sendWithPublicWallet, true, "no broadcaster configured → self-sign");
  });

  it("quotes context fees: unshield fee per token plus broadcaster fee", async () => {
    const broadcaster = {
      client: { submit: async () => "0xbroadcast" },
      fee: { tokenAddress: TOKEN_A, amount: 7n, recipientAddress: "0x4444444444444444444444444444444444444444" },
    };
    const context = createRailgunContext(makeDeps({ broadcaster }));
    const quote = await context.quote([baseCall]);
    const unshieldFee = quote.contextFees.find((f) => f.label === "RAILGUN unshield fee");
    // Unshield 101n for a 100n spend; fee ≈ 101 − 101×9975/10000 = 1n (integer math).
    assert.ok(unshieldFee.amount >= 0n && unshieldFee.amount <= 1n);
    const broadcasterFee = quote.contextFees.find((f) => f.label === "Broadcaster fee");
    assert.equal(broadcasterFee.amount, 7n);
    assert.equal(quote.gas, 500_000n);
    assert.ok(quote.notes.some((n) => n.includes("Relay Adapt")));
    assert.ok(!quote.notes.some((n) => n.includes("Self-signed")), "broadcaster path: no self-sign note");
  });

  it("executes via broadcaster: prepared → proving → broadcasting → submitted → confirmed", async () => {
    const submitted = [];
    const broadcaster = {
      client: { submit: async (tx) => { submitted.push(tx); return "0xbroadcast"; } },
      fee: { tokenAddress: TOKEN_A, amount: 7n, recipientAddress: "0x4444444444444444444444444444444444444444" },
    };
    const sdk = mockSdk();
    const context = createRailgunContext(makeDeps({ sdk, broadcaster }));
    const progress = [];
    const events = [];
    const iterator = context.execute([baseCall], { onProgress: (p) => progress.push(p) });
    let step = await iterator.next();
    while (!step.done) {
      events.push(step.value);
      step = await iterator.next();
    }
    assert.deepEqual(
      events.map((e) => e.phase),
      ["prepared", "proving", "proving", "broadcasting", "submitted", "confirmed"],
    );
    assert.deepEqual(progress, [0.5, 1], "proof progress ticks forwarded to onProgress");
    assert.equal(submitted.length, 1);
    assert.deepEqual(step.value.txHashes, ["0xbroadcast"]);
    assert.equal(sdk.calls.proofs[0].broadcasterFee.amount, 7n, "broadcaster fee flows into the proof");
  });

  it("self-signs when no broadcaster is configured, with a privacy note", async () => {
    const context = createRailgunContext(makeDeps());
    const quote = await context.quote([baseCall]);
    assert.ok(quote.notes.some((n) => n.includes("Self-signed")));
    const events = [];
    for await (const event of context.execute([baseCall])) events.push(event);
    assert.deepEqual(
      events.map((e) => e.phase),
      ["prepared", "proving", "proving", "submitted", "confirmed"],
      "no broadcasting phase when self-signing",
    );
  });

  it("fails closed: execute() on unsupported calls yields failed and throws", async () => {
    const context = createRailgunContext(makeDeps());
    const events = [];
    await assert.rejects(async () => {
      for await (const event of context.execute([{ to: baseCall.to, data: baseCall.data }])) {
        events.push(event);
      }
    }, /Unsupported for RAILGUN/);
    assert.deepEqual(events.map((e) => e.phase), ["failed"]);
  });

  it("registers with per-chain availability", async () => {
    assert.deepEqual(railgunContextFactory.kind, "railgun");
    assert.deepEqual([...railgunContextFactory.chains].sort((a, b) => a - b), [1, 56, 137, 8453, 31337, 42161]);
  });
});
