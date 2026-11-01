import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResponse, Json, Method, XClient } from "../src/api.js";
import { formatApproval, type ApprovalRequest, type ApprovalResult } from "../src/approve.js";
import type { AuthService, AuthStatus, LogoutReport } from "../src/auth.js";
import { buildCommands } from "../src/commands.js";
import { readConfig } from "../src/config.js";

const STATUS: AuthStatus = {
  logged_in: true,
  storage: "fake keystore",
  client_id: "client-id-1234",
  scopes: ["tweet.read"],
  access_token_expires_at: "2026-11-01T10:00:00.000Z",
  access_token: "valid",
  refresh_token: "present",
};
const LOGOUT: LogoutReport = { had_login: true, revoked: ["access_token", "refresh_token"], revoke_failed: {}, deleted: true };

/** Fake login state. Nothing in it resembles a token, so output tests can assert on the whole output. */
function fakeAuth(overrides: Partial<AuthService> = {}): AuthService {
  return {
    accessToken: async () => "fake-access-token",
    login: async () => STATUS,
    logout: async () => LOGOUT,
    status: async () => STATUS,
    ...overrides,
  };
}

type Call = { method: Method; path: string; body?: Json };
const ok = (body: Json, status = 200): ApiResponse => ({ status, body });
const ME = ok({ data: { id: "1", username: "shreejit" } });
const PARENT = ok({
  data: { id: "50", text: "parent text", author_id: "9" },
  includes: { users: [{ id: "9", username: "alice" }] },
});

function harness(handler: (call: Call) => ApiResponse | Promise<ApiResponse>, approval: ApprovalResult = "approved") {
  const calls: Call[] = [];
  const client: XClient = {
    request: async (method, path, body) => {
      const call = { method, path, ...(body ? { body } : {}) };
      calls.push(call);
      if (path === "/2/users/me") return ME;
      return handler(call);
    },
  };
  const requests: ApprovalRequest[] = [];
  const approve = vi.fn(async (request: ApprovalRequest) => {
    requests.push(request);
    return approval;
  });
  const writes = () => calls.filter((c) => c.method !== "GET");
  const auth = fakeAuth();
  return { commands: buildCommands({ client, approve, auth }), calls, writes, requests, approve, auth };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "x-axi-test-"));
  process.env["X_AXI_STATE_DIR"] = dir;
  process.env["X_AXI_CONFIG_DIR"] = join(dir, "config");
});
afterEach(() => {
  delete process.env["X_AXI_STATE_DIR"];
  delete process.env["X_AXI_CONFIG_DIR"];
  rmSync(dir, { recursive: true, force: true });
});

