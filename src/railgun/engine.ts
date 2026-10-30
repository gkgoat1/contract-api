import type { Address, Hex } from "../core/types.js";
import {
  NETWORK_CONFIG,
  TXIDVersion,
  calculateGasPrice,
  type RailgunERC20AmountRecipient,
  type TransactionGasDetails,
} from "@railgun-community/shared-models";
// The wallet SDK is a Node-oriented package (touches `process` at module
// scope) and heavy (zk proving stack) — it must never be statically imported
// into a browser bundle. Load it lazily, once, on first use.
type WalletSdk = typeof import("@railgun-community/wallet");
let walletSdkPromise: Promise<WalletSdk> | undefined;
function loadWalletSdk(): Promise<WalletSdk> {
  walletSdkPromise ??= import("@railgun-community/wallet");
  return walletSdkPromise;
}
import { networkNameForChain } from "./networks.js";
import type { PopulatedRailgunTransaction, RailgunReadProvider, RailgunSdk } from "./types.js";

/**
 * Binds the real @railgun-community/wallet SDK behind the RailgunSdk
 * interface. Requires a running engine (started by the consumer via
 * startRailgunEngine) with the wallet's merkletrees synced.
 */
export interface RailgunSdkDeps {
  chainId: number;
  railgunWalletId: string;
  encryptionKey: string;
  publicClient: RailgunReadProvider;
  /** Public wallet used for base-token unshield proofs. */
  publicWalletAddress: string;
  /** Shield private key + RAILGUN address, for base-token shield sweeps. */
  shieldPrivateKey: string;
  railgunAddress: string;
}

async function gasDetailsFor(
  provider: RailgunReadProvider,
  gasEstimate: bigint,
): Promise<TransactionGasDetails> {
  const fees = await provider.getFeeData();
  if (fees.maxFeePerGas == null || fees.maxPriorityFeePerGas == null) {
    throw new Error("RAILGUN needs an EIP-1559 chain: the provider returned no maxFeePerGas/maxPriorityFeePerGas.");
  }
  return {
    evmGasType: 2, // EVMGasType.Type2 — EIP-1559 chains only for Phase B
    gasEstimate,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
  };
}

