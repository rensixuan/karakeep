/** Credential mutations and article payloads must never reach console/error capture. */
export function shouldLogTRPCOperation(
  operation: { path?: string; direction: "up" | "down"; result?: unknown },
  development: boolean,
) {
  // Some tRPC versions omit the path from the down-event type. Unknown
  // operations must also fail closed, since their input may contain a key.
  if (!operation.path || operation.path.startsWith("translations."))
    return false;
  return (
    development ||
    (operation.direction === "down" && operation.result instanceof Error)
  );
}
