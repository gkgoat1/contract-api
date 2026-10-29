export type {
  ContextDeps,
  ContextDescriptor,
  ContextFactory,
  ContractCall,
  ExecuteOpts,
  ExecutionEvent,
  ExecutionQuote,
  ExecutionResult,
  InteractionContext,
  PipelineEvent,
  PipelineResult,
  PipelineStage,
  StageOutput,
  SupportReport,
} from "./types.js";
export { registerContext, resetContexts, availableContexts, resolveContext } from "./registry.js";
export { DirectContext, directContextFactory, createDirectContext } from "./direct.js";
export type { DirectContextDeps } from "./direct.js";
export {
  MulticallContext,
  multicallContextFactory,
  createMulticallContext,
  MULTICALL3_ADDRESS,
} from "./multicall.js";
export type { MulticallContextDeps } from "./multicall.js";
export { runPipeline } from "./pipeline.js";
export { CANONICAL_CREATE2_FACTORY, precomputeCreate2Address, deployCall, withCounterfactualDeploy } from "./deploy.js";
export type { CounterfactualDeploySpec } from "./deploy.js";
export { verifyContractSignature, signAndVerify } from "./signers.js";
export type { ArbitrarySigner } from "./signers.js";
export {
  SmartWalletDirectContext,
  SmartWalletMulticall3Context,
  walletExecuteBatch,
  walletDelegateMulticall3,
  encodeBatch7821,
  ERC7821_BATCH_MODE,
} from "./smart-wallet.js";
export type { SmartWalletDeps, WalletExecutor } from "./smart-wallet.js";
