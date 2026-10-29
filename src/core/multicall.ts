import {
  encodeFunctionData,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
  type WalletClient,
} from "viem";
import type {
  ContextFactory,
  ContractCall,
  ExecuteOpts,
  ExecutionEvent,
  ExecutionQuote,
  ExecutionResult,
  InteractionContext,
  SupportReport,
} from "./types.js";

/** Canonical Multicall3 deployment (same address on every EVM chain). */
export const MULTICALL3_ADDRESS: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";

const multicall3Abi = [
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
    outputs: [
      {
        name: "returnData",
        type: "tuple[]",
        components: [
          { name: "success", type: "bool" },
          { name: "returnData", type: "bytes" },
        ],
      },
    ],
  },
] as const;

export interface MulticallContextDeps {
  walletClient: WalletClient;
  publicClient?: PublicClient;
  account: Address;
  chain: Chain;
  /** Override for chains with a non-canonical Multicall3. */
  multicallAddress?: Address;
}

/**
 * Extensibility proof: calls execute atomically from the Multicall3 contract —
 * a "special context" distinct from both direct signing and RAILGUN. One
 * transaction runs the whole batch; any failure reverts all of it.
 */
export class MulticallContext implements InteractionContext {
  readonly kind = "multicall";
  readonly chainId: number;

  private readonly deps: Required<Pick<MulticallContextDeps, "walletClient" | "account" | "chain">> &
    MulticallContextDeps;

  constructor(deps: MulticallContextDeps) {
    this.deps = deps;
    this.chainId = deps.chain.id;
  }

  async supports(calls: ContractCall[]): Promise<SupportReport> {
    const blockers: { call?: number; reason: string }[] = [];
    calls.forEach((call, i) => {
      if (call.value !== undefined && call.value !== 0n) {
        blockers.push({
          call: i,
          reason: "aggregate3 cannot forward per-call native value.",
        });
      }
    });
    return { supported: blockers.length === 0, blockers };
  }

  private multicallAddress(): Address {
    return this.deps.multicallAddress ?? MULTICALL3_ADDRESS;
  }

  private encodeBatch(calls: ContractCall[]): Hex {
    return encodeFunctionData({
      abi: multicall3Abi,
      functionName: "aggregate3",
      args: [
        calls.map((c) => ({ target: c.to, allowFailure: false, callData: c.data })),
      ],
    });
  }

  async quote(calls: ContractCall[]): Promise<ExecutionQuote> {
    const data = this.encodeBatch(calls);
    let gas = 0n;
    if (this.deps.publicClient) {
      gas = await this.deps.publicClient.estimateGas({
        account: this.deps.account,
        to: this.multicallAddress(),
        data,
      });
    }
    const gasPrice = this.deps.publicClient ? await this.deps.publicClient.getGasPrice() : 0n;
    return {
      gas,
      nativeCost: gas * gasPrice,
      contextFees: [],
      notes: [
        `Atomic batch: ${calls.length} call(s) execute from Multicall3 in one transaction; any failure reverts all.`,
        "msg.sender inside the batch is Multicall3, not your wallet.",
      ],
    };
  }

  async *execute(
    calls: ContractCall[],
    _opts?: ExecuteOpts,
  ): AsyncGenerator<ExecutionEvent, ExecutionResult> {
    const support = await this.supports(calls);
    if (!support.supported) {
      const error = new Error(`Unsupported for multicall: ${support.blockers[0].reason}`);
      yield { phase: "failed", error };
      throw error;
    }
    yield { phase: "prepared" };
    const txHashes: Hex[] = [];
    const receipts: TransactionReceipt[] = [];
    try {
      const txHash = await this.deps.walletClient.sendTransaction({
        account: this.deps.account,
        chain: this.deps.chain,
        to: this.multicallAddress(),
        data: this.encodeBatch(calls),
      });
      txHashes.push(txHash);
      yield { phase: "submitted", txHash };
      if (this.deps.publicClient) {
        const receipt = await this.deps.publicClient.waitForTransactionReceipt({ hash: txHash });
        if (receipt.status === "reverted") {
          throw new Error(`Transaction ${txHash} was reverted.`);
        }
        receipts.push(receipt);
        yield { phase: "confirmed", txHash };
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      yield { phase: "failed", error: err };
      throw err;
    }
    return { txHashes, receipts };
  }
}

export const multicallContextFactory: ContextFactory = {
  kind: "multicall",
  chains: [], // any chain with a Multicall3 deployment
  async create(deps) {
    // SAFETY: ContextDeps is an opaque bag by design; callers of the
    // "multicall" kind pass MulticallContextDeps-shaped deps.
    return new MulticallContext(deps as unknown as MulticallContextDeps);
  },
};

export function createMulticallContext(deps: MulticallContextDeps): MulticallContext {
  return new MulticallContext(deps);
}
