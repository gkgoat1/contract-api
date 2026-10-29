/**
 * AutoLift funding-statement v2 ("ALT2") encoders — the canonical machine statement.
 *
 * Spec: autolift/CONTEXT-FUNDING-PLAN.md §3.2 / Appendix A. Byte identity across this
 * file, `autolift/crates/statement-v2` (Rust), and `autolift/src/FundsDataV2.sol`
 * (Solidity) is enforced by golden vectors at `autolift/test/.vectors/funds-data-v2.json`.
 */
import {
  bytesToHex,
  concat,
  hexToBytes,
  keccak256,
  numberToHex,
  stringToBytes,
  stringToHex,
  type Address,
  type Hex,
} from "viem";

export const FUNDS_DATA_V2_MAGIC = "ALT2";

/** Re-exported so vector tooling needs no direct viem resolution. */
export { keccak256 };

// ---------------------------------------------------------------------------
// Envelope types
// ---------------------------------------------------------------------------

export interface FundingPolicyV2 {
  /** Native-ETH gas float advanced at request time (0 = none; user self-funds). */
  advance: bigint;
  /** Payout ERC20 held by the Store. */
  coin: Address;
  refund: bigint;
  reward: bigint;
  /** Relative seconds; the Store adds block.timestamp at request time. */
  expirySeconds: bigint;
  /** Guest policy program; 0x00..0 = the Store's default imageId. */
  policyId: Hex;
  /** Explicit statement nonce (guest-visible id input). */
  nonce: bigint;
}

export type TextCheckV2 =
  | { tag: 0; offset: number; expected: Hex } // equals: bytes at offset
  | { tag: 1; substring: Hex } // contains: substring present
  | { tag: 2; digest: Hex } // sha256-eq: sha256(content) == digest
  | { tag: 3; maxLen: number }; // max-len: content length bound

export type ClaimV2 =
  | {
      kind: 0x01; // text-content (in-ZK)
      origin: string;
      contentDigest: Hex;
      checks: TextCheckV2[];
    }
  | { kind: 0x02; stmtHash: Hex } // registry-fact (existing OOV3 statement)
  | { kind: 0x03; subject: Hex; payloadDigest: Hex; signature: Hex } // RA-attested
  | { kind: 0x04; templateId: number; params: Hex }; // extern-statement

export interface FundsDataV2 {
  rpId: string;
  policy: FundingPolicyV2;
  claims: ClaimV2[];
  /** The existing funding/effect op stream, passed through untouched. */
  ops: Hex;
}

// ---------------------------------------------------------------------------
// Integer / bytes helpers (big-endian, fixed width)
// ---------------------------------------------------------------------------

const u16 = (n: number): Hex => numberToHex(n, { size: 2 });
const u32 = (n: number): Hex => numberToHex(n, { size: 4 });
const u64 = (n: bigint): Hex => numberToHex(n, { size: 8 });
const u128 = (n: bigint): Hex => numberToHex(n, { size: 16 });

