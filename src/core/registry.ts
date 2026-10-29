import type {
  ContextDeps,
  ContextDescriptor,
  ContextFactory,
  InteractionContext,
} from "./types.js";

const factories = new Map<string, ContextFactory>();

export function registerContext(factory: ContextFactory): void {
  if (factories.has(factory.kind)) {
    throw new Error(`A context factory named "${factory.kind}" is already registered.`);
  }
  factories.set(factory.kind, factory);
}

/** Test helper: clears all registered contexts. */
export function resetContexts(): void {
  factories.clear();
}

export function availableContexts(chainId: number): ContextDescriptor[] {
  return [...factories.values()]
    .filter((f) => f.chains.length === 0 || f.chains.includes(chainId))
    .map((f) => ({ kind: f.kind, chains: f.chains }));
}

export async function resolveContext(
  kind: string,
  chainId: number,
  deps: ContextDeps,
): Promise<InteractionContext> {
  const factory = factories.get(kind);
  if (!factory) {
    throw new Error(
      `No context factory named "${kind}" is registered (have: ${[...factories.keys()].join(", ") || "none"}).`,
    );
  }
  if (factory.chains.length > 0 && !factory.chains.includes(chainId)) {
    throw new Error(`Context "${kind}" is not available on chain ${chainId}.`);
  }
  return factory.create(deps);
}
