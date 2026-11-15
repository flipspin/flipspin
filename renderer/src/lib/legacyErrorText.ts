import { isApiError } from "../data";

/**
 * The text the legacy screens have always shown for a failed backend call: the
 * server's own `detail`/`message`, else `HTTP <status>`, else the underlying
 * network failure. `ApiError.message` is diagnostic (method, path, status) and
 * was never what these screens displayed; new screens use `userMessage`.
 */
export function legacyErrorText(error: unknown): string {
  if (isApiError(error)) {
    if (error.kind === "http") {
      const body = (error.body ?? {}) as { detail?: unknown; message?: unknown };
      const detail = body.detail || body.message || `HTTP ${error.status}`;
      return typeof detail === "string" ? detail : JSON.stringify(detail);
    }
    if (error.cause !== undefined) {
      return error.cause instanceof Error ? error.cause.message : String(error.cause);
    }
  }
  return error instanceof Error ? error.message : String(error ?? "");
}
