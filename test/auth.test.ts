import { AxiError } from "axi-sdk-js";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createAuth, type AuthDeps, type Credentials } from "../src/auth.js";
import type { Keystore } from "../src/keystore.js";
import { authorizeUrl, codeChallenge, randomState, randomVerifier, SCOPES } from "../src/oauth.js";

// ---- PKCE against an independent oracle ------------------------------------

describe("PKCE", () => {
  it("matches the RFC 7636 appendix B test vector", () => {
    expect(codeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("makes verifiers and states of the right shape, and different each time", () => {
    const verifiers = new Set(Array.from({ length: 20 }, randomVerifier));
    expect(verifiers.size).toBe(20);
    for (const v of verifiers) expect(v).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomState()).not.toBe(randomState());
  });

  it("builds an S256 authorize URL carrying state, scopes, and the callback", () => {
    const url = new URL(authorizeUrl("https://x.com/i/oauth2/authorize", { clientId: "cid", redirectUri: "http://127.0.0.1:8711/callback", scopes: SCOPES, state: "st", codeChallenge: "ch" }));
    expect(url.origin + url.pathname).toBe("https://x.com/i/oauth2/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: "cid",
      redirect_uri: "http://127.0.0.1:8711/callback",
      scope: SCOPES.join(" "),
      state: "st",
      code_challenge: "ch",
      code_challenge_method: "S256",
    });
    expect(SCOPES).toContain("offline.access");
    expect(SCOPES).toContain("tweet.moderate.write");
    expect(SCOPES).toContain("follows.read");
  });
});

// ---- a fake X OAuth server ---------------------------------------------------

interface FormRequest {
  path: string;
  headers: Record<string, string | string[] | undefined>;
  form: Record<string, string>;
}

const ACCESS = "ACCESS_TOKEN_SECRET_1";
const REFRESH = "REFRESH_TOKEN_SECRET_1";
const ACCESS_2 = "ACCESS_TOKEN_SECRET_2";
const REFRESH_2 = "REFRESH_TOKEN_SECRET_2";
const ALL_SECRETS = [ACCESS, REFRESH, ACCESS_2, REFRESH_2];

/** Issues one code per challenge, exchanges it once with a matching verifier, refreshes, and revokes. */
class FakeX {
  server!: Server;
  base = "";
  requests: FormRequest[] = [];
  codes = new Map<string, string>();
  refreshTokens = new Set<string>([REFRESH]);
  refreshResponse: () => Record<string, unknown> | { status: number; body: Record<string, unknown> } = () => ({ access_token: ACCESS_2, refresh_token: REFRESH_2, expires_in: 7200, scope: "tweet.read users.read", token_type: "bearer" });
  revokeStatus = 200;
  revokeBody: Record<string, unknown> | undefined;
  refreshDelayMs = 0;

  async start() {
    this.server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString()));
      req.on("end", () => void this.handle(req.url ?? "", req.headers, body, res));
    });
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  /** The browser's part: visit the authorize URL and come back to the callback with a code. */
  async browse(url: string, tamper: (params: URLSearchParams) => void = () => undefined): Promise<void> {
    const authorize = new URL(url);
    expect(authorize.origin + authorize.pathname).toBe(`${this.base}/authorize`);
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    const code = `code-${this.codes.size + 1}`;
    this.codes.set(code, authorize.searchParams.get("code_challenge") ?? "");
    const back = new URL(authorize.searchParams.get("redirect_uri") ?? "");
    back.searchParams.set("code", code);
    back.searchParams.set("state", authorize.searchParams.get("state") ?? "");
    tamper(back.searchParams);
    await fetch(back);
  }

  private async handle(url: string, headers: FormRequest["headers"], body: string, res: import("node:http").ServerResponse) {
    const form = Object.fromEntries(new URLSearchParams(body));
    this.requests.push({ path: url, headers, form });
    const json = (status: number, value: unknown) => {
      res.statusCode = status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(value));
    };
    if (headers["content-type"] !== "application/x-www-form-urlencoded") return json(400, { error: "invalid_request", error_description: "form expected" });
    if (headers["authorization"]) return json(401, { error: "invalid_client", error_description: "public client sent an Authorization header" });
    if (form["client_id"] !== "client-id-1234") return json(401, { error: "invalid_client" });
    if (url === "/token" && form["grant_type"] === "authorization_code") {
      const challenge = this.codes.get(form["code"] ?? "");
      this.codes.delete(form["code"] ?? "");
      if (!challenge || codeChallenge(form["code_verifier"] ?? "") !== challenge || form["redirect_uri"] !== "http://127.0.0.1:8711/callback") {
        return json(400, { error: "invalid_request", error_description: "Value passed for the authorization code was invalid." });
      }
      return json(200, { token_type: "bearer", expires_in: 7200, access_token: ACCESS, scope: SCOPES.join(" "), refresh_token: REFRESH });
    }
    if (url === "/token" && form["grant_type"] === "refresh_token") {
      if (this.refreshDelayMs) await new Promise((r) => setTimeout(r, this.refreshDelayMs));
      if (!this.refreshTokens.delete(form["refresh_token"] ?? "")) return json(400, { error: "invalid_grant", error_description: `Value passed for the token was invalid. ${form["refresh_token"] ?? ""}` });
      const answer = this.refreshResponse();
      if ("status" in answer && typeof answer.status === "number") return json(answer.status, answer.body);
      if (typeof answer["refresh_token"] === "string") this.refreshTokens.add(answer["refresh_token"]);
      return json(200, answer);
    }
    if (url === "/revoke") return json(this.revokeStatus, this.revokeBody ?? (this.revokeStatus === 200 ? { revoked: true } : { error: "invalid_request" }));
    return json(404, {});
  }

  stop() {
    this.server.close();
  }
}

