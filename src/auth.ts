import { AxiError } from "axi-sdk-js";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import type { Keystore } from "./keystore.js";
import { authorizeUrl, codeChallenge, exchangeCode, randomState, randomVerifier, refreshTokens, revokeToken, SCOPES, TokenEndpointError, type FetchLike, type OAuthEndpoints, type TokenResponse } from "./oauth.js";

/** What the keystore holds, as one JSON record. Only client_id is not secret. */
export interface Credentials {
  version: 1;
  client_id: string;
  access_token: string;
  refresh_token?: string;
  /** ISO time the access token stops working. */
  expires_at: string;
  scope: string[];
  obtained_at: string;
}

/** Everything `auth status` may show. There is no token in it by construction. */
export interface AuthStatus {
  logged_in: boolean;
  storage: string;
  client_id?: string;
  scopes?: string[];
  access_token_expires_at?: string;
  access_token?: "valid" | "expired";
  refresh_token?: "present" | "absent";
  problem?: string;
  help?: string[];
}

export interface LogoutReport {
  had_login: boolean;
  revoked: string[];
  revoke_failed: Record<string, string>;
  deleted: boolean;
}

export interface AuthService {
  /** A usable access token, refreshed when near expiry. Never retries X. */
  accessToken(): Promise<string>;
  login(clientId: string): Promise<AuthStatus>;
  logout(): Promise<LogoutReport>;
  status(): Promise<AuthStatus>;
}

export interface AuthDeps {
  store: Keystore;
  endpoints: OAuthEndpoints;
  redirectUri: string;
  /** Where the refresh lock lives; shared by every x-axi process of this user. */
  lockDir: string;
  openBrowser: (url: string) => Promise<void>;
  /** Progress for the human at the terminal, during login only. */
  log: (line: string) => void;
  fetch?: FetchLike;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  loginTimeoutMs?: number;
}

export const LOGIN_HINT = "Run `x-axi login` in your own terminal to sign in again";
// Refresh this long before expiry, so a command that starts with a valid token does not see it expire mid-run.
const REFRESH_MARGIN_MS = 120_000;
const LOCK_WAIT_MS = 30_000;
// A holder touches its lock this often; a lock untouched for LOCK_STALE_MS belongs to a process that died.
const LOCK_HEARTBEAT_MS = 5_000;
const LOCK_STALE_MS = 60_000;
const DEFAULT_LOGIN_TIMEOUT_MS = 5 * 60_000;

function authRequired(message: string, extra: string[] = []): AxiError {
  return new AxiError(message, "AUTH_REQUIRED", [LOGIN_HINT, ...extra]);
}

/** Removes every known secret from text that is about to leave the process, then bounds its length. */
export function scrub(text: string, secrets: (string | undefined)[]): string {
  let out = text;
  for (const secret of secrets) if (secret) out = out.replaceAll(secret, "[redacted]");
  return out.slice(0, 300);
}

/** A 400 or 401 carrying an OAuth error code is X's verdict on the grant; anything else says nothing about the login. */
function isRejection(error: TokenEndpointError): boolean {
  return (error.status === 400 || error.status === 401) && !error.error.startsWith("http_") && error.error !== "unusable_response";
}

function parseCredentials(raw: string): Credentials | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const c = value as Partial<Credentials> | null;
  if (
    c?.version !== 1 ||
    typeof c.client_id !== "string" ||
    typeof c.access_token !== "string" ||
    !c.access_token ||
    typeof c.expires_at !== "string" ||
    !Array.isArray(c.scope) ||
    (c.refresh_token !== undefined && typeof c.refresh_token !== "string")
  ) {
    return undefined;
  }
  return c as Credentials;
}

function fromTokens(tokens: TokenResponse, clientId: string, previous: Credentials | undefined, now: number): Credentials {
  // The docs do not say whether refresh tokens rotate, so any new one wins and the old one is kept only when none came.
  const refresh = tokens.refresh_token ?? previous?.refresh_token;
  return {
    version: 1,
    client_id: clientId,
    access_token: tokens.access_token,
    ...(refresh ? { refresh_token: refresh } : {}),
    expires_at: new Date(now + tokens.expires_in * 1000).toISOString(),
    scope: tokens.scope.length ? tokens.scope : previous?.scope ?? [],
    obtained_at: new Date(now).toISOString(),
  };
}