class Reader {
  private bytes: Uint8Array;
  private pos = 0;
  constructor(hex: Hex) {
    this.bytes = hexToBytes(hex);
  }
  private take(n: number): Uint8Array {
    if (this.pos + n > this.bytes.length) throw new Error("fundsData v2: truncated");
    const out = this.bytes.slice(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  u8(): number {
    const b = this.take(1)[0];
    if (b === undefined) throw new Error("fundsData v2: truncated");
    return b;
  }
  u16(): number {
    return Number(BigInt(bytesToHex(this.take(2))));
  }
  u32(): number {
    return Number(BigInt(bytesToHex(this.take(4))));
  }
  u64(): bigint {
    return BigInt(bytesToHex(this.take(8)));
  }
  u128(): bigint {
    return BigInt(bytesToHex(this.take(16)));
  }
  addr(): Address {
    return bytesToHex(this.take(20)) as Address;
  }
  bytes32(): Hex {
    return bytesToHex(this.take(32));
  }
  rest(): Hex {
    const out = this.bytes.slice(this.pos);
    this.pos = this.bytes.length;
    return bytesToHex(out);
  }
  takeHex(n: number): Hex {
    return bytesToHex(this.take(n));
  }
}

// ---------------------------------------------------------------------------
// Encode / decode
// ---------------------------------------------------------------------------

export function encodeTextCheck(check: TextCheckV2): Hex {
  switch (check.tag) {
    case 0:
      return concat([numberToHex(0, { size: 1 }), u32(4 + hexToBytes(check.expected).length), u32(check.offset), check.expected]);
    case 1:
      return concat([numberToHex(1, { size: 1 }), u32(hexToBytes(check.substring).length), check.substring]);
    case 2:
      return concat([numberToHex(2, { size: 1 }), u32(32), check.digest]);
    case 3:
      return concat([numberToHex(3, { size: 1 }), u32(4), u32(check.maxLen)]);
  }
}

export function encodeClaim(claim: ClaimV2): Hex {
  let body: Hex;
  switch (claim.kind) {
    case 0x01: {
      const origin = stringToHex(claim.origin);
      const checks = concat(claim.checks.map(encodeTextCheck));
      body = concat([u16(hexToBytes(origin).length), origin, claim.contentDigest, u16(claim.checks.length), checks]);
      break;
    }
    case 0x02:
      body = claim.stmtHash;
      break;
    case 0x03:
      body = concat([claim.subject, claim.payloadDigest, claim.signature]);
      break;
    case 0x04:
      body = concat([u16(claim.templateId), claim.params]);
      break;
  }
  return concat([numberToHex(claim.kind, { size: 1 }), u32(hexToBytes(body).length), body]);
}

export function encodeFundsDataV2(input: FundsDataV2): Hex {
  const rpId = stringToHex(input.rpId);
  const { policy } = input;
  return concat([
    stringToHex(FUNDS_DATA_V2_MAGIC),
    u16(hexToBytes(rpId).length),
    rpId,
    "0xff",
    u128(policy.advance),
    policy.coin,
    u128(policy.refund),
    u128(policy.reward),
    u64(policy.expirySeconds),
    policy.policyId,
    u64(policy.nonce),
    u16(input.claims.length),
    ...input.claims.map(encodeClaim),
    input.ops,
  ]);
}

export function isFundsDataV2(data: Hex): boolean {
  return data.length >= 10 && data.slice(2, 10) === stringToHex(FUNDS_DATA_V2_MAGIC).slice(2);
}

export function decodeFundsDataV2(data: Hex): FundsDataV2 {
  if (!isFundsDataV2(data)) throw new Error("fundsData: not an ALT2 envelope");
  const r = new Reader(data);
  r.takeHex(4); // magic
  const rpIdLen = r.u16();
  const rpId = new TextDecoder().decode(hexToBytes(r.takeHex(rpIdLen)));
  if (r.u8() !== 0xff) throw new Error("fundsData v2: missing separator");
  const policy: FundingPolicyV2 = {
    advance: r.u128(),
    coin: r.addr(),
    refund: r.u128(),
    reward: r.u128(),
    expirySeconds: r.u64(),
    policyId: r.bytes32(),
    nonce: r.u64(),
  };
  const claims: ClaimV2[] = [];
  const claimsCount = r.u16();
  for (let i = 0; i < claimsCount; i++) {
    const kind = r.u8();
    const len = r.u32();
    const body = r.takeHex(len);
    const b = new Reader(body);
    if (kind === 0x01) {
      const originLen = b.u16();
      const origin = new TextDecoder().decode(hexToBytes(b.takeHex(originLen)));
      const contentDigest = b.bytes32();
      const checkCount = b.u16();
      const checks: TextCheckV2[] = [];
      for (let j = 0; j < checkCount; j++) {
        const tag = b.u8();
        const clen = b.u32();
        const cbody = b.takeHex(clen);
        if (tag === 0) {
          const cb = new Reader(cbody);
          checks.push({ tag: 0, offset: cb.u32(), expected: cb.rest() });
        } else if (tag === 1) checks.push({ tag: 1, substring: cbody });
        else if (tag === 2) checks.push({ tag: 2, digest: cbody });
        else if (tag === 3) checks.push({ tag: 3, maxLen: Number(BigInt(cbody)) });
        else throw new Error(`fundsData v2: unknown text check tag ${tag}`);
      }
      claims.push({ kind: 0x01, origin, contentDigest, checks });
    } else if (kind === 0x02) claims.push({ kind: 0x02, stmtHash: body });
    else if (kind === 0x03) {
      claims.push({ kind: 0x03, subject: b.bytes32(), payloadDigest: b.bytes32(), signature: b.rest() });
    } else if (kind === 0x04) {
      claims.push({ kind: 0x04, templateId: b.u16(), params: b.rest() });
    } else throw new Error(`fundsData v2: unknown claim kind ${kind}`);
  }
  return { rpId, policy, claims, ops: r.rest() };
}

// ---------------------------------------------------------------------------
// Statement templates (optimistic statement registry — CONTEXT-FUNDING-PLAN §3.4.2)
// Only genuinely non-programmable facts get templates.
// ---------------------------------------------------------------------------

/** template 0 (legacy byte-compat): litecoin block hash. */
export const TEMPLATE_LITECOIN_BLOCK_HASH = 0;
/** template 1: bitcoin block hash. */
export const TEMPLATE_BITCOIN_BLOCK_HASH = 1;

export function renderStatementTemplate(templateId: number, blockHash: Hex): string {
  // OZ Strings.toHexString(uint256) semantics: minimal-length (leading zero BYTES
  // dropped, first nonzero byte keeps both nibbles; all-zero renders "00"). Byte
  // identity with proposeExterns' on-chain rendering is load-bearing — a leading-zero
  // block hash must land on the same statement string.
  const full = blockHash.slice(2).toLowerCase().padStart(64, "0");
  let hex = full.replace(/^(00)+/, "");
  if (hex === "") hex = "00";
  if (templateId === TEMPLATE_LITECOIN_BLOCK_HASH)
    return `The following is a valid Litecoin block hash:0x${hex}`;
  if (templateId === TEMPLATE_BITCOIN_BLOCK_HASH)
    return `The following is a valid Bitcoin block hash:0x${hex}`;
  throw new Error(`unknown statement template ${templateId}`);
}

// ---------------------------------------------------------------------------
// Id / challenge derivation (must match the guest byte-for-byte)
// ---------------------------------------------------------------------------

/** Guest-visible request id for v2 envelopes: keccak256(cell ‖ nonce be64 ‖ fundsData). */
export function fundingRequestIdV2(cell: Address, nonce: bigint, fundsData: Hex): Hex {
  return keccak256(concat([cell, u64(nonce), fundsData]));
}

/** Passkey ceremony challenge: keccak256(id ‖ rpId as utf8). */
export function passkeyChallenge(id: Hex, rpId: string): Hex {
  return keccak256(concat([id, bytesToHex(stringToBytes(rpId))]));
}