export function createRailgunSdk(deps: RailgunSdkDeps): RailgunSdk {
  const networkName = networkNameForChain(deps.chainId);
  if (!networkName) throw new Error(`RAILGUN is not available on chain ${deps.chainId}.`);
  const txidVersion = TXIDVersion.V2_PoseidonMerkle;
  // Base-token unshields/shields are denominated in the wrapped base token.
  const wrappedBaseToken = NETWORK_CONFIG[networkName].baseToken.wrappedAddress;
  const wrappedBaseAmount = (amount: bigint) => ({ tokenAddress: wrappedBaseToken, amount });

  return {
    async estimateCrossContractCalls(input) {
      const { gasEstimateForUnprovenCrossContractCalls } = await loadWalletSdk();
      const originalGasDetails = await gasDetailsFor(deps.publicClient, 0n);
      const { gasEstimate } = await gasEstimateForUnprovenCrossContractCalls(
        txidVersion,
        networkName,
        deps.railgunWalletId,
        deps.encryptionKey,
        input.unshieldAmounts,
        [], // no NFT unshield
        input.shieldRecipients,
        [],
        input.calls.map((c) => ({ to: c.to, data: c.data, value: c.value ?? 0n })),
        originalGasDetails,
        // The broadcaster's fee terms let the SDK resolve the fee iteratively
        // during estimation; the fee itself is a private output in the proof.
        input.feeTokenDetails ?? undefined,
        input.sendWithPublicWallet,
        input.minGasLimit ?? null,
      );
      return gasEstimate;
    },

    async proveCrossContractCalls(input, onProgress) {
      const { generateCrossContractCallsProof } = await loadWalletSdk();
      const gasEstimate = await this.estimateCrossContractCalls(input);
      const gasDetails = await gasDetailsFor(deps.publicClient, gasEstimate);
      await generateCrossContractCallsProof(
        txidVersion,
        networkName,
        deps.railgunWalletId,
        deps.encryptionKey,
        input.unshieldAmounts,
        [],
        input.shieldRecipients,
        [],
        input.calls.map((c) => ({ to: c.to, data: c.data, value: c.value ?? 0n })),
        input.broadcasterFee,
        input.sendWithPublicWallet,
        calculateGasPrice(gasDetails),
        input.minGasLimit ?? null,
        onProgress,
      );
    },

    async populateCrossContractCalls(input) {
      const { populateProvedCrossContractCalls } = await loadWalletSdk();
      const gasEstimate = await this.estimateCrossContractCalls(input);
      const gasDetails = await gasDetailsFor(deps.publicClient, gasEstimate);
      const response = await populateProvedCrossContractCalls(
        txidVersion,
        networkName,
        deps.railgunWalletId,
        input.unshieldAmounts,
        [],
        input.shieldRecipients,
        [],
        input.calls.map((c) => ({ to: c.to, data: c.data, value: c.value ?? 0n })),
        input.broadcasterFee,
        input.sendWithPublicWallet,
        calculateGasPrice(gasDetails),
        gasDetails,
      );
      const tx = response.transaction as { to?: string; data?: string; value?: bigint };
      if (!tx.to || !tx.data) {
        throw new Error("RAILGUN returned an incomplete populated transaction.");
      }
      const populated: PopulatedRailgunTransaction = {
        to: tx.to as Address,
        data: tx.data as Hex,
        value: tx.value,
        nullifiers: response.nullifiers ?? undefined,
      };
      return populated;
    },

    async estimateNativeUnshield(input) {
      const { gasEstimateForUnprovenUnshieldBaseToken } = await loadWalletSdk();
      const originalGasDetails = await gasDetailsFor(deps.publicClient, 0n);
      const { gasEstimate } = await gasEstimateForUnprovenUnshieldBaseToken(
        txidVersion,
        networkName,
        deps.publicWalletAddress,
        deps.railgunWalletId,
        deps.encryptionKey,
        wrappedBaseAmount(input.amount),
        originalGasDetails,
        undefined,
        input.sendWithPublicWallet,
      );
      return gasEstimate;
    },

    async proveNativeUnshield(input, onProgress) {
      const { generateUnshieldBaseTokenProof } = await loadWalletSdk();
      const gasEstimate = await this.estimateNativeUnshield(input);
      const gasDetails = await gasDetailsFor(deps.publicClient, gasEstimate);
      await generateUnshieldBaseTokenProof(
        txidVersion,
        networkName,
        deps.publicWalletAddress,
        deps.railgunWalletId,
        deps.encryptionKey,
        wrappedBaseAmount(input.amount),
        input.broadcasterFee,
        input.sendWithPublicWallet,
        calculateGasPrice(gasDetails),
        onProgress,
      );
    },

    async populateNativeUnshield(input) {
      const { populateProvedUnshieldBaseToken } = await loadWalletSdk();
      const gasEstimate = await this.estimateNativeUnshield(input);
      const gasDetails = await gasDetailsFor(deps.publicClient, gasEstimate);
      const response = await populateProvedUnshieldBaseToken(
        txidVersion,
        networkName,
        input.to,
        deps.railgunWalletId,
        wrappedBaseAmount(input.amount),
        input.broadcasterFee,
        input.sendWithPublicWallet,
        calculateGasPrice(gasDetails),
        gasDetails,
      );
      const tx = response.transaction as { to?: string; data?: string; value?: bigint };
      if (!tx.to || !tx.data) {
        throw new Error("RAILGUN returned an incomplete populated transaction.");
      }
      return { to: tx.to as Address, data: tx.data as Hex, value: tx.value };
    },

    async populateNativeShield(amount, fromWalletAddress) {
      const { populateShield } = await loadWalletSdk();
      const response = await populateShield(
        txidVersion,
        networkName,
        deps.shieldPrivateKey,
        [{ ...wrappedBaseAmount(amount), recipientAddress: deps.railgunAddress }],
        [],
      );
      const tx = response.transaction as { to?: string; data?: string; value?: bigint };
      if (!tx.to || !tx.data) {
        throw new Error(`RAILGUN returned an incomplete shield transaction for ${fromWalletAddress}.`);
      }
      // Base-token shields carry the native value on the transaction itself.
      return { to: tx.to as Address, data: tx.data as Hex, value: tx.value ?? amount };
    },
  };
}

/** The unshield fee for a chain, in basis points (RAILGUN charges 25 = 0.25%). */
export function unshieldFeeBpsForChain(chainId: number): bigint {
  const networkName = networkNameForChain(chainId);
  if (!networkName) throw new Error(`RAILGUN is not available on chain ${chainId}.`);
  // The published Network type omits the fee fields even though the runtime
  // config carries them (checked against @railgun-community/wallet 11.x's
  // load-provider). Probe defensively; the documented default is 25 bps.
  const network = NETWORK_CONFIG[networkName] as { fees?: { unshieldFeeV2?: string } };
  if (!network.fees?.unshieldFeeV2) return 25n;
  return BigInt(network.fees.unshieldFeeV2);
}

/** Re-export for consumers building broadcaster fees. */
export type { RailgunERC20AmountRecipient };
