/**
 * Shared RAILGUN plumbing for the deploy panels (master plan §6.5 / T-2.4):
 * a framework-free port of sc's railgun-session.ts + privacy.ts so the
 * refuje console and the sphinc-wallet/autolift panels all share one
 * implementation.
 *
 * The host seam is deliberately tiny — the connected wallet is represented by
 * a raw EIP-1193 provider (viem wraps it for signing/calls), and the ephemeral
 * deployer is injected by the app (ethers, viem, whatever it already uses):
 *
 *   const funding = await bootstrapRailgunFunding({ chainId, rpcUrl, provider, account, feeTokenAddress });
 *   await deployPrivately(
 *     { funding, publicClient: createPublicClient(...) },
 *     { fundAmount: ..., ephemeral: { address, sendTransaction }, deploy: (deployer) => ... },
 *   );
 *
 * Heavy, Node-oriented modules (@railgun-community/wallet, engine, level-js,
 * localforage) load lazily and only when privacy mode actually runs.
 */
import { BrowserProvider, JsonRpcProvider, keccak256 } from "ethers";
// E-3 ISLAND (deleted when the railgun internals take ReadProvider): the sdk and
// context deps still speak viem PublicClient until the worker's E-3 lands.
import { createPublicClient, http, type PublicClient as ViemPublicClient } from "viem";
import type { Address, Hex, ReadProvider, WriteSigner } from "./core/types.js";

/** Raw EIP-1193 request shape (what window.ethereum exposes). */
export interface EIP1193Provider {
  request(args: { method: string; params?: unknown[] | Record<string, unknown> }): Promise<unknown>;
}
import { NETWORK_CONFIG } from "@railgun-community/shared-models";
import {
  createRailgunContext,
  createRailgunSdk,
  networkNameForChain,
  unshieldFeeBpsForChain,
  type BroadcasterSelection,
  type FundingSource,
} from "@gkgo/contract-api/railgun";
import type { ContractCall, ExecutionEvent, ExecutionQuote, ExecutionResult } from "@gkgo/contract-api";

/** Chains where private (RAILGUN) execution is offered (re-exported for UI gating). */
export { RAILGUN_CHAIN_IDS } from "@gkgo/contract-api/railgun";

export function isPrivacySupported(chainId: number | undefined): boolean {
  return chainId !== undefined && networkNameForChain(chainId) !== undefined;
}

/** E-3 island: the viem read client the railgun internals still expect. */
export function viemPublicClientFor(host: { rpcUrl: string }): ViemPublicClient {
  return createPublicClient({ transport: http(host.rpcUrl) });
}

/** ethers read provider for the host's own calls. */
export function ethersReadProvider(host: { rpcUrl: string; chainId: number }): JsonRpcProvider {
  return new JsonRpcProvider(host.rpcUrl, host.chainId);
}

/** ethers signer over the host's EIP-1193 provider (signMessage + sendTransaction). */
export async function ethersHostSigner(
  host: RailgunHost,
): Promise<WriteSigner & { signMessage(message: string): Promise<string> }> {
  const bp = new BrowserProvider(host.provider as never, host.chainId);
  return (await bp.getSigner(host.account)) as never;
}


/** Anything that can send a transaction from the ephemeral deployer identity. */
export interface EphemeralDeployer {
  address: Address;
  sendTransaction(tx: { to: Address; data: Hex; value?: bigint }): Promise<Hex>;
}

/**
 * Fixed derivation message: one wallet signature deterministically derives both
 * the RAILGUN encryption key and the wallet mnemonic (the Railway-style
 * signature-derived wallet). It authorizes nothing and costs no gas.
 */
const RAILGUN_DERIVATION_MESSAGE =
  "Sign this message to derive your RAILGUN credentials for the token dashboard.\n\n" +
  "This is not a transaction and costs no gas.";

/** The engine is a page-lifetime singleton. */
let engineStarted = false;