// ---- an injected keystore ------------------------------------------------------

function memoryStore(initial?: string, options: { writeDelayMs?: number; failWrite?: boolean; unavailable?: boolean } = {}) {
  let value = initial;
  const writes: string[] = [];
  const reads = { count: 0 };
  const store: Keystore = {
    backend: "fake keystore",
    async read() {
      if (options.unavailable) throw new AxiError("no keystore here", "KEYSTORE_UNAVAILABLE", ["Install one"]);
      reads.count += 1;
      return value;
    },
    async write(secret) {
      if (options.writeDelayMs) await new Promise((r) => setTimeout(r, options.writeDelayMs));
      if (options.failWrite) throw new AxiError("disk on fire", "KEYSTORE_ERROR");
      writes.push(secret);
      value = secret;
    },
    async delete() {
      if (options.unavailable) throw new AxiError("no keystore here", "KEYSTORE_UNAVAILABLE", ["Install one"]);
      value = undefined;
    },
  };
  return { store, writes, reads, current: () => value };
}

const x = new FakeX();
let dir: string;
beforeAll(() => x.start());
afterAll(() => x.stop());
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "x-axi-auth-"));
  x.requests = [];
  x.refreshTokens = new Set([REFRESH]);
  x.revokeStatus = 200;
  x.refreshDelayMs = 0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function credentials(overrides: Partial<Credentials> = {}): string {
  return JSON.stringify({
    version: 1,
    client_id: "client-id-1234",
    access_token: ACCESS,
    refresh_token: REFRESH,
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    scope: ["tweet.read", "users.read"],
    obtained_at: new Date().toISOString(),
    ...overrides,
  } satisfies Credentials);
}

const EXPIRED = { expires_at: new Date(Date.now() - 1000).toISOString() };

