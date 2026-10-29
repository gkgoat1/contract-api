import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  registerContext,
  resetContexts,
  availableContexts,
  resolveContext,
} from "@gkgo/contract-api";
import { MockContext, mockContextFactory } from "@gkgo/contract-api/testing";

const stubFactory = (kind, chains = []) => ({
  kind,
  chains,
  create: async () => new MockContext({ kind }),
});

describe("context registry", () => {
  beforeEach(() => resetContexts());

  it("registers and resolves a factory", async () => {
    registerContext(stubFactory("direct"));
    const context = await resolveContext("direct", 1, {});
    assert.equal(context.kind, "direct");
  });

  it("rejects duplicate registrations", () => {
    registerContext(stubFactory("direct"));
    assert.throws(() => registerContext(stubFactory("direct")), /already registered/);
  });

  it("lists only contexts available on the queried chain", () => {
    registerContext(stubFactory("direct")); // all chains
    registerContext(stubFactory("railgun", [1, 8453])); // mainnet + base only
    assert.deepEqual(
      availableContexts(8453).map((c) => c.kind).sort(),
      ["direct", "railgun"],
    );
    assert.deepEqual(
      availableContexts(10).map((c) => c.kind),
      ["direct"],
      "optimism (10) has no railgun context",
    );
  });

  it("throws for unknown kinds and unsupported chains", async () => {
    registerContext(stubFactory("railgun", [1]));
    await assert.rejects(() => resolveContext("nope", 1, {}), /No context factory/);
    await assert.rejects(() => resolveContext("railgun", 10, {}), /not available on chain 10/);
  });

  it("resolves through a factory built by mockContextFactory", async () => {
    registerContext(mockContextFactory({ kind: "mock", chainId: 31337 }));
    const context = await resolveContext("mock", 31337, {});
    const report = await context.supports([]);
    assert.equal(report.supported, true);
  });
});
