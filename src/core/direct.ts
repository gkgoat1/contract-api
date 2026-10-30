import type {
  Address,
  ContractCall,
  ContextFactory,
  ExecuteOpts,
  ExecutionEvent,
  ExecutionQuote,
  ExecutionResult,
  Hex,
  InteractionContext,
  ReadProvider,
  Receipt,
  SupportReport,
  WriteSigner,
} from "./types.js";

export interface DirectContextDeps {
  /** The connected signer (an ethers `Signer` satisfies this). */
  signer: WriteSigner;
  provider?: ReadProvider;
  chainId: number;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function normalizeReceipt(r: { status: number | null; transactionHash: string; blockNumber: number }): Receipt {
  return {
    transactionHash: r.transactionHash as Hex,
    status: r.status === 1 ? "success" : "reverted",
    blockNumber: BigInt(r.blockNumber),
  };
}

/**
 * The baseline context: the connected wallet signs and sends each call
 * directly. Identity and funding source are fully public.
 */
export class DirectContext implements InteractionContext {
  readonly kind = "direct";
  readonly chainId: number;

  private readonly signer: WriteSigner;
  private readonly provider?: ReadProvider;

  constructor(deps: DirectContextDeps) {
    this.signer = deps.signer;
    this.provider = deps.provider;
    this.chainId = deps.chainId;
  }

  async supports(_calls: ContractCall[]): Promise<SupportReport> {
    // A directly-signing wallet can attempt any call; the contract decides.
    return { supported: true, blockers: [] };
  }

  async quote(calls: ContractCall[]): Promise<ExecutionQuote> {
    let gas = 0n;
    const from = (await this.signer.getAddress()) as Address;
    if (this.provider) {
      for (const call of calls) {
        gas += await this.provider.estimateGas({
          from,
          to: call.to,
          data: call.data,
          value: call.value,
        });
      }
    }
    const fee = this.provider ? await this.provider.getFeeData() : null;
    const gasPrice = fee?.gasPrice ?? 0n;
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
    const receipts: Receipt[] = [];
    try {
      for (const call of calls) {
        const sent = await this.signer.sendTransaction({
          to: call.to,
          data: call.data,
          value: call.value,
        });
        const txHash = sent.hash as Hex;
        txHashes.push(txHash);
        yield { phase: "submitted", txHash };
        if (this.provider) {
          const raw = await this.provider.waitForTransaction(txHash);
          if (!raw) throw new Error(`Transaction ${txHash} not found.`);
          const receipt = normalizeReceipt(raw);
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
