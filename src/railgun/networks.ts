import { NetworkName } from "@railgun-community/shared-models";

/** Chain ids with RAILGUN deployments (shared-models 8.2.x). Optimism is NOT covered —
 *  asserted below so its absence stays a decision, not an accident. */
export const RAILGUN_CHAIN_IDS: readonly number[] = [1, 56, 137, 42161, 8453, 31337];

const NETWORK_BY_CHAIN_ID = new Map<number, NetworkName>([
  [1, NetworkName.Ethereum],
  [56, NetworkName.BNBChain],
  [137, NetworkName.Polygon],
  [42161, NetworkName.Arbitrum],
  [8453, NetworkName.Base],
  [31337, NetworkName.Hardhat],
]);

export function networkNameForChain(chainId: number): NetworkName | undefined {
  return NETWORK_BY_CHAIN_ID.get(chainId);
}

export function chainIdForNetwork(name: NetworkName): number | undefined {
  for (const [chainId, networkName] of NETWORK_BY_CHAIN_ID) {
    if (networkName === name) return chainId;
  }
  return undefined;
}
