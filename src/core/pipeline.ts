import type {
  ExecutionResult,
  PipelineEvent,
  PipelineResult,
  PipelineStage,
  StageOutput,
} from "./types.js";

/**
 * Runs a sequence of stages, each on its own interaction context, feeding each
 * stage the results of the ones before it. This is how a private deployment
 * composes a RAILGUN funding stage with a direct ephemeral-deployer stage.
 */
export async function* runPipeline(
  stages: PipelineStage[],
): AsyncGenerator<PipelineEvent, PipelineResult> {
  const outputs: StageOutput[] = [];
  for (const stage of stages) {
    yield { type: "stage-started", stage: stage.name };
    const calls = await stage.calls(outputs);
    const iterator = stage.context.execute(calls);
    let step = await iterator.next();
    while (!step.done) {
      yield { type: "stage-event", stage: stage.name, event: step.value };
      if (step.value.phase === "failed") throw step.value.error;
      step = await iterator.next();
    }
    const result: ExecutionResult = step.value;
    outputs.push({ stage: stage.name, result });
    yield { type: "stage-finished", stage: stage.name, result };
  }
  return { stages: outputs };
}
