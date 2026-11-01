import test from "node:test";
import assert from "node:assert/strict";

import { aliasMuseCodeBuiltinTools } from "../../open-sse/executors/museCodeToolNames.ts";
import { restoreOpenAIToolNames } from "../../open-sse/translator/helpers/toolCallHelper.ts";
import { processBufferedPassthroughLine } from "../../open-sse/utils/passthroughTailProcessor.ts";

type JsonRecord = Record<string, unknown>;

function aliasMap(body: unknown): Map<string, string> {
  const map = (body as JsonRecord)._toolNameMap;
  assert.ok(map instanceof Map);
  return map as Map<string, string>;
}

test("muse-code tool aliasing handles the Codex builtin collisions", () => {
  const body = {
    model: "muse-code/muse-wonder-full-1.0",
    tools: [
      { type: "function", name: "create_goal", parameters: { type: "object" } },
      { type: "function", name: "exec_command", parameters: { type: "object" } },
      { type: "function", name: "get_goal", parameters: { type: "object" } },
      { type: "namespace", name: "multi_agent_v1", tools: [] },
      { type: "function", name: "request_user_input", parameters: { type: "object" } },
      { type: "function", name: "update_goal", parameters: { type: "object" } },
    ],
    input: [
      { type: "message", role: "user", content: "hello" },
      { type: "function_call", call_id: "call_1", name: "create_goal", arguments: "{}" },
    ],
    tool_choice: { type: "function", name: "update_goal" },
  };
  const original = structuredClone(body);
  const adapted = aliasMuseCodeBuiltinTools(body);
  const next = adapted.body as JsonRecord;
  const tools = next.tools as JsonRecord[];

  assert.deepEqual(
    tools.map((tool) => tool.name),
    [
      "client_create_goal",
      "exec_command",
      "client_get_goal",
      "multi_agent_v1",
      "client_request_user_input",
      "client_update_goal",
    ]
  );
  assert.equal((next.input as JsonRecord[])[1].name, "client_create_goal");
  assert.equal(next.tool_choice, "auto");
  assert.deepEqual(body, original, "caller body must not be mutated");

  const aliases = aliasMap(next);
  assert.equal(aliases.get("client_create_goal"), "create_goal");
  assert.equal(aliases.get("client_get_goal"), "get_goal");
  assert.equal(aliases.get("client_request_user_input"), "request_user_input");
  assert.equal(aliases.get("client_update_goal"), "update_goal");
});

test("muse-code normalizes empty no-argument function call arguments", () => {
  const body = {
    tools: [{ type: "function", name: "collaboration_list_agents" }],
    input: [
      {
        type: "function_call",
        call_id: "call_list",
        name: "collaboration_list_agents",
        arguments: "",
      },
      {
        type: "function_call",
        call_id: "call_space",
        name: "exec_command",
        arguments: "   ",
      },
      {
        type: "function_call",
        call_id: "call_missing",
        name: "create_goal",
      },
      {
        type: "function_call",
        call_id: "call_object",
        name: "exec_command",
        arguments: { cmd: "pwd" },
      },
      {
        type: "function_call",
        call_id: "call_valid",
        name: "exec_command",
        arguments: '{"cmd":"pwd"}',
      },
    ],
  };
  const original = structuredClone(body);
  const adapted = aliasMuseCodeBuiltinTools(body);
  const input = (adapted.body as JsonRecord).input as JsonRecord[];

  assert.equal(input[0].arguments, "{}");
  assert.equal(input[1].arguments, "{}");
  assert.equal(input[2].name, "client_create_goal");
  assert.equal(input[2].arguments, "{}");
  assert.equal(input[3].arguments, '{"cmd":"pwd"}');
  assert.equal(input[4].arguments, '{"cmd":"pwd"}');
  assert.deepEqual(body, original, "caller body must not be mutated");
});

test("muse-code leaves non-empty JSON function arguments byte-for-byte intact", () => {
  const argumentsValue = ' { "cmd": "pwd" } ';
  const body = {
    input: [
      {
        type: "function_call",
        call_id: "call_1",
        name: "collaboration_list_agents",
        arguments: argumentsValue,
      },
    ],
  };
  const adapted = aliasMuseCodeBuiltinTools(body);
  assert.equal(adapted.body, body);
  assert.equal((body.input[0] as JsonRecord).arguments, argumentsValue);
});

test("muse-code tool aliasing avoids collisions with caller-owned aliases", () => {
  const body = {
    tools: [
      { type: "function", name: "client_read_file" },
      { type: "function", name: "read_file" },
    ],
  };
  const adapted = aliasMuseCodeBuiltinTools(body).body as JsonRecord;
  assert.equal((adapted.tools as JsonRecord[])[1].name, "client_read_file_2");
});