export interface RailgunHost {
  chainId: number;
  /** The app's configured RPC URL for the chain (provider load + public calls). */
  rpcUrl: string;
  /** The connected wallet's raw EIP-1193 provider (signs derivation + self-submits). */
  provider: EIP1193Provider;
  /** The connected account. */
  account: Address;
  /** ERC-20 the broadcaster fee is paid in (the chain's wrapped base token);
   *  enables anonymous broadcaster-submitted funding. */
  feeTokenAddress?: Address;
  onStatus?: (message: string) => void;
}

export interface RailgunSession {
  sdk: ReturnType<typeof createRailgunSdk>;
  railgunAddress: string;
  /** Derived shield key (public shield transactions are signed by this key's
   *  owner — the host wallet). Needed for the ERC-20 shield on-ramp. */
  shieldPrivateKey: string;
  chainId: number;
  unshieldFeeBps: bigint;
  selfSubmit: (tx: { to: Address; data: Hex; value?: bigint }) => Promise<Hex>;
  /** Build the execution context, optionally with a broadcaster selection. */
  contextWith: (broadcaster?: BroadcasterSelection) => ReturnType<typeof createRailgunContext>;
}

/**
 * The broadcaster fee for a transaction: the broadcaster's per-gas token rate
 * times the estimated gas, via the wallet SDK's fee calculator.
 */
export async function calculateBroadcasterFee(opts: {
  feeTokenAddress: Address;
  feePerUnitGas: bigint;
  gasEstimate: bigint;
  /** E-3 island: viem client until the railgun internals take ReadProvider. */
  publicClient: ViemPublicClient;
}): Promise<bigint> {
  const { calculateBroadcasterFeeERC20Amount } = await import("@railgun-community/wallet");
  const fees = await opts.publicClient.estimateFeesPerGas();
  const fee = calculateBroadcasterFeeERC20Amount(
    { tokenAddress: opts.feeTokenAddress, feePerUnitGas: opts.feePerUnitGas },
    {
      evmGasType: 2, // EVMGasType.Type2 — EIP-1559 chains
      gasEstimate: opts.gasEstimate,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    },
  );
  return fee.amount;
}

/**
 * Funding-source view of the session (private-deploy pipeline).
 *
 * With a fee token configured, funding selects a Broadcaster and the unshield
 * is submitted over Waku — the connected wallet never signs, so the
 * wallet→ephemeral-deployer link disappears from the chain. Without one (or
 * when no broadcaster is available for the fee token), it falls back to a
 * self-signed submission and the submitter is visible on-chain.
 */
export async function bootstrapRailgunFunding(host: RailgunHost): Promise<FundingSource> {
  const session = await bootstrapRailgunSessionInner(host);
  if (!host.feeTokenAddress) {
    return session.contextWith();
  }
  const status = host.onStatus ?? ((): void => undefined);
  const publicClient = viemPublicClientFor(host);
  const { selectBroadcasterForContext } = await import("./railgun/index.js");
  try {
    // A shape-only estimate: the unshield's gas is roughly constant for a given
    // amount; the SDK prices the broadcaster fee from the selected broadcaster's
    // feePerUnitGas when it populates the funding transaction.
    const gasEstimate = await session.sdk.estimateNativeUnshield({
      to: host.account,
      amount: 0n,
      sendWithPublicWallet: false,
    });
    const feeAmount = await calculateBroadcasterFee({
      feeTokenAddress: host.feeTokenAddress,
      feePerUnitGas: 1n,
      gasEstimate,
      publicClient,
    });
    const selection = await selectBroadcasterForContext({
      chainId: host.chainId,
      feeTokenAddress: host.feeTokenAddress,
      feeAmount,
      overallBatchMinGasPrice: (await publicClient.estimateFeesPerGas()).maxFeePerGas ?? 0n,
      onStatus: (s) => status(`broadcaster: ${s}`),
    });
    status("broadcaster selected — funding will be submitted anonymously over Waku");
    return session.contextWith(selection);
  } catch (error) {
    status(
      `broadcaster selection failed (${error instanceof Error ? error.message : String(error)}); ` +
        "falling back to a self-signed funding submission — the submitting wallet will be visible on-chain",
    );
    return session.contextWith();
  }
}

