import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRailgunContext, runPrivateDeploy } from "@gkgo/contract-api/railgun";

const EPHEMERAL = "0x9999999999999999999999999999999999999999";
const DEPLOY_CALL = { to: "0x5555555555555555555555555555555555555555", data: "0xdead" };
const CHAIN = { id: 8453, name: "Base" };

function mockFunding({ nativeGas = 200_000n } = {}) {
  const sent = [];
  return {
    sent,
    context: createRailgunContext({
      chainId: 8453,
      railgunAddress: "0zk1qtest",
      sdk: {
        estimateNativeUnshield: async () => nativeGas,
        proveNativeUnshield: async (_input, onProgress) => onProgress(1),
        populateNativeUnshield: async (input) => ({
          to: "0x7777777777777777777777777777777777777777",
          data: "0xbeef",
          value: 0n,
          _input: input,
        }),
        populateNativeShield: async (amount, from) => ({
          to: "0x8888888888888888888888888888888888888888",
          data: "0xshield",
          value: amount,
          _from: from,
        }),
      },
      publicClient: {
        waitForTransactionReceipt: async ({ hash }) => ({ transactionHash: hash, status: "success" }),
      },
      unshieldFeeBps: 25n,
      selfSubmit: async (tx) => {
        sent.push(tx);
        return "0xfundtx";
      },
    }),
  };
}

function mockEphemeral(balanceAfterDeploy = 5_000_000_000_000_000n) {
  const sent = [];
  return {
    sent,
    walletClient: {
      sendTransaction: async (args) => {
        sent.push(args);
        return `0xdeploy${sent.length}`;
      },
    },
    publicClient: {
      estimateGas: async () => 100_000n,
      getGasPrice: async () => 1_000_000_000n,
      getBalance: async () => balanceAfterDeploy,
      waitForTransactionReceipt: async ({ hash }) => ({ transactionHash: hash, status: "success" }),
    },
  };
}

async function drain(gen) {
  const events = [];
  let step = await gen.next();
  while (!step.done) {
    events.push(step.value);
    step = await gen.next();
  }
  return { events, result: step.value };
}

describe("runPrivateDeploy", () => {
  it("funds, deploys, and sweeps — three stages in order", async () => {
    const funding = mockFunding();
    const ephemeral = mockEphemeral();
    const deployCalls = [];
    const { events, result } = await drain(runPrivateDeploy({
      funding: funding.context,
      publicClient: ephemeral.publicClient,
      ephemeralWalletClient: ephemeral.walletClient,
      ephemeralAccount: EPHEMERAL,
      chain: CHAIN,
      fundAmount: 10n ** 16n,
      buildDeployCalls: async (deployer) => {
        deployCalls.push(deployer);
        return [DEPLOY_CALL];
      },
    }));

    assert.deepEqual(
      events.filter((e) => e.type === "stage-started").map((e) => e.stage),
      ["fund", "deploy", "sweep"],
    );
    assert.deepEqual(deployCalls, [EPHEMERAL], "deploy calls built for the ephemeral deployer");
    assert.equal(funding.sent.length, 1, "funding unshield submitted");
    // deploy + sweep both send from the ephemeral wallet.
    assert.equal(ephemeral.sent.length, 2);
    assert.equal(ephemeral.sent[0].to, DEPLOY_CALL.to);
    assert.equal(ephemeral.sent[1].value, 5_000_000_000_000_000n - 1_000_000_000_000_000n, "sweep keeps the default reserve");
    assert.equal(result.stages.length, 3);
  });

  it("skips the sweep when disabled or when the balance is dust", async () => {
    const funding = mockFunding();
    const ephemeral = mockEphemeral(500_000_000_000_000n); // below the 0.001 reserve
    const { events, result } = await drain(runPrivateDeploy({
      funding: funding.context,
      publicClient: ephemeral.publicClient,
      ephemeralWalletClient: ephemeral.walletClient,
      ephemeralAccount: EPHEMERAL,
      chain: CHAIN,
      fundAmount: 10n ** 16n,
      buildDeployCalls: async () => [DEPLOY_CALL],
    }));
    assert.equal(ephemeral.sent.length, 1, "no sweep tx sent");
    assert.equal(result.stages.length, 2);
    assert.deepEqual(
      events.filter((e) => e.type === "stage-started").map((e) => e.stage),
      ["fund", "deploy"],
    );
  });

  it("aborts before deploying when funding fails", async () => {
    const funding = mockFunding();
    funding.context.deps.sdk.proveNativeUnshield = async () => {
      throw new Error("proof failed");
    };
    const ephemeral = mockEphemeral();
    await assert.rejects(() => drain(runPrivateDeploy({
      funding: funding.context,
      publicClient: ephemeral.publicClient,
      ephemeralWalletClient: ephemeral.walletClient,
      ephemeralAccount: EPHEMERAL,
      chain: CHAIN,
      fundAmount: 10n ** 16n,
      buildDeployCalls: async () => [DEPLOY_CALL],
    })), /proof failed/);
    assert.equal(ephemeral.sent.length, 0, "no deployment after a funding failure");
  });
});

