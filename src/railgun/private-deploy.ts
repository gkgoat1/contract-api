import type { Address, Chain, PublicClient, WalletClient } from "viem";
import { DirectContext } from "../core/direct.js";
import type {
  ContractCall,
  ExecutionResult,
  PipelineEvent,
  PipelineResult,
  StageOutput,
} from "../core/types.js";
import type { PopulatedRailgunTransaction } from "./types.js";

/**
 * Anything that can privately fund an ephemeral deployer and build a shield
 * transaction for the sweep. RailgunContext satisfies this; tests substitute
 * mocks.
 */
export interface FundingSource {
  fund(
    to: Address,
    amount: bigint,
    opts?: { onProgress?: (progress: number) => void },
  ): AsyncGenerator<import("../core/types.js").ExecutionEvent, ExecutionResult>;
  buildNativeShield(amount: bigint, fromWalletAddress: Address): Promise<PopulatedRailgunTransaction>;
}

export interface PrivateDeployDeps {
  /** Funding source: unshields native gas to the ephemeral deployer. */
  funding: FundingSource;
  publicClient: PublicClient;
  /** A freshly generated, never-before-used account. */
  ephemeralWalletClient: WalletClient;
  ephemeralAccount: Address;
  chain: Chain;
  /** Native amount to unshield into the ephemeral deployer. */
  fundAmount: bigint;
  /** The deployment calls, built once the deployer address is known. */
  buildDeployCalls: (deployer: Address) => Promise<ContractCall[]>;
  /**
   * Shield leftover gas back into the private balance, keeping `reserve` for
   * the sweep transaction's own gas. `false` leaves the dust (documented).
   * Default: sweep with a 0.001 native reserve.
   */
  sweep?: { reserve: bigint } | false;
}

/**
 * The private-deployment pipeline (plan, section 3): RAILGUN funds an
 * ephemeral EOA (unlinkable via Broadcaster submission), the unchanged
 * direct/deployment flow runs from it, and leftover gas is shielded back.
 * Deployment semantics — salts, canonical addresses, gas profile — are
 * untouched; only the funding link is broken.
 */
export async function* runPrivateDeploy(
  deps: PrivateDeployDeps,
): AsyncGenerator<PipelineEvent, PipelineResult> {
  const outputs: StageOutput[] = [];

  async function* runStage(
    name: string,
    stream: AsyncGenerator<
      import("../core/types.js").ExecutionEvent,
      ExecutionResult
    >,
  ): AsyncGenerator<PipelineEvent, ExecutionResult> {
    yield { type: "stage-started", stage: name };
    let step = await stream.next();
    while (!step.done) {
      yield { type: "stage-event", stage: name, event: step.value };
      if (step.value.phase === "failed") throw step.value.error;
      step = await stream.next();
    }
    outputs.push({ stage: name, result: step.value });
    yield { type: "stage-finished", stage: name, result: step.value };
    return step.value;
  }

  // Stage 1: fund the ephemeral deployer from the shielded balance.
  for await (const event of runStage("fund", deps.funding.fund(deps.ephemeralAccount, deps.fundAmount))) {
    yield event;
  }

  // Stage 2: deploy from the ephemeral EOA via the direct context.
  const direct = new DirectContext({
    walletClient: deps.ephemeralWalletClient,
    publicClient: deps.publicClient,
    account: deps.ephemeralAccount,
    chain: deps.chain,
  });
  const deployCalls = await deps.buildDeployCalls(deps.ephemeralAccount);
  for await (const event of runStage("deploy", direct.execute(deployCalls))) {
    yield event;
  }

  // Stage 3: sweep leftover gas back into the shielded balance.
  const sweep = deps.sweep ?? { reserve: 1_000_000_000_000_000n }; // 0.001
  if (sweep !== false) {
    const balance = await deps.publicClient.getBalance({ address: deps.ephemeralAccount });
    const amount = balance - sweep.reserve;
    if (amount > 0n) {
      const shieldTx = await deps.funding.buildNativeShield(amount, deps.ephemeralAccount);
      for await (const event of runStage(
        "sweep",
        direct.execute([{ to: shieldTx.to, data: shieldTx.data, value: shieldTx.value }]),
      )) {
        yield event;
      }
    }
  }

  return { stages: outputs };
}
