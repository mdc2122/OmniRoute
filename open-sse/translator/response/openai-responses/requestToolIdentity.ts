type RequestToolIdentity = { namespace: string; name: string };

function asRequestToolIdentity(value: unknown): RequestToolIdentity | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { namespace, name } = value as Record<string, unknown>;
  return typeof namespace === "string" && namespace && typeof name === "string" && name
    ? { namespace, name }
    : null;
}

// #8295's `flattenNamespaceToolName` folds a declared `type:"namespace"` tool
// group onto the Chat wire as `${nsName}__${leaf}`, always prefixed with the
// MCP container convention documented in open-sse/executors/codex/tools.ts
// (`mcp__<server>...`). Gate the split-fallback below on this exact prefix so
// it never misfires on an unrelated flat `type:"function"` tool that merely
// happens to contain `__` in its own name.
const NAMESPACE_TOOL_PREFIX = "mcp__";

/**
 * #12996 — deterministic wire-name fallback for when no per-request identity
 * map entry exists at all (e.g. a follow-up turn in the same Codex/MCP
 * session that relies on `previous_response_id` continuity instead of
 * re-declaring its `type:"namespace"` tools every turn — OmniRoute is a
 * stateless-upstream-by-default proxy for the Responses API, so nothing
 * persists the prior turn's identity map across separate HTTP requests).
 *
 * Recovers `{namespace, name}` by splitting the wire name on its LAST `__`
 * separator, mirroring `flattenNamespaceToolName`'s own construction
 * (`${nsName}__${leaf}`, with leaf never containing its own `__`). Scoped to
 * wire names that start with the `mcp__` namespace-container convention so it
 * cannot attach a spurious `namespace` to a flat, non-namespaced tool that
 * happens to contain `__`.
 *
 * Known gap: a wire name hash-truncated by `flattenNamespaceToolName` (>64
 * chars) loses its `__` boundary and cannot be recovered here.
 */
function splitFlattenedNamespaceWireName(toolName: string): RequestToolIdentity | null {
  if (!toolName.startsWith(NAMESPACE_TOOL_PREFIX)) return null;

  const lastSeparator = toolName.lastIndexOf("__");
  if (lastSeparator <= 0) return null;

  const namespace = toolName.slice(0, lastSeparator);
  const name = toolName.slice(lastSeparator + 2);
  return namespace && name ? { namespace, name } : null;
}

/**
 * Resolve a flattened Chat function name back to the identity declared by the
 * request's Responses namespace tool. The request path supplies this map on
 * the response translation state.
 *
 * Some model-specific tool parsers render the registered `namespace__leaf`
 * wire name as `namespace.leaf`. Accept that spelling only when it matches an
 * identity already present in the request ledger; never infer a namespace by
 * splitting an otherwise unknown tool name outside the narrow `mcp__`
 * fallback below.
 */
export function resolveRequestToolIdentity(identityMap: unknown, toolName: string) {
  if (!toolName) return null;

  const direct =
    identityMap instanceof Map
      ? identityMap.get(toolName)
      : identityMap && typeof identityMap === "object" && !Array.isArray(identityMap)
        ? (identityMap as Record<string, unknown>)[toolName]
        : undefined;
  const directIdentity = asRequestToolIdentity(direct);
  if (directIdentity) return directIdentity;

  const candidates =
    identityMap instanceof Map
      ? identityMap.values()
      : identityMap && typeof identityMap === "object" && !Array.isArray(identityMap)
        ? Object.values(identityMap as Record<string, unknown>)
        : [];
  const flatToolNames =
    identityMap instanceof Map
      ? (identityMap as Map<string, unknown> & { flatToolNames?: ReadonlySet<string> })
          .flatToolNames
      : undefined;
  let underscoreMatch: RequestToolIdentity | null = null;
  let underscoreMatchCount = 0;
  let leafMatch: RequestToolIdentity | null = null;
  let leafMatchCount = 0;
  for (const candidate of candidates) {
    const identity = asRequestToolIdentity(candidate);
    if (identity && `${identity.namespace}.${identity.name}` === toolName) return identity;
    if (identity && `${identity.namespace}_${identity.name}` === toolName) {
      underscoreMatch = identity;
      underscoreMatchCount += 1;
    }
    if (identity && identity.name === toolName) {
      leafMatch = identity;
      leafMatchCount += 1;
    }
  }

  // Some model tool parsers flatten `namespace__leaf` as `namespace_leaf`
  // (instead of `namespace.leaf`). Accept that spelling only when it maps to a
  // single declared identity; an ambiguous underscore join must stay untouched.
  if (!flatToolNames?.has(toolName) && underscoreMatchCount === 1) return underscoreMatch;

  // Muse sometimes drops the namespace entirely and emits only the declared
  // leaf. Use that spelling only for a collector-created ledger, where the
  // declared flat-tool set lets us reject a real top-level tool with that name.
  if (flatToolNames && !flatToolNames.has(toolName) && leafMatchCount === 1) return leafMatch;

  // The wire-name split only stands in for a request that declared no
  // namespace identities at all (follow-up turns). When the ledger is populated
  // the request declared its own tools, so an unlisted `mcp__a__b` is a flat
  // function tool and must not gain a namespace.
  const ledgerSize =
    identityMap instanceof Map
      ? identityMap.size
      : identityMap && typeof identityMap === "object" && !Array.isArray(identityMap)
        ? Object.keys(identityMap).length
        : 0;
  return ledgerSize === 0 ? splitFlattenedNamespaceWireName(toolName) : null;
}
