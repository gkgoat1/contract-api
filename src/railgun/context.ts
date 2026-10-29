import type { Address, Hex, TransactionReceipt } from "viem";
import type { RailgunERC20Amount } from "@railgun-community/shared-models";
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
import { RAILGUN_CHAIN_IDS } from "./networks.js";
import type {
  NativeUnshieldInput,
  PopulatedRailgunTransaction,
  RailgunContextDeps,
  RailgunExecutionInput,
} from "./types.js";

const BPS = 10_000n;

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Interactions executed against a shielded RAILGUN balance: unshield the exact
 * (fee-padded) ERC-20 spends into Relay Adapt, run the ordered calls from
 * Relay Adapt, then re-shield every declared output token — one atomic,
 * unlinkable transaction.
 *
 * Scope limits (honest blockers via supports()):
 * - every call must declare its ERC-20 flows (`tokens`) — undeclared flows are
 *   a funds-safety risk (re-shield completeness) and are refused;
 * - native `value` on calls is not supported yet (base-token unshielding is a
 *   separate SDK path);
 * - calls execute with Relay Adapt as msg.sender, so calls that authenticate
 *   msg.sender cannot be made private this way.
 */
export class RailgunContext implements InteractionContext {
  readonly kind = "railgun";
  readonly chainId: number;

  private readonly deps: RailgunContextDeps;

  constructor(deps: RailgunContextDeps) {
    if (!RAILGUN_CHAIN_IDS.includes(deps.chainId)) {
      throw new Error(`RAILGUN is not available on chain ${deps.chainId}.`);
    }
    if (!deps.broadcaster && !deps.selfSubmit) {
      throw new Error("RailgunContext needs a broadcaster client or a selfSubmit function.");
    }
    this.deps = deps;
    this.chainId = deps.chainId;
  }

  /** Blockers for calls the Relay Adapt path cannot safely execute. */
  async supports(calls: ContractCall[]): Promise<SupportReport> {
    const blockers: { call?: number; reason: string }[] = [];
    calls.forEach((call, i) => {
      if (!call.tokens) {
        blockers.push({
          call: i,
          reason:
            "ERC-20 flows are undeclared; RAILGUN execution requires tokens.spends/receives so unshielding and re-shielding are exact.",
        });
      }
      if (call.value !== undefined && call.value !== 0n) {
        blockers.push({
          call: i,
          reason: "Native value on RAILGUN cross-contract calls is not supported yet.",
        });
      }
    });
    return { supported: blockers.length === 0, blockers };
  }

  /**
   * Aggregate per-token spends and pad for the unshield fee: to have `amount`
   * available in Relay Adapt, unshield ceil(amount × 10000 / (10000 − feeBps)).
   */
  private buildExecutionInput(calls: ContractCall[]): RailgunExecutionInput {
    const spendByToken = new Map<Address, bigint>();
    const receiveTokens = new Set<Address>();
    for (const call of calls) {
      for (const spend of call.tokens?.spends ?? []) {
        spendByToken.set(spend.token, (spendByToken.get(spend.token) ?? 0n) + spend.amount);
      }
      for (const receive of call.tokens?.receives ?? []) {
        receiveTokens.add(receive.token);
      }
    }
    const { unshieldFeeBps, railgunAddress, broadcaster, sendWithPublicWallet, minGasLimit } =
      this.depsWithDefaults();
    const unshieldAmounts: RailgunERC20Amount[] = [...spendByToken.entries()].map(
      ([tokenAddress, amount]) => ({
        tokenAddress,
        // Round up so the post-fee amount still covers the declared spend.
        amount: (amount * BPS + (BPS - unshieldFeeBps) - 1n) / (BPS - unshieldFeeBps),
      }),
    );
    return {
      unshieldAmounts,
      shieldRecipients: [...receiveTokens].map((tokenAddress) => ({
        tokenAddress,
        recipientAddress: railgunAddress,
      })),
      calls,
      broadcasterFee: sendWithPublicWallet ? undefined : broadcaster?.fee,
      feeTokenDetails: sendWithPublicWallet ? undefined : broadcaster?.feeTokenDetails,
      sendWithPublicWallet,
      minGasLimit,
    };
  }

  /**
   * Funding primitive: unshield native base token from the private balance to
   * `to` (e.g. an ephemeral deployer EOA). Proofed and submitted like any
   * other private transaction.
   */
  async *fund(
    to: Address,
    amount: bigint,
    opts?: ExecuteOpts,
  ): AsyncGenerator<ExecutionEvent, ExecutionResult> {
    yield { phase: "prepared" };
    try {
      const { broadcaster, sendWithPublicWallet } = this.depsWithDefaults();
      const input: NativeUnshieldInput = {
        to,
        amount,
        broadcasterFee: sendWithPublicWallet ? undefined : broadcaster?.fee,
        sendWithPublicWallet,
      };
      yield { phase: "proving", progress: 0 };
      await this.deps.sdk.proveNativeUnshield(input, (progress) => {
        opts?.onProgress?.(progress);
      });
      yield { phase: "proving", progress: 1 };
      const populated = await this.deps.sdk.populateNativeUnshield(input);
      const txHash = await this.submit(populated, input.sendWithPublicWallet);
      yield { phase: "submitted", txHash };
      const receipt = await this.deps.publicClient.waitForTransactionReceipt({ hash: txHash });
      if (receipt.status === "reverted") {
        throw new Error(`Transaction ${txHash} was reverted.`);
      }
      yield { phase: "confirmed", txHash };
      return { txHashes: [txHash], receipts: [receipt as TransactionReceipt] };
    } catch (error) {
      const err = toError(error);
      yield { phase: "failed", error: err };
      throw err;
    }
  }