describe("approval gate", () => {
  for (const result of ["cancelled", "timed_out", "unavailable"] as const) {
    it(`sends nothing when approval is ${result}`, async () => {
      const h = harness(() => PARENT, result);
      await expect(h.commands["post"]!(["hello"])).rejects.toMatchObject({
        code: result === "unavailable" ? "APPROVAL_UNAVAILABLE" : "NOT_APPROVED",
      });
      await expect(h.commands["reply"]!(["50", "hi"])).rejects.toBeDefined();
      await expect(h.commands["delete"]!(["50"])).rejects.toBeDefined();
      await expect(h.commands["hide"]!(["50"])).rejects.toBeDefined();
      await expect(h.commands["unhide"]!(["50"])).rejects.toBeDefined();
      await expect(h.commands["follow"]!(["alice"])).rejects.toBeDefined();
      await expect(h.commands["unfollow"]!(["alice"])).rejects.toBeDefined();
      await expect(h.commands["dm"]!(["send", "alice", "hi"])).rejects.toBeDefined();
      expect(h.writes()).toEqual([]);
      expect(h.approve).toHaveBeenCalledTimes(8);
    });
  }

  it("shows the exact text and the parent post before a reply", async () => {
    const h = harness((c) => (c.method === "GET" ? PARENT : ok({ data: { id: "60" } }, 201)));
    await h.commands["reply"]!(["https://x.com/alice/status/50?s=20", "my reply"]);
    const shown = formatApproval(h.requests[0]!);
    expect(shown).toContain("my reply");
    expect(shown).toContain("@alice: parent text");
    expect(shown).toContain("@shreejit");
    expect(h.writes()[0]).toEqual({
      method: "POST",
      path: "/2/tweets",
      body: { text: "my reply", reply: { in_reply_to_tweet_id: "50" } },
    });
  });

  it("refuses invisible characters before asking for approval", async () => {
    const h = harness(() => PARENT);
    await expect(h.commands["post"]!(["safe‮text"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(h.approve).not.toHaveBeenCalled();
  });

  it("quotes URL post pricing in the dialog", async () => {
    const h = harness(() => ok({ data: { id: "2" } }, 201));
    await h.commands["post"]!(["see https://example.com"]);
    expect(h.requests[0]!.estCostUsd).toBe(0.2);
  });
});

describe("write failures", () => {
  it("never retries and reports unknown outcome when the network drops", async () => {
    let posts = 0;
    const h = harness(() => {
      posts += 1;
      throw new Error("socket hang up");
    });
    await expect(h.commands["post"]!(["hello"])).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    expect(posts).toBe(1);
  });

  it("reports unknown outcome on 5xx", async () => {
    const h = harness(() => ok({ title: "Service Unavailable" }, 503));
    await expect(h.commands["post"]!(["hello"])).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
  });

  it("reports unknown outcome on 2xx without an ID", async () => {
    const h = harness(() => ok({}, 201));
    await expect(h.commands["post"]!(["hello"])).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
  });

  it("turns the summon 403 into a browser fallback carrying the text", async () => {
    const detail = "Reply to this conversation is not allowed because you have not been mentioned or otherwise engaged by the author of the post you are replying to.";
    const h = harness((c) => (c.method === "GET" ? PARENT : ok({ detail }, 403)));
    const error = await h.commands["reply"]!(["50", "hi there"]).then(
      () => { throw new Error("expected rejection"); },
      (e: { code: string; suggestions: string[] }) => e,
    );
    expect(error.code).toBe("REPLY_NOT_SUMMONED");
    expect(error.suggestions[0]).toContain("in_reply_to=50");
    expect(error.suggestions[0]).toContain("text=hi+there");
  });

  it("does not report success when X did not confirm a delete", async () => {
    const h = harness((c) => (c.method === "GET" ? PARENT : ok({ data: { deleted: false } })));
    await expect(h.commands["delete"]!(["50"])).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
  });

  it("treats deleting a missing post as a no-op without approval", async () => {
    const h = harness(() => ok({ errors: [{ title: "Not Found Error" }] }));
    await expect(h.commands["delete"]!(["50"])).resolves.toMatchObject({ post: { status: "already gone (no-op)" } });
    expect(h.approve).not.toHaveBeenCalled();
  });
});

describe("reads", () => {
  it("states a definitive empty result", async () => {
    const h = harness(() => ok({ meta: { result_count: 0 } }));
    await expect(h.commands["mentions"]!([])).resolves.toMatchObject({ posts: "0 mentions found" });
  });

  it("surfaces partial errors on a 200", async () => {
    const h = harness(() => ok({ data: [{ id: "5", text: "x", author_id: "9" }], errors: [{ detail: "one hidden" }] }));
    await expect(h.commands["search"]!(["foo"])).resolves.toMatchObject({ partial_errors: "1: one hidden" });
  });

  it("flags which mentions an API reply can reach", async () => {
    const h = harness(() =>
      ok({
        data: [
          { id: "5", text: "@shreejit hi", author_id: "9", entities: { mentions: [{ username: "Shreejit" }] } },
          { id: "6", text: "no mention", author_id: "9" },
          { id: "7", text: "mine", author_id: "1" },
        ],
      }),
    );
    const out = (await h.commands["mentions"]!([])) as { posts: { reply_via_api: string }[] };
    expect(out.posts.map((p) => p.reply_via_api)).toEqual(["likely", "unlikely", "yes"]);
  });

  it("truncates long text with the total size unless --full", async () => {
    const long = "a".repeat(400);
    const h = harness(() => ok({ data: [{ id: "5", text: "t", note_tweet: { text: long }, author_id: "1" }] }));
    const short = (await h.commands["timeline"]!([])) as { posts: { text: string }[] };
    expect(short.posts[0]!.text).toContain("truncated, 400 chars total");
    const full = (await h.commands["timeline"]!(["--full"])) as { posts: { text: string }[] };
    expect(full.posts[0]!.text).toBe(long);
  });

  it.each([
    ["list", ["list"]],
    ["read", ["read", "alice"]],
  ])("truncates long DM text unless --full on dm %s", async (_name, args) => {
    const long = "a".repeat(600);
    const h = harness((c) =>
      c.path.startsWith("/2/users/by/username/")
        ? ok({ data: { id: "9", username: "alice" } })
        : ok({ data: [{ id: "7", text: long, sender_id: "9" }] }),
    );
    const short = (await h.commands["dm"]!(args)) as { messages: { text: string }[] };
    expect(short.messages[0]!.text).toContain("truncated, 600 chars total");
    const full = (await h.commands["dm"]!([...args, "--full"])) as { messages: { text: string }[] };
    expect(full.messages[0]!.text).toBe(long);
  });

  it("refuses --full on dm send", async () => {
    const h = harness(() => PARENT);
    await expect(h.commands["dm"]!(["send", "alice", "hi", "--full"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(h.approve).not.toHaveBeenCalled();
  });

  it.each([
    ["timeline", []],
    ["mentions", []],
    ["search", ["foo"]],
  ])("%s names the cached account it read as, with no refresh", async (command, args) => {
    writeFileSync(join(dir, "account.json"), JSON.stringify({ id: "2", username: "older" }));
    const h = harness(() => ok({ data: [{ id: "5", text: "hi", author_id: "9" }] }));
    await expect(h.commands[command]!(args)).resolves.toMatchObject({ account: "@older" });
    expect(h.calls.map((c) => c.path)).not.toContain("/2/users/me");
  });

  it("search names no account before one is known", async () => {
    const h = harness(() => ok({ data: [{ id: "5", text: "hi", author_id: "9" }] }));
    await expect(h.commands["search"]!(["foo"])).resolves.not.toHaveProperty("account");
  });

  it("uses a conversation search for replies", async () => {
    const h = harness(() => ok({ data: [] }));
    await h.commands["replies"]!(["50"]);
    expect(h.calls.at(-1)!.path).toContain("query=conversation_id%3A50");
  });

  it("rejects unknown flags and out-of-range limits before any API call", async () => {
    const h = harness(() => ok({}));
    await expect(h.commands["search"]!(["foo", "--limit", "5"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(h.commands["timeline"]!(["--stat"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(h.calls).toEqual([]);
  });

  it("offers no way to send a non-GET through api", async () => {
    const h = harness(() => ok({}));
    await expect(h.commands["api"]!(["/2/tweets", "--method", "POST"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(h.calls).toEqual([]);
  });

  it("maps 429 to a reset time and missing credits to their own code", async () => {
    const limited = harness(() => ok({ reset_at: "2026-11-01T00:00:00.000Z" }, 429));
    await expect(limited.commands["search"]!(["foo"])).rejects.toMatchObject({ code: "RATE_LIMITED" });
    const broke = harness(() => ok({ title: "CreditsDepleted", detail: "no credits left" }, 402));
    await expect(broke.commands["search"]!(["foo"])).rejects.toMatchObject({ code: "CREDITS_DEPLETED" });
  });
});

describe("review regressions", () => {
  const hidden = ["a\u{e0041}b", "a\u00adb", "a\u2028b", "a\u0085b", "a\u061cb", "\u3164", "a\u200db"];
  it.each(hidden)("refuses deceptive text %j", async (text) => {
    const h = harness(() => PARENT);
    await expect(h.commands["post"]!([text])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(h.approve).not.toHaveBeenCalled();
  });

  const joined = [
    ["woman technologist", "\u{1f469}‍\u{1f4bb}"],
    ["woman technologist with a skin tone", "\u{1f469}\u{1f3fd}‍\u{1f4bb}"],
    ["rainbow flag", "\u{1f3f3}️‍\u{1f308}"],
    ["woman health worker", "\u{1f469}‍⚕️"],
    ["family", "\u{1f468}‍\u{1f469}‍\u{1f467}"],
    ["a Devanagari conjunct", "क्‍ष"],
    ["a Sinhala conjunct", "ශ්‍රී"],
    ["a Bengali ra-phala", "র‍্যাব"],
    ["Persian with a non-joiner", "می‌خواهم"],
    ["a Devanagari non-joiner after a virama", "क्‌ष"],
    ["the England flag", "\u{1f3f4}\u{e0067}\u{e0062}\u{e0065}\u{e006e}\u{e0067}\u{e007f}"],
    ["the Scotland flag", "\u{1f3f4}\u{e0067}\u{e0062}\u{e0073}\u{e0063}\u{e0074}\u{e007f}"],
    ["the Wales flag", "\u{1f3f4}\u{e0067}\u{e0062}\u{e0077}\u{e006c}\u{e0073}\u{e007f}"],
    ["Hebrew with a right-to-left mark", "שלום‏!"],
    ["Arabic with a left-to-right mark", "مرحبا ‎abc"],
    ["a reserved emoji code point", "\u{1f0f6}"],
    ["accented Latin with a combining mark", "cafe\u0301"],
    ["Devanagari vowel signs", "\u0915\u093f \u0915\u0941"],
  ];

  it.each(joined)("posts and shows %s unchanged", async (_name, text) => {
    const h = harness(() => ok({ data: { id: "2" } }, 201));
    await h.commands["post"]!([`hi ${text}`]);
    expect(h.writes()[0]!.body).toEqual({ text: `hi ${text}` });
    expect(formatApproval(h.requests[0]!)).toContain(text);
  });

  it.each(joined)("shows %s from X unchanged in the dialog", async (_name, text) => {
    const parent = ok({ data: { id: "50", text, author_id: "9" }, includes: { users: [{ id: "9", username: "alice" }] } });
    const h = harness((c) => (c.method === "GET" ? parent : ok({ data: { deleted: true } })));
    await h.commands["delete"]!(["50"]);
    expect(formatApproval(h.requests[0]!)).toContain(text);
  });

  const strayJoiners = [
    ["between letters", "a‍b"],
    ["at the start", "‍\u{1f4bb}"],
    ["at the end of an emoji", "\u{1f469}‍"],
    ["from an emoji to a letter", "\u{1f469}‍b"],
    ["from a letter to an emoji", "a‍\u{1f4bb}"],
    ["doubled between emoji", "\u{1f469}‍‍\u{1f4bb}"],
    ["doubled after a virama", "क्‍‍ष"],
    ["across a line break", "\u{1f469}\n‍\u{1f4bb}"],
    ["after a consonant with no virama", "क‍ष"],
    ["with a selector after a letter", "a️‍\u{1f4bb}"],
    ["before a virama with no letter", "‍্য"],
    ["before another script's virama", "क‍্"],
    ["between Bengali letters with no virama", "র‍য"],
  ];

  const strayFormat = [
    ["a non-joiner in Latin", "a‌b"],
    ["a non-joiner at the end", "م‌"],
    ["a non-joiner at the start", "‌م"],
    ["a non-joiner across scripts", "م‌क"],
    ["a non-joiner before a digit", "م‌1"],
    ["a doubled non-joiner", "م‌‌م"],
    ["tag characters with no flag", "\u{e0067}\u{e0062}\u{e0065}\u{e006e}\u{e0067}\u{e007f}"],
    ["a flag sequence with no terminator", "\u{1f3f4}\u{e0067}\u{e0062}\u{e0065}"],
    ["a flag sequence of hidden text", `\u{1f3f4}${"\u{e0061}".repeat(8)}\u{e007f}`],
    ["capital tag characters in a flag", "\u{1f3f4}\u{e0047}\u{e0042}\u{e0045}\u{e007f}"],
    ["tag characters after another flag", "\u{1f3f3}\u{e0067}\u{e0062}\u{e0065}\u{e006e}\u{e0067}\u{e007f}"],
    ["a right-to-left mark in Latin", "abc‏def"],
    ["a left-to-right mark in Latin", "abc‎def"],
    ["an override in Hebrew", "ש‮abc"],
    ["an embedding in Arabic", "م‪abc‬"],
    ["an isolate in Hebrew", "ש⁦abc⁩"],
    ["an unassigned code point that is not an emoji", "a͸b"],
    ["a soft hyphen in Hebrew", "ש­ל"],
  ];

  it.each(strayFormat)("refuses %s, and marks it in text from X", async (_name, text) => {
    const refused = harness(() => PARENT);
    await expect(refused.commands["post"]!([text])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(refused.commands["dm"]!(["send", "alice", text])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(refused.approve).not.toHaveBeenCalled();
    const parent = ok({ data: { id: "50", text, author_id: "9" }, includes: { users: [{ id: "9", username: "alice" }] } });
    const shown = harness((c) => (c.method === "GET" ? parent : ok({ data: { deleted: true } })));
    await shown.commands["delete"]!(["50"]);
    expect(formatApproval(shown.requests[0]!)).toContain("�");
  });

  it.each(strayJoiners)("refuses a joiner %s", async (_name, text) => {
    const h = harness(() => PARENT);
    await expect(h.commands["post"]!([text])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(h.commands["dm"]!(["send", "alice", text])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(h.approve).not.toHaveBeenCalled();
  });

  it("marks a stray joiner from X in the dialog, next to a kept one", async () => {
    const parent = ok({ data: { id: "50", text: "a‍b \u{1f469}‍\u{1f4bb}", author_id: "9" }, includes: { users: [{ id: "9", username: "alice" }] } });
    const h = harness((c) => (c.method === "GET" ? parent : ok({ data: { deleted: true } })));
    await h.commands["delete"]!(["50"]);
    expect(formatApproval(h.requests[0]!)).toContain("a�b \u{1f469}‍\u{1f4bb}");
  });

  describe("when the network is down", () => {
    const down = () => {
      const approve = vi.fn(async (): Promise<ApprovalResult> => "approved");
      const request = vi.fn(async () => { throw new Error("network failure: ENOTFOUND"); });
      return { approve, request, commands: buildCommands({ client: { request }, approve, auth: fakeAuth() }) };
    };

    it.each([
      ["me", []],
      ["timeline", []],
      ["search", ["foo"]],
      ["view", ["50"]],
      ["user", ["alice"]],
      ["dm", ["list"]],
      ["dm", ["read", "alice"]],
      ["api", ["/2/x"]],
      ["post", ["hello"]],
      ["reply", ["50", "hi"]],
      ["delete", ["50"]],
      ["follow", ["alice"]],
    ])("%s %j reports X_UNAVAILABLE before any write or dialog", async (command, args) => {
      const d = down();
      await expect(d.commands[command]!(args)).rejects.toMatchObject({ code: "X_UNAVAILABLE", message: "network failure: ENOTFOUND" });
      expect(d.approve).not.toHaveBeenCalled();
      expect(d.request.mock.calls.every((call) => (call as unknown[])[0] === "GET")).toBe(true);
    });

    it("reports X_UNAVAILABLE for an owned read with a cached account", async () => {
      writeFileSync(join(dir, "account.json"), JSON.stringify({ id: "1", username: "shreejit" }));
      await expect(down().commands["mentions"]!([])).rejects.toMatchObject({ code: "X_UNAVAILABLE" });
    });
  });

  describe("reply pricing", () => {
    const parentBy = (authorId: string) => ok({ data: { id: "50", text: "parent", author_id: authorId }, includes: { users: [{ id: authorId, username: "author" }] } });

    it.each([
      ["your own post, at the Post: Create rate", "1", "thanks", 0.015],
      ["someone else's post, at the summoned rate", "9", "thanks", 0.01],
      ["your own post with a URL, at the URL rate", "1", "see https://example.com", 0.2],
      ["someone else's post with a URL, at the URL rate", "9", "see https://example.com", 0.2],
    ])("quotes a reply to %s", async (_name, authorId, text, usd) => {
      const h = harness((c) => (c.method === "GET" ? parentBy(authorId) : ok({ data: { id: "60" } }, 201)));
      await expect(h.commands["reply"]!(["50", text])).resolves.toMatchObject({ est_cost: `$${usd.toFixed(3)}` });
      expect(h.requests[0]!.estCostUsd).toBe(usd);
    });
  });

  describe("read est_cost", () => {
    const recorded = async (h: ReturnType<typeof harness>) =>
      ((await h.commands["spend"]!([])) as { spend: { last_30d_usd: string } }).spend.last_30d_usd;
    const ALICE_USER = ok({ data: { id: "9", username: "alice" } });

    it("includes the user lookup on dm read, with no messages", async () => {
      const h = harness((c) => (c.path.startsWith("/2/users/by/username/") ? ALICE_USER : ok({ meta: { result_count: 0 } })));
      await expect(h.commands["dm"]!(["read", "alice"])).resolves.toMatchObject({ est_cost: "$0.010" });
      expect(await recorded(h)).toBe("0.010");
    });

    it("includes the account lookup on the first timeline, and not on the next", async () => {
      const h = harness(() => ok({ data: [{ id: "5", text: "hi", author_id: "1" }] }));
      await expect(h.commands["timeline"]!([])).resolves.toMatchObject({ est_cost: "$0.011" });
      await expect(h.commands["timeline"]!([])).resolves.toMatchObject({ est_cost: "$0.001" });
      expect(await recorded(h)).toBe("0.012");
    });

    it("prices included authors of an owned read at the User: Read rate", async () => {
      writeFileSync(join(dir, "account.json"), JSON.stringify({ id: "1", username: "shreejit" }));
      const h = harness(() =>
        ok({
          data: [
            { id: "5", text: "hi", author_id: "9" },
            { id: "6", text: "hey", author_id: "9" },
          ],
          includes: { users: [{ id: "9", username: "alice" }] },
        }),
      );
      await expect(h.commands["mentions"]!([])).resolves.toMatchObject({ est_cost: "$0.012" }); // 2 posts at 0.001 + 1 user at 0.010
      expect(await recorded(h)).toBe("0.012");
    });

    it("shows the refresh cost on me", async () => {
      const h = harness(() => PARENT);
      await expect(h.commands["me"]!([])).resolves.toMatchObject({ est_cost: "$0.010" });
    });

    it("keeps a write's estimate to the write itself", async () => {
      const h = harness(() => ok({ data: { id: "2" } }, 201));
      await expect(h.commands["post"]!(["hello"])).resolves.toMatchObject({ est_cost: "$0.015" });
    });
  });

  it("keeps multi-line and non-Latin posts", async () => {
    const h = harness(() => ok({ data: { id: "2" } }, 201));
    await h.commands["post"]!(["line one\nनमस्ते"]);
    expect(h.writes()).toHaveLength(1);
  });

  const SUSPENDED = {
    errors: [{ title: "Forbidden", detail: "User has been suspended: [alice].", type: "https://api.twitter.com/2/problems/resource-not-found" }],
  };
  const UNAUTHORIZED = { errors: [{ title: "Authorization Error", detail: "cannot view" }] };
  const MISSING = {
    errors: [{ title: "Not Found Error", detail: "Could not find user.", type: "https://api.twitter.com/2/problems/resource-not-found" }],
  };

  it.each([
    ["an empty 200", {}, "X_UNAVAILABLE"],
    ["an unusable body", { detail: "unusable response: <html>" }, "X_UNAVAILABLE"],
    ["a suspension", SUSPENDED, "FORBIDDEN"],
    ["an authorization error", UNAUTHORIZED, "FORBIDDEN"],
  ])("does not call %s already gone", async (_name, body, code) => {
    const h = harness(() => ok(body));
    await expect(h.commands["delete"]!(["50"])).rejects.toMatchObject({ code });
    expect(h.approve).not.toHaveBeenCalled();
  });

  describe.each([
    ["user", ["alice"]],
    ["follow", ["alice"]],
    ["unfollow", ["alice"]],
    ["dm", ["send", "alice", "hi"]],
    ["dm", ["read", "alice"]],
  ])("%s %j", (command, args) => {
    it.each([
      ["an empty 200", {}, "X_UNAVAILABLE"],
      ["an unusable body", { detail: "unusable response: <html>" }, "X_UNAVAILABLE"],
      ["a suspension", SUSPENDED, "FORBIDDEN"],
      ["an authorization error", UNAUTHORIZED, "FORBIDDEN"],
      ["X's not-found error", MISSING, "NOT_FOUND"],
    ])("reports %s from the user lookup as its own code", async (_name, body, code) => {
      const h = harness(() => ok(body));
      await expect(h.commands[command]!(args)).rejects.toMatchObject({ code });
      expect(h.approve).not.toHaveBeenCalled();
      expect(h.writes()).toEqual([]);
    });
  });

  it("does not turn an unusable 200 into zero results", async () => {
    for (const body of [{}, { detail: "unusable response: <html>" }]) {
      const h = harness(() => ok(body));
      await expect(h.commands["mentions"]!([])).rejects.toMatchObject({ code: "X_UNAVAILABLE" });
      await expect(h.commands["api"]!(["/2/x"])).rejects.toMatchObject({ code: "X_UNAVAILABLE" });
    }
  });

  it("reports a redirected write as unknown", async () => {
    const h = harness(() => ok({}, 307));
    await expect(h.commands["post"]!(["hello"])).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
  });

  it("stops text from X posing as the reply in the dialog", async () => {
    const spoof = ok({
      data: { id: "50", text: "x\n\nYour reply:\n\nbenign\u202e", author_id: "9" },
      includes: { users: [{ id: "9", username: "alice" }] },
    });
    const h = harness((c) => (c.method === "GET" ? spoof : ok({ data: { id: "60" } }, 201)));
    await h.commands["reply"]!(["50", "real"]);
    const shown = formatApproval(h.requests[0]!);
    expect(shown.indexOf("real")).toBeLessThan(shown.indexOf("context from X"));
    expect(shown).toContain("x Your reply: benign\ufffd");
    expect(shown).not.toContain("\u202e");
  });

  it("classifies a duplicate reply as a duplicate", async () => {
    const detail = "You are not allowed to create a Tweet with duplicate content.";
    const h = harness((c) => (c.method === "GET" ? PARENT : ok({ detail }, 403)));
    await expect(h.commands["reply"]!(["50", "hi"])).rejects.toMatchObject({ code: "DUPLICATE_POST" });
  });

  it.each([
    ["a run of blank lines", `shown${"\n".repeat(4)}hidden`],
    ["a run of whitespace-only lines", "shown\n \n \n \nhidden"],
    ["a long run of spaces", `shown${" ".repeat(40)}hidden`],
    ["too many short lines", Array.from({ length: 41 }, () => ".").join("\n")],
    ["lines blank but for a variation selector", `Nice${"\n\ufe0f".repeat(30)}\nBuy`],
    ["lines blank but for a left-to-right mark", `\u05e9${"\n\u200e".repeat(30)}\nBuy`],
    ["lines blank but for a right-to-left mark", `\u05e9${"\n\u200f".repeat(30)}\nBuy`],
    ["spaces split by variation selectors", `shown${" \ufe0f".repeat(200)}hidden`],
    ["spaces split by direction marks", `\u05e9${" \u200e".repeat(200)}hidden`],
    ["lines blank but for a combining mark", `a${"\n\u0301".repeat(30)}\nb`],
    ["lines blank but for a virama and a joiner", `a${"\n\u094d\u200d".repeat(30)}\nb`],
    ["spaces split by combining marks", `shown${" \u0301".repeat(200)}hidden`],
    ["nothing but a combining mark", "\u0301"],
    ["nothing but a virama and a joiner", "\u094d\u200d"],
    ["nothing but a variation selector", "\ufe0f"],
    ["nothing but direction marks", "\u200f\u200e"],
  ])("refuses outgoing text with %s in post and dm send", async (_name, text) => {
    const h = harness(() => PARENT);
    await expect(h.commands["post"]!([text])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(h.commands["dm"]!(["send", "alice", text])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(h.approve).not.toHaveBeenCalled();
  });

  it("frames outgoing text so part of it cannot pass as not sent", async () => {
    const text = "Nice work\n\n----- quoted text, not sent -----\nBuy at evil.example";
    const posted = harness(() => ok({ data: { id: "2" } }, 201));
    await posted.commands["post"]!([text]);
    expect(formatApproval(posted.requests[0]!)).toBe(
      `Post as @shreejit (about $0.200)\n\nText to send, all of it (64 characters, 4 lines):\n${text}`,
    );
    const sent = harness((c) => (c.method === "GET" ? PARENT : ok({ data: { dm_event_id: "3" } }, 201)));
    await sent.commands["dm"]!(["send", "alice", "hi"]);
    expect(formatApproval(sent.requests[0]!)).toContain("Text to send, all of it (2 characters, 1 line):\nhi");
    const replied = harness((c) => (c.method === "GET" ? PARENT : ok({ data: { id: "60" } }, 201)));
    await replied.commands["reply"]!(["50", "a\u{1f600}\nb"]);
    expect(formatApproval(replied.requests[0]!)).toContain("Text to send, all of it (4 characters, 2 lines):\na\u{1f600}\nb\n\n----- context from X, not sent -----");
  });

  it("does not call a target of another write text to send", async () => {
    const h = harness((c) => (c.method === "GET" ? PARENT : ok({ data: { deleted: true } })));
    await h.commands["delete"]!(["50"]);
    expect(formatApproval(h.requests[0]!)).not.toContain("Text to send");
  });

  it.each([
    ["a 503", () => ok({}, 503)],
    ["a redirect", () => ok({}, 307)],
    ["a lost response", () => { throw new Error("socket hang up"); }],
  ])("records the estimate for a write that may have gone through after %s", async (_name, respond) => {
    const h = harness(respond);
    await expect(h.commands["post"]!(["hello"])).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    const out = (await h.commands["spend"]!([])) as { spend: { last_30d_usd: string } };
    expect(out.spend.last_30d_usd).toBe("0.025"); // refresh 0.010 + post 0.015
  });

  it("records nothing for a write that X refused", async () => {
    const h = harness(() => ok({ detail: "bad" }, 400));
    await expect(h.commands["post"]!(["hello"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    const out = (await h.commands["spend"]!([])) as { spend: { last_30d_usd: string } };
    expect(out.spend.last_30d_usd).toBe("0.010"); // refresh only
  });

  it("keeps ordinary paragraph spacing", async () => {
    const h = harness(() => ok({ data: { id: "2" } }, 201));
    await h.commands["post"]!(["one\n\n\ntwo"]);
    await h.commands["post"]!(["cafe\u0301\n\n\n\u0915\u093f"]);
    expect(h.writes()).toHaveLength(2);
  });

  it("names a check that fits the write when the outcome is unknown", async () => {
    const down = () => ok({}, 503);
    const cases: [string, string[], string][] = [
      ["post", ["hello"], "x-axi timeline"],
      ["delete", ["50"], "x-axi view 50"],
      ["hide", ["50"], "x.com/i/status/50"],
      ["unhide", ["50"], "x.com/i/status/50"],
      ["dm", ["send", "alice", "hi"], "x-axi dm read"],
      ["follow", ["alice"], "x.com/"],
      ["unfollow", ["alice"], "x.com/"],
    ];
    for (const [command, args, check] of cases) {
      const h = harness((c) => (c.method === "GET" ? PARENT : down()));
      await expect(h.commands[command]!(args)).rejects.toMatchObject({
        code: "OUTCOME_UNKNOWN",
        suggestions: [expect.stringContaining(check)],
      });
    }
  });

  it("charges view for the post and its included author", async () => {
    const h = harness(() => PARENT);
    await expect(h.commands["view"]!(["50"])).resolves.toMatchObject({ est_cost: "$0.015" });
    const out = (await h.commands["spend"]!([])) as { spend: { last_30d_usd: string } };
    expect(out.spend.last_30d_usd).toBe("0.015");
  });

  it("warns when a confirmed write cannot reach the spend ledger", async () => {
    mkdirSync(join(dir, "ledger.jsonl"));
    const h = harness(() => ok({ data: { id: "2" } }, 201));
    await expect(h.commands["post"]!(["hello"])).resolves.toMatchObject({
      post: { status: "published" },
      warning: expect.stringContaining("spend ledger not updated"),
    });
  });

  it("keeps a ledger warning when the command then fails", async () => {
    mkdirSync(join(dir, "ledger.jsonl"));
    const h = harness(() => ok({}, 201));
    await expect(h.commands["post"]!(["hello"])).rejects.toMatchObject({
      code: "OUTCOME_UNKNOWN",
      suggestions: expect.arrayContaining([expect.stringContaining("spend ledger not updated")]),
    });
  });

  it("does not repeat a warning from an earlier command", async () => {
    mkdirSync(join(dir, "ledger.jsonl"));
    const h = harness(() => ok({ data: { id: "2" } }, 201));
    await h.commands["post"]!(["hello"]);
    rmSync(join(dir, "ledger.jsonl"), { recursive: true });
    await expect(h.commands["post"]!(["hello"])).resolves.not.toHaveProperty("warning");
  });

  it("rejects stray arguments instead of dropping them", async () => {
    const h = harness(() => ok({ data: [] }));
    await expect(h.commands["search"]!(["foo", "bar"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(h.commands["delete"]!(["50", "51"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(h.calls).toEqual([]);
  });
});

describe("follow-file", () => {
  const queue = (n: number) => {
    const file = join(dir, "queue.json");
    writeFileSync(file, JSON.stringify(Array.from({ length: n }, (_, i) => ({ id: String(100 + i), username: `user${i}` }))));
    return file;
  };
  const followOk = () => ok({ data: { following: true, pending_follow: false } });
  const withSleep = (h: ReturnType<typeof harness>, client: XClient, sleeps: number[]) =>
    buildCommands({ client, approve: h.approve, auth: h.auth, sleep: async (ms) => { sleeps.push(ms); } });

  function run(handler: Parameters<typeof harness>[0], approval: ApprovalResult = "approved") {
    const h = harness(handler, approval);
    const sleeps: number[] = [];
    const client: XClient = { request: async (method, path, body) => {
      const call = { method, path, ...(body ? { body } : {}) };
      h.calls.push(call);
      return path === "/2/users/me" ? ME : handler(call);
    } };
    return { ...h, sleeps, commands: withSleep(h, client, sleeps) };
  }

  it("asks once, paces requests, and resumes without repeating anyone", async () => {
    const file = queue(3);
    const h = run(followOk);
    await expect(h.commands["follow-file"]!([file, "--max", "2"])).resolves.toMatchObject({ follow_file: { followed: 2, remaining: 1 } });
    expect(h.approve).toHaveBeenCalledTimes(1);
    expect(h.sleeps).toEqual([20_000]);
    await h.commands["follow-file"]!([file]);
    expect(h.writes().map((c) => c.body?.["target_user_id"])).toEqual(["100", "101", "102"]);
    await expect(h.commands["follow-file"]!([file])).resolves.toMatchObject({ follow_file: { remaining: 0 } });
    expect(h.approve).toHaveBeenCalledTimes(2);
  });

  it("sends nothing when the batch is not approved", async () => {
    const h = run(followOk, "cancelled");
    await expect(h.commands["follow-file"]!([queue(2)])).rejects.toMatchObject({ code: "NOT_APPROVED" });
    expect(h.writes()).toEqual([]);
  });

  it("stops at the first error and reports it without marking that account", async () => {
    const file = queue(3);
    let n = 0;
    const h = run(() => (++n === 2 ? ok({ reset_at: "soon" }, 429) : followOk()));
    await expect(h.commands["follow-file"]!([file])).resolves.toMatchObject({
      follow_file: { followed: 1, remaining: 2, status: "stopped early" },
      stopped: { at: "@user1", code: "RATE_LIMITED" },
    });
    expect(h.writes()).toHaveLength(2);
  });

  it("does not count an unconfirmed follow", async () => {
    const h = run(() => ok({ data: { following: false, pending_follow: false } }));
    await expect(h.commands["follow-file"]!([queue(1)])).resolves.toMatchObject({ stopped: { code: "OUTCOME_UNKNOWN" }, follow_file: { followed: 0 } });
  });

  it("holds to 400 follows in 24 hours across runs", async () => {
    const now = new Date().toISOString();
    const used = Object.fromEntries(Array.from({ length: 400 }, (_, i) => [String(9000 + i), now]));
    writeFileSync(join(dir, "follows.json"), JSON.stringify(used));
    const h = run(followOk);
    await expect(h.commands["follow-file"]!([queue(1)])).rejects.toMatchObject({ code: "DAILY_LIMIT" });
    expect(h.approve).not.toHaveBeenCalled();
  });

  it("refuses a corrupt log and a bad queue", async () => {
    const h = run(followOk);
    const bad = join(dir, "bad.json");
    writeFileSync(bad, '[{"id":"1","username":"has space"}]');
    await expect(h.commands["follow-file"]!([bad])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(h.commands["follow-file"]!([queue(1), "--max", "401"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    writeFileSync(join(dir, "follows.json"), "{not json");
    await expect(h.commands["follow-file"]!([queue(1)])).rejects.toMatchObject({ code: "FOLLOW_LOG_CORRUPT" });
    expect(h.writes()).toEqual([]);
  });
});

describe("follow log", () => {
  const ALICE = ok({ data: { id: "100", username: "alice" } });
  const followed = () => ok({ data: { following: true, pending_follow: false } });
  const unfollowed = () => ok({ data: { following: false } });
  const social = (c: Call) => (c.method === "GET" ? ALICE : c.method === "POST" ? followed() : unfollowed());
  const logPath = () => join(dir, "follows.json");
  const logFile = () => JSON.parse(readFileSync(logPath(), "utf8")) as { accounts: Record<string, { following: Json; events: string[] }> };
  const queueFile = (ids: string[]) => {
    const file = join(dir, "queue.json");
    writeFileSync(file, JSON.stringify(ids.map((id) => ({ id, username: `user${id}` }))));
    return file;
  };
  const seedRecent = (count: number, atMs = Date.now()) => {
    const at = new Date(atMs).toISOString();
    const following = Object.fromEntries(Array.from({ length: count }, (_, i) => [String(9000 + i), at]));
    writeFileSync(logPath(), JSON.stringify({ version: 2, accounts: { "1": { following, events: Object.values(following) } } }));
  };
  const withoutSleep = (h: ReturnType<typeof harness>, handler: (c: Call) => ApiResponse) =>
    buildCommands({
      client: { request: async (method, path, body) => {
        const call = { method, path, ...(body ? { body } : {}) };
        h.calls.push(call);
        return path === "/2/users/me" ? ME : handler(call);
      } },
      approve: h.approve,
      auth: h.auth,
      sleep: async () => {},
    });

  it("migrates a flat log to the account that made it, for resume and for the cap", async () => {
    const at = new Date().toISOString();
    writeFileSync(join(dir, "account.json"), JSON.stringify({ id: "1", username: "shreejit" }));
    writeFileSync(logPath(), JSON.stringify({ "100": at, "101": at }));
    const h = harness(social);
    const commands = withoutSleep(h, social);
    await commands["follow-file"]!([queueFile(["100", "101", "102"])]);
    expect(h.writes().map((c) => c.body?.["target_user_id"])).toEqual(["102"]);
    expect(logFile().accounts["1"]!.events).toHaveLength(3);
  });

  it("keeps a flat log with its owner when a different login runs first", async () => {
    const at = new Date().toISOString();
    writeFileSync(join(dir, "account.json"), JSON.stringify({ id: "2", username: "older" }));
    writeFileSync(logPath(), JSON.stringify({ "100": at }));
    const h = harness(social);
    await h.commands["me"]!([]);
    expect(Object.keys(logFile().accounts)).toEqual(["2"]);
    await withoutSleep(h, social)["follow-file"]!([queueFile(["100"])]);
    expect(h.writes().map((c) => c.body?.["target_user_id"])).toEqual(["100"]);
    expect(logFile().accounts["2"]!.following).toEqual({ "100": at });
  });

  it("does not treat another login's follows as done or count them against the cap", async () => {
    const at = new Date().toISOString();
    const following = Object.fromEntries(Array.from({ length: 400 }, (_, i) => [String(100 + i), at]));
    writeFileSync(logPath(), JSON.stringify({ version: 2, accounts: { "2": { following, events: Object.values(following) } } }));
    const h = harness(social);
    await expect(withoutSleep(h, social)["follow-file"]!([queueFile(["100"])])).resolves.toMatchObject({ follow_file: { followed: 1 } });
  });

  it("reports an empty queue as empty, with no API call", async () => {
    const h = harness(social);
    await expect(h.commands["follow-file"]!([queueFile([])])).resolves.toMatchObject({
      follow_file: { status: "the file lists no accounts (no-op)" },
    });
    expect(h.calls).toEqual([]);
  });

  it("follows and bills a repeated queue entry once", async () => {
    const h = harness(social);
    const out = await withoutSleep(h, social)["follow-file"]!([queueFile(["100", "100", "101"])]);
    expect(out).toMatchObject({ follow_file: { followed: 2, remaining: 0 }, est_cost: "$0.030" });
    expect(h.requests[0]!.estCostUsd).toBeCloseTo(0.03);
    expect(h.writes()).toHaveLength(2);
  });

  it.each([
    [1, "Follow 1 account over about 1 minute as"],
    [3, "Follow 3 accounts over about 1 minute as"],
    [6, "Follow 6 accounts over about 2 minutes as"],
  ])("names a batch of %i correctly in the dialog", async (count, wording) => {
    const h = harness(social);
    await withoutSleep(h, social)["follow-file"]!([queueFile(Array.from({ length: count }, (_, i) => String(100 + i)))]);
    expect(formatApproval(h.requests[0]!)).toContain(wording);
  });

  it("says one follow is left when one is", async () => {
    seedRecent(398);
    const h = harness(social);
    const out = (await withoutSleep(h, social)["follow-file"]!([queueFile(["100", "101"]), "--max", "1"])) as { help: string[] };
    expect(out.help[0]).toContain("1 follow left");
  });

  it("says in the dialog that usernames come from the file and were not verified", async () => {
    const h = harness(social);
    const file = queueFile(["100"]);
    await withoutSleep(h, social)["follow-file"]!([file]);
    const shown = formatApproval(h.requests[0]!);
    expect(shown).toContain("@user100");
    expect(shown).toContain(`Usernames come from ${file} and were not verified with X.`);
  });

  it("flattens a deceptive file name in the dialog", async () => {
    const file = join(dir, "q\nApprove\u202e.json");
    writeFileSync(file, JSON.stringify([{ id: "100", username: "user100" }]));
    const h = harness(social);
    await withoutSleep(h, social)["follow-file"]!([file]);
    const shown = formatApproval(h.requests[0]!);
    expect(shown).toContain("q Approve\ufffd.json");
    expect(shown).not.toContain("\u202e");
  });

  it("keeps the 400 cap after an unfollow, but resumes the unfollowed account", async () => {
    seedRecent(400);
    const h = harness((c) => (c.method === "GET" ? ok({ data: { id: "9000", username: "bob" } }) : unfollowed()));
    await h.commands["unfollow"]!(["bob"]);
    const record = logFile().accounts["1"]!;
    expect(record.following["9000"]).toBeUndefined();
    expect(record.events).toHaveLength(400);
    const next = harness(social);
    await expect(next.commands["follow-file"]!([queueFile(["9000"])])).rejects.toMatchObject({ code: "DAILY_LIMIT" });
    const aged = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
    const file = logFile();
    file.accounts["1"]!.events = file.accounts["1"]!.events.map(() => aged);
    writeFileSync(logPath(), JSON.stringify({ version: 2, ...file }));
    const later = harness(social);
    await expect(withoutSleep(later, social)["follow-file"]!([queueFile(["9000"])])).resolves.toMatchObject({ follow_file: { followed: 1, remaining: 0 } });
    expect(later.writes().map((c) => c.body?.["target_user_id"])).toEqual(["9000"]);
  });

  it("counts a re-follow against the cap", async () => {
    const h = harness(social);
    await h.commands["follow"]!(["alice"]);
    await h.commands["follow"]!(["alice"]);
    expect(logFile().accounts["1"]!.events).toHaveLength(2);
    expect(Object.keys(logFile().accounts["1"]!.following)).toEqual(["100"]);
  });

  it("names the time the cap really reopens when over 400", async () => {
    const base = Date.now() - 3600 * 1000;
    const events = Array.from({ length: 401 }, (_, i) => new Date(base + i * 1000).toISOString());
    writeFileSync(logPath(), JSON.stringify({ version: 2, accounts: { "1": { following: {}, events } } }));
    const h = harness(social);
    const reopens = new Date(base + 1000 + 24 * 3600 * 1000).toISOString();
    await expect(h.commands["follow-file"]!([queueFile(["100"])])).rejects.toThrow(reopens);
  });

  it.each([
    ["follow", social],
    ["unfollow", social],
  ] as const)("%s reports success with a warning when the log breaks after X confirms", async (command, respond) => {
    const h = harness((c) => {
      if (c.method !== "GET") writeFileSync(logPath(), "{not json");
      return respond(c);
    });
    const out = await h.commands[command]!(["alice"]);
    expect(out).toMatchObject({ [command]: { handle: "@alice" }, warning: expect.stringContaining("follow log not updated") });
    expect(JSON.stringify(out)).not.toContain("Nothing was sent");
  });

  it.each(["follow", "unfollow"])("%s sends nothing when the log is already corrupt", async (command) => {
    writeFileSync(logPath(), "{not json");
    const h = harness(social);
    await expect(h.commands[command]!(["alice"])).rejects.toMatchObject({
      code: "FOLLOW_LOG_CORRUPT",
      message: expect.stringContaining(logPath()),
      suggestions: [expect.stringContaining("Nothing was sent")],
    });
    expect(h.approve).not.toHaveBeenCalled();
    expect(h.writes()).toEqual([]);
  });

  it("stops a batch and keeps its counts when the log breaks after X confirms", async () => {
    const respond = (c: Call) => {
      if (c.method !== "GET") mkdirSync(join(dir, "follows.json.tmp"), { recursive: true });
      return social(c);
    };
    const h = harness(respond);
    const out = await withoutSleep(h, respond)["follow-file"]!([queueFile(["100", "101"])]);
    expect(out).toMatchObject({
      follow_file: { followed: 1, remaining: 1, status: "stopped early" },
      stopped: { at: "@user100", code: "FOLLOW_LOG_FAILED" },
      est_cost: "$0.015",
    });
    expect(h.writes()).toHaveLength(1);
  });

  it("rejects a log that is valid JSON but not a follow log", async () => {
    writeFileSync(logPath(), JSON.stringify(["100"]));
    const h = harness(social);
    await expect(h.commands["follow"]!(["alice"])).rejects.toMatchObject({ code: "FOLLOW_LOG_CORRUPT" });
    expect(h.writes()).toEqual([]);
  });

  it("includes a follow with an unknown outcome in the batch estimate", async () => {
    let posts = 0;
    const respond = (c: Call) => (c.method === "GET" ? ALICE : ++posts === 2 ? ok({}, 503) : followed());
    const h = harness(respond);
    const out = await withoutSleep(h, respond)["follow-file"]!([queueFile(["100", "101", "102"])]);
    expect(out).toMatchObject({ follow_file: { followed: 1, remaining: 2 }, stopped: { code: "OUTCOME_UNKNOWN" }, est_cost: "$0.030" });
  });

  const unknownFollows: [string, () => ApiResponse][] = [
    ["a 503", () => ok({}, 503)],
    ["a redirect", () => ok({}, 307)],
    ["a lost response", () => { throw new Error("socket hang up"); }],
    ["an unconfirmed 2xx", () => ok({ data: { following: false, pending_follow: false } })],
  ];

  it.each(unknownFollows)("follow-file counts a follow against the cap after %s, and resume still tries it", async (_name, unknown) => {
    seedRecent(398);
    const respond = (c: Call) => (c.method === "GET" ? ALICE : unknown());
    const h = harness(respond);
    const file = queueFile(["100"]);
    await expect(withoutSleep(h, respond)["follow-file"]!([file])).resolves.toMatchObject({ stopped: { code: "OUTCOME_UNKNOWN" } });
    const record = logFile().accounts["1"]!;
    expect(record.events).toHaveLength(399);
    expect(record.following["100"]).toBeUndefined();
    const next = harness(social);
    await expect(withoutSleep(next, social)["follow-file"]!([file])).resolves.toMatchObject({ follow_file: { followed: 1, remaining: 0 } });
    expect(next.writes().map((c) => c.body?.["target_user_id"])).toEqual(["100"]);
    expect(logFile().accounts["1"]!.events).toHaveLength(400);
    await expect(next.commands["follow-file"]!([queueFile(["101"])])).rejects.toMatchObject({ code: "DAILY_LIMIT" });
  });

  it.each(unknownFollows)("follow counts against the cap after %s, without marking the account followed", async (_name, unknown) => {
    const h = harness((c) => (c.method === "GET" ? ALICE : unknown()));
    await expect(h.commands["follow"]!(["alice"])).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    const record = logFile().accounts["1"]!;
    expect(record.events).toHaveLength(1);
    expect(record.following).toEqual({});
  });

  it("does not use up cap room for a follow X refused", async () => {
    const h = harness((c) => (c.method === "GET" ? ALICE : ok({ detail: "no" }, 403)));
    await expect(h.commands["follow"]!(["alice"])).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(existsSync(logPath())).toBe(false);
  });

  it("keeps the unknown outcome when the log breaks while counting it", async () => {
    const h = harness((c) => {
      if (c.method === "GET") return ALICE;
      writeFileSync(logPath(), "{not json");
      return ok({}, 503);
    });
    await expect(h.commands["follow"]!(["alice"])).rejects.toMatchObject({
      code: "OUTCOME_UNKNOWN",
      suggestions: expect.arrayContaining([expect.stringContaining("follow log not updated")]),
    });
  });

  it("leaves a follow X refused out of the batch estimate", async () => {
    const respond = (c: Call) => (c.method === "GET" ? ALICE : ok({ detail: "no" }, 403));
    const h = harness(respond);
    const out = await withoutSleep(h, respond)["follow-file"]!([queueFile(["100"])]);
    expect(out).toMatchObject({ stopped: { code: "FORBIDDEN" }, est_cost: "$0.000" });
  });

  it("carries the outcome check into a stopped batch", async () => {
    const respond = (c: Call) => (c.method === "GET" ? ALICE : ok({}, 503));
    const h = harness(respond);
    const out = (await withoutSleep(h, respond)["follow-file"]!([queueFile(["100"])])) as { help: string[] };
    expect(out.help[0]).toContain("https://x.com/user100");
  });

  it("gives no continue hint once nothing remains", async () => {
    const h = harness(social);
    const out = await withoutSleep(h, social)["follow-file"]!([queueFile(["100"])]);
    expect(out).toMatchObject({ follow_file: { remaining: 0, status: "batch complete" } });
    expect(out).not.toHaveProperty("help");
  });

  it("offers to continue now while the cap has room", async () => {
    const h = harness(social);
    const out = (await withoutSleep(h, social)["follow-file"]!([queueFile(["100", "101"]), "--max", "1"])) as { help: string[] };
    expect(out.help[0]).toContain("399 follows left");
    expect(out.help[0]).not.toContain("tomorrow");
  });

  it("names the reopening time when a batch fills the cap", async () => {
    const start = Date.now();
    seedRecent(399, start);
    const h = harness(social);
    const out = (await withoutSleep(h, social)["follow-file"]!([queueFile(["100", "101"])])) as { follow_file: Json; help: string[] };
    expect(out.follow_file).toMatchObject({ followed: 1, remaining: 1 });
    expect(out.help[0]).toContain(`after ${new Date(start + 24 * 3600 * 1000).toISOString()}`);
  });
});

describe("spend ledger", () => {
  it("adds up what was recorded and counts unpriced calls", async () => {
    const h = harness((c) => (c.method === "GET" ? PARENT : ok({ data: { id: "2" } }, 201)));
    await h.commands["post"]!(["hello"]);
    await h.commands["api"]!(["/2/users/42"]);
    const out = (await h.commands["spend"]!([])) as { spend: { last_30d_usd: string; unpriced_calls_30d: number } };
    expect(out.spend.last_30d_usd).toBe("0.025"); // refresh 0.010 + post 0.015
    expect(out.spend.unpriced_calls_30d).toBe(1);
  });
});

describe("account commands", () => {
  it("login takes the client ID from the flag, stores it in the config, and caches the account", async () => {
    const login = vi.fn(async () => STATUS);
    const h = harness(() => PARENT);
    const commands = buildCommands({ client: { request: async (m, p, b) => { h.calls.push({ method: m, path: p, ...(b ? { body: b } : {}) }); return ME; } }, approve: h.approve, auth: fakeAuth({ login }) });
    const out = await commands["login"]!(["--client-id", "client-id-1234"]);
    expect(login).toHaveBeenCalledWith("client-id-1234");
    expect(out).toMatchObject({ login: { account: "@shreejit", scopes: ["tweet.read"], storage: "fake keystore" }, est_cost: "$0.010" });
    expect(readConfig()).toEqual({ client_id: "client-id-1234" });
    expect(JSON.parse(readFileSync(join(dir, "account.json"), "utf8"))).toEqual({ id: "1", username: "shreejit" });
    expect(h.calls.map((c) => c.path)).toEqual(["/2/users/me"]);
  });

  it("login falls back to the saved client ID, ignores the environment, and refuses to run with none", async () => {
    const login = vi.fn(async () => STATUS);
    const h = harness(() => PARENT);
    const commands = buildCommands({ client: { request: async () => ME }, approve: h.approve, auth: fakeAuth({ login }) });
    process.env["X_AXI_CLIENT_ID"] = "from-environment";
    try {
      await expect(commands["login"]!([])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      expect(login).not.toHaveBeenCalled();
    } finally {
      delete process.env["X_AXI_CLIENT_ID"];
    }
    await commands["login"]!(["--client-id", "client-id-1234"]);
    await commands["login"]!([]);
    expect(login).toHaveBeenLastCalledWith("client-id-1234");
    await expect(commands["login"]!(["--client-id", "bad id!"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(commands["login"]!(["extra"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("login keeps the stored login when the account read fails, says so, and drops the previous account cache", async () => {
    writeFileSync(join(dir, "account.json"), JSON.stringify({ id: "2", username: "previous" }));
    const h = harness(() => PARENT);
    const commands = buildCommands({ client: { request: async () => ok({ detail: "client-not-enrolled" }, 403) }, approve: h.approve, auth: fakeAuth() });
    await expect(commands["login"]!(["--client-id", "client-id-1234"])).rejects.toMatchObject({
      code: "APP_NOT_ENROLLED",
      message: expect.stringContaining("stored the login"),
      suggestions: expect.arrayContaining([expect.stringContaining("x-axi me")]),
    });
    expect(readConfig()).toEqual({ client_id: "client-id-1234" });
    expect(existsSync(join(dir, "account.json"))).toBe(false);
    const broken = buildCommands({ client: { request: async () => { throw new Error("socket hang up"); } }, approve: h.approve, auth: fakeAuth() });
    await expect(broken["login"]!([])).rejects.toMatchObject({ code: "X_UNAVAILABLE", message: expect.stringContaining("stored the login") });
  });

  it("login succeeds with a warning when the config file cannot be written", async () => {
    writeFileSync(join(dir, "config"), "a file where the config directory should be");
    const h = harness(() => PARENT);
    const commands = buildCommands({ client: { request: async () => ME }, approve: h.approve, auth: fakeAuth() });
    await expect(commands["login"]!(["--client-id", "client-id-1234"])).resolves.toMatchObject({
      login: { account: "@shreejit" },
      warning: expect.stringContaining("client ID not saved"),
    });
  });

  it("logout clears the cached account and reports what was revoked", async () => {
    writeFileSync(join(dir, "account.json"), JSON.stringify({ id: "1", username: "shreejit" }));
    writeFileSync(join(dir, "ledger.jsonl"), "");
    const h = harness(() => PARENT);
    await expect(h.commands["logout"]!([])).resolves.toEqual({
      logout: { stored_login: "deleted", revoked_at_x: "access_token, refresh_token" },
    });
    expect(existsSync(join(dir, "account.json"))).toBe(false);
    expect(existsSync(join(dir, "ledger.jsonl"))).toBe(true);
    expect(h.calls).toEqual([]);
  });

  it("keeps a flat follow log with its owner when the cached account is cleared before a different login", async () => {
    for (const leave of [
      async (commands: ReturnType<typeof buildCommands>) => commands["login"]!(["--client-id", "client-id-1234"]),
      async (commands: ReturnType<typeof buildCommands>) => {
        await commands["logout"]!([]);
        await commands["login"]!(["--client-id", "client-id-1234"]);
      },
    ]) {
      writeFileSync(join(dir, "follows.json"), JSON.stringify({ "77": "2026-01-01T00:00:00.000Z" }));
      writeFileSync(join(dir, "account.json"), JSON.stringify({ id: "2", username: "previous" }));
      const h = harness(() => PARENT);
      await leave(buildCommands({ client: { request: async () => ME }, approve: h.approve, auth: fakeAuth() }));
      const log = JSON.parse(readFileSync(join(dir, "follows.json"), "utf8")) as { accounts: Record<string, { following: Record<string, string> }> };
      expect(Object.keys(log.accounts)).toEqual(["2"]);
      expect(log.accounts["2"]!.following).toEqual({ "77": "2026-01-01T00:00:00.000Z" });
      expect(JSON.parse(readFileSync(join(dir, "account.json"), "utf8"))).toEqual({ id: "1", username: "shreejit" });
    }
  });

  it("setup uses a 127.0.0.1 redirect_uri on an unprivileged port", async () => {
    for (const uri of ["http://127.0.0.1:1024/callback", "http://127.0.0.1:65535/callback"]) {
      mkdirSync(join(dir, "config"), { recursive: true });
      writeFileSync(join(dir, "config", "config.json"), JSON.stringify({ redirect_uri: uri }));
      const h = harness(() => PARENT);
      const out = (await h.commands["setup"]!([])) as { callback_url: string; steps: string[] };
      expect(out.callback_url).toBe(uri);
      expect(out.steps.join("\n")).toContain(uri);
    }
  });

  it("setup and login refuse any other redirect_uri before starting a sign-in", async () => {
    mkdirSync(join(dir, "config"), { recursive: true });
    for (const uri of ["http://localhost:8711/callback", "http://127.0.0.1:99999/callback", "http://127.0.0.1:65536/callback", "http://127.0.0.1:80/callback", "http://127.0.0.1:1023/callback", "http://127.0.0.1/callback", "https://127.0.0.1:8711/callback", "http://127.0.0.1.example.com:8711/callback", 8711]) {
      writeFileSync(join(dir, "config", "config.json"), JSON.stringify({ redirect_uri: uri }));
      const login = vi.fn(async () => STATUS);
      const h = harness(() => PARENT);
      const commands = buildCommands({ client: { request: async () => ME }, approve: h.approve, auth: fakeAuth({ login }) });
      const expected = { code: "VALIDATION_ERROR", suggestions: [expect.stringContaining("Callback URI")] };
      await expect(commands["login"]!(["--client-id", "client-id-1234"])).rejects.toMatchObject(expected);
      await expect(commands["setup"]!([])).rejects.toMatchObject(expected);
      expect(login).not.toHaveBeenCalled();
    }
  });

  it("logout reports a failed revocation next to the deletion", async () => {
    const h = harness(() => PARENT);
    const auth = fakeAuth({ logout: async () => ({ had_login: true, revoked: ["access_token"], revoke_failed: { refresh_token: "invalid_request" }, deleted: true }) });
    const out = await buildCommands({ client: { request: async () => ME }, approve: h.approve, auth })["logout"]!([]);
    expect(out).toMatchObject({ logout: { stored_login: "deleted", revoked_at_x: "access_token", revoke_failed: { refresh_token: "invalid_request" } }, help: [expect.stringContaining("connected_apps")] });
  });

  it("auth status names the cached account and the storage, with no API call", async () => {
    writeFileSync(join(dir, "account.json"), JSON.stringify({ id: "1", username: "shreejit" }));
    const h = harness(() => PARENT);
    await expect(h.commands["auth"]!(["status"])).resolves.toEqual({ auth: { account: "@shreejit", ...STATUS } });
    await expect(h.commands["auth"]!([])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(h.commands["auth"]!(["status", "--full"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(h.calls).toEqual([]);
  });

  it("setup names the exact callback URL, the Native App type, the keystore, and a working xurl upgrade, with no xurl command", async () => {
    const h = harness(() => PARENT);
    const out = (await h.commands["setup"]!([])) as { callback_url: string; steps: string[]; storage: string; client_id: string };
    expect(out.callback_url).toBe("http://127.0.0.1:8711/callback");
    expect(out.storage).toBe("fake keystore");
    expect(out.client_id).toContain("not configured");
    expect(out.steps.join("\n")).toContain("http://127.0.0.1:8711/callback");
    expect(out.steps.join("\n")).toContain("Native App");
    expect(out.steps.join("\n")).toContain("x-axi login --client-id");
    expect(out.steps.join("\n")).toContain("tweet.moderate.write");
    expect(out.steps.join("\n").toLowerCase()).not.toContain("client secret:");
    expect(out.steps.join("\n")).not.toContain("xurl auth");
    const upgrade = out.steps.find((step) => step.startsWith("Upgrading"));
    for (const part of ["Native App", "http://127.0.0.1:8711/callback", "x-axi login --client-id YOUR_CLIENT_ID", "delete ~/.xurl"]) expect(upgrade).toContain(part);
    expect(h.calls).toEqual([]);
  });

  it("setup shows a keystore problem instead of failing", async () => {
    const h = harness(() => PARENT);
    const auth = fakeAuth({ status: async () => ({ logged_in: false, storage: "unavailable (no keystore)", problem: "no OS keystore is available", help: ["Install secret-tool"] }) });
    const out = await buildCommands({ client: { request: async () => ME }, approve: h.approve, auth })["setup"]!([]);
    expect(out).toMatchObject({ login: expect.stringContaining("unknown"), storage_problem: "no OS keystore is available", help: ["Install secret-tool"] });
  });
});
