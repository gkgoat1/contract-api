#!/usr/bin/env node
/**
 * IPFS publish: a directory (or file) → CID, with a written record.
 *
 * Providers (first configured wins), all PINNING locally where applicable:
 *   - ipfs CLI:  a local Kubo binary on PATH (`ipfs add -r` + `ipfs pin add`)
 *   - Kubo RPC:  IPFS_API (default http://127.0.0.1:5001) — `POST /api/v0/add?pin=true`
 *     plus an explicit `pin/add` afterwards (local pinning is the point)
 *   - Pinata:    PINATA_JWT — POST /pinning/pinFileToIPFS (remote pin)
 *
 *   --no-pin   compute the CID without pinning (add only)
 *
 * Usage:
 *   node scripts/ipfs-publish.mjs <path> [--name <pin name>] [--record <out.json>]
 *   node scripts/ipfs-publish.mjs dist --record dist/ipfs.json
 *
 * The record (default <path>/../ipfs.json when --record is relative) gets
 * { cid, provider, publishedAt, name? } so deployments can carry their content
 * address alongside.
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, basename } from "node:path";

const args = process.argv.slice(2);
const target = args[0];
if (!target) {
  console.error("usage: ipfs-publish.mjs <path> [--name n] [--record out.json]");
  process.exit(2);
}
const name = args.includes("--name") ? args[args.indexOf("--name") + 1] : basename(target);
const recordArg = args.includes("--record") ? args[args.indexOf("--record") + 1] : null;
const noPin = args.includes("--no-pin");

const IPFS_API = process.env.IPFS_API ?? "http://127.0.0.1:5001";
const PINATA_JWT = process.env.PINATA_JWT;

function* walk(p) {
  const st = statSync(p);
  if (st.isDirectory()) {
    for (const e of readdirSync(p)) yield* walk(join(p, e));
  } else {
    yield p;
  }
}

function buildForm(targetPath) {
  const form = new FormData();
  const st = statSync(targetPath);
  if (st.isDirectory()) {
    for (const f of walk(targetPath)) {
      const rel = relative(targetPath, f).split("/").join("/");
      form.append("file", new Blob([readFileSync(f)]), `${name}/${rel}`);
    }
  } else {
    form.append("file", new Blob([readFileSync(targetPath)]), basename(targetPath));
  }
  return form;
}

async function publishKubo(targetPath) {
  const form = buildForm(targetPath);
  const url = `${IPFS_API}/api/v0/add?recursive=true&wrap-with-directory=true&cid-version=1&pin=true`;
  const res = await fetch(url, { method: "POST", body: form });
  if (!res.ok) throw new Error(`kubo add failed: ${res.status} ${await res.text()}`);
  // NDJSON, one line per file; the last line is the root (wrapped dir).
  let root = null;
  for (const line of (await res.text()).trim().split("\n")) {
    root = JSON.parse(line);
  }
  return root.Hash;
}

async function publishPinata(targetPath) {
  const form = buildForm(targetPath);
  form.append("pinataMetadata", JSON.stringify({ name }));
  const res = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", {
    method: "POST",
    headers: { Authorization: `Bearer ${PINATA_JWT}` },
    body: form,
  });
  if (!res.ok) throw new Error(`pinata failed: ${res.status} ${await res.text()}`);
  return (await res.json()).IpfsHash;
}

async function cliAvailable() {
  try {
    const { execFileSync } = await import("node:child_process");
    execFileSync("ipfs", ["version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

async function main() {
  let cid, provider;
  const errors = [];
  if (await cliAvailable()) {
    try {
      cid = await publishIpfsCli(target);
      provider = "ipfs-cli (local pin)";
    } catch (e) {
      errors.push(e.message);
    }
  }
  if (!cid) {
    try {
      cid = await publishKubo(target);
      provider = `kubo:${IPFS_API} (local pin)`;
    } catch (e) {
      errors.push(e.message);
      if (PINATA_JWT) {
        cid = await publishPinata(target);
        provider = "pinata";
      } else {
        throw new Error(
          `no IPFS provider: ${errors.join("; ")}; install Kubo (ipfs CLI / IPFS_API) or set PINATA_JWT`,
        );
      }
    }
  }
  const record = { cid, provider, publishedAt: new Date().toISOString(), name };
  const recordPath = recordArg ?? join(target, "..", "ipfs.json");
  writeFileSync(recordPath, JSON.stringify(record, null, 2) + "\n");
  console.log(`ipfs: ${cid}  (${provider})`);
  console.log(`record: ${recordPath}`);
  console.log(`gateway: https://ipfs.io/ipfs/${cid}/`);
}

main().catch((e) => {
  console.error("ipfs-publish FAIL:", e.message);
  process.exit(1);
});
