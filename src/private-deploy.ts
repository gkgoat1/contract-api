/**
 * Generic RAILGUN private-deployment glue for the deploy panels (master plan
 * T-2.4 / T-3.4 / T-4.5): the engine plumbing is in ./host-railgun.ts; this module
 * adapts any ethers-based panel onto the host seam. The connected EIP-1193
 * wallet signs the derivation messages; a funded ephemeral ethers wallet
 * deploys; leftover gas is swept back into the shielded balance.
 */
import { JsonRpcProvider, NonceManager, Wallet, parseEther, type Signer } from "ethers";
import type { Address } from "./core/types.js";
import { viemPublicClientFor, type EIP1193Provider } from "./host-railgun.ts";
import {
  deployPrivately,
  isPrivacySupported,
  resolveRailgunFunding,
  type RailgunHost,
} from "./host-railgun.ts";

/** The chain's wrapped base token — the ERC-20 broadcasters accept as fees.
 *  Anvil has no canonical WETH; private funding there relies on the test hook
 *  (or a self-signed fallback submission with the visible-link caveat). */
const WETH_BY_CHAIN: Record<number, Address | undefined> = {
  1: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  56: "0x2170Ed0880ac9A755fd29B2688956BD959F933F8",
  137: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
  42161: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
  8453: "0x4200000000000000000000000000000000000006",
};

export function wethForChain(chainId: number): Address | undefined {
  return WETH_BY_CHAIN[chainId];
}

export { isPrivacySupported };

/** Native gas unshielded into the ephemeral deployer (sc's panel uses the same). */
export const PRIVATE_DEPLOY_FUND_AMOUNT = parseEther("0.01");

interface EphemeralWithSigner {
  address: Address;
  signer: Signer;
  sendTransaction(tx: { to: Address; data: string; value?: bigint }): Promise<`0x${string}`>;
}

/** A freshly generated, never-before-used deployer identity (ethers-backed).
 *  NonceManager: ethers populates from getTransactionCount("pending"), and
 *  Anvil's auto-mined pending block excludes mined txs — so the second
 *  deployment of a sequence would replay nonce 0 and fail with "nonce too
 *  low". The manager signs sequentially from the fetched count. */
function createEphemeralDeployer(rpcUrl: string): EphemeralWithSigner {
  const key = Wallet.createRandom().connect(new JsonRpcProvider(rpcUrl));
  const signer = new NonceManager(key);
  return {
    address: key.address.toLowerCase() as Address,
    signer,
    sendTransaction: async (tx: { to: Address; data: string; value?: bigint }) => {
      const response = await signer.sendTransaction({
        to: tx.to,
        data: tx.data,
        value: tx.value ?? 0n,
      });
      return response.hash as `0x${string}`;
    },
  };
}

// The wallet side of the host seam (browsers' injected providers only guarantee
// `request` (+`on`)) — the canonical shape lives in host-railgun.ts.

export interface RailgunDeployArgs {
  chainId: number;
  rpcUrl: string;
  provider: EIP1193Provider;
  account: string;
  /** Overrides the chain's wrapped base token as the broadcaster fee token. */
  feeTokenAddress?: Address | null;
  /**
   * Runs the deployment from the funded ephemeral signer — exactly the flow
   * the wallet-broadcast path runs from the connected signer.
   */
  deploy: (signer: Signer, deployer: Address) => Promise<void>;
  onStatus: (message: string) => void;
  onStage: (stage: string, phase: string) => void;
}

/**
 * The full private-deployment flow: resolve the funding source (e2e hook wins,
 * then the real engine bootstrap with broadcaster selection), fund an
 * ephemeral deployer, run the app's deployment from it, sweep the dust back.
 */
export async function deployViaRailgun(args: RailgunDeployArgs): Promise<void> {
  if (!isPrivacySupported(args.chainId)) {
    throw new Error("Private deployment is not available on this network (RAILGUN covers Ethereum, BNB Chain, Polygon, Arbitrum and Base).");
  }
  const host: RailgunHost = {
    chainId: args.chainId,
    rpcUrl: args.rpcUrl,
    provider: args.provider,
    account: args.account.toLowerCase() as Address,
    feeTokenAddress: args.feeTokenAddress === undefined ? wethForChain(args.chainId) : (args.feeTokenAddress ?? undefined),
    onStatus: args.onStatus,
  };
  const funding = await resolveRailgunFunding(host);
  const publicClient = viemPublicClientFor(args); // E-3 island (sweep reads balances)
  const ephemeral = createEphemeralDeployer(args.rpcUrl);
  args.onStatus(`Funding ephemeral deployer ${ephemeral.address} from the shielded balance…`);
  await deployPrivately(
    { funding, publicClient },
    {
      fundAmount: PRIVATE_DEPLOY_FUND_AMOUNT,
      ephemeral,
      deploy: (deployer) => args.deploy(ephemeral.signer, deployer),
    },
    args.onStage,
  );
}
