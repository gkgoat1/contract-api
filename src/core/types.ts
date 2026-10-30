/** Canonical address/hex shapes (identical in ethers code; template literals). */
export type Address = `0x${string}`;
export type Hex = `0x${string}`;

/** Minimal receipt shape shared by all contexts (ethers status 1/0 normalized). */
export interface Receipt {
  transactionHash: Hex;
  status: "success" | "reverted";
  blockNumber: bigint;
}

/**
 * Read-side chain access. Narrow and mock-friendly; an ethers `Provider`
 * satisfies it directly (`call`, `estimateGas`, `getFeeData`,
 * `waitForTransaction`).
 */
export interface ReadProvider {
  call(tx: { to: Address; data: Hex; from?: Address; value?: bigint }): Promise<string>;
  estimateGas(tx: { to: Address; data: Hex; from?: Address; value?: bigint }): Promise<bigint>;
  getFeeData(): Promise<{ gasPrice: bigint | null }>;
  waitForTransaction(hash: string): Promise<{
    status: number | null;
    transactionHash: string;
    blockNumber: number;
  } | null>;
}

/** Write-side signing. Narrow; an ethers `Signer` satisfies it directly. */
export interface WriteSigner {
  getAddress(): Promise<string>;
  sendTransaction(tx: { to: Address; data: Hex; value?: bigint }): Promise<{ hash: string }>;
}

/** A single encoded contract call. */
export interface ContractCall {
  to: Address;
  data: Hex;
  value?: bigint;
  /**
   * Declares the ERC-20 tokens this call spends and can produce. Contexts that
   * must pre-move funds (e.g. RAILGUN unshield / re-shield) require this; a
   * context may refuse calls whose token flows are undeclared.
   */
  tokens?: {
    spends: { token: Address; amount: bigint }[];
    /** Every token the call can leave behind — completeness is funds safety. */
    receives: { token: Address }[];
  };
}

export interface ExecutionQuote {
  gas: bigint;
  nativeCost: bigint;
  /** Context-specific fees, e.g. RAILGUN unshield fee + broadcaster fee. */
  contextFees: { token: Address; amount: bigint; label: string }[];
  /** Human-readable caveats shown before execution. */
  notes: string[];
}

export interface SupportReport {
  supported: boolean;
  /** Per-call blockers; `call` indexes into the queried call list when set. */
  blockers: { call?: number; reason: string }[];
}

export type ExecutionEvent =
  | { phase: "prepared" }
  | { phase: "proving"; progress: number }
  | { phase: "broadcasting" }
  | { phase: "submitted"; txHash: Hex }
  | { phase: "confirmed"; txHash: Hex }
  | { phase: "failed"; error: Error };

export interface ExecutionResult {
  txHashes: Hex[];
  receipts: Receipt[];
}

export interface ExecuteOpts {
  signal?: AbortSignal;
  /** Fine-grained progress ticks (e.g. RAILGUN proof generation, 0..1). The
      event stream itself only emits coarse proving start/end events. */
  onProgress?: (progress: number) => void;
}

/**
 * A pluggable way of getting calls onto a chain: a directly signing wallet,
 * RAILGUN's Relay Adapt, a multisig, a bundler — anything that executes
 * contracts under a special context.
 */
export interface InteractionContext {
  readonly kind: string;
  readonly chainId: number;
  supports(calls: ContractCall[]): Promise<SupportReport>;
  quote(calls: ContractCall[]): Promise<ExecutionQuote>;
  execute(
    calls: ContractCall[],
    opts?: ExecuteOpts,
  ): AsyncGenerator<ExecutionEvent, ExecutionResult>;
}

/** Dependencies handed to a context factory; each factory narrows this type. */
export type ContextDeps = Record<string, unknown>;

export interface ContextDescriptor {
  kind: string;
  /** Supported chain ids; empty means every chain. */
  chains: number[];
}

export interface ContextFactory {
  kind: string;
  /** Supported chain ids; empty means every chain. */
  chains: number[];
  create(deps: ContextDeps): Promise<InteractionContext>;
}

/** Output of one pipeline stage, passed to the next stage's `calls`. */
export interface StageOutput {
  stage: string;
  result: ExecutionResult;
}

export interface PipelineStage {
  name: string;
  context: InteractionContext;
  /** Builds this stage's calls, possibly from earlier stages' results. */
  calls: (prev: StageOutput[]) => Promise<ContractCall[]>;
}

export type PipelineEvent =
  | { type: "stage-started"; stage: string }
  | { type: "stage-event"; stage: string; event: ExecutionEvent }
  | { type: "stage-finished"; stage: string; result: ExecutionResult };

export interface PipelineResult {
  stages: StageOutput[];
}
