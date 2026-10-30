import type { Hex, Receipt } from "../core/types.js";
import type {
  ContextFactory,
  ContractCall,
  ExecuteOpts,
  ExecutionEvent,
  ExecutionQuote,
  ExecutionResult,
  InteractionContext,
  SupportReport,
} from "../core/types.js";

export interface MockContextOptions {
  kind?: string;
  chainId?: number;
  supportReport?: SupportReport;
  quote?: ExecutionQuote;
  /** Events yielded per execute() run, before the result. Defaults to a
      prepared → submitted → confirmed sequence with a fake hash. */
  events?: ExecutionEvent[];
  result?: ExecutionResult;
}

/**
 * A scriptable context for consumer tests: records the calls it was asked to
 * execute and replays a configurable event stream.
 */
export class MockContext implements InteractionContext {
  readonly kind: string;
  readonly chainId: number;
  readonly executed: ContractCall[][] = [];

  private readonly supportReport: SupportReport;
  private readonly quoteResult: ExecutionQuote;
  private readonly events: ExecutionEvent[];
  private readonly result: ExecutionResult;

  constructor(options: MockContextOptions = {}) {
    this.kind = options.kind ?? "mock";
    this.chainId = options.chainId ?? 1;
    this.supportReport = options.supportReport ?? { supported: true, blockers: [] };
    this.quoteResult = options.quote ?? {
      gas: 0n,
      nativeCost: 0n,
      contextFees: [],
      notes: [],
    };
    this.events = options.events ?? [
      { phase: "prepared" },
      { phase: "submitted", txHash: "0xdeadbeef" as Hex },
      { phase: "confirmed", txHash: "0xdeadbeef" as Hex },
    ];
    this.result = options.result ?? {
      txHashes: ["0xdeadbeef" as Hex],
      receipts: [] as Receipt[],
    };
  }

  async supports(_calls: ContractCall[]): Promise<SupportReport> {
    return this.supportReport;
  }

  async quote(_calls: ContractCall[]): Promise<ExecutionQuote> {
    return this.quoteResult;
  }

  async *execute(
    calls: ContractCall[],
    _opts?: ExecuteOpts,
  ): AsyncGenerator<ExecutionEvent, ExecutionResult> {
    this.executed.push(calls);
    for (const event of this.events) {
      yield event;
      if (event.phase === "failed") throw event.error;
    }
    return this.result;
  }

  /** Mocked funding primitive (see FundingSource / runPrivateDeploy). */
  async *fund(
    _to: string,
    _amount: bigint,
  ): AsyncGenerator<ExecutionEvent, ExecutionResult> {
    for (const event of this.events) {
      yield event;
      if (event.phase === "failed") throw event.error;
    }
    return this.result;
  }

  async buildNativeShield(amount: bigint, _from: string) {
    return {
      to: "0x9999999999999999999999999999999999999999" as const,
      data: "0x" as const,
      value: amount,
    };
  }
}

export function mockContextFactory(options: MockContextOptions = {}): ContextFactory {
  return {
    kind: options.kind ?? "mock",
    chains: options.chainId !== undefined ? [options.chainId] : [],
    async create() {
      return new MockContext(options);
    },
  };
}
