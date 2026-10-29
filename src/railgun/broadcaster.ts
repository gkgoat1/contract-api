import type { Address, Hex } from "viem";
import { NETWORK_CONFIG, TXIDVersion } from "@railgun-community/shared-models";
import type { Chain, SelectedBroadcaster } from "@railgun-community/shared-models";
import { networkNameForChain } from "./networks.js";
import type {
  BroadcasterClient,
  BroadcasterSelection,
  PopulatedRailgunTransaction,
} from "./types.js";

/** The Waku broadcaster client is a heavy browser P2P stack — load it lazily. */
type WakuModule = typeof import("@railgun-community/waku-broadcaster-client-web");
let wakuModulePromise: Promise<WakuModule> | undefined;
function loadWaku(): Promise<WakuModule> {
  wakuModulePromise ??= import("@railgun-community/waku-broadcaster-client-web");
  return wakuModulePromise;
}

function chainForId(chainId: number): Chain {
  const networkName = networkNameForChain(chainId);
  if (!networkName) throw new Error(`RAILGUN is not available on chain ${chainId}.`);
  return NETWORK_CONFIG[networkName].chain;
}

/**
 * Selects the best broadcaster for a fee token on a chain. Starts the Waku
 * client on first use (peer discovery takes a few seconds — callers should
 * surface the status callback).
 *
 * `feePerUnitGas` comes from the broadcaster's advertised token fee; the fee
 * amount itself is resolved by the caller via the wallet SDK's
 * calculateBroadcasterFeeERC20Amount once a gas estimate exists.
 */
export async function selectBroadcaster(
  chainId: number,
  feeTokenAddress: Address,
  onStatus?: (status: string) => void,
): Promise<{ broadcaster: SelectedBroadcaster; feePerUnitGas: bigint }> {
  const { WakuBroadcasterClient } = await loadWaku();
  const chain = chainForId(chainId);
  if (!WakuBroadcasterClient.isStarted()) {
    await WakuBroadcasterClient.start(
      chain,
      // The docs' own example passes an empty options object; the client's
      // built-in defaults cover the official broadcaster network.
      {} as never,
      (_chain, status) => onStatus?.(String(status)),
    );
  }
  // Fee quotes arrive asynchronously over Waku; poll briefly for a broadcaster.
  const deadline = Date.now() + 30_000;
  let broadcaster: SelectedBroadcaster | undefined;
  while (Date.now() < deadline) {
    broadcaster = WakuBroadcasterClient.findBestBroadcaster(chain, feeTokenAddress, true) ?? undefined;
    if (broadcaster) break;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  if (!broadcaster) {
    throw new Error(
      `No broadcaster on chain ${chainId} accepts fees in ${feeTokenAddress}. ` +
        "Try a more common fee token (WETH, USDC, DAI).",
    );
  }
  return { broadcaster, feePerUnitGas: BigInt(broadcaster.tokenFee.feePerUnitGas) };
}

/**
 * BroadcasterClient over the Waku broadcaster network: wraps the populated
 * RAILGUN transaction in a BroadcasterTransaction and sends it — the
 * broadcaster pays gas, so nothing the user controls appears on-chain.
 */
export function createWakuBroadcasterClient(opts: {
  chainId: number;
  broadcaster: SelectedBroadcaster;
  /** From calculateGasPrice on the transaction's gas details. */
  overallBatchMinGasPrice: bigint;
}): BroadcasterClient {
  const chain = chainForId(opts.chainId);
  return {
    async submit(tx: PopulatedRailgunTransaction): Promise<Hex> {
      if (!tx.nullifiers || tx.nullifiers.length === 0) {
        throw new Error("Broadcaster submission needs the populated transaction's nullifiers.");
      }
      const { BroadcasterTransaction } = await loadWaku();
      const broadcasterTx = await BroadcasterTransaction.create(
        TXIDVersion.V2_PoseidonMerkle,
        tx.to,
        tx.data,
        opts.broadcaster.railgunAddress,
        opts.broadcaster.tokenFee.feesID,
        chain,
        tx.nullifiers,
        opts.overallBatchMinGasPrice,
        true, // useRelayAdapt: cross-contract calls go through Relay Adapt
        {}, // preTransactionPOIs: none (POI lists are a broadcaster-side concern here)
      );
      const txHash = await broadcasterTx.send();
      return txHash as Hex;
    },
  };
}

/**
 * Full broadcaster selection for a RailgunContext: picks a broadcaster for the
 * fee token and returns the BroadcasterSelection the context expects.
 * `feeAmount` comes from the wallet SDK's fee calculation at session setup.
 */
export async function selectBroadcasterForContext(opts: {
  chainId: number;
  feeTokenAddress: Address;
  feeAmount: bigint;
  overallBatchMinGasPrice: bigint;
  onStatus?: (status: string) => void;
}): Promise<BroadcasterSelection> {
  const { broadcaster, feePerUnitGas } = await selectBroadcaster(
    opts.chainId,
    opts.feeTokenAddress,
    opts.onStatus,
  );
  return {
    client: createWakuBroadcasterClient({
      chainId: opts.chainId,
      broadcaster,
      overallBatchMinGasPrice: opts.overallBatchMinGasPrice,
    }),
    fee: {
      tokenAddress: opts.feeTokenAddress,
      amount: opts.feeAmount,
      recipientAddress: broadcaster.railgunAddress,
    },
    feeTokenDetails: {
      tokenAddress: opts.feeTokenAddress,
      feePerUnitGas,
    },
  };
}