/** Bootstrap the engine + wallet session directly (runtime coin interactions
 *  that need the 0zk address / shield key, not just a funding context). */
export async function bootstrapRailgunSession(host: RailgunHost): Promise<RailgunSession> {
  return bootstrapRailgunSessionInner(host);
}

async function bootstrapRailgunSessionInner(host: RailgunHost): Promise<RailgunSession> {
  const networkName = networkNameForChain(host.chainId);
  if (!networkName) throw new Error(`RAILGUN is not available on chain ${host.chainId}.`);
  const status = host.onStatus ?? ((): void => undefined);

  const wallet = await import("@railgun-community/wallet");
  const { Mnemonic } = await import("@railgun-community/engine");
  // SAFETY: level-js ships no TypeScript types; every consumer toolchain
  // resolves it to the untyped JS, so the boundary is suppressed at the
  // import (ambient stubs and paths mappings do not survive svelte-check).
  // @ts-ignore untyped vendored dependency
  const { default: Level } = await import("level-js");
  const { default: localforage } = await import("localforage");

  const signer = await ethersHostSigner(host);
  const publicClient = viemPublicClientFor(host);

  if (!engineStarted) {
    status("Starting the RAILGUN engine (first run downloads proving artifacts)…");
    const artifactStore = new wallet.ArtifactStore(
      async (path) => (await localforage.getItem(`rg-artifact:${path}`)) as string | null,
      async (_dir, path, item) => {
        await localforage.setItem(`rg-artifact:${path}`, item);
      },
      async (path) => (await localforage.getItem(`rg-artifact:${path}`)) !== null,
    );
    await wallet.startRailgunEngine(
      "gkgo-deploy-kit",
      // SAFETY: untyped boundary — level-js implements the AbstractLevelDOWN
      // interface the engine expects but ships no TypeScript types.
      new Level("railgun-deploy-kit") as never,
      false,
      artifactStore,
      false, // useNativeArtifacts: false → wasm artifacts via the store (browser)
      false, // do not skip merkletree scans
    );
    engineStarted = true;
  }

  status("Deriving RAILGUN credentials (one signature)…");
  const signature = await signer.signMessage(RAILGUN_DERIVATION_MESSAGE);
  const encryptionKey = keccak256(signature);
  const mnemonic = Mnemonic.fromEntropy(encryptionKey);

  const info = await wallet.createRailgunWallet(encryptionKey, mnemonic, undefined);

  status("Connecting the RAILGUN provider…");
  await wallet.loadProvider(
    { chainId: host.chainId, providers: [{ provider: host.rpcUrl, priority: 1, weight: 1 }] },
    networkName,
  );

  const shieldPrivateKey = keccak256(
    await signer.signMessage(wallet.getShieldPrivateKeySignatureMessage()),
  );

  status("Syncing shielded balances (QuickSync)…");
  await wallet.refreshBalances(NETWORK_CONFIG[networkName].chain, [info.id]);

  const sdk = createRailgunSdk({
    chainId: host.chainId,
    railgunWalletId: info.id,
    encryptionKey,
    publicClient,
    publicWalletAddress: host.account,
    shieldPrivateKey,
    railgunAddress: info.railgunAddress,
  });

  const selfSubmit = async (tx: { to: Address; data: Hex; value?: bigint }): Promise<Hex> =>
    (await signer.sendTransaction({ to: tx.to, data: tx.data, value: tx.value })).hash as Hex;

  return {
    sdk,
    railgunAddress: info.railgunAddress,
    shieldPrivateKey,
    chainId: host.chainId,
    unshieldFeeBps: unshieldFeeBpsForChain(host.chainId),
    selfSubmit,
    contextWith: (broadcaster?: BroadcasterSelection) =>
      createRailgunContext({
        chainId: host.chainId,
        railgunAddress: info.railgunAddress,
        sdk,
        publicClient,
        unshieldFeeBps: unshieldFeeBpsForChain(host.chainId),
        broadcaster,
        // Self-signed fallback: the submitting wallet is visible on-chain.
        selfSubmit,
      }),
  };
}