test("muse-code tool aliasing leaves non-colliding and namespaced tools untouched", () => {
  const body = {
    tools: [
      { type: "function", name: "exec_command" },
      {
        type: "namespace",
        name: "multi_agent_v1",
        tools: [{ type: "function", name: "read_file" }],
      },
    ],
  };
  const adapted = aliasMuseCodeBuiltinTools(body);
  assert.equal(adapted.body, body);
  assert.equal(adapted.aliases.size, 0);
});

test("restoreOpenAIToolNames restores Responses output, tools echo, and SSE top-level names", () => {
  const aliases = new Map([
    ["client_create_goal", "create_goal"],
    ["client_read_file", "read_file"],
  ]);
  const payload: JsonRecord = {
    type: "response.completed",
    response: {
      output: [{ type: "function_call", name: "client_create_goal" }],
      tools: [{ type: "function", name: "client_read_file" }],
    },
  };
  assert.equal(restoreOpenAIToolNames(payload, aliases), true);
  const response = payload.response as { output: JsonRecord[]; tools: JsonRecord[] };
  assert.equal(response.output[0].name, "create_goal");
  assert.equal(response.tools[0].name, "read_file");

  const argsDone = {
    type: "response.function_call_arguments.done",
    name: "client_read_file",
  };
  assert.equal(restoreOpenAIToolNames(argsDone, aliases), true);
  assert.equal(argsDone.name, "read_file");
});

test("restoreOpenAIToolNames still restores Chat Completions tool calls", () => {
  const aliases = new Map([["client_read_file", "read_file"]]);
  const payload = {
    choices: [{ delta: { tool_calls: [{ function: { name: "client_read_file" } }] } }],
  };
  assert.equal(restoreOpenAIToolNames(payload, aliases), true);
  assert.equal(payload.choices[0].delta.tool_calls[0].function.name, "read_file");
});

test("streaming Responses backfill restores aliases before buffering output items", () => {
  const aliases = new Map([["client_create_goal", "create_goal"]]);
  const emitted: string[] = [];
  const pending = new Map<string, JsonRecord>();
  const outputItems: unknown[] = [];
  let currentKey: string | null = null;
  const context = {
    getSkipPassthroughEvent: () => false,
    setSkipPassthroughEvent: () => {},
    clearPendingPassthroughEvent: () => {},
    shouldAbortOnClaudeLifecycle: () => false,
    emitClaudeEmptyStreamErrorAndAbort: () => {},
    isClaudeEventPayload: () => false,
    updateClaudeEmptyResponseLifecycle: () => {},
    passthroughEventPrefix: {
      eventType: () => "",
      flush: () => "",
      prefixData: (output: string) => output,
      remember: () => {},
    },
    emitConvertedOutput: (output: string) => emitted.push(output),
    pushProviderPayload: () => {},
    pushClientPayload: () => {},
    sanitizeUsagePayload: () => false,
    setPassthroughResponsesId: () => {},
    setUsage: () => {},
    addTotalContentLength: () => {},
    appendPassthroughContent: () => {},
    appendPassthroughReasoning: () => {},
    getResponsesReasoningKey: () => null,
    markResponsesReasoningSummarySeen: () => {},
    emitSyntheticResponsesReasoningSummary: () => {},
    passthroughResponsesOutputItems: outputItems,
    passthroughResponsesPendingFunctionCalls: pending,
    getPassthroughResponsesCurrentFunctionCallKey: () => currentKey,
    setPassthroughResponsesCurrentFunctionCallKey: (value: string | null) => {
      currentKey = value;
    },
    hasPassthroughToolCalls: () => false,
    toResponsesCompletedWithToolCalls: (payload: JsonRecord) => payload,
    restoreOpenAIToolNames: (payload: JsonRecord) => restoreOpenAIToolNames(payload, aliases),
    abortFailure: () => {},
  };
  const feed = (payload: JsonRecord) =>
    processBufferedPassthroughLine(`data: ${JSON.stringify(payload)}`, context);

  feed({
    type: "response.output_item.added",
    item: {
      type: "function_call",
      id: "fc_1",
      call_id: "call_1",
      name: "client_create_goal",
      arguments: "",
    },
  });
  feed({
    type: "response.function_call_arguments.delta",
    item_id: "fc_1",
    delta: "{}",
  });
  feed({
    type: "response.output_item.done",
    item: {
      type: "function_call",
      id: "fc_1",
      call_id: "call_1",
      name: "client_create_goal",
      arguments: "{}",
    },
  });
  feed({
    type: "response.completed",
    response: { id: "resp_1", output: [] },
  });

  const completed = emitted
    .flatMap((chunk) => chunk.split("\n"))
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)) as JsonRecord)
    .find((event) => event.type === "response.completed");
  const response = completed?.response as { output: JsonRecord[] };
  assert.equal(response.output.length, 1);
  assert.equal(response.output[0].name, "create_goal");
  assert.ok(!JSON.stringify(completed).includes("client_create_goal"));
});
