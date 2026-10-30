/**
 * Counterfactual deployments as API calls (the deploy-kit merge's framing):
 * a deployment is just a ContractCall to a CREATE2 factory — the resulting
 * address is precomputed, so later calls in the same multicall/pipeline can
 * target the not-yet-deployed contract.
 *
 *   const spec = { factory: CANONICAL_CREATE2, salt, initCode };
 *   const { address, calls } = withCounterfactualDeploy(spec, [
 *     { to: address, data: initializeCalldata },   // used before it exists
 *   ]);
 *   // execute `calls` in any context (direct, multicall, RAILGUN Relay Adapt)
 */
import { concat as concatHex, getCreate2Address, keccak256, zeroPadValue, type BytesLike } from "ethers";
import type { Address, ContractCall, Hex } from "./types.js";

/** The canonical CREATE2 deployer proxy (same address on every EVM chain). Its
 *  `deploy(bytes)` treats the first 32 bytes of the input as the salt. */
export const CANONICAL_CREATE2_FACTORY: Address = "0x4e59b44847b379578588920cA78FbF26c0B4956C";

/** CREATE2 address math: keccak256(0xff ‖ deployer(20B, unpadded) ‖ salt(32B) ‖ keccak256(initCode))[12:].
 *  (ethers' getCreate2Address implements exactly this; golden-vector tested.) */
export function precomputeCreate2Address(deployer: Address, salt: Hex, initCode: Hex): Address {
  return getCreate2Address(deployer, salt, keccak256(initCode)) as Address;
}

function concat(parts: Hex[]): Hex {
  return concatHex(parts as BytesLike[]) as Hex;
}

export interface CounterfactualDeploySpec {
  /** The CREATE2 factory the deploy call targets. */
  factory: Address;
  salt: Hex;
  initCode: Hex;
  /** Factory calldata encoder. Default: the canonical deployer's convention
   *  (raw salt ‖ initCode as the call data). */
  encodeDeploy?: (salt: Hex, initCode: Hex) => Hex;
}

/**
 * The deployment expressed as a ContractCall. Spending semantics: the factory
 * call moves no ERC-20s, so tokens stay undeclared (`tokens` omitted — RAILGUN
 * contexts refuse undeclared ERC-20 flows but a bare contract call has none).
 */
export function deployCall(spec: CounterfactualDeploySpec): ContractCall {
  const encode = spec.encodeDeploy ?? ((salt: Hex, initCode: Hex) => concat([zeroPadValue(salt, 32) as Hex, initCode]));
  return { to: spec.factory, data: encode(spec.salt, spec.initCode) };
}

/**
 * Prepend the deployment to a call list; returns the precomputed address for
 * use in the remaining calls. The deployment and its consumers land in ONE
 * atomic execution — no intermediate "deploy, wait, then use" round trip.
 */
export function withCounterfactualDeploy(
  spec: CounterfactualDeploySpec,
  calls: ContractCall[],
): { address: Address; calls: ContractCall[] } {
  return {
    address: precomputeCreate2Address(spec.factory, spec.salt, spec.initCode),
    calls: [deployCall(spec), ...calls],
  };
}