export interface PrivateDeploymentOpts {
  /** Native gas to unshield into the ephemeral deployer. */
  fundAmount: bigint;
  /** The ephemeral deployer identity (app-provided: ethers/viem/…). */
  ephemeral: EphemeralDeployer;
  /**
   * Runs the app's deployment flow with the ephemeral deployer installed as
   * the active signer. Must return once the deployment is complete.
   */
  deploy: (deployer: Address) => Promise<void>;
}

export interface PrivateDeploymentCtx {
  funding: FundingSource;
  /** E-3 island: viem client until the railgun internals take ReadProvider. */
  publicClient: ViemPublicClient;
}

/**
 * Private deployment: RAILGUN funds an ephemeral EOA, the app's unchanged
 * deployment flow runs from it, leftover gas is shielded back. Deployment
 * semantics (salts, canonical addresses) are untouched — only the funding
 * link is broken.
 */
export async function deployPrivately(
  ctx: PrivateDeploymentCtx,
  opts: PrivateDeploymentOpts,
  onStage: (stage: string, phase: string) => void = () => undefined,
): Promise<void> {
  for await (const event of ctx.funding.fund(opts.ephemeral.address, opts.fundAmount)) {
    onStage("fund", event.phase);
    if (event.phase === "failed") throw event.error;
  }
  try {
    await opts.deploy(opts.ephemeral.address);
    onStage("deploy", "confirmed");
  } finally {
    // Sweep leftover gas back into the shielded balance (keep a reserve for
    // the sweep transaction's own gas).
    const reserve = 1_000_000_000_000_000n; // 0.001 native
    const balance = await ctx.publicClient.getBalance({ address: opts.ephemeral.address }).catch(() => 0n);
    const amount = balance - reserve;
    if (amount > 0n) {
      try {
        const shieldTx = await ctx.funding.buildNativeShield(amount, opts.ephemeral.address);
        await opts.ephemeral.sendTransaction({
          to: shieldTx.to,
          data: shieldTx.data,
          value: shieldTx.value,
        });
        onStage("sweep", "confirmed");
      } catch {
        onStage("sweep", "skipped");
      }
    }
  }
}

/** e2e hook: apps call resolveRailgunFunding, which defers to this when set. */
export type RailgunFundingHook = () => Promise<FundingSource>;

declare global {
  interface Window {
    /** Test hook: e2e injects a funding stand-in here. */
    __contractApiFunding?: RailgunFundingHook;
  }
}

/**
 * Resolve the RAILGUN funding source for a private deployment: the e2e mock
 * hook wins when present, otherwise the real engine bootstrap (lazy — the zk
 * stack only loads on first use).
 */
export async function resolveRailgunFunding(host: RailgunHost): Promise<FundingSource> {
  if (typeof window !== "undefined" && window.__contractApiFunding) {
    return window.__contractApiFunding();
  }
  return bootstrapRailgunFunding(host);
}

/**
 * The full runtime context for coin interactions (quote + execute), e2e
 * hookable the same way. FundingSource is the narrow deploy-time surface; this
 * is the full one.
 */
export type RailgunRuntimeContext = FundingSource & {
  quote: (calls: ContractCall[]) => Promise<ExecutionQuote>;
  execute: (
    calls: ContractCall[],
    opts?: { onProgress?: (progress: number) => void },
  ) => AsyncGenerator<ExecutionEvent, ExecutionResult>;
};

export async function resolveRailgunContext(host: RailgunHost): Promise<RailgunRuntimeContext> {
  if (typeof window !== "undefined" && window.__contractApiFunding) {
    return window.__contractApiFunding() as Promise<RailgunRuntimeContext>;
  }
  return bootstrapRailgunFunding(host) as Promise<RailgunRuntimeContext>;
}