function auth(store: Keystore, overrides: Partial<AuthDeps> = {}) {
  const logged: string[] = [];
  const opened: string[] = [];
  const service = createAuth({
    store,
    endpoints: { authorize: `${x.base}/authorize`, token: `${x.base}/token`, revoke: `${x.base}/revoke` },
    redirectUri: "http://127.0.0.1:8711/callback",
    lockDir: dir,
    openBrowser: async (url) => {
      opened.push(url);
      await x.browse(url);
    },
    log: (line) => logged.push(line),
    loginTimeoutMs: 5000,
    ...overrides,
  });
  return { service, logged, opened };
}

const rejection = (promise: Promise<unknown>) => promise.then(() => { throw new Error("expected rejection"); }, (e: Error & { code: string; suggestions: string[] }) => e);

// ---- login ------------------------------------------------------------------------

describe("login", () => {
  it("completes the PKCE callback flow and stores the tokens without printing them", async () => {
    const m = memoryStore();
    const { service, logged, opened } = auth(m.store);
    const status = await service.login("client-id-1234");
    expect(opened).toHaveLength(1);
    expect(status).toEqual({
      logged_in: true,
      storage: "fake keystore",
      client_id: "client-id-1234",
      scopes: SCOPES,
      access_token_expires_at: expect.any(String),
      access_token: "valid",
      refresh_token: "present",
    });
    const exchange = x.requests.find((r) => r.form["grant_type"] === "authorization_code")!;
    expect(exchange.form["client_id"]).toBe("client-id-1234");
    expect(exchange.headers["authorization"]).toBeUndefined();
    const stored = JSON.parse(m.current()!) as Credentials;
    expect(stored).toMatchObject({ version: 1, access_token: ACCESS, refresh_token: REFRESH, client_id: "client-id-1234" });
    expect(new Date(stored.expires_at).getTime() - Date.now()).toBeGreaterThan(7000_000);
    for (const secret of ALL_SECRETS) {
      expect(JSON.stringify(status)).not.toContain(secret);
      expect(logged.join("\n")).not.toContain(secret);
    }
    expect(logged[0]).toContain(`${x.base}/authorize`);
  });

  it("ignores a callback with the wrong state and still accepts the real one", async () => {
    const m = memoryStore();
    const { service, logged } = auth(m.store, {
      openBrowser: async (url) => {
        await x.browse(url, (params) => params.set("state", "forged"));
        await x.browse(url);
      },
    });
    await service.login("client-id-1234");
    expect(logged).toContain("Ignored a callback with the wrong state.");
    expect(x.requests.filter((r) => r.path === "/token")).toHaveLength(1);
    expect(m.writes).toHaveLength(1);
  });

  it("stores nothing when the user denies access", async () => {
    const m = memoryStore();
    const { service } = auth(m.store, {
      openBrowser: async (url) => x.browse(url, (params) => { params.delete("code"); params.set("error", "access_denied"); }),
    });
    await expect(service.login("client-id-1234")).rejects.toMatchObject({ code: "LOGIN_DENIED" });
    expect(x.requests).toEqual([]);
    expect(m.writes).toEqual([]);
  });

  it("stores nothing when X refuses the exchange, and names the likely portal mistakes", async () => {
    const m = memoryStore();
    const { service } = auth(m.store, { openBrowser: async (url) => x.browse(url, (params) => params.set("code", "stolen")) });
    const error = await rejection(service.login("client-id-1234"));
    expect(error.code).toBe("LOGIN_FAILED");
    expect(error.suggestions.join("\n")).toContain("http://127.0.0.1:8711/callback");
    expect(m.writes).toEqual([]);
  });

  it("times out without storing anything when nobody signs in", async () => {
    const m = memoryStore();
    const { service } = auth(m.store, { openBrowser: async () => undefined, loginTimeoutMs: 100 });
    await expect(service.login("client-id-1234")).rejects.toMatchObject({ code: "LOGIN_TIMEOUT" });
    expect(m.writes).toEqual([]);
  });

  it("answers a malformed request path and still accepts the real callback", async () => {
    const m = memoryStore();
    const statuses: number[] = [];
    const { service } = auth(m.store, {
      openBrowser: async (url) => {
        statuses.push((await fetch("http://127.0.0.1:8711//")).status);
        await x.browse(url);
      },
    });
    await expect(service.login("client-id-1234")).resolves.toMatchObject({ logged_in: true });
    expect(statuses).toEqual([400]);
    expect(m.writes).toHaveLength(1);
  });

  it("stops before the browser when the keystore cannot be read", async () => {
    for (const code of ["KEYSTORE_UNAVAILABLE", "KEYSTORE_LOCKED"]) {
      const m = memoryStore();
      const store: Keystore = { ...m.store, read: async () => { throw new AxiError("cannot read", code); } };
      const { service, opened } = auth(store);
      await expect(service.login("client-id-1234")).rejects.toMatchObject({ code });
      expect(opened).toEqual([]);
      expect(x.requests).toEqual([]);
    }
  });

  it("replaces a record the backend cannot decode", async () => {
    const m = memoryStore();
    const store: Keystore = { ...m.store, read: async () => { throw new AxiError("not one this version wrote", "KEYSTORE_CORRUPT"); } };
    await expect(auth(store).service.login("client-id-1234")).resolves.toMatchObject({ logged_in: true });
    expect(m.writes).toHaveLength(1);
  });

  it("revokes the new tokens at X when the save fails, and says so", async () => {
    const m = memoryStore(undefined, { failWrite: true });
    const error = await rejection(auth(m.store).service.login("client-id-1234"));
    expect(error.code).toBe("KEYSTORE_ERROR");
    expect(error.message).toContain("disk on fire");
    expect(error.message).toContain("the new tokens were revoked at X");
    for (const secret of ALL_SECRETS) expect(error.message).not.toContain(secret);
    expect(x.requests.filter((r) => r.path === "/revoke").map((r) => r.form["token"])).toEqual([ACCESS, REFRESH]);
  });

  it("says the new tokens may still be live when their revocation fails too", async () => {
    x.revokeStatus = 503;
    const error = await rejection(auth(memoryStore(undefined, { failWrite: true }).store).service.login("client-id-1234"));
    expect(error.code).toBe("KEYSTORE_ERROR");
    expect(error.message).toContain("could not all be revoked");
    for (const secret of ALL_SECRETS) expect(error.message).not.toContain(secret);
  });

  it("revokes the new tokens at X when the credential lock cannot be taken", async () => {
    writeFileSync(join(dir, "auth.lock"), "another process");
    let clock = Date.now();
    const m = memoryStore();
    const error = await rejection(auth(m.store, { now: () => clock, sleep: async () => { clock += 10_000; } }).service.login("client-id-1234"));
    expect(error.code).toBe("AUTH_LOCKED");
    expect(error.suggestions).toEqual([expect.stringContaining("auth.lock")]);
    expect(m.writes).toEqual([]);
    expect(x.requests.filter((r) => r.path === "/revoke").map((r) => r.form["token"])).toEqual([ACCESS, REFRESH]);
  });

  it("keeps the replaced login's tokens revocable without revoking them or exposing them", async () => {
    const old = credentials({ access_token: "OLD_ACCESS", refresh_token: "OLD_REFRESH", client_id: "client-id-1234" });
    const m = memoryStore(old);
    const result = await auth(m.store).service.login("client-id-1234");
    expect(x.requests.filter((r) => r.path === "/revoke")).toEqual([]);
    expect(JSON.parse(m.current()!)).toMatchObject({ access_token: ACCESS, refresh_token: REFRESH });
    expect(JSON.stringify(result)).not.toContain("OLD_");
    await expect(result.revokeReplaced!()).resolves.toEqual({ revoked: ["access_token", "refresh_token"], revoke_failed: {} });
    expect(x.requests.filter((r) => r.path === "/revoke").map((r) => r.form)).toEqual([
      { token: "OLD_ACCESS", token_type_hint: "access_token", client_id: "client-id-1234" },
      { token: "OLD_REFRESH", token_type_hint: "refresh_token", client_id: "client-id-1234" },
    ]);
    expect(JSON.parse(m.current()!)).toMatchObject({ access_token: ACCESS, refresh_token: REFRESH });
  });

  it("offers no revocation when nothing readable was replaced", async () => {
    for (const initial of [undefined, "garbage"]) {
      const result = await auth(memoryStore(initial).store).service.login("client-id-1234");
      expect(result).not.toHaveProperty("revokeReplaced");
    }
  });

  it("reports a busy callback port", async () => {
    const blocker = createServer();
    await new Promise<void>((r) => blocker.listen(8711, "127.0.0.1", r));
    try {
      const { service } = auth(memoryStore().store, { openBrowser: async () => undefined });
      await expect(service.login("client-id-1234")).rejects.toMatchObject({ code: "PORT_IN_USE" });
    } finally {
      blocker.close();
    }
  });
});

