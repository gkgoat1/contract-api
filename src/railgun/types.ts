import type { Address, Hex, PublicClient } from "viem";
import type {
  RailgunERC20Amount,
  RailgunERC20AmountRecipient,
  RailgunERC20Recipient,
} from "@railgun-community/shared-models";
import type { ContractCall } from "../core/types.js";

/** Everything the RAILGUN context needs to know to build one execution. */
export interface RailgunExecutionInput {
  /** Exact amounts to unshield into Relay Adapt (already fee-padded). */
  unshieldAmounts: RailgunERC20Amount[];
  /** Output tokens re-shielded to the user's RAILGUN address afterwards. */
  shieldRecipients: RailgunERC20Recipient[];
  /** The ordered cross-contract calls executed from Relay Adapt. */
  calls: ContractCall[];
  /** Broadcaster fee; undefined means self-signed submission. */
  broadcasterFee?: RailgunERC20AmountRecipient;
  /** The broadcaster's fee terms, for iterative fee resolution at estimate time. */
  feeTokenDetails?: { tokenAddress: string; feePerUnitGas: bigint };
  sendWithPublicWallet: boolean;
  minGasLimit?: bigint;
}

export interface PopulatedRailgunTransaction {
  to: Address;
  data: Hex;
  value?: bigint;
  /** Nullifiers of the spent notes — Broadcaster submission needs them. */
  nullifiers?: string[];
}

/** A base-token unshield: native token out of the shielded balance to `to`. */
export interface NativeUnshieldInput {
  to: Address;
  amount: bigint;
  broadcasterFee?: RailgunERC20AmountRecipient;
  sendWithPublicWallet: boolean;
}

/**
 * The RAILGUN plumbing boundary: the context owns domain logic (validation,
 * fee math, event stream); an implementation of this interface owns the
 * wallet-SDK mechanics (gas details, txid versions, proof generation).
 * `createRailgunSdk` in engine.ts binds the real @railgun-community/wallet.
 */
export interface RailgunSdk {
  estimateCrossContractCalls(input: RailgunExecutionInput): Promise<bigint>;
  proveCrossContractCalls(
    input: RailgunExecutionInput,
    onProgress: (progress: number) => void,
  ): Promise<void>;
  populateCrossContractCalls(
    input: RailgunExecutionInput,
  ): Promise<PopulatedRailgunTransaction>;
  /** Base-token unshield (funding an ephemeral deployer, paying out, …). */
  estimateNativeUnshield(input: NativeUnshieldInput): Promise<bigint>;
  proveNativeUnshield(input: NativeUnshieldInput, onProgress: (progress: number) => void): Promise<void>;
  populateNativeUnshield(input: NativeUnshieldInput): Promise<PopulatedRailgunTransaction>;
  /**
   * Build a base-token shield transaction (no proof — shields are public and
   * are sent by the funder, e.g. an ephemeral deployer sweeping leftover gas).
   */
  populateNativeShield(amount: bigint, fromWalletAddress: Address): Promise<PopulatedRailgunTransaction>;
}

/** Submits a populated RAILGUN transaction through a Broadcaster. */
export interface BroadcasterClient {
  submit(tx: PopulatedRailgunTransaction): Promise<Hex>;
}

/** Broadcaster selection: the fee recipient (baked into the proof) + submitter. */
export interface BroadcasterSelection {
  client: BroadcasterClient;
  fee: RailgunERC20AmountRecipient;
  /** Token fee terms, fed back into gas estimation (iterative fee resolution). */
  feeTokenDetails: { tokenAddress: string; feePerUnitGas: bigint };
}

export interface RailgunContextDeps {
  chainId: number;
  /** The user's RAILGUN wallet address (0zk…); outputs re-shield to it. */
  railgunAddress: string;
  sdk: RailgunSdk;
  publicClient: PublicClient;
  /** Unshield fee in basis points (RAILGUN charges 25 = 0.25%). */
  unshieldFeeBps: bigint;
  /** Broadcaster submission; falls back to selfSubmit when absent. */
  broadcaster?: BroadcasterSelection;
  /** Self-signed submission; used only when no broadcaster is configured. */
  selfSubmit?: (tx: PopulatedRailgunTransaction) => Promise<Hex>;
  minGasLimit?: bigint;
}
