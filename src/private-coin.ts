/**
 * Runtime coin interactions over RAILGUN (the generalization of
 * private-deploy.ts's deploy-time funding): unshield exact spends into Relay
 * Adapt, run the dApp's calls atomically, re-shield every declared output — one
 * transaction, submitted via a broadcaster (unlinkable) or self-signed.
 *
 * Every dApp (markets, refuje, autolift, …) routes runtime coin movements
 * through this module so privacy is a per-interaction choice, not a per-app
 * feature:
 *
 *   await runCoinsPrivately(host, [
 *     { to: token, data: approveCall, spends: [] },
 *     { to: event, data: depositCall,
 *       spends: [{ token: underlying, amount }], receives: [outcomeToken] },
 *   ]);
 *
 * `spends`/`receives` declarations are mandatory — they drive the exact
 * unshield and the complete re-shield (undeclared flows are refused by the
 * context as a funds-safety measure). Calls execute with Relay Adapt as
 * msg.sender: tokens a call produces land in Relay Adapt and are re-shielded,
 * so positions obtained this way live in the user's shielded balance, not on
 * their public address.
 */
import type { Address, Hex } from "viem";
import type { ContractCall, ExecutionQuote, ExecutionResult } from "@gkgo/contract-api";
import { isPrivacySupported, resolveRailgunContext, type RailgunHost } from "./host-railgun.ts";

export { isPrivacySupported };

export interface CoinCall {
  to: Address;
  data: Hex;
  /** ERC-20s this call pulls out of Relay Adapt (must be unshielded exactly). */
  spends?: { token: Address; amount: bigint }[];
  /** Every ERC-20 this call can leave in Relay Adapt (re-shielded afterwards). */
  receives?: Address[];
}

function toContractCall(call: CoinCall): ContractCall {
  return {
    to: call.to,
    data: call.data,
    tokens: {
      spends: (call.spends ?? []).map((s) => ({ token: s.token, amount: s.amount })),
      receives: (call.receives ?? []).map((token) => ({ token })),
    },
  };
}

/**
 * Quote a private execution (gas + RAILGUN context fees) without proving.
 * Throws when privacy is unsupported on the chain or a call is undeclared.
 */
export async function quoteCoinsPrivately(host: RailgunHost, calls: CoinCall[]): Promise<ExecutionQuote> {
  if (!isPrivacySupported(host.chainId)) {
    throw new Error(`RAILGUN is not available on chain ${host.chainId}.`);
  }
  const ctx = await resolveRailgunContext(host);
  return ctx.quote(calls.map(toContractCall));
}

/**
 * Run coin interactions privately: one atomic RAILGUN transaction executing
 * the calls in order, outputs re-shielded to the user's 0zk address. Returns
 * the execution result (tx hashes); progress phases stream to onStatus.
 */
export async function runCoinsPrivately(
  host: RailgunHost,
  calls: CoinCall[],
  onStatus: (message: string) => void = () => undefined,
): Promise<ExecutionResult> {
  if (!isPrivacySupported(host.chainId)) {
    throw new Error(`RAILGUN is not available on chain ${host.chainId}.`);
  }
  const ctx = await resolveRailgunContext(host);
  const gen = ctx.execute(calls.map(toContractCall), {
    onProgress: (p: number) => onStatus(`proving ${(p * 100).toFixed(0)}%`),
  });
  // Drive manually (for-await discards the generator's return value).
  let step = await gen.next();
  while (!step.done) {
    const event = step.value;
    if (event.phase === "failed") throw event.error;
    if (event.phase !== "proving") {
      onStatus(event.phase === "confirmed" ? `confirmed: ${event.txHash}` : event.phase);
    }
    step = await gen.next();
  }
  return step.value;
}

/**
 * Shield ERC-20 into the user's RAILGUN balance (the on-ramp for private
 * interactions). Shielding is a public transaction by construction — privacy
 * starts inside the shielded pool — so the connected wallet signs directly.
 */
export async function shieldErc20(
  host: RailgunHost & { railgunAddress: string; shieldPrivateKey: string },
  token: Address,
  amount: bigint,
): Promise<{ to: Address; data: Hex }> {
  const { populateShield } = await import("@railgun-community/wallet");
  const { TXIDVersion } = await import("@railgun-community/shared-models");
  const { networkNameForChain } = await import("@gkgo/contract-api/railgun");
  const networkName = networkNameForChain(host.chainId);
  if (!networkName) throw new Error(`RAILGUN is not available on chain ${host.chainId}.`);
  const populated = await populateShield(
    TXIDVersion.V2_PoseidonMerkle,
    networkName,
    host.shieldPrivateKey,
    [{ tokenAddress: token, amount, recipientAddress: host.railgunAddress }],
    [],
  );
  const tx = populated.transaction;
  return { to: tx.to as Address, data: (tx.data ?? "0x") as Hex };
}
