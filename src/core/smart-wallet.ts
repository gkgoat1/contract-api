/**
 * Smart contract wallet contexts: calls execute FROM a contract wallet,
 * authorized by an arbitrary signer (signers.ts) whose signature is checked
 * ahead-of-time against the wallet's ERC-1271 isValidSignature.
 *
 * Two modes:
 * - `SmartWalletDirectContext` — one wallet execution per call.
 * - `SmartWalletMulticall3Context` — the whole batch in one wallet execution
 *   through Multicall3. Our wallets DELEGATE to Multicall3 (the dispatch is
 *   marked delegateSafe): wallet.delegate(multicall3.ADDRESS, aggregate3 data)
 *   so calls execute with msg.sender = the wallet while reusing the canonical
 *   audited batcher. Wallets with their own batch surface (ERC-7821) use
 *   `walletCall` instead.
 *
 * Submission is host-pluggable (4337 userOp, relayer, an authorized executor
 * EOA, …): the context shapes the wallet call, gets the digest signed, and
 * preflights the signature against the wallet before submitting.
 */
import { AbiCoder, Interface } from "ethers";
import type { Address, Hex, ReadProvider } from "./types.js";
import type {
  ContractCall,
  ExecuteOpts,
  ExecutionEvent,
  ExecutionQuote,
  ExecutionResult,
  InteractionContext,
  SupportReport,
} from "./types.js";
import { signAndVerify, type ArbitrarySigner } from "./signers.js";
import { multicall3 } from "./dispatch/multicall3.js";

/** How the host gets an authorized wallet execution on-chain. */
export interface WalletExecutor {
  /** The digest the signer must sign to authorize this wallet execution. */
  digestFor(walletCall: { to: Address; data: Hex }): Promise<Hex>;
  /** Estimate gas for the authorized execution (signature may be a dummy). */
  estimate(walletCall: { to: Address; data: Hex }, signature: Hex): Promise<bigint>;
  /** Submit the authorized execution; resolves to the on-chain tx hash. */
  submit(walletCall: { to: Address; data: Hex }, signature: Hex): Promise<Hex>;
}

export interface SmartWalletDeps {
  /** The contract wallet (must implement ERC-1271). */
  wallet: Address;
  /** Arbitrary signer whose signatures the wallet accepts. */
  signer: ArbitrarySigner;
  executor: WalletExecutor;
  publicClient: ReadProvider;
  chainId: number;
}

/** ERC-7821 default batch mode (callType=batch 0x01, execType=default 0x00). */
export const ERC7821_BATCH_MODE: Hex =
  "0x0100000000000000000000000000000000000000000000000000000000000000";

const ERC7821_EXECUTE = new Interface([
  "function execute(bytes32 mode, bytes executionData)",
]);
const WALLET_DELEGATE = new Interface([
  "function delegate(address target, bytes data) returns (bytes result)",
]);
const EXECUTION_TUPLE = "tuple(address target, uint256 value, bytes callData)[]";

/** ERC-7821 batch executionData = abi.encode(Execution[]). */
export function encodeBatch7821(calls: ContractCall[]): Hex {
  return AbiCoder.defaultAbiCoder().encode(
    [EXECUTION_TUPLE],
    [calls.map((c) => ({ target: c.to, value: c.value ?? 0n, callData: c.data }))],
  ) as Hex;
}

/** The wallet call executing the batch via the wallet's own ERC-7821 loop. */
export function walletExecuteBatch(wallet: Address, calls: ContractCall[]): { to: Address; data: Hex } {
  return {
    to: wallet,
    data: ERC7821_EXECUTE.encodeFunctionData("execute", [ERC7821_BATCH_MODE, encodeBatch7821(calls)]) as Hex,
  };
}

/** The wallet call executing the batch by DELEGATING to Multicall3 (our
 *  wallets' pattern; msg.sender inside the batch is the wallet). */