  /**
   * Build a base-token shield transaction (public; no proof needed) — used to
   * sweep leftover gas from an ephemeral deployer back into the private
   * balance. The returned transaction must be sent by `fromWalletAddress`.
   */
  buildNativeShield(amount: bigint, fromWalletAddress: Address): Promise<PopulatedRailgunTransaction> {
    return this.deps.sdk.populateNativeShield(amount, fromWalletAddress);
  }

  private async submit(
    populated: PopulatedRailgunTransaction,
    sendWithPublicWallet: boolean,
  ): Promise<Hex> {
    if (!sendWithPublicWallet && this.deps.broadcaster) {
      return this.deps.broadcaster.client.submit(populated);
    }
    if (this.deps.selfSubmit) {
      return this.deps.selfSubmit(populated);
    }
    throw new Error("No submission path: configure a broadcaster or selfSubmit.");
  }

  private depsWithDefaults() {
    return {
      ...this.deps,
      sendWithPublicWallet: this.deps.broadcaster ? false : true,
    };
  }

  async quote(calls: ContractCall[]): Promise<ExecutionQuote> {
    const support = await this.supports(calls);
    if (!support.supported) {
      throw new Error(`Unsupported for RAILGUN: ${support.blockers[0].reason}`);
    }
    const input = this.buildExecutionInput(calls);
    const gas = await this.deps.sdk.estimateCrossContractCalls(input);
    const contextFees = input.unshieldAmounts.map(({ tokenAddress, amount }) => ({
      token: tokenAddress as Address,
      amount: amount - (amount * (BPS - this.deps.unshieldFeeBps)) / BPS,
      label: "RAILGUN unshield fee",
    }));
    if (input.broadcasterFee) {
      contextFees.push({
        token: input.broadcasterFee.tokenAddress as Address,
        amount: input.broadcasterFee.amount,
        label: "Broadcaster fee",
      });
    }
    return {
      gas,
      nativeCost: 0n, // paid by the broadcaster (or self-sign wallet), priced into fees
      contextFees,
      notes: [
        "Private execution: the on-chain sender is RAILGUN's Relay Adapt, not you.",
        "Proof generation takes roughly 20-30s on slow devices.",
        ...(input.sendWithPublicWallet
          ? ["Self-signed submission: the submitting wallet is visible on-chain."]
          : []),
      ],
    };
  }

  async *execute(
    calls: ContractCall[],
    opts?: ExecuteOpts,
  ): AsyncGenerator<ExecutionEvent, ExecutionResult> {
    const support = await this.supports(calls);
    if (!support.supported) {
      const error = new Error(`Unsupported for RAILGUN: ${support.blockers[0].reason}`);
      yield { phase: "failed", error };
      throw error;
    }
    yield { phase: "prepared" };
    try {
      const input = this.buildExecutionInput(calls);
      yield { phase: "proving", progress: 0 };
      await this.deps.sdk.proveCrossContractCalls(input, (progress) => {
        opts?.onProgress?.(progress);
      });
      yield { phase: "proving", progress: 1 };
      const populated = await this.deps.sdk.populateCrossContractCalls(input);
      if (!input.sendWithPublicWallet && this.deps.broadcaster) {
        yield { phase: "broadcasting" };
      }
      const txHash = await this.submit(populated, input.sendWithPublicWallet);
      yield { phase: "submitted", txHash };
      const receipt = await this.deps.publicClient.waitForTransactionReceipt({ hash: txHash });
      if (receipt.status === "reverted") {
        throw new Error(`Transaction ${txHash} was reverted.`);
      }
      yield { phase: "confirmed", txHash };
      return { txHashes: [txHash], receipts: [receipt as TransactionReceipt] };
    } catch (error) {
      const err = toError(error);
      yield { phase: "failed", error: err };
      throw err;
    }
  }
}

export const railgunContextFactory: ContextFactory = {
  kind: "railgun",
  chains: [...RAILGUN_CHAIN_IDS],
  async create(deps) {
    // SAFETY: ContextDeps is an opaque bag by design; callers of the "railgun"
    // kind pass RailgunContextDeps-shaped deps (see the plan, section 4.2).
    return new RailgunContext(deps as unknown as RailgunContextDeps);
  },
};

export function createRailgunContext(deps: RailgunContextDeps): RailgunContext {
  return new RailgunContext(deps);
}
