<script lang="ts">
  /**
   * OwnerPicker — owner address field with live on-chain classification and an
   * optional create-a-Safe flow (master plan §4.3). Binds the chosen owner via
   * `bind:value`. All contract I/O goes through the passed provider/signer
   * getters so the component stays panel-agnostic.
   */
  import type { JsonRpcApiProvider, JsonRpcSigner } from "ethers";
  import { Button, TextFieldOutlined } from "m3-svelte";
  import {
    buildSafeSetupInitializer,
    classifyOwnerAddress,
    createSafe,
    parseOwnerList,
    predictSafeAddress,
    readProxyCreationCode,
    safeAddressesFromSearch,
    type SafeAddresses,
  } from "./safe.ts";

  interface Props {
    /** The selected owner (two-way bound). */
    value?: string;
    /** Read-only provider for classification and CREATE2 math. */
    provider?: JsonRpcApiProvider | null;
    /** Signing accessor; null when the wallet is disconnected (creation disabled). */
    getSigner?: (() => Promise<JsonRpcSigner>) | null;
    /** The connected account, prefilled as default owner / default Safe owner. */
    account?: string | null;
    /** Panel label for the owner role. */
    label?: string;
    /** The connected chain id (drives canonical Safe address selection). */
    chainId?: number;
  }

  let {
    value = $bindable(""),
    provider = null,
    getSigner = null,
    account = null,
    label = "Owner",
    chainId = 1,
  }: Props = $props();

  let status = $state("");
  let statusTone = $state<"info" | "error">("info");
  let safeOwners = $state("");
  let safeThreshold = $state("1");
  let safeSaltNonce = $state("0");
  let safeMessage = $state("");
  let creating = $state(false);

  // Prefill the owner with the connected account once it is known.
  $effect(() => {
    if (account && !value.trim()) value = account;
  });

  function resolveSafeAddresses(): SafeAddresses {
    const resolved = safeAddressesFromSearch(window.location.search, chainId);
    if (!resolved) {
      throw new Error(
        `Chain ${chainId} has no canonical Safe v1.4.1 deployment. Deploy a SafeProxyFactory locally and pass ?safefactory=0x…&safesingleton=0x…&safefallback=0x…`,
      );
    }
    return resolved;
  }

  let classifyToken = 0;
  async function classify(): Promise<void> {
    const token = ++classifyToken;
    const v = value.trim();
    if (!v) {
      status = "";
      return;
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(v)) {
      status = "Not a valid address.";
      statusTone = "error";
      return;
    }
    if (!provider) {
      status = "Connect to a network to verify this owner address.";
      return;
    }
    try {
      const found = await classifyOwnerAddress(provider, v);
      if (token !== classifyToken) return;
      if (found.kind === "zero") {
        status = "The zero address cannot own anything.";
        statusTone = "error";
      } else if (found.kind === "eoa") {
        status = "EOA — signs with a private key.";
        statusTone = "info";
      } else if (found.kind === "safe") {
        const count = found.owners?.length ?? 0;
        status = `Safe — ${count} owner${count === 1 ? "" : "s"}, threshold ${found.threshold}. Ownership actions run through its signers.`;
        statusTone = "info";
      } else {
        status = "Contract — not a Safe; make sure it can act as an owner.";
        statusTone = "error";
      }
    } catch {
      if (token === classifyToken) {
        status = "Owner address not reachable on this network.";
        statusTone = "error";
      }
    }
  }

  $effect(() => {
    void value;
    void provider;
    void chainId;
    void classify();
  });

  async function previewSafe(): Promise<string> {
    const addresses = resolveSafeAddresses();
    if (!provider) throw new Error("Connect to a network before creating a Safe.");
    const owners = parseOwnerList(safeOwners);
    const threshold = Number(safeThreshold);
    if (!Number.isSafeInteger(threshold) || threshold < 1 || threshold > owners.length) {
      throw new Error(`Threshold must be between 1 and the number of owners (${owners.length}).`);
    }
    const saltNonce = BigInt(safeSaltNonce || "0");
    const initializer = buildInitializer(addresses, owners, threshold);
    const proxyCreationCode = await readProxyCreationCode(provider, addresses.proxyFactory);
    return predictSafeAddress(addresses.proxyFactory, addresses.singleton, proxyCreationCode, initializer, saltNonce);
  }

  function buildInitializer(addresses: SafeAddresses, owners: string[], threshold: number): string {
    return buildSafeSetupInitializer(owners, threshold, addresses.fallbackHandler);
  }

  let previewToken = 0;
  async function onSafeInput(): Promise<void> {
    const token = ++previewToken;
    if (!safeOwners.trim()) {
      safeMessage = "";
      return;
    }
    try {
      const predicted = await previewSafe();
      if (token === previewToken) safeMessage = `Predicted Safe address: ${predicted}`;
    } catch (error) {
      if (token === previewToken) safeMessage = error instanceof Error ? error.message : String(error);
    }
  }

  function onCreateSafeClick(): void {
    void onCreateSafe()
      .then(() => undefined)
      .catch((e: unknown) => {
        safeMessage = e instanceof Error ? e.message : String(e);
      });
  }

  async function onCreateSafe(): Promise<void> {
    if (!getSigner || !provider) throw new Error("Connect a wallet before creating a Safe.");
    creating = true;
    try {
      const addresses = resolveSafeAddresses();
      const owners = parseOwnerList(safeOwners);
      const threshold = Number(safeThreshold);
      if (!Number.isSafeInteger(threshold) || threshold < 1 || threshold > owners.length) {
        throw new Error(`Threshold must be between 1 and the number of owners (${owners.length}).`);
      }
      const saltNonce = BigInt(safeSaltNonce || "0");
      const signer = await getSigner();
      const { address } = await createSafe(signer, provider, addresses, owners, threshold, saltNonce);
      value = address;
      safeMessage = `Safe deployed at ${address} — set as owner.`;
      void classify();
    } finally {
      creating = false;
    }
  }