export function walletDelegateMulticall3(wallet: Address, calls: ContractCall[]): { to: Address; data: Hex } {
  const agg = multicall3.aggregate3(calls.map((c) => ({ target: c.to, allowFailure: false, callData: c.data })));
  return {
    to: wallet,
    data: WALLET_DELEGATE.encodeFunctionData("delegate", [agg.to, agg.data]) as Hex,
  };
}

abstract class SmartWalletBase implements InteractionContext {
  abstract readonly kind: string;
  protected readonly deps: SmartWalletDeps;
  readonly chainId: number;

  constructor(deps: SmartWalletDeps) {
    this.deps = deps;
    this.chainId = deps.chainId;
  }

  async supports(calls: ContractCall[]): Promise<SupportReport> {
    const blockers: { call?: number; reason: string }[] = [];
    calls.forEach((call, i) => {
      if (call.value !== undefined && call.value !== 0n) {
        blockers.push({ call: i, reason: "batched wallet execution cannot forward per-call native value." });
      }
    });
    return { supported: blockers.length === 0, blockers };
  }

  protected abstract batches(calls: ContractCall[]): { to: Address; data: Hex }[];

  async quote(calls: ContractCall[]): Promise<ExecutionQuote> {
    let gas = 0n;
    for (const wc of this.batches(calls)) {
      const digest = await this.deps.executor.digestFor(wc);
      const dummySig = await this.deps.signer.sign(digest); // real sig for a faithful estimate
      gas += await this.deps.executor.estimate(wc, dummySig);
    }
    const gasPrice = (await this.deps.publicClient.getFeeData()).gasPrice ?? 0n;
    return {
      gas,
      nativeCost: gas * gasPrice,
      contextFees: [],
      notes: [
        `Calls execute from the contract wallet ${this.deps.wallet} (msg.sender = the wallet).`,
        "Authorization is an arbitrary signer checked ahead-of-time against the wallet's ERC-1271.",
      ],
    };
  }

  async *execute(calls: ContractCall[], opts?: ExecuteOpts): AsyncGenerator<ExecutionEvent, ExecutionResult> {
    const txHashes: Hex[] = [];
    const receipts: ExecutionResult["receipts"] = [];
    for (const wc of this.batches(calls)) {
      const digest = await this.deps.executor.digestFor(wc);
      // Arbitrary signer, checked ahead-of-time against the wallet contract.
      const signature = await signAndVerify(this.deps.signer, digest, this.deps.publicClient);
      const txHash = await this.deps.executor.submit(wc, signature);
      yield { phase: "submitted", txHash };
      const raw = await this.deps.publicClient.waitForTransaction(txHash);
      if (!raw || raw.status !== 1) throw new Error(`Transaction ${txHash} was reverted.`);
      txHashes.push(txHash);
      receipts.push({
        transactionHash: raw.transactionHash as Hex,
        status: "success",
        blockNumber: BigInt(raw.blockNumber),
      });
      yield { phase: "confirmed", txHash };
    }
    return { txHashes, receipts };
  }
}

/** Direct mode: one authorized wallet execution per call. */
export class SmartWalletDirectContext extends SmartWalletBase {
  readonly kind = "smart-wallet-direct";
  protected batches(calls: ContractCall[]): { to: Address; data: Hex }[] {
    return calls.map((c) => walletExecuteBatch(this.deps.wallet, [c]));
  }
}

/** Multicall3 mode: the whole batch in ONE authorized wallet execution.
 *  `via: "delegate"` (default — our wallets) delegates to Multicall3;
 *  `"erc7821"` uses the wallet's own batch loop. */
export class SmartWalletMulticall3Context extends SmartWalletBase {
  readonly kind = "smart-wallet-multicall3";
  private readonly via: "delegate" | "erc7821";

  constructor(deps: SmartWalletDeps, via: "delegate" | "erc7821" = "delegate") {
    super(deps);
    this.via = via;
  }

  protected batches(calls: ContractCall[]): { to: Address; data: Hex }[] {
    return [
      this.via === "delegate"
        ? walletDelegateMulticall3(this.deps.wallet, calls)
        : walletExecuteBatch(this.deps.wallet, calls),
    ];
  }
}
