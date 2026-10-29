import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData, keccak256, toHex } from "viem";
import { verifyContractSignature, signAndVerify } from "../dist/core/signers.js";
import { multicall3 } from "../dist/core/dispatch/multicall3.js";
import {
  SmartWalletDirectContext,
  SmartWalletMulticall3Context,
  walletDelegateMulticall3,
  walletExecuteBatch,
  ERC7821_BATCH_MODE,
} from "../dist/core/smart-wallet.js";
import { MULTICALL3_ADDRESS } from "../dist/core/multicall.js";

const WALLET = "0x1111111111111111111111111111111111111111";
const TARGET = "0x2222222222222222222222222222222222222222";
const DIGEST = keccak256(toHex("hello"));
const SIG = "0xdeadbeef";

/** A publicClient stub whose readContract answers ERC-1271 per a flag. */
function fakePublicClient(valid, receipts = true) {
  const calls = [];
  return {
    calls,
    async readContract(args) {
      calls.push(args);
      if (!valid) throw new Error("revert");
      return "0x1626ba7e";
    },
    async getGasPrice() {
      return 1_000_000_000n;
    },
    async waitForTransactionReceipt({ hash }) {
      return { status: "success", transactionHash: hash };
    },
  };
}

const CALLS = [
  { to: TARGET, data: "0xaaaaaaaa" },
  { to: TARGET, data: "0xbbbbbbbb" },
];

function fakeExecutor(log) {
  return {
    async digestFor(wc) {
      return keccak256(wc.data);
    },
    async estimate() {
      return 21000n;
    },
    async submit(wc, signature) {
      log.push({ wc, signature });
      return "0x" + "ab".repeat(32);
    },
  };
}

function fakeSigner(sig = SIG) {
  return { address: WALLET, async sign() { return sig; } };
}

test("verifyContractSignature preflight: magic accepted, revert rejected", async () => {
  assert.equal(await verifyContractSignature(fakePublicClient(true), WALLET, DIGEST, SIG), true);
  assert.equal(await verifyContractSignature(fakePublicClient(false), WALLET, DIGEST, SIG), false);
});

test("signAndVerify throws before reliance when the contract rejects", async () => {
  await assert.rejects(signAndVerify(fakeSigner(), DIGEST, fakePublicClient(false)), /checked ahead-of-time/);
  assert.equal(await signAndVerify(fakeSigner(), DIGEST, fakePublicClient(true)), SIG);
});

test("multicall3 dispatch encodes aggregate3 identically to a hand-built viem call", async () => {
  const { encodeFunctionData: viemEncode } = await import("viem");
  const abi = [
    {
      type: "function",
      name: "aggregate3",
      stateMutability: "payable",
      inputs: [
        {
          name: "calls",
          type: "tuple[]",
          components: [
            { name: "target", type: "address" },
            { name: "allowFailure", type: "bool" },
            { name: "callData", type: "bytes" },
          ],
        },
      ],
      outputs: [],
    },
  ];
  const calls = [{ target: TARGET, allowFailure: false, callData: "0xaaaaaaaa" }];
  assert.equal(multicall3.aggregate3(calls).data, viemEncode({ abi, functionName: "aggregate3", args: [calls] }));
  assert.equal(multicall3.aggregate3(calls).to, MULTICALL3_ADDRESS);
});

test("smart-wallet direct: one authorized wallet execution per call, 1271-preflighted", async () => {
  const submitted = [];
  const pc = fakePublicClient(true);
  const ctx = new SmartWalletDirectContext({
    wallet: WALLET,
    signer: fakeSigner(),
    executor: fakeExecutor(submitted),
    publicClient: pc,
    chainId: 31337,
  });
  const gen = ctx.execute(CALLS);
  let r = await gen.next();
  while (!r.done) r = await gen.next();
  assert.equal(submitted.length, 2, "one submission per call");
  assert.equal(pc.calls.length, 2, "each execution preflighted via isValidSignature");
  assert.equal(pc.calls[0].address, WALLET);
  assert.equal(submitted[0].signature, SIG);
});

test("smart-wallet multicall3 (delegate): one execution, delegate to canonical Multicall3", async () => {
  const submitted = [];
  const pc = fakePublicClient(true);
  const ctx = new SmartWalletMulticall3Context(
    { wallet: WALLET, signer: fakeSigner(), executor: fakeExecutor(submitted), publicClient: pc, chainId: 31337 },
    "delegate",
  );
  const gen = ctx.execute(CALLS);
  let r = await gen.next();
  while (!r.done) r = await gen.next();
  assert.equal(submitted.length, 1, "the whole batch in one execution");
  const wc = submitted[0].wc;
  assert.equal(wc.to, WALLET);
  // delegate(MULTICALL3, aggregate3(calls)) — the delegate selector + inner call
  const expected = walletDelegateMulticall3(WALLET, CALLS);
  assert.equal(wc.data, expected.data);
  assert.ok(wc.data.slice(2, 10) !== "", "has calldata");
  assert.ok(wc.data.includes(MULTICALL3_ADDRESS.slice(2).toLowerCase()), "delegates to Multicall3");
});

test("smart-wallet multicall3 (erc7821): batch mode + Execution[] encoding", async () => {
  const wc = walletExecuteBatch(WALLET, CALLS);
  assert.equal(wc.to, WALLET);
  assert.ok(wc.data.includes(ERC7821_BATCH_MODE.slice(2)), "batch mode embedded");
});

test("invalid signature: nothing is submitted", async () => {
  const submitted = [];
  const ctx = new SmartWalletMulticall3Context({
    wallet: WALLET,
    signer: fakeSigner(),
    executor: fakeExecutor(submitted),
    publicClient: fakePublicClient(false),
    chainId: 31337,
  });
  const gen = ctx.execute(CALLS);
  await assert.rejects(async () => {
    let r = await gen.next();
    while (!r.done) r = await gen.next();
  }, /checked ahead-of-time/);
  assert.equal(submitted.length, 0);
});
