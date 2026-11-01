import { AxiError } from "axi-sdk-js";
import { createHash, randomBytes } from "node:crypto";
import type { Json } from "./api.js";

export interface OAuthEndpoints {
  authorize: string;
  token: string;
  revoke: string;
}

/** From https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code, read 2026-11-01. */
export const X_OAUTH: OAuthEndpoints = {
  authorize: "https://x.com/i/oauth2/authorize",
  token: "https://api.x.com/2/oauth2/token",
  revoke: "https://api.x.com/2/oauth2/revoke",
};

/**
 * What the commands call, checked against each endpoint's documented scopes:
 * reads and posting (tweet.read, tweet.write, users.read), hide and unhide (tweet.moderate.write),
 * follow and unfollow (follows.write), DMs (dm.read, dm.write), and a refresh token (offline.access).
 * follows.read is the one exception: no command uses it yet. It is requested ahead of the queue builder, so users need not consent a second time.
 * The `api` command can reach only endpoints these scopes cover.
 */
export const SCOPES = ["tweet.read", "tweet.write", "tweet.moderate.write", "users.read", "follows.read", "follows.write", "dm.read", "dm.write", "offline.access"];

export function base64url(bytes: Buffer): string {
  return bytes.toString("base64url");
}

/** RFC 7636 section 4.1: 43 to 128 unreserved characters. 32 random bytes give 43. */
export function randomVerifier(): string {
  return base64url(randomBytes(32));
}

export function randomState(): string {
  return base64url(randomBytes(32));
}

/** RFC 7636 S256: BASE64URL(SHA256(ASCII(verifier))), no padding. */
export function codeChallenge(verifier: string): string {
  return base64url(createHash("sha256").update(verifier, "ascii").digest());
}

export interface AuthorizeRequest {
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state: string;
  codeChallenge: string;
}

export function authorizeUrl(endpoint: string, request: AuthorizeRequest): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: request.clientId,
    redirect_uri: request.redirectUri,
    scope: request.scopes.join(" "),
    state: request.state,
    code_challenge: request.codeChallenge,
    code_challenge_method: "S256",
  });
  return `${endpoint}?${params.toString()}`;
}

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  /** Seconds. */
  expires_in: number;
  scope: string[];
}

/** The token endpoint said no. `error` is the OAuth error code, such as invalid_grant. */
export class TokenEndpointError extends Error {
  constructor(
    readonly status: number,
    readonly error: string,
    description: string,
  ) {
    super(description ? `${error}: ${description}` : error);
  }
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** Public client: client_id travels in the form body, there is no secret and no Authorization header. */
async function postForm(url: string, params: Record<string, string>, fetchLike: FetchLike): Promise<{ status: number; body: Json }> {
  let response: Response;
  let text: string;
  try {
    response = await fetchLike(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    text = await response.text();
  } catch (error) {
    // Only the failure's name: fetch errors can quote the request, and the request carries a token.
    const cause = (error as { cause?: { code?: string } }).cause?.code;
    throw new AxiError(`could not reach X's OAuth endpoint: ${cause ?? (error as Error).name}`, "X_UNAVAILABLE", [
      "Try again when the network is back; the stored login is unchanged",
    ]);
  }
  let body: Json = {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Json;
  } catch {
    // An unusable body is reported through the status below.
  }
  return { status: response.status, body };
}

/** Callers scrub the message before it leaves the process, then bound its length. */
function tokenError(status: number, body: Json): TokenEndpointError {
  const error = typeof body["error"] === "string" ? body["error"].slice(0, 100) : `http_${status}`;
  const description = typeof body["error_description"] === "string" ? body["error_description"] : "";
  return new TokenEndpointError(status, error, description);
}

function parseTokens(status: number, body: Json): TokenResponse {
  if (status < 200 || status >= 300) throw tokenError(status, body);
  const access = body["access_token"];
  if (typeof access !== "string" || !access) throw new TokenEndpointError(status, "unusable_response", "X returned no usable token");
  const expires = body["expires_in"];
  const refresh = body["refresh_token"];
  return {
    access_token: access,
    ...(typeof refresh === "string" && refresh ? { refresh_token: refresh } : {}),
    // A missing or absurd lifetime counts as already expired: the tokens are kept, and the next call refreshes.
    expires_in: typeof expires === "number" && Number.isFinite(expires) && expires > 0 && expires < 1e9 ? expires : 0,
    scope: typeof body["scope"] === "string" ? body["scope"].split(" ").filter(Boolean) : [],
  };
}

export interface CodeExchange {
  clientId: string;
  code: string;
  redirectUri: string;
  codeVerifier: string;
}

export async function exchangeCode(endpoint: string, exchange: CodeExchange, fetchLike: FetchLike): Promise<TokenResponse> {
  const { status, body } = await postForm(
    endpoint,
    {
      grant_type: "authorization_code",
      code: exchange.code,
      redirect_uri: exchange.redirectUri,
      code_verifier: exchange.codeVerifier,
      client_id: exchange.clientId,
    },
    fetchLike,
  );
  return parseTokens(status, body);
}

export async function refreshTokens(endpoint: string, clientId: string, refreshToken: string, fetchLike: FetchLike): Promise<TokenResponse> {
  const { status, body } = await postForm(endpoint, { grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId }, fetchLike);
  return parseTokens(status, body);
}

/** Resolves only on X's documented success body, `{"revoked": true}`. */
export async function revokeToken(endpoint: string, clientId: string, token: string, hint: "access_token" | "refresh_token", fetchLike: FetchLike): Promise<void> {
  const { status, body } = await postForm(endpoint, { token, token_type_hint: hint, client_id: clientId }, fetchLike);
  if (status < 200 || status >= 300) throw tokenError(status, body);
  if (body["revoked"] !== true) throw new TokenEndpointError(status, "unusable_response", "X did not confirm the revocation");
}
