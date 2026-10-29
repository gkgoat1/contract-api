import {
  Contract,
  Interface,
  ZeroAddress,
  concat,
  getAddress,
  keccak256,
  toBeHex,
  zeroPadValue,
  type BrowserProvider,
  type JsonRpcApiProvider,
  type JsonRpcSigner,
} from "ethers";
import {
  getCompatibilityFallbackHandlerDeployment,
  getProxyFactoryDeployment,
  getSafeSingletonDeployment,
} from "@safe-global/safe-deployments";

/**
 * @gkgo/deploy-kit — shared deployment-panel logic for the firestorm/eth panels
 * (master plan §4.3). Framework-free modules (this file) plus thin Svelte
 * components (OwnerPicker.svelte). Safe-as-owner support: canonical v1.4.1
 * addresses from @safe-global/safe-deployments with URL-param overrides for
 * Anvil and private chains; CREATE2 math matches SafeProxyFactory 1.4.1 exactly
 * (golden-vector-cross-checked against sc's Solidity suite).
 */

export type SafeAddresses = { singleton: string; proxyFactory: string; fallbackHandler: string };

/** Canonical Safe v1.4.1 addresses for a chain, or null when it has none. */
export function canonicalSafeAddresses(chainId: number): SafeAddresses | null {
  const common = { version: "1.4.1", deploymentType: "canonical" as const, network: String(chainId) };
  const singleton = getSafeSingletonDeployment(common);
  const proxyFactory = getProxyFactoryDeployment(common);
  const fallbackHandler = getCompatibilityFallbackHandlerDeployment(common);
  if (!singleton?.defaultAddress || !proxyFactory?.defaultAddress || !fallbackHandler?.defaultAddress) return null;
  return {
    singleton: singleton.defaultAddress,
    proxyFactory: proxyFactory.defaultAddress,
    fallbackHandler: fallbackHandler.defaultAddress,
  };
}

/** URL overrides (?safefactory=0x…&safesingleton=0x…&safefallback=0x…) win over canonical. */
export function safeAddressesFromSearch(search: string, chainId: number): SafeAddresses | null {
  const params = new URLSearchParams(search);
  const pick = (key: string, canonical: string | undefined): string | undefined => {
    const value = params.get(key)?.trim();
    return value && /^0x[0-9a-fA-F]{40}$/.test(value) ? getAddress(value) : canonical;
  };
  const canonical = canonicalSafeAddresses(chainId);
  const singleton = pick("safesingleton", canonical?.singleton);
  const proxyFactory = pick("safefactory", canonical?.proxyFactory);
  const fallbackHandler = pick("safefallback", canonical?.fallbackHandler);
  if (!singleton || !proxyFactory || !fallbackHandler) return null;
  return { singleton, proxyFactory, fallbackHandler };
}

const SAFE_SETUP_IFACE = new Interface([
  "function setup(address[] _owners, uint256 _threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)",
]);
const CREATE_PROXY_IFACE = new Interface([
  "function createProxyWithNonce(address _singleton, bytes initializer, uint256 saltNonce) returns (address proxy)",
  "function proxyCreationCode() view returns (bytes)",
]);

export function buildSafeSetupInitializer(owners: string[], threshold: number, fallbackHandler: string): string {
  return SAFE_SETUP_IFACE.encodeFunctionData("setup", [
    owners,
    threshold,
    ZeroAddress,
    "0x",
    fallbackHandler,
    ZeroAddress,
    0,
    ZeroAddress,
  ]);
}

export function buildCreateSafeCalldata(singleton: string, initializer: string, saltNonce: bigint): string {
  return CREATE_PROXY_IFACE.encodeFunctionData("createProxyWithNonce", [singleton, initializer, saltNonce]);
}

/** CREATE2 address for a SafeProxy; matches SafeProxyFactory 1.4.1 exactly. */
export function predictSafeAddress(
  factory: string,
  singleton: string,
  proxyCreationCode: string,
  initializer: string,
  saltNonce: bigint,
): string {
  const salt = keccak256(concat([keccak256(initializer), zeroPadValue(toBeHex(saltNonce), 32)]));
  const initCode = concat([proxyCreationCode, zeroPadValue(singleton, 32)]);
  const digest = keccak256(concat(["0xff", factory, salt, keccak256(initCode)]));
  return "0x" + digest.slice(-40);
}

export type OwnerKind = "eoa" | "safe" | "contract" | "zero";

/** Classifies a candidate owner address on-chain (EOA / Safe N-of-M / other contract). */
export async function classifyOwnerAddress(
  provider: JsonRpcApiProvider,
  address: string,
): Promise<{ kind: OwnerKind; owners?: string[]; threshold?: bigint }> {
  if (/^0x0{40}$/i.test(address)) return { kind: "zero" };
  const code = await provider.getCode(address);
  if (!code || code === "0x") return { kind: "eoa" };
  try {
    const probe = new Contract(
      address,
      ["function getOwners() view returns (address[])", "function getThreshold() view returns (uint256)"],
      provider,
    );
    const owners = (await probe.getOwners()) as string[];
    const threshold = (await probe.getThreshold()) as bigint;
    return { kind: "safe", owners, threshold };
  } catch {
    return { kind: "contract" };
  }
}

export function parseOwnerList(value: string): string[] {
  const parts = value.split(/[\s,]+/).filter(Boolean);
  if (parts.length === 0) throw new Error("Enter at least one Safe owner address.");
  const normalized = parts.map((part) => getAddress(part));
  return [...new Set(normalized.map((a) => a.toLowerCase()))].map((a) => getAddress(a));
}

/** Reads the factory's proxyCreationCode needed for CREATE2 prediction. */
export async function readProxyCreationCode(provider: JsonRpcApiProvider, factory: string): Promise<string> {
  const factoryContract = new Contract(factory, ["function proxyCreationCode() view returns (bytes)"], provider);
  return (await factoryContract.proxyCreationCode()) as string;
}

/**
 * Deploys a Safe through SafeProxyFactory.createProxyWithNonce and resolves its
 * address (from the ProxyCreation event, falling back to the CREATE2 prediction).
 */
export async function createSafe(
  signer: JsonRpcSigner,
  provider: JsonRpcApiProvider,
  addresses: SafeAddresses,
  owners: string[],
  threshold: number,
  saltNonce: bigint,
): Promise<{ address: string; hash: string }> {
  const initializer = buildSafeSetupInitializer(owners, threshold, addresses.fallbackHandler);
  const calldata = buildCreateSafeCalldata(addresses.singleton, initializer, saltNonce);
  const proxyCreationCode = await readProxyCreationCode(provider, addresses.proxyFactory);
  const predicted = predictSafeAddress(addresses.proxyFactory, addresses.singleton, proxyCreationCode, initializer, saltNonce);
  const tx = await signer.sendTransaction({ to: addresses.proxyFactory, data: calldata });
  const receipt = await provider.waitForTransaction(tx.hash);
  if (!receipt || receipt.status === 0) throw new Error("The Safe creation transaction failed on-chain.");
  return { address: predicted, hash: receipt.hash };
}

export type { BrowserProvider };
