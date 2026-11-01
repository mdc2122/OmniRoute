/**
 * Muse Code subscription attestation compatibility.
 *
 * Meta's subscription-backed Responses endpoint rejects a request when a flat
 * `function` tool collides with one of Muse Code's builtin tool names. The gate
 * returns HTTP 403 `client_attestation_denied` even though the request is
 * otherwise valid. Codex CLI ships several of those names (`create_goal`,
 * `get_goal`, `update_goal`, `request_user_input`), so coding-agent traffic
 * fails before inference starts.
 *
 * Alias only the colliding flat names on the way upstream, then restore them in
 * the response. This preserves the caller's tool surface and schemas. Namespace
 * tools are left untouched because Meta accepts namespaced collisions.
 *
 * Measured contract:
 * https://github.com/TheStreamCode/opencode-muse-auth/blob/main/ADAPTER_CONTRACT.md
 */

type JsonRecord = Record<string, unknown>;

const ALIAS_PREFIX = "client_";

/**
 * Flat function names that collide with Muse Code's builtin catalog.
 * Keep in sync with the measured v3 contract above; add a name only with evidence
 * that api.meta.ai rejects it.
 */
export const MUSE_CODE_BUILTIN_TOOL_NAMES: ReadonlySet<string> = new Set([
  "workflow",
  "read_file",
  "write_file",
  "edit_file",
  "bash",
  "bash_input",
  "search",
  "web_search",
  "web_fetch",
  "powershell",
  "powershell_input",
  "read_memory",
  "add_memory",
  "edit_memory",
  "read_skill",
  "write_todos",
  "monitor",
  "work_status",
  "work_list",
  "work_stop",
  "snooze_reminder",
  "apply_patch",
  "shell",
  "create_goal",
  "get_goal",
  "update_goal",
  "report_progress",
  "request_user_input",
  "cron_create",
  "cron_delete",
  "cron_list",
  "send_session_message",
  "list_peer_sessions",
  "subagent_send_message",
  "subagent_cancel",
  "subagent_spawn",
  "subagent_status",
  "subagent_wait",
  "subagent_read_result",
  "tool_search",
]);

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Responses requires a JSON-string field even when a no-argument tool is replayed. */
function normalizeFunctionCallArguments(value: unknown): string {
  if (typeof value === "string") return value.trim() ? value : "{}";
  if (value !== undefined && value !== null) {
    try {
      const serialized = JSON.stringify(value);
      if (serialized !== undefined) return serialized;
    } catch {
      // Fall through to the no-argument representation.
    }
  }
  return "{}";
}

/** Alias → original mapping consumed by the existing `_toolNameMap` response seam. */
export type MuseCodeToolAliases = Map<string, string>;

/**
 * Return an adapted copy of a Muse Code Responses request.
 *
 * Flat function declarations whose names collide with Muse builtins are renamed
 * to `client_<name>` (with a numeric suffix if needed). Matching historical
 * `function_call` items are renamed too, so follow-up turns remain coherent.
 * Meta also requires every replayed `function_call.arguments` to be valid JSON;
 * Codex emits an empty string for no-argument tools, so normalize those to `{}`.
 * The input is never mutated; the response alias ledger is attached as the
 * non-enumerable `_toolNameMap` side channel used by OmniRoute's response layer.
 */
export function aliasMuseCodeBuiltinTools(body: unknown): {
  body: unknown;
  aliases: MuseCodeToolAliases;
} {
  if (!isRecord(body)) return { body, aliases: new Map() };

  const aliases: MuseCodeToolAliases = new Map();
  const existingAliases = body._toolNameMap;
  if (existingAliases instanceof Map) {
    for (const [alias, original] of existingAliases.entries()) {
      if (typeof alias === "string" && typeof original === "string") aliases.set(alias, original);
    }
  }
  const originalToAlias = new Map<string, string>();
  const tools = Array.isArray(body.tools) ? body.tools : null;
  const taken = new Set<string>();

  if (tools) {
    for (const tool of tools) {
      if (isRecord(tool)) {
        const name = stringValue(tool.name);
        if (name) taken.add(name);
      }
    }
  }

  const aliasFor = (name: string): string => {
    const existing = originalToAlias.get(name);
    if (existing) return existing;
    let alias = `${ALIAS_PREFIX}${name}`;
    let suffix = 2;
    while (taken.has(alias)) {
      alias = `${ALIAS_PREFIX}${name}_${suffix}`;
      suffix += 1;
    }
    taken.add(alias);
    originalToAlias.set(name, alias);
    aliases.set(alias, name);
    return alias;
  };

  let toolsChanged = false;
  const adaptedTools = tools?.map((tool) => {
    if (!isRecord(tool) || tool.type !== "function") return tool;
    const name = stringValue(tool.name);
    if (!name || !MUSE_CODE_BUILTIN_TOOL_NAMES.has(name)) return tool;
    toolsChanged = true;
    return { ...tool, name: aliasFor(name) };
  });

  let inputChanged = false;
  const input = Array.isArray(body.input) ? body.input : null;
  const adaptedInput = input?.map((item) => {
    if (!isRecord(item) || item.type !== "function_call") return item;

    const name = stringValue(item.name);
    const adaptedName = name && MUSE_CODE_BUILTIN_TOOL_NAMES.has(name) ? aliasFor(name) : name;
    const normalizedArguments = normalizeFunctionCallArguments(item.arguments);
    const argumentsChanged = normalizedArguments !== item.arguments;
    if (adaptedName === name && !argumentsChanged) return item;

    inputChanged = true;
    const next = { ...item };
    if (adaptedName !== name) next.name = adaptedName;
    if (argumentsChanged) next.arguments = normalizedArguments;
    return next;
  });

  // Meta accepts only the string "auto" for Muse subscription requests.
  const toolChoiceChanged = body.tool_choice !== undefined && body.tool_choice !== "auto";
  const toolChoice = toolChoiceChanged ? "auto" : body.tool_choice;

  if (!toolsChanged && !inputChanged && !toolChoiceChanged) {
    return { body, aliases };
  }

  const next: JsonRecord = { ...body };
  if (toolsChanged) next.tools = adaptedTools;
  if (inputChanged) next.input = adaptedInput;
  if (toolChoiceChanged) next.tool_choice = toolChoice;
  Object.defineProperty(next, "_toolNameMap", {
    value: aliases,
    enumerable: false,
    configurable: true,
    writable: true,
  });
  return { body: next, aliases };
}
