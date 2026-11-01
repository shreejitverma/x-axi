import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResponse, Json, Method, XClient } from "../src/api.js";
import { formatApproval, type ApprovalRequest, type ApprovalResult } from "../src/approve.js";
import { buildCommands } from "../src/commands.js";

type Call = { method: Method; path: string; body?: Json };
const ok = (body: Json, status = 200): ApiResponse => ({ status, body, rateRemaining: null });
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
  return { commands: buildCommands({ client, approve }), calls, writes, requests, approve };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "x-axi-test-"));
  process.env["X_AXI_STATE_DIR"] = dir;
});
afterEach(() => {
  delete process.env["X_AXI_STATE_DIR"];
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
      await expect(h.commands["dm"]!(["send", "alice", "hi"])).rejects.toBeDefined();
      expect(h.writes()).toEqual([]);
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

  it("keeps multi-line and non-Latin posts", async () => {
    const h = harness(() => ok({ data: { id: "2" } }, 201));
    await h.commands["post"]!(["line one\nनमस्ते"]);
    expect(h.writes()).toHaveLength(1);
  });

  it("does not call a permission error already gone", async () => {
    for (const body of [{}, { errors: [{ title: "Authorization Error", detail: "cannot view" }] }]) {
      const h = harness(() => ok(body));
      await expect(h.commands["delete"]!(["50"])).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(h.approve).not.toHaveBeenCalled();
    }
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
    buildCommands({ client, approve: h.approve, sleep: async (ms) => { sleeps.push(ms); } });

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
    await expect(h.commands["follow-file"]!([queue(1)])).rejects.toBeDefined();
    expect(h.writes()).toEqual([]);
  });
});

describe("spend ledger", () => {
  it("adds up what was recorded and counts unpriced calls", async () => {
    const h = harness((c) => (c.method === "GET" ? PARENT : ok({ data: { id: "2" } }, 201)));
    await h.commands["post"]!(["hello"]);
    await h.commands["api"]!(["/2/users/42"]);
    const out = (await h.commands["spend"]!([])) as { spend: { last_30d_usd: string; unpriced_calls_30d: number } };
    expect(out.spend.last_30d_usd).toBe("0.016"); // refresh 0.001 + post 0.015
    expect(out.spend.unpriced_calls_30d).toBe(1);
  });
});