export function createAuth(deps: AuthDeps): AuthService {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const fetchLike: FetchLike = deps.fetch ?? ((url, init) => fetch(url, init));
  const lockPath = join(deps.lockDir, "auth.lock");

  const readCredentials = async (): Promise<Credentials | undefined> => {
    const raw = await deps.store.read();
    if (raw === undefined) return undefined;
    const credentials = parseCredentials(raw);
    if (!credentials) {
      throw new AxiError(`the login stored in the ${deps.store.backend} is not one this version can read`, "AUTH_REQUIRED", [
        "Run `x-axi logout` to delete it, then `x-axi login`",
      ]);
    }
    return credentials;
  };

  const fresh = (credentials: Credentials): boolean => new Date(credentials.expires_at).getTime() - now() > REFRESH_MARGIN_MS;

  const lockFailure = (reason: string): AxiError =>
    new AxiError(`cannot use the login lock at ${lockPath}: ${reason}`, "AUTH_LOCKED", [`If no other x-axi is running, delete ${lockPath} and try again`]);

  /**
   * One credential change at a time across processes, so a single-use refresh token is spent once
   * and a login or logout cannot interleave with a refresh. The lock file holds a random owner
   * token: a stale lock is claimed by renaming it aside, which only one process can win, and a
   * release removes the file only while it still carries this process's token.
   */
  const withCredentialLock = async <T>(work: () => Promise<T>): Promise<T> => {
    const owner = randomBytes(16).toString("hex");
    try {
      mkdirSync(deps.lockDir, { recursive: true, mode: 0o700 });
    } catch (error) {
      throw lockFailure((error as NodeJS.ErrnoException).code ?? String(error));
    }
    const deadline = now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        writeFileSync(lockPath, owner, { flag: "wx", mode: 0o600 });
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") throw lockFailure(code ?? String(error));
      }
      let stale = false;
      try {
        stale = now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw lockFailure(String(error));
        continue; // Released between our two calls.
      }
      if (stale) {
        const claimed = `${lockPath}.${owner}`;
        try {
          renameSync(lockPath, claimed);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw lockFailure(String(error));
          continue; // Another process claimed it first.
        }
        try {
          // A live holder may have touched it between the stat and the rename; give it back in that case.
          if (now() - statSync(claimed).mtimeMs > LOCK_STALE_MS) unlinkSync(claimed);
          else renameSync(claimed, lockPath);
        } catch (error) {
          throw lockFailure(String(error));
        }
        continue;
      }
      if (now() > deadline) throw lockFailure("another x-axi process has held it for over 30 seconds");
      await sleep(50 + Math.floor(Math.random() * 50));
    }
    const heartbeat = setInterval(() => {
      try {
        const at = new Date(now());
        utimesSync(lockPath, at, at);
      } catch {
        // The lock was taken away; the owner check on release handles it.
      }
    }, LOCK_HEARTBEAT_MS);
    heartbeat.unref();
    try {
      return await work();
    } finally {
      clearInterval(heartbeat);
      try {
        if (readFileSync(lockPath, "utf8") === owner) unlinkSync(lockPath);
      } catch {
        // Already gone, or now owned by a process that broke a stale lock.
      }
    }
  };

  const revokeAll = async (credentials: Credentials): Promise<Pick<LogoutReport, "revoked" | "revoke_failed">> => {
    const outcome = { revoked: [] as string[], revoke_failed: {} as Record<string, string> };
    const tokens: ["access_token" | "refresh_token", string | undefined][] = [
      ["access_token", credentials.access_token],
      ["refresh_token", credentials.refresh_token],
    ];
    for (const [kind, token] of tokens) {
      if (!token) continue;
      try {
        await revokeToken(deps.endpoints.revoke, credentials.client_id, token, kind, fetchLike);
        outcome.revoked.push(kind);
      } catch (error) {
        outcome.revoke_failed[kind] = scrub((error as Error).message, [credentials.access_token, credentials.refresh_token]);
      }
    }
    return outcome;
  };

  /** Tokens X issued that nothing here can keep must not stay live at X. Best effort; the result says how it went. */
  const discardUnsaved = async (credentials: Credentials): Promise<string> => {
    const { revoke_failed } = await revokeAll(credentials);
    return Object.keys(revoke_failed).length
      ? "the new tokens could not all be revoked at X, so revoke the app at https://x.com/settings/connected_apps to be sure"
      : "the new tokens were revoked at X";
  };

  const refresh = async (): Promise<string> =>
    withCredentialLock(async () => {
      // Another process may have refreshed while this one waited for the lock.
      const current = await readCredentials();
      if (!current) throw authRequired("not logged in to X");
      if (fresh(current)) return current.access_token;
      if (!current.refresh_token) throw authRequired("the X access token expired and the login has no refresh token");
      const secrets = [current.refresh_token, current.access_token];
      let tokens: TokenResponse;
      try {
        tokens = await refreshTokens(deps.endpoints.token, current.client_id, current.refresh_token, fetchLike);
      } catch (error) {
        if (!(error instanceof TokenEndpointError)) throw error;
        // The stored login is kept so the user can see what happened and decide; nothing is cleared silently.
        if (isRejection(error)) {
          throw authRequired(`X rejected the refresh token (${scrub(error.message, secrets)}); the stored login was left in place`, ["Run `x-axi logout` to delete the stored login"]);
        }
        throw new AxiError(`X's token endpoint gave no usable answer (${scrub(error.message, secrets)}); the stored login is unchanged`, "X_UNAVAILABLE", ["Try again later; do not retry in a loop"]);
      }
      const next = fromTokens(tokens, current.client_id, current, now());
      // Persisted before use: if this process dies after here, the next one finds the new refresh token.
      try {
        await deps.store.write(JSON.stringify(next));
      } catch (error) {
        // X has already consumed the old refresh token, so the stored login is dead and the user must know.
        const reason = error instanceof AxiError ? error.message : String(error);
        const discarded = await discardUnsaved(next);
        throw authRequired(`X refreshed the login, but the new tokens could not be saved (${scrub(reason, [...secrets, next.access_token, next.refresh_token])}), so the stored login no longer works; ${discarded}`);
      }
      return next.access_token;
    });

  const describe = (credentials: Credentials): AuthStatus => ({
    logged_in: true,
    storage: deps.store.backend,
    client_id: credentials.client_id,
    scopes: credentials.scope,
    access_token_expires_at: credentials.expires_at,
    access_token: new Date(credentials.expires_at).getTime() > now() ? "valid" : "expired",
    refresh_token: credentials.refresh_token ? "present" : "absent",
  });

  /** One loopback server for one login. It answers the browser, then closes. */
  const waitForCode = (state: string, onListening: () => void): Promise<string> =>
    new Promise((resolve, reject) => {
      const redirect = new URL(deps.redirectUri);
      let server: Server | undefined;
      const finish = (outcome: () => void): void => {
        clearTimeout(timer);
        server?.close();
        outcome();
      };
      const timer = setTimeout(
        () => finish(() => reject(new AxiError("no sign-in arrived within the time limit; nothing was stored", "LOGIN_TIMEOUT", ["Run `x-axi login` again and finish in the browser"]))),
        deps.loginTimeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS,
      );
      server = createServer((req, res) => {
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.setHeader("Connection", "close");
        let url: URL;
        try {
          url = new URL(req.url ?? "/", `http://${redirect.host}`);
        } catch {
          res.statusCode = 400;
          res.end("x-axi: not a request this callback understands\n");
          return;
        }
        if (req.method !== "GET" || url.pathname !== redirect.pathname) {
          res.statusCode = 404;
          res.end("x-axi: not the callback path\n");
          return;
        }
        if (url.searchParams.get("state") !== state) {
          // A stale tab or a cross-site request: refused, and the real callback is still awaited.
          res.statusCode = 400;
          res.end("x-axi: this sign-in response does not belong to the running login; start `x-axi login` again\n");
          deps.log("Ignored a callback with the wrong state.");
          return;
        }
        const denied = url.searchParams.get("error");
        if (denied) {
          res.statusCode = 400;
          res.end("x-axi: X did not grant access. You can close this tab.\n");
          finish(() => reject(new AxiError(`X did not grant access: ${denied.slice(0, 100)}`, "LOGIN_DENIED", ["Run `x-axi login` again and choose Authorize app"])));
          return;
        }
        const code = url.searchParams.get("code");
        if (!code) {
          res.statusCode = 400;
          res.end("x-axi: the sign-in response had no code\n");
          finish(() => reject(new AxiError("the sign-in response had no authorization code", "LOGIN_FAILED")));
          return;
        }
        res.statusCode = 200;
        res.end("x-axi received the sign-in response. Return to the terminal; it reports whether the login succeeded. You can close this tab.\n");
        finish(() => resolve(code));
      });
      server.on("error", (error: NodeJS.ErrnoException) => {
        finish(() =>
          reject(
            error.code === "EADDRINUSE"
              ? new AxiError(`${redirect.host} is in use, so the sign-in callback cannot listen`, "PORT_IN_USE", ["Stop the other process, or set a different loopback redirect_uri in the config file and register it with X"])
              : new AxiError(`the sign-in callback server failed: ${error.code ?? error.message}`, "LOGIN_FAILED"),
          ),
        );
      });
      server.listen(Number(redirect.port), redirect.hostname, onListening);
    });

  return {
    async accessToken() {
      const credentials = await readCredentials();
      if (!credentials) throw authRequired("not logged in to X");
      if (fresh(credentials)) return credentials.access_token;
      return refresh();
    },

    async login(clientId) {
      // Before the browser: a keystore that cannot be read will not keep the tokens X is about to issue.
      try {
        await deps.store.read();
      } catch (error) {
        if (!(error instanceof AxiError && error.code === "KEYSTORE_CORRUPT")) throw error;
      }
      const verifier = randomVerifier();
      const state = randomState();
      const url = authorizeUrl(deps.endpoints.authorize, { clientId, redirectUri: deps.redirectUri, scopes: SCOPES, state, codeChallenge: codeChallenge(verifier) });
      const code = await waitForCode(state, () => {
        deps.log(`Opening your browser to sign in to X. If it does not open, visit:\n${url}`);
        deps.openBrowser(url).catch((error: Error) => deps.log(`Could not open a browser (${error.message}); use the link above.`));
      });
      // The code lasts 30 seconds, so the exchange follows at once.
      let tokens: TokenResponse;
      try {
        tokens = await exchangeCode(deps.endpoints.token, { clientId, code, redirectUri: deps.redirectUri, codeVerifier: verifier }, fetchLike);
      } catch (error) {
        if (!(error instanceof TokenEndpointError)) throw error;
        if (isRejection(error)) {
          throw new AxiError(`X refused the code exchange (${scrub(error.message, [])}); nothing was stored`, "LOGIN_FAILED", [
            "Check that the client ID is the app's OAuth 2.0 Client ID and that the app type is Native App",
            `Check that ${deps.redirectUri} is registered as the app's callback URI`,
          ]);
        }
        throw new AxiError(`X's token endpoint gave no usable answer (${scrub(error.message, [])}); nothing was stored`, "X_UNAVAILABLE", ["Run `x-axi login` again later"]);
      }
      const credentials = fromTokens(tokens, clientId, undefined, now());
      // Under the lock, so a refresh in another process cannot write the previous login back over this one.
      try {
        await withCredentialLock(() => deps.store.write(JSON.stringify(credentials)));
      } catch (error) {
        const known = error instanceof AxiError;
        const reason = known ? error.message : String(error);
        const discarded = await discardUnsaved(credentials);
        throw new AxiError(`X granted the login, but it could not be saved (${scrub(reason, [credentials.access_token, credentials.refresh_token])}); ${discarded}`, known ? error.code : "KEYSTORE_ERROR", known ? error.suggestions : []);
      }
      return describe(credentials);
    },

    logout() {
      return withCredentialLock(async () => {
        let raw: string | undefined;
        let unreadable: string | undefined;
        try {
          raw = await deps.store.read();
        } catch (error) {
          // A record the backend cannot decode is still a record, and logout must be able to remove it.
          if (!(error instanceof AxiError && error.code === "KEYSTORE_CORRUPT")) throw error;
          unreadable = error.message;
        }
        const credentials = raw === undefined ? undefined : parseCredentials(raw);
        const outcome = credentials ? await revokeAll(credentials) : { revoked: [], revoke_failed: {} };
        const report: LogoutReport = { had_login: raw !== undefined || unreadable !== undefined, ...outcome, deleted: false };
        if (!credentials && report.had_login) {
          report.revoke_failed["all"] = `nothing was revoked because the stored record could not be read: ${unreadable ?? "it is not one this version wrote"}`;
        }
        try {
          await deps.store.delete();
        } catch (error) {
          const revoked = report.revoked.length
            ? `revoked ${report.revoked.join(" and ")} at X, but`
            : Object.keys(report.revoke_failed).length
              ? "could not revoke at X, and"
              : "found nothing to revoke, and";
          if (error instanceof AxiError) throw new AxiError(`${revoked} ${error.message}`, error.code, error.suggestions);
          throw error;
        }
        report.deleted = true;
        return report;
      });
    },

    async status() {
      let raw: string | undefined;
      try {
        raw = await deps.store.read();
      } catch (error) {
        if (error instanceof AxiError && error.code.startsWith("KEYSTORE_")) {
          return { logged_in: false, storage: deps.store.backend, problem: error.message, help: error.suggestions };
        }
        throw error;
      }
      if (raw === undefined) return { logged_in: false, storage: deps.store.backend, help: [LOGIN_HINT] };
      const credentials = parseCredentials(raw);
      if (!credentials) {
        return { logged_in: false, storage: deps.store.backend, problem: "the stored login is not one this version can read", help: ["Run `x-axi logout` to delete it, then `x-axi login`"] };
      }
      return describe(credentials);
    },
  };
}
