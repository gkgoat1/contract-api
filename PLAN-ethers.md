# PLAN: ethers-only cutover (viem eliminated from first-party code)

**Status:** DRAFT — for owner + gkgoat-worker design coordination. The worker and
its packages (and RAILGUN itself) are ethers v6; contract-api and sc are still
viem in the contracts-adjacent core. We cut over to `ethers` only: one stack,
no duplicated encoding/RPC/signing code. This repo is the coordination point;
the worker co-designs and co-implements.

## Why this is safe, not just tidy

RAILGUN's `@railgun-community/wallet` and `/engine` depend on **ethers, not
viem** (wallet returns ethers `ContractTransaction`s; proofs sign via ethers
signers). Our railgun path today is viem plumbing around an ethers-native SDK —
an impedance layer we wrote and now get to delete. Everything else in the
stack (refuje, panels, sites, wallitify) is already ethers v6.

## Inventory (viem files)

- contract-api: 17 (`core/*` — types, deploy, direct, multicall, signers,
  smart-wallet, dispatch; `railgun/*` — engine, context, broadcaster,
  private-deploy; `host-railgun`, `private-coin`, `private-deploy`, testing).
- sc: 12 (consumers of the contexts + session plumbing).
- Zero viem anywhere else (dApps are already ethers).

## Design: what the ethers-only surface looks like

- **Types**: `Address`/`Hex` stay `0x${string}` template literals (identical in
  ethers code). viem `PublicClient`/`WalletClient` in context deps become ethers
  `Provider`/`Signer` (or the narrow `{ sendTransaction, call, getGasPrice,
  waitForTransactionReceipt, getTransactionCount }` shapes where testability
  matters — keep them narrow and mock-friendly).
- **Encoding**: `encodeFunctionData` → `ethers.Interface`; `decodeFunctionResult`
  → `Interface.decodeFunctionResult`; `keccak256/concat/padHex/getAddress` →
  ethers equivalents; **CREATE2 precompute → `ethers.getCreate2Address`**
  (deploy.ts simplifies to a thin wrapper + the factory-call framing stays).
- **Dispatch generator**: emit ethers-based dispatch (`Interface`-driven encode
  + decode); the `delegateSafe` marker and generated API are unchanged.
- **Railgun path**: keep the SDK calls as-is (they're ethers already); replace
  only our wrapper types — `publicClient.estimateFeesPerGas/waitForTransactionReceipt`
  → ethers `feeData`/`waitForTransactionReceipt`; broadcaster submission stays
  hex-in/hex-out (provider-agnostic).
- **Signer seam**: `ArbitrarySigner` is already signer-implementation-agnostic;
  stays as-is with the `Hex` alias unchanged.
- **What we do NOT touch**: `@railgun-community/*` internals, level-js/
  localforage, svelte components' runtime (OwnerPicker keeps working with
  ethers-typed props).

## Milestones (co-owned with the worker — see §Coordination)

| ID | Work | Done when |
|----|------|-----------|
| E-1 | core types + Hex/Address aliases + `Interface`-based encode helpers | tsc, no viem import in core |
| E-2 | host seams (host-railgun, private-coin, private-deploy) on ethers Provider/Signer | panels typecheck |
| E-3 | railgun engine/context/broadcaster wrapper types on ethers | railgun tests green |
| E-4 | dispatch generator emits ethers dispatch; regenerate + drift test | golden diff green |
| E-5 | sc's 12 files (consumers) | sc unit green |
| E-6 | testing doubles + docs; remove viem from deps entirely | node --test, all dApp builds + e2e |

Non-goals: changing RAILGUN SDK versions, touching the worker's own packages'
internals, performance tuning.

## Gates (every milestone)

- `npm run build` + `npm run typecheck` in contract-api; `node --test tests/`.
- sc: `npm run test:unit`; refuje/sphinc/autolift panels: svelte-check;
  markets + autolift sites: tsc + vite build + anvil e2e; wallitify extension e2e.
- `grep -rn 'from "viem"'` returns nothing outside node_modules (the final gate).

## Coordination with gkgoat-worker (open)

1. **Ownership**: proposed — worker takes E-3 (they know the railgun/4337
   executor paths best) + their packages' share; we take E-1/E-2/E-4 here, E-5
   jointly. Confirm or re-cut.
2. **Shared shapes**: the `ContractCall`, `ArbitrarySigner`, `WalletExecutor`,
   and narrow provider/submitter interfaces are the code-sharing boundary —
   agree the final shapes before E-1 lands (PR against this plan).
3. **Consumption**: they consume contract-api via file: dep today; decide
   whether they need a published/tagged version before E-5.
4. **Signer inventory**: they have smart-wallet x402 signer work in flight
   (Safe, Cells, 4337) — the E-1 `ArbitrarySigner` must cover their schemes;
   send their signer list for the shared-types review.
