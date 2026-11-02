import test from "node:test";
import assert from "node:assert/strict";

import { resolveRequestToolIdentity } from "../../open-sse/translator/response/openai-responses/requestToolIdentity.ts";

test("restores a dotted namespace alias from the request identity ledger", () => {
  const identity = { namespace: "exec", name: "exec_command" };
  const identityMap = new Map([["exec__exec_command", identity]]);

  assert.deepEqual(resolveRequestToolIdentity(identityMap, "exec__exec_command"), identity);
  assert.deepEqual(resolveRequestToolIdentity(identityMap, "exec.exec_command"), identity);
  assert.equal(resolveRequestToolIdentity(identityMap, "other.exec_command"), null);
});

test("prefers an exact map entry over dotted-alias fallback", () => {
  const exact = { namespace: "literal", name: "tool" };
  const identityMap = new Map([
    ["exec__exec_command", { namespace: "exec", name: "exec_command" }],
    ["exec.exec_command", exact],
  ]);

  assert.deepEqual(resolveRequestToolIdentity(identityMap, "exec.exec_command"), exact);
});

test("restores a single underscore-flattened namespace alias", () => {
  const identity = { namespace: "collaboration", name: "list_agents" };
  const identityMap = new Map([["collaboration__list_agents", identity]]);

  assert.deepEqual(resolveRequestToolIdentity(identityMap, "collaboration_list_agents"), identity);
  assert.equal(resolveRequestToolIdentity(identityMap, "unrelated_list_agents"), null);
});

test("does not guess when an underscore-flattened name is ambiguous", () => {
  const identityMap = new Map([
    ["a__b_c", { namespace: "a", name: "b_c" }],
    ["a_b__c", { namespace: "a_b", name: "c" }],
  ]);

  assert.equal(resolveRequestToolIdentity(identityMap, "a_b_c"), null);
});
