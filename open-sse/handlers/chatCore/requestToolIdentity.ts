import { flattenNamespaceToolName } from "../../translator/request/openai-responses/namespaceFlatten.ts";

export type NamespaceIdentity = { namespace: string; name: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function toolName(value: unknown): string {
  const record = asRecord(value);
  if (!record) return "";
  if (typeof record.name === "string" && record.name.trim()) return record.name.trim();
  const functionRecord = asRecord(record.function);
  return typeof functionRecord?.name === "string" ? functionRecord.name.trim() : "";
}

/**
 * Build the namespace identity ledger directly from a native Responses body.
 * The same-format Responses -> Responses path skips the request translator, so
 * it never publishes `_namespaceToolIdentityMap` for the response seam.
 */
export function collectResponsesNamespaceToolIdentityMap(
  body: Record<string, unknown>
): Map<string, NamespaceIdentity> | null {
  const identityMap = new Map<string, NamespaceIdentity>();
  const inputItems = Array.isArray(body.input) ? body.input : [];
  const toolGroups = [Array.isArray(body.tools) ? body.tools : []];
  for (const item of inputItems) {
    const record = asRecord(item);
    if (record?.type === "additional_tools" && Array.isArray(record.tools)) {
      toolGroups.push(record.tools);
    }
  }

  for (const tools of toolGroups) {
    for (const value of tools) {
      const tool = asRecord(value);
      if (tool?.type !== "namespace" || !Array.isArray(tool.tools)) continue;
      const namespace = toolName(tool);
      if (!namespace) continue;
      for (const childValue of tool.tools) {
        const leaf = toolName(childValue);
        if (!leaf) continue;
        identityMap.set(flattenNamespaceToolName(namespace, leaf), { namespace, name: leaf });
      }
    }
  }

  return identityMap.size > 0 ? identityMap : null;
}

/**
 * Capture both ledgers before the legacy extractor deletes their side channels.
 * Responses pivots carry object-valued namespace identities AND string-valued
 * provider aliases; recovering aliases from identities alone loses the latter.
 */
export function extractRequestToolMetadata(translatedBody: Record<string, unknown>): {
  requestToolIdentityMap: Map<string, NamespaceIdentity> | null;
  toolNameAliasMap: Map<string, string> | null;
} {
  const toolNameAliasMap = toToolNameAliasMap(
    translatedBody._toolNameMap instanceof Map ? translatedBody._toolNameMap : null
  );
  const requestToolIdentityMap = extractRequestToolIdentityMap(translatedBody);
  // Both ledgers are captured above, so the side channel is consumed here. The
  // standalone extractor keeps a string alias ledger next to namespace identities
  // (#14751) for callers that resolve aliases from the body later; this combined
  // entry point returns that ledger instead (#12839), so nothing may linger on the
  // body that is about to be serialized for dispatch.
  delete translatedBody._toolNameMap;
  return {
    requestToolIdentityMap,
    toolNameAliasMap: toolNameAliasMap ?? toToolNameAliasMap(requestToolIdentityMap),
  };
}

/**
 * Return a string-valued copy only when the complete map is an alias ledger.
 *
 * The legacy `_toolNameMap` side channel can carry either response aliases or
 * namespace identities. Checking every value before copying keeps those two
 * contracts separate and gives callers a real `Map<string, string>` instead of
 * asserting an identity map into the alias shape.
 */
export function toToolNameAliasMap(
  map: ReadonlyMap<string, unknown> | null
): Map<string, string> | null {
  if (!map || map.size === 0) return null;

  const aliases = new Map<string, string>();
  for (const [wireName, originalName] of map) {
    if (typeof originalName !== "string") return null;
    aliases.set(wireName, originalName);
  }
  return aliases;
}

/**
 * Decide which alias ledger the response translator gets.
 *
 * Namespace identities and provider aliases are independent ledgers. Prefer
 * the intact provider aliases, then native Claude aliases. Older producers
 * expose only a string-valued `_toolNameMap`, which extraction consumes and
 * returns through the legacy channel; recover that ledger as a fallback.
 * Never reinterpret object-valued namespace identities as response aliases.
 */
export function resolveResponseToolNameMap(
  translatedToolNameMap: unknown,
  nativeClaudeToolNameMap: Map<string, string> | null,
  requestToolIdentityMap: ReadonlyMap<string, unknown> | null
): Map<string, string> | null {
  if (translatedToolNameMap instanceof Map && translatedToolNameMap.size > 0) {
    return translatedToolNameMap as Map<string, string>;
  }
  return nativeClaudeToolNameMap ?? toToolNameAliasMap(requestToolIdentityMap);
}

/**
 * Extract the #7936 request-tool identity map from the translated body and
 * consume namespace metadata while preserving an independent provider alias ledger.
 *
 * #9780 — prefer the dedicated `_namespaceToolIdentityMap`: on a pivot the
 * openai->claude/gemini step publishes its own alias `Map<string, string>` on
 * `_toolNameMap`, so that property alone can yield aliases instead of
 * identities. The `_toolNameMap` read stays as the fallback for the non-pivot
 * producers (executors/base.ts, cliproxyapi.ts, antigravity).
 */
export function extractRequestToolIdentityMap(
  translatedBody: Record<string, unknown>
): Map<string, NamespaceIdentity> | null {
  const namespaceIdentityMap = translatedBody._namespaceToolIdentityMap;
  const requestToolIdentityMap =
    namespaceIdentityMap instanceof Map
      ? namespaceIdentityMap
      : translatedBody._toolNameMap instanceof Map
        ? translatedBody._toolNameMap
        : null;
  delete translatedBody._namespaceToolIdentityMap;
  // With both channels present, consuming provider aliases here loses the
  // sanitized Gemini name before resolveResponseToolNameMap can restore it.
  // Keep legacy single-ledger extraction behavior for older producers.
  if (
    !(namespaceIdentityMap instanceof Map) ||
    !toToolNameAliasMap(translatedBody._toolNameMap as Map<string, unknown>)
  ) {
    delete translatedBody._toolNameMap;
  }
  return requestToolIdentityMap as Map<string, NamespaceIdentity> | null;
}