// ---- access tokens and refresh ----------------------------------------------------

describe("access token", () => {
  it("requires a login", async () => {
    const { service } = auth(memoryStore().store);
    await expect(service.accessToken()).rejects.toMatchObject({ code: "AUTH_REQUIRED", suggestions: [expect.stringContaining("x-axi login")] });
  });

  it("uses a fresh token without touching X", async () => {
    const { service } = auth(memoryStore(credentials()).store);
    await expect(service.accessToken()).resolves.toBe(ACCESS);
    expect(x.requests).toEqual([]);
  });

  it("refreshes near expiry and persists the rotated refresh token before returning", async () => {
    const m = memoryStore(credentials({ expires_at: new Date(Date.now() + 60_000).toISOString() }));
    const { service } = auth(m.store);
    await expect(service.accessToken()).resolves.toBe(ACCESS_2);
    const refresh = x.requests.find((r) => r.form["grant_type"] === "refresh_token")!;
    expect(refresh.form).toEqual({ grant_type: "refresh_token", refresh_token: REFRESH, client_id: "client-id-1234" });
    expect(refresh.headers["authorization"]).toBeUndefined();
    const stored = JSON.parse(m.current()!) as Credentials;
    expect(stored).toMatchObject({ access_token: ACCESS_2, refresh_token: REFRESH_2, scope: ["tweet.read", "users.read"] });
    expect(new Date(stored.expires_at).getTime() - Date.now()).toBeGreaterThan(7000_000);
    // The next call needs no refresh and X is not asked again.
    await expect(service.accessToken()).resolves.toBe(ACCESS_2);
    expect(x.requests).toHaveLength(1);
  });

  it("keeps the old refresh token when X returns none", async () => {
    x.refreshResponse = () => ({ access_token: ACCESS_2, expires_in: 7200, token_type: "bearer" });
    const m = memoryStore(credentials(EXPIRED));
    try {
      await expect(auth(m.store).service.accessToken()).resolves.toBe(ACCESS_2);
      expect(JSON.parse(m.current()!)).toMatchObject({ access_token: ACCESS_2, refresh_token: REFRESH, scope: ["tweet.read", "users.read"] });
    } finally {
      x.refreshResponse = () => ({ access_token: ACCESS_2, refresh_token: REFRESH_2, expires_in: 7200, scope: "tweet.read users.read", token_type: "bearer" });
    }
  });

  it("turns invalid_grant into AUTH_REQUIRED, leaves the stored login in place, and scrubs the token from X's message", async () => {
    const stale = credentials({ ...EXPIRED, refresh_token: "REFRESH_TOKEN_SECRET_STALE" });
    const m = memoryStore(stale);
    const error = await rejection(auth(m.store).service.accessToken());
    expect(error.code).toBe("AUTH_REQUIRED");
    expect(error.message).toContain("invalid_grant");
    expect(error.message).not.toContain("REFRESH_TOKEN_SECRET_STALE");
    expect(error.suggestions.join("\n")).toContain("x-axi login");
    expect(m.current()).toBe(stale);
    expect(x.requests).toHaveLength(1);
  });

  it("does not retry a failing token endpoint", async () => {
    x.refreshResponse = () => ({ status: 503, body: { error: "temporarily_unavailable" } });
    try {
      const m = memoryStore(credentials(EXPIRED));
      await expect(auth(m.store).service.accessToken()).rejects.toMatchObject({ code: "X_UNAVAILABLE" });
      expect(x.requests).toHaveLength(1);
      expect(JSON.parse(m.current()!)).toMatchObject({ access_token: ACCESS });
    } finally {
      x.refreshResponse = () => ({ access_token: ACCESS_2, refresh_token: REFRESH_2, expires_in: 7200, scope: "tweet.read users.read", token_type: "bearer" });
    }
  });

  it("reports an unreachable token endpoint without a retry or a token", async () => {
    const m = memoryStore(credentials(EXPIRED));
    const { service } = auth(m.store, { endpoints: { authorize: "http://127.0.0.1:9/a", token: "http://127.0.0.1:9/token", revoke: "http://127.0.0.1:9/revoke" } });
    const error = await rejection(service.accessToken());
    expect(error.code).toBe("X_UNAVAILABLE");
    for (const secret of ALL_SECRETS) expect(error.message).not.toContain(secret);
  });

  it("refuses a login with no refresh token once it expires", async () => {
    const m = memoryStore(credentials({ ...EXPIRED, refresh_token: undefined }));
    await expect(auth(m.store).service.accessToken()).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    expect(x.requests).toEqual([]);
  });

  it("spends a single-use refresh token once across concurrent processes", async () => {
    x.refreshDelayMs = 100;
    const m = memoryStore(credentials(EXPIRED), { writeDelayMs: 50 });
    const a = auth(m.store).service;
    const b = auth(m.store).service;
    const c = auth(m.store).service;
    const tokens = await Promise.all([a.accessToken(), b.accessToken(), c.accessToken()]);
    expect(tokens).toEqual([ACCESS_2, ACCESS_2, ACCESS_2]);
    expect(x.requests.filter((r) => r.form["grant_type"] === "refresh_token")).toHaveLength(1);
    expect(m.writes).toHaveLength(1);
  });

  it("says the login is dead when X refreshed it but the new tokens could not be saved, and releases the lock", async () => {
    const m = memoryStore(credentials(EXPIRED), { failWrite: true });
    const { service } = auth(m.store);
    const error = await rejection(service.accessToken());
    expect(error.code).toBe("AUTH_REQUIRED");
    expect(error.message).toContain("could not be saved");
    expect(error.message).toContain("disk on fire");
    expect(error.message).toContain("the new tokens were revoked at X");
    for (const secret of ALL_SECRETS) expect(error.message).not.toContain(secret);
    expect(x.requests.filter((r) => r.path === "/revoke").map((r) => r.form["token"])).toEqual([ACCESS_2, REFRESH_2]);
    // The lock is free: a second attempt reaches X again instead of waiting out the lock.
    await expect(service.accessToken()).rejects.toMatchObject({ code: "AUTH_REQUIRED", message: expect.stringContaining("invalid_grant") });
    expect(x.requests.filter((r) => r.path === "/token")).toHaveLength(2);
  });

  it("treats a rate limit or an unusable body from the token endpoint as X being unavailable, not as a rejected login", async () => {
    for (const answer of [{ status: 429, body: { error: "too_many_requests" } }, { status: 200, body: { nonsense: true } }]) {
      x.refreshResponse = () => answer;
      x.refreshTokens = new Set([REFRESH]);
      const m = memoryStore(credentials(EXPIRED));
      const error = await rejection(auth(m.store).service.accessToken());
      expect(error.code).toBe("X_UNAVAILABLE");
      expect(error.suggestions.join(" ")).not.toContain("logout");
      expect(JSON.parse(m.current()!)).toMatchObject({ refresh_token: REFRESH });
    }
    x.refreshResponse = () => ({ access_token: ACCESS_2, refresh_token: REFRESH_2, expires_in: 7200, scope: "tweet.read users.read", token_type: "bearer" });
  });

  it("keeps a rotated refresh token even when X omits the lifetime", async () => {
    x.refreshResponse = () => ({ access_token: ACCESS_2, refresh_token: REFRESH_2, token_type: "bearer" });
    try {
      const m = memoryStore(credentials(EXPIRED));
      await expect(auth(m.store).service.accessToken()).resolves.toBe(ACCESS_2);
      expect(JSON.parse(m.current()!)).toMatchObject({ refresh_token: REFRESH_2 });
    } finally {
      x.refreshResponse = () => ({ access_token: ACCESS_2, refresh_token: REFRESH_2, expires_in: 7200, scope: "tweet.read users.read", token_type: "bearer" });
    }
  });

  it("does not let a refresh write the old login back over a logout", async () => {
    x.refreshDelayMs = 150;
    const m = memoryStore(credentials(EXPIRED));
    const refreshing = auth(m.store).service.accessToken();
    await new Promise((r) => setTimeout(r, 30));
    const report = await auth(m.store).service.logout();
    await refreshing;
    expect(report.deleted).toBe(true);
    expect(m.current()).toBeUndefined();
  });

  it("breaks a stale lock left by a crashed process", async () => {
    const lock = join(dir, "auth.lock");
    writeFileSync(lock, "99999\n");
    const old = (Date.now() - 120_000) / 1000;
    utimesSync(lock, old, old);
    const m = memoryStore(credentials(EXPIRED));
    await expect(auth(m.store).service.accessToken()).resolves.toBe(ACCESS_2);
  });

  it("gives up on a live lock instead of refreshing twice", async () => {
    writeFileSync(join(dir, "auth.lock"), `${process.pid}\n`);
    let clock = Date.now();
    const m = memoryStore(credentials(EXPIRED));
    const { service } = auth(m.store, { now: () => clock, sleep: async () => { clock += 10_000; } });
    await expect(service.accessToken()).rejects.toMatchObject({ code: "AUTH_LOCKED", suggestions: [expect.stringContaining("auth.lock")] });
    expect(x.requests).toEqual([]);
  });

  it("refuses an unreadable record instead of using it", async () => {
    await expect(auth(memoryStore("{not json").store).service.accessToken()).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    await expect(auth(memoryStore(JSON.stringify({ version: 1, access_token: 5 })).store).service.accessToken()).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
  });
});

