import { test } from "node:test";
import assert from "node:assert/strict";
import { precomputeCreate2Address, deployCall, withCounterfactualDeploy, CANONICAL_CREATE2_FACTORY } from "../dist/core/deploy.js";

const SALT = "0x000000000000000000000000000000000000000000000000000000000000002a";
const INITCODE = "0x60006000";
// Golden vector: `cast create2 --deployer 0x4e59… --salt 0x2a --init-code 0x60006000`
const EXPECTED = "0xA0008FED748c0561754ABafa1df8b3a76E58820e";

test("precomputeCreate2Address matches the cast golden vector", () => {
  assert.equal(precomputeCreate2Address(CANONICAL_CREATE2_FACTORY, SALT, INITCODE), EXPECTED);
});

test("deployCall encodes salt ‖ initCode for the canonical factory", () => {
  const call = deployCall({ factory: CANONICAL_CREATE2_FACTORY, salt: SALT, initCode: INITCODE });
  assert.equal(call.to, CANONICAL_CREATE2_FACTORY);
  assert.equal(call.data, SALT + INITCODE.slice(2));
});

test("withCounterfactualDeploy prepends and exposes the address", () => {
  const consumer = { to: "0x0000000000000000000000000000000000000001", data: "0xdeadbeef" };
  const { address, calls } = withCounterfactualDeploy(
    { factory: CANONICAL_CREATE2_FACTORY, salt: SALT, initCode: INITCODE },
    [consumer],
  );
  assert.equal(address, EXPECTED);
  assert.equal(calls.length, 2);
  assert.equal(calls[1], consumer); // later calls can target the precomputed address
});
