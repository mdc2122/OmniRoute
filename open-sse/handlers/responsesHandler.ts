import { CORS_HEADERS } from "../utils/cors.ts";
/**
 * Responses API Handler for Workers
 * Converts Chat Completions to Codex Responses API format
 */

import { handleChatCore } from "./chatCore.ts";
import { convertResponsesApiFormat } from "../translator/helpers/responsesApiHelper.ts";
import { collectResponsesCustomToolNames } from "../translator/request/openai-responses/additionalTools.ts";
import { createResponsesApiTransformStream } from "../transformer/responsesTransformer.ts";
import { createSseHeartbeatTransform, HEARTBEAT_SHAPES } from "../utils/sseHeartbeat.ts";
import { SSE_HEARTBEAT_INTERVAL_MS } from "../config/constants.ts";
import { restoreResponsesFunctionCallIdentities } from "../translator/response/openai-responses/functionCallIdentity.ts";

async function restoreJsonResponseFunctionCallIdentities(
  response: Response,
  requestToolIdentityMap: Map<string, unknown> | null
): Promise<Response> {
  if (!(requestToolIdentityMap instanceof Map) || requestToolIdentityMap.size === 0)
    return response;
  if (response.status !== 200) return response;

  const contentType = response.headers.get("Content-Type") || "";
  if (!contentType.toLowerCase().includes("application/json")) return response;

  let payload: unknown;
  try {
    payload = await response.clone().json();
  } catch {
    return response;
  }
  if (!restoreResponsesFunctionCallIdentities(payload, requestToolIdentityMap)) return response;

  const headers = new Headers(response.headers);
  headers.delete("Content-Length");
  return new Response(JSON.stringify(payload), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Handle /v1/responses request
 * @param {object} options
 * @param {object} options.body - Request body (Responses API format)
 * @param {object} options.modelInfo - { provider, model }
 * @param {object} options.credentials - Provider credentials
 * @param {object} options.log - Logger instance (optional)
 * @param {function} options.onCredentialsRefreshed - Callback when credentials are refreshed
 * @param {function} options.onRequestSuccess - Callback when request succeeds
 * @param {function} options.onDisconnect - Callback when client disconnects
 * @param {string} options.connectionId - Connection ID for usage tracking
 * @param {AbortSignal} [options.signal] - Abort signal for request/disconnect cleanup
 * @returns {Promise<{success: boolean, response?: Response, status?: number, error?: string}>}
 */
export async function handleResponsesCore({
  body,
  modelInfo,
  credentials,
  log,
  onCredentialsRefreshed,
  onRequestSuccess,
  onDisconnect,
  connectionId,
  signal,
}) {
  const inputItems = Array.isArray(body?.input) ? body.input : [];
  const customToolNames = collectResponsesCustomToolNames(body?.tools, inputItems);

  // Convert Responses API format to Chat Completions format
  const convertedBody = convertResponsesApiFormat(
    body,
    credentials,
    modelInfo?.provider,
    modelInfo?.model
  );

  // #14154 — capture the #7936 {namespace, name} identity ledger BEFORE
  // handleChatCore dispatches: extractRequestToolIdentityMap() deletes this
  // side channel from the same object once the request is translated, so it
  // must be read here to reach the response transform stream below.
  const requestToolIdentityMap =
    (convertedBody as { _namespaceToolIdentityMap?: Map<string, unknown> })
      ._namespaceToolIdentityMap ?? null;

  // Ensure stream is enabled
  convertedBody.stream = true;

  // Call chat core handler
  const result = await handleChatCore({
    body: convertedBody,
    modelInfo,
    credentials,
    log,
    onCredentialsRefreshed,
    onRequestSuccess,
    onDisconnect,
    clientRawRequest: null,
    connectionId,
    userAgent: null,
    comboName: null,
    onStreamFailure: null,
  });

  // handleChatCore's union includes a bare Response (early returns that never
  // reach the {success, response} envelope). Peel it off first so the envelope
  // checks below are reading a shape that actually has those fields — the
  // outcome is unchanged, a bare Response was already returned as-is.
  if (result instanceof Response) {
    return result;
  }
  if (!result.success || !result.response) {
    return result;
  }

  const response = result.response;
  const contentType = response.headers.get("Content-Type") || "";

  // Non-streaming Responses calls return JSON before the SSE transforms below
  // run. Apply the same namespace identity closure so Codex receives the
  // declared {namespace, name} pair instead of a flattened model spelling.
  if (!contentType.includes("text/event-stream") || response.status !== 200) {
    const restoredResponse = await restoreJsonResponseFunctionCallIdentities(
      response,
      requestToolIdentityMap
    );
    return restoredResponse === response ? result : { ...result, response: restoredResponse };
  }

  // Transform SSE stream to Responses API format (no logging in worker)
  const transformStream = createResponsesApiTransformStream(null, undefined, {
    customToolNames,
    requestToolIdentityMap,
  });
  const transformedBody = response.body.pipeThrough(transformStream).pipeThrough(
    createSseHeartbeatTransform({
      signal,
      intervalMs: SSE_HEARTBEAT_INTERVAL_MS,
      shape: HEARTBEAT_SHAPES.OPENAI_RESPONSES_IN_PROGRESS,
    })
  );

  return {
    success: true,
    response: new Response(transformedBody, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    }),
  };
}