// ---- status and logout --------------------------------------------------------------

describe("status", () => {
  it("describes a login without any token", async () => {
    const status = await auth(memoryStore(credentials()).store).service.status();
    expect(status).toEqual({
      logged_in: true,
      storage: "fake keystore",
      client_id: "client-id-1234",
      scopes: ["tweet.read", "users.read"],
      access_token_expires_at: expect.any(String),
      access_token: "valid",
      refresh_token: "present",
    });
    for (const secret of ALL_SECRETS) expect(JSON.stringify(status)).not.toContain(secret);
    expect((await auth(memoryStore(credentials(EXPIRED)).store).service.status()).access_token).toBe("expired");
  });

  it("says there is no login, and why when the keystore is unavailable", async () => {
    await expect(auth(memoryStore().store).service.status()).resolves.toMatchObject({ logged_in: false, help: [expect.stringContaining("x-axi login")] });
    const unavailable = await auth(memoryStore(undefined, { unavailable: true }).store).service.status();
    expect(unavailable).toMatchObject({ logged_in: false, problem: "no keystore here", help: ["Install one"] });
    await expect(auth(memoryStore("garbage").store).service.status()).resolves.toMatchObject({ logged_in: false, problem: expect.stringContaining("not one this version can read") });
  });
});

describe("logout", () => {
  it("revokes both tokens at X as a public client, then deletes the record", async () => {
    const m = memoryStore(credentials());
    await expect(auth(m.store).service.logout()).resolves.toEqual({ had_login: true, revoked: ["access_token", "refresh_token"], revoke_failed: {}, deleted: true });
    const revokes = x.requests.filter((r) => r.path === "/revoke");
    expect(revokes.map((r) => r.form)).toEqual([
      { token: ACCESS, token_type_hint: "access_token", client_id: "client-id-1234" },
      { token: REFRESH, token_type_hint: "refresh_token", client_id: "client-id-1234" },
    ]);
    expect(m.current()).toBeUndefined();
  });

  it("does not count a 200 without revoked:true as a revocation", async () => {
    x.revokeBody = { revoked: false };
    try {
      const m = memoryStore(credentials());
      const report = await auth(m.store).service.logout();
      expect(report.revoked).toEqual([]);
      expect(Object.keys(report.revoke_failed)).toEqual(["access_token", "refresh_token"]);
      expect(m.current()).toBeUndefined();
    } finally {
      x.revokeBody = undefined;
    }
  });

  it("still deletes when revocation fails, and reports both honestly", async () => {
    x.revokeStatus = 400;
    const m = memoryStore(credentials());
    const report = await auth(m.store).service.logout();
    expect(report).toMatchObject({ had_login: true, revoked: [], deleted: true });
    expect(Object.keys(report.revoke_failed)).toEqual(["access_token", "refresh_token"]);
    for (const secret of ALL_SECRETS) expect(JSON.stringify(report)).not.toContain(secret);
    expect(m.current()).toBeUndefined();
  });

  it("deletes an unreadable record without calling X, says nothing was revoked, and is a no-op with none", async () => {
    const m = memoryStore("garbage");
    await expect(auth(m.store).service.logout()).resolves.toEqual({ had_login: true, revoked: [], revoke_failed: { all: expect.stringContaining("nothing was revoked") }, deleted: true });
    expect(m.current()).toBeUndefined();
    await expect(auth(memoryStore().store).service.logout()).resolves.toMatchObject({ had_login: false, deleted: true });
    expect(x.requests).toEqual([]);
  });

  it("deletes a record the backend cannot decode, so a corrupt item is never stuck", async () => {
    const m = memoryStore(credentials());
    const store: Keystore = { ...m.store, read: async () => { throw new AxiError("not one this version wrote", "KEYSTORE_CORRUPT"); } };
    await expect(auth(store).service.logout()).resolves.toEqual({ had_login: true, revoked: [], revoke_failed: { all: expect.stringContaining("not one this version wrote") }, deleted: true });
    // A backend failure, as opposed to a corrupt record, is not something logout may paper over.
    const failing: Keystore = { ...m.store, read: async () => { throw new AxiError("prompt denied", "KEYSTORE_ERROR"); } };
    await expect(auth(failing).service.logout()).rejects.toMatchObject({ code: "KEYSTORE_ERROR" });
    expect(m.current()).toBeUndefined();
    await expect(auth(store).service.status()).resolves.toMatchObject({ logged_in: false, problem: "not one this version wrote" });
    expect(x.requests).toEqual([]);
  });

  it("says what was revoked when the deletion itself fails", async () => {
    const m = memoryStore(credentials());
    const store: Keystore = { ...m.store, delete: async () => { throw new AxiError("keychain refused", "KEYSTORE_ERROR"); } };
    const error = await rejection(auth(store).service.logout());
    expect(error.code).toBe("KEYSTORE_ERROR");
    expect(error.message).toContain("revoked access_token and refresh_token at X, but");
    expect(error.message).toContain("keychain refused");
  });
});
