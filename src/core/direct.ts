import type {
  Address,
  Chain,
  Hex,
  PublicClient,
  TransactionReceipt,
  WalletClient,
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

export interface DirectContextDeps {
  walletClient: WalletClient;
  publicClient?: PublicClient;
  account: Address;
  chain: Chain;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * The baseline context: the connected wallet signs and sends each call
 * directly. Identity and funding source are fully public.
 */
export class DirectContext implements InteractionContext {
  readonly kind = "direct";
  readonly chainId: number;

  private readonly walletClient: WalletClient;
  private readonly publicClient?: PublicClient;
  private readonly account: Address;
  private readonly chain: Chain;

  constructor(deps: DirectContextDeps) {
    this.walletClient = deps.walletClient;
    this.publicClient = deps.publicClient;
    this.account = deps.account;
    this.chain = deps.chain;
    this.chainId = deps.chain.id;
  }

  async supports(_calls: ContractCall[]): Promise<SupportReport> {
    // A directly-signing wallet can attempt any call; the contract decides.
    return { supported: true, blockers: [] };
  }

  async quote(calls: ContractCall[]): Promise<ExecutionQuote> {
    let gas = 0n;
    if (this.publicClient) {
      for (const call of calls) {
        gas += await this.publicClient.estimateGas({
          account: this.account,
          to: call.to,
          data: call.data,
          value: call.value,
        });
      }
    }
    const gasPrice = this.publicClient ? await this.publicClient.getGasPrice() : 0n;
    return {
      gas,
      nativeCost: gas * gasPrice,
      contextFees: [],
      notes: ["Public execution: the connected wallet signs and pays, and is visible on-chain."],
    };
  }

  async *execute(
    calls: ContractCall[],
    _opts?: ExecuteOpts,
  ): AsyncGenerator<ExecutionEvent, ExecutionResult> {
    yield { phase: "prepared" };
    const txHashes: Hex[] = [];
    const receipts: TransactionReceipt[] = [];
    try {
      for (const call of calls) {
        const txHash = await this.walletClient.sendTransaction({
          account: this.account,
          chain: this.chain,
          to: call.to,
          data: call.data,
          value: call.value,
        });
        txHashes.push(txHash);
        yield { phase: "submitted", txHash };
        if (this.publicClient) {
          const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash });
          if (receipt.status === "reverted") {
            throw new Error(`Transaction ${txHash} was reverted.`);
          }
          receipts.push(receipt);
          yield { phase: "confirmed", txHash };
        }
      }
    } catch (error) {
      const err = toError(error);
      yield { phase: "failed", error: err };
      throw err;
    }
    return { txHashes, receipts };
  }
}

export const directContextFactory: ContextFactory = {
  kind: "direct",
  chains: [], // every chain
  async create(deps) {
    // SAFETY: ContextDeps is an opaque bag by design (each factory narrows it);
    // the registry contract is that callers of the "direct" kind pass
    // DirectContextDeps-shaped deps, and DirectContext only reads those fields.
    return new DirectContext(deps as unknown as DirectContextDeps);
  },
};

export function createDirectContext(deps: DirectContextDeps): DirectContext {
  return new DirectContext(deps);
}