</script>

<label class="owner-label" for="owner-picker-input">{label}</label>
<input
  id="owner-picker-input"
  bind:value={value}
  autocomplete="off"
  spellcheck="false"
  placeholder="0x… (wallet, Safe, or any contract that can own)"
  oninput={() => void classify()}
/>
<p class="owner-status" class:error={statusTone === "error"}>{status}</p>

<details>
  <summary>Or create a new Safe to own this deployment</summary>
  <TextFieldOutlined label="Safe owners (comma-separated addresses)" bind:value={safeOwners} oninput={() => void onSafeInput()} />
  <TextFieldOutlined label="Threshold" type="number" bind:value={safeThreshold} oninput={() => void onSafeInput()} />
  <TextFieldOutlined label="Salt nonce" type="number" bind:value={safeSaltNonce} oninput={() => void onSafeInput()} />
  <p class="safe-message">{safeMessage}</p>
  <Button variant="text" disabled={creating} onclick={onCreateSafeClick}>
    {creating ? "Creating…" : "Create Safe"}
  </Button>
  <p class="muted">
    Deploys a Safe (v1.4.1 canonical singletons) through SafeProxyFactory and sets it as the owner.
    Private chains and Anvil need a locally-deployed factory via ?safefactory=0x…&amp;safesingleton=0x…&amp;safefallback=0x…
  </p>
</details>

<style>
  .owner-label {
    display: block;
    margin: 0.5rem 0 0.25rem;
    font-size: 0.9rem;
  }
  #owner-picker-input {
    width: 100%;
  }
  .owner-status {
    min-height: 1.2rem;
    font-size: 0.85rem;
    opacity: 0.85;
  }
  .owner-status.error {
    color: var(--md-sys-color-error, #b3261e);
  }
  details {
    margin: 0.5rem 0 1rem;
  }
  summary {
    cursor: pointer;
    font-size: 0.9rem;
  }
  .safe-message {
    min-height: 1.2rem;
    font-size: 0.85rem;
    opacity: 0.85;
  }
  .muted {
    font-size: 0.8rem;
    opacity: 0.7;
  }
</style>
