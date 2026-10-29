# @gkgo/contract-api

Contract interaction contexts and deployment helpers for the firestorm/eth
projects. **Deployments are just an API feature**: a deploy is a contract call to
a CREATE2 factory whose result address is precomputed counterfactually, so later
calls in the same multicall/pipeline can target the not-yet-deployed contract.

This repo merges what used to be `sc/packages/contract-api` (contexts) and
`eth/deploy-kit` (deploy panels' helpers) into one package.

## Layout

- `src/core/` — the context model: `ContractCall` (with mandatory `tokens`
  spends/receives declarations), direct EOA execution, Multicall3, pipelines,
  the context registry, and `deploy.ts` (counterfactual CREATE2:
  `precomputeCreate2Address`, `deployCall`, `withCounterfactualDeploy`).
- `src/railgun/` — the RAILGUN context (Relay Adapt unshield→calls→reshield),
  engine SDK binding, broadcaster selection, private-deploy funding source.
- `src/testing/` — test doubles.
- `src/private-coin.ts` — runtime coin interactions over RAILGUN for dApps
  (`runCoinsPrivately`, `quoteCoinsPrivately`, `shieldErc20`); e2e hook
  `window.__contractApiFunding`.
- `src/private-deploy.ts` — private contract deployment (RAILGUN-funded
  ephemeral deployer; ethers glue).
- `src/host-railgun.ts` — the browser host seam (EIP-1193 + RPC in, engine
  bootstrap, sessions, broadcaster-aware contexts).
- `src/safe.ts` — Safe-as-owner logic (CREATE2 math matches SafeProxyFactory
  1.4.1; golden-vector cross-checked).
- `src/OwnerPicker.svelte` — Svelte 5 owner field with live classification.
- `src/funds-data-v2.ts` — autolift funds-data-v2 envelope codec.

## Consumption

- Built entry points (tsc → dist): `@gkgo/contract-api` (core),
  `/testing`, `/railgun`.
- Source-level (vite/svelte compile TS directly): `@gkgo/contract-api/src/*`.

## Gates

- `npm run build` (tsc, NodeNext, core/railgun/testing → dist)
- `npm run typecheck` (whole src incl. the .ts-extension source files)
- `npm test` (node --test; 34 tests incl. the CREATE2 golden vector)

Deps install with `npm install --legacy-peer-deps` (railgun shared-models pins
ethers@6.14.3 exactly; we support newer ethers in practice).