describe("broadcaster-submitted funding (T-1.5)", () => {
  function broadcasterFunding({ withBroadcaster = true } = {}) {
    const calls = { selfSubmit: 0, broadcasterSubmit: 0 };
    const broadcasterSelection = withBroadcaster
      ? {
          client: {
            submit: async (tx) => {
              calls.broadcasterSubmit += 1;
              return "0xbroadcasttx";
            },
          },
          fee: { tokenAddress: "0x4200000000000000000000000000000000000006", amount: 1_000_000_000_000n, recipientAddress: "0zk1qbroadcaster" },
          feeTokenDetails: { tokenAddress: "0x4200000000000000000000000000000000000006", feePerUnitGas: 1_000_000_000n },
        }
      : undefined;
    const context = createRailgunContext({
      chainId: 8453,
      railgunAddress: "0zk1qtest",
      sdk: {
        estimateNativeUnshield: async () => 300_000n,
        proveNativeUnshield: async () => {},
        populateNativeUnshield: async (input) => ({
          to: "0x7777777777777777777777777777777777777777",
          data: "0xbeef",
          value: 0n,
          nullifiers: ["0x01"],
          _input: input,
        }),
        populateNativeShield: async (amount, from) => ({
          to: "0x8888888888888888888888888888888888888888",
          data: "0xshield",
          value: amount,
          _from: from,
        }),
      },
      publicClient: {
        waitForTransactionReceipt: async ({ hash }) => ({ transactionHash: hash, status: "success" }),
      },
      unshieldFeeBps: 25n,
      broadcaster: broadcasterSelection,
      selfSubmit: async (tx) => {
        calls.selfSubmit += 1;
        return "0xfundtx";
      },
    });
    return { calls, context };
  }

  /** Drains the fund() generator to completion and returns its result. */
  async function runFund(context, to = EPHEMERAL, amount = 100n) {
    const gen = context.fund(to, amount);
    let step = await gen.next();
    while (!step.done) step = await gen.next();
    return step.value;
  }

  it("funding submits through the broadcaster; the wallet never signs", async () => {
    const { calls, context } = broadcasterFunding();
    const result = await runFund(context);
    assert.equal(calls.selfSubmit, 0, "selfSubmit must not run when a broadcaster is configured");
    assert.equal(calls.broadcasterSubmit, 1);
    assert.equal(result.txHashes[0], "0xbroadcasttx");
  });

  it("the funding transaction is built with public-wallet-free terms (broadcaster fee, no public wallet)", async () => {
    let capturedInput;
    const { context } = broadcasterFunding();
    // Recreate the mock with capture on populate:
    const context2 = createRailgunContext({
      chainId: 8453,
      railgunAddress: "0zk1qtest",
      sdk: {
        estimateNativeUnshield: async () => 300_000n,
        proveNativeUnshield: async () => {},
        populateNativeUnshield: async (input) => {
          capturedInput = input;
          return { to: "0x7777777777777777777777777777777777777777", data: "0xbeef", value: 0n, nullifiers: ["0x01"] };
        },
        populateNativeShield: async (amount, from) => ({ to: "0x8888888888888888888888888888888888888888", data: "0xshield", value: amount }),
      },
      publicClient: { waitForTransactionReceipt: async ({ hash }) => ({ transactionHash: hash, status: "success" }) },
      unshieldFeeBps: 25n,
      broadcaster: {
        client: { submit: async () => "0xbroadcasttx" },
        fee: { tokenAddress: "0x4200000000000000000000000000000000000006", amount: 1_000_000_000_000n, recipientAddress: "0zk1qbroadcaster" },
        feeTokenDetails: { tokenAddress: "0x4200000000000000000000000000000000000006", feePerUnitGas: 1_000_000_000n },
      },
      selfSubmit: async () => "0xfundtx",
    });
    await runFund(context2);
    assert.equal(capturedInput.sendWithPublicWallet, false);
    assert.equal(capturedInput.broadcasterFee?.amount, 1_000_000_000_000n);
    assert.equal(capturedInput.broadcasterFee?.recipientAddress, "0zk1qbroadcaster");
  });

  it("without a broadcaster configured, funding falls back to selfSubmit (visible link)", async () => {
    const { calls, context } = broadcasterFunding({ withBroadcaster: false });
    await runFund(context);
    assert.equal(calls.broadcasterSubmit, 0);
    assert.equal(calls.selfSubmit, 1, "self-signed fallback is the explicit fallback path");
  });
});
