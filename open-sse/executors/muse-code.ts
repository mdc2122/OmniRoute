import { DefaultExecutor } from "./default.ts";
import { aliasMuseCodeBuiltinTools } from "./museCodeToolNames.ts";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

/**
 * Muse Code uses the normal OpenAI-compatible executor for inference, plus two
 * provider-specific behaviours after generic sanitisation:
 *
 * - Muse's Responses API supports a 24h prompt-cache retention window. The
 *   generic executor intentionally strips this field for strict upstreams, so
 *   restore it only on the Muse Code route (#13634).
 * - Subscription attestation rejects flat tool names that collide with the
 *   Muse builtin catalog. Alias those declarations upstream and stash the
 *   alias ledger on `_toolNameMap`; the response seam restores client names
 *   (see museCodeToolNames.ts).
 *
 * Credential remint stays on the centralized path: DefaultExecutor
 * refreshCredentials → getAccessToken → refreshMuseCodeToken (remint from the
 * durable `dca:` token, with race dedup). No override here on purpose.
 */
export class MuseCodeExecutor extends DefaultExecutor {
  constructor() {
    super("muse-code");
  }

  transformRequest(
    model: string,
    body: unknown,
    stream: boolean,
    credentials: Parameters<DefaultExecutor["transformRequest"]>[3]
  ): unknown {
    const original = asRecord(body);
    const requestedRetention =
      typeof original?.prompt_cache_retention === "string"
        ? original.prompt_cache_retention
        : "24h";
    const cleaned = super.transformRequest(model, body, stream, credentials);
    const adapted = aliasMuseCodeBuiltinTools(cleaned).body;
    const record = asRecord(adapted);
    if (!record) return adapted;
    if (record.prompt_cache_retention === requestedRetention) return adapted;

    const result: JsonRecord = {
      ...record,
      prompt_cache_retention: requestedRetention,
    };
    // The spread drops the non-enumerable alias ledger; without it the
    // streaming merge in chatCore cannot restore client tool names.
    const toolNameMap = (adapted as JsonRecord)._toolNameMap;
    if (toolNameMap instanceof Map) {
      Object.defineProperty(result, "_toolNameMap", {
        value: toolNameMap,
        enumerable: false,
        configurable: true,
        writable: true,
      });
    }
    return result;
  }
}

export default MuseCodeExecutor;
