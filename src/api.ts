import { execFile } from "node:child_process";
import { AxiError } from "axi-sdk-js";

export type Json = Record<string, unknown>;

export interface ApiResponse {
  status: number;
  body: Json;
  rateRemaining: string | null;
}

export type Method = "GET" | "POST" | "PUT" | "DELETE";

export interface XClient {
  request(method: Method, path: string, body?: Json): Promise<ApiResponse>;
}

export const SETUP_HINT = "Run `x-axi setup` for the login steps";

/** Token retrieval goes through xurl. Its stderr is discarded so nothing secret can reach output. */
export function readToken(): Promise<string> {
  const bin = process.env["XURL_BIN"] ?? "xurl";
  return new Promise((resolve, reject) => {
    execFile(bin, ["token"], { timeout: 30_000 }, (error, stdout) => {
      const token = stdout.trim();
      if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") {
        reject(new AxiError("the xurl binary is not installed", "AUTH_REQUIRED", [SETUP_HINT]));
      } else if (error || !/^[\x21-\x7e]+$/.test(token)) {
        // A malformed value must never reach a header, whose errors echo it.
        reject(new AxiError("not logged in to X", "AUTH_REQUIRED", [SETUP_HINT]));
      } else {
        resolve(token);
      }
    });
  });
}

/** The override exists for the end-to-end test and may only target loopback, so the token cannot be redirected. */
export function apiBase(): string {
  const override = process.env["X_AXI_API_BASE"];
  if (!override) return "https://api.x.com";
  if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(override)) {
    throw new AxiError("X_AXI_API_BASE may only point at loopback", "VALIDATION_ERROR");
  }
  return override;
}

function parseBody(text: string): Json {
  if (!text) return {};
  try {
    const value: unknown = JSON.parse(text);
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Json;
  } catch {
    // Reported below like any other unusable body.
  }
  return { detail: `unusable response: ${text.slice(0, 200)}` };
}

export const httpClient: XClient = {
  async request(method, path, body) {
    const token = await readToken();
    const base = apiBase();
    let response: Response;
    let text: string;
    try {
      response = await fetch(`${base}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        // A followed redirect would replay a write and carry the token elsewhere.
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
      });
      text = await response.text();
    } catch (error) {
      // Only the failure's name: fetch errors can quote request headers.
      const cause = (error as { cause?: { code?: string } }).cause?.code;
      throw new Error(`network failure: ${cause ?? (error as Error).name}`);
    }
    const parsed = parseBody(text);
    if (response.status === 429) {
      const reset = Number(response.headers.get("x-rate-limit-reset"));
      parsed["reset_at"] = reset ? new Date(reset * 1000).toISOString() : "unknown";
    }
    return {
      status: response.status,
      body: parsed,
      rateRemaining: response.headers.get("x-rate-limit-remaining"),
    };
  },
};

export function errorDetail(body: Json): string {
  const nested = Array.isArray(body["errors"]) ? (body["errors"] as Json[])[0] : undefined;
  const value = body["detail"] ?? body["title"] ?? nested?.["message"] ?? nested?.["detail"];
  return typeof value === "string" ? value : JSON.stringify(body).slice(0, 300);
}

/** Translates X failures into codes an agent can act on. */
export function toApiError(response: ApiResponse, context: { replyTo?: string; text?: string } = {}): AxiError {
  const detail = errorDetail(response.body);
  const { status } = response;
  if (status === 401) return new AxiError("X rejected the login", "AUTH_REQUIRED", [SETUP_HINT]);
  if (status === 402 || /credit/i.test(detail)) {
    return new AxiError(detail, "CREDITS_DEPLETED", ["Add credits or raise the spend limit at https://console.x.com"]);
  }
  if (status === 429) {
    return new AxiError(`rate limited until ${String(response.body["reset_at"])}`, "RATE_LIMITED", [
      "Wait until the reset time; do not retry in a loop",
    ]);
  }
  if (/client-not-enrolled|client-forbidden/.test(JSON.stringify(response.body))) {
    return new AxiError(detail, "APP_NOT_ENROLLED", [
      "Move the app to the Pay-per-use package and Production environment at https://console.x.com",
    ]);
  }
  if (status === 403 && /duplicate/i.test(detail)) return new AxiError(detail, "DUPLICATE_POST");
  if (status === 403 && /mentioned or otherwise engaged|reply to this conversation is not allowed/i.test(detail) && context.replyTo) {
    const intent = new URLSearchParams({ in_reply_to: context.replyTo, text: context.text ?? "" });
    return new AxiError(
      "X only allows an API reply when the post's author mentioned or quoted you",
      "REPLY_NOT_SUMMONED",
      [`Send it by hand in the browser instead: https://x.com/intent/post?${intent.toString()}`],
    );
  }
  if (status === 403) return new AxiError(detail, "FORBIDDEN");
  if (status === 404) return new AxiError(detail, "NOT_FOUND");
  return new AxiError(`X returned ${status}: ${detail}`, status >= 400 && status < 500 ? "VALIDATION_ERROR" : "X_UNAVAILABLE");
}
