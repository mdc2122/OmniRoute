import { resolveRequestToolIdentity } from "./requestToolIdentity.ts";
import { plaintextCollaborationFields } from "./collaborationPlaintextMarker.ts";

interface FunctionCallItemLike {
  namespace?: string;
  name?: string;
  encrypted_function_args?: unknown[];
  [key: string]: unknown;
}

type JsonRecord = Record<string, unknown>;

/**
 * #7936 identity closure: rewrite a function_call item's `name` back to its
 * bare leaf and stamp the original `namespace` alongside it, matching the
 * codex ResponseItem::FunctionCall schema (independent `namespace` field, NOT
 * a `__` split on `name`). #14154: once the identity is restored, also stamp
 * the `encrypted_function_args: []` plaintext-delivery marker Codex requires
 * for collaboration spawn_agent/send_message/followup_task calls.
 *
 * Mutates `funcItem` in place and returns it for convenience at call sites.
 */
export function applyFunctionCallIdentity<T extends FunctionCallItemLike>(
  funcItem: T,
  identityMap: unknown,
  toolName: string
): T {
  const identity = resolveRequestToolIdentity(identityMap, toolName);
  if (identity) {
    funcItem.namespace = identity.namespace;
    funcItem.name = identity.name;
  }
  Object.assign(funcItem, plaintextCollaborationFields(funcItem.namespace, funcItem.name));
  return funcItem;
}

/**
 * Restore namespace identities on a complete Responses JSON body. Streaming
 * Responses and Chat SSE paths restore identities as events are emitted; the
 * non-streaming Responses path returns JSON before those transforms run.
 */
export function restoreResponsesFunctionCallIdentities(
  payload: unknown,
  identityMap: unknown
): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const output = (payload as JsonRecord).output;
  if (!Array.isArray(output)) return false;

  let changed = false;
  for (const value of output) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const item = value as FunctionCallItemLike;
    if (item.type !== "function_call" || typeof item.name !== "string") continue;

    const previousNamespace = item.namespace;
    const previousName = item.name;
    const previousEncryptedArgs = item.encrypted_function_args;
    applyFunctionCallIdentity(item, identityMap, item.name);
    if (
      item.namespace !== previousNamespace ||
      item.name !== previousName ||
      item.encrypted_function_args !== previousEncryptedArgs
    ) {
      changed = true;
    }
  }
  return changed;
}
