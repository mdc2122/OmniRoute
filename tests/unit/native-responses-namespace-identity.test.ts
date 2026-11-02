import test from "node:test";
import assert from "node:assert/strict";

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.ts");

type JsonRecord = Record<string, unknown>;

test("native Responses tool calls restore namespace identities without a request pivot", async () => {
  const originalFetch = globalThis.fetch;
  const upstreamBodies: JsonRecord[] = [];
  globalThis.fetch = async (_url, init = {}) => {
    upstreamBodies.push(JSON.parse(String(init.body)) as JsonRecord);
    return new Response(
      JSON.stringify({
        id: "resp_native",
        object: "response",
        created_at: 1,
        status: "completed",
        model: "muse-wonder-full-1.0",
        output: [
          {
            id: "fc_1",
            type: "function_call",
            call_id: "call_1",
            name: "collaboration.spawn_agent",
            arguments: '{"task_name":"child","message":"go"}',
          },
        ],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  try {
    const requestBody = {
      model: "muse-code/muse-wonder-full-1.0",
      stream: false,
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Spawn a child" }],
        },
      ],
      tools: [
        {
          type: "namespace",
          name: "collaboration",
          tools: [{ type: "function", name: "spawn_agent", parameters: { type: "object" } }],
        },
      ],
    };
    const result = await handleChatCore({
      body: structuredClone(requestBody),
      modelInfo: { provider: "muse-code", model: "muse-wonder-full-1.0", extendedContext: false },
      credentials: {
        apiKey: "test-only",
        providerSpecificData: { baseUrl: "http://muse.invalid/v1" },
      },
      log: { debug() {}, info() {}, warn() {}, error() {} },
      onCredentialsRefreshed: null,
      onRequestSuccess: null,
      onDisconnect: null,
      clientRawRequest: {
        endpoint: "/v1/responses",
        body: structuredClone(requestBody),
        headers: new Headers({ "content-type": "application/json" }),
      },
      userAgent: "native-responses-namespace-test",
      connectionId: null,
      comboName: null,
    } as never);

    assert.equal(result.success, true);
    assert.ok(result.response);
    const payload = (await result.response.json()) as JsonRecord;
    const output = payload.output as JsonRecord[];
    assert.deepEqual(
      { namespace: output[0]?.namespace, name: output[0]?.name },
      { namespace: "collaboration", name: "spawn_agent" }
    );
    assert.deepEqual(output[0]?.encrypted_function_args, []);
    assert.ok(upstreamBodies.length >= 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
