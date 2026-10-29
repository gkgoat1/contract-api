/**
 * Arbitrary signers for smart contract wallets: the signer is any key type
 * (ECDSA, SLH-DSA, passkey-derived, Safe-owner compound, …) producing a
 * signature FOR a contract wallet; validity is checked ahead-of-time against
 * the contract's ERC-1271 `isValidSignature` before anything executes.
 */
import type { Address, Hex, PublicClient } from "viem";

/** A signer whose signatures authorize a contract wallet (or any contract). */
export interface ArbitrarySigner {
  /** The contract the signatures are validated against (the wallet). */
  address: Address;
  /** Sign a 32-byte digest. Format is the contract's own (bare, wrapped, raw PQ…). */
  sign(digest: Hex): Promise<Hex>;
}

const IERC1271_ABI = [
  {
    type: "function",
    name: "isValidSignature",
    stateMutability: "view",
    inputs: [
      { name: "hash", type: "bytes32" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [{ name: "magicValue", type: "bytes4" }],
  },
] as const;

const ERC1271_MAGIC = "0x1626ba7e";

/**
 * Ahead-of-time validity check: staticcall the contract's ERC-1271
 * isValidSignature. Returns false (never throws) on revert / wrong magic.
 */
export async function verifyContractSignature(
  publicClient: PublicClient,
  contract: Address,
  hash: Hex,
  signature: Hex,
): Promise<boolean> {
  try {
    const result = await publicClient.readContract({
      address: contract,
      abi: IERC1271_ABI,
      functionName: "isValidSignature",
      args: [hash, signature],
    });
    return (result as string).toLowerCase() === ERC1271_MAGIC;
  } catch {
    return false;
  }
}

/**
 * Sign and check ahead-of-time: the signature is verified against the contract
 * BEFORE it is relied on (execution, submission, storage). Throws when invalid.
 */
export async function signAndVerify(
  signer: ArbitrarySigner,
  digest: Hex,
  publicClient: PublicClient,
): Promise<Hex> {
  const signature = await signer.sign(digest);
  const ok = await verifyContractSignature(publicClient, signer.address, digest, signature);
  if (!ok) {
    throw new Error(`signature rejected by ${signer.address}'s isValidSignature (checked ahead-of-time)`);
  }
  return signature;
}
