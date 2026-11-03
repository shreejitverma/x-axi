// Bookmarks, liked posts, Lists, mutes, blocks, trends, polls, and post metrics.
// Each fake response and each expected request follows the endpoint's API reference on docs.x.com, read 2026-11-03.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResponse, Json, Method, XClient } from "../src/api.js";
import { formatApproval, linuxApprovalText, type ApprovalRequest, type ApprovalResult } from "../src/approve.js";
import type { AuthService } from "../src/auth.js";
import { buildCommands } from "../src/commands.js";
import { SCOPES } from "../src/oauth.js";

type Call = { method: Method; path: string; body?: Json | FormData };
const ok = (body: Json, status = 200): ApiResponse => ({ status, body });

/** The scopes a login made before this version holds. */
const OLD_SCOPES = ["tweet.read", "tweet.write", "tweet.moderate.write", "users.read", "follows.read", "follows.write", "media.write", "dm.read", "dm.write", "offline.access"];

const POST = { id: "50", text: "parent text", author_id: "9", public_metrics: { reply_count: 1, like_count: 2, repost_count: 3, quote_count: 4, bookmark_count: 5, impression_count: 600 } };
const POSTS = { data: [{ id: "50", text: "first", author_id: "9" }, { id: "51", text: "second", author_id: "9" }], includes: { users: [{ id: "9", username: "alice" }] }, meta: { result_count: 2 } };
const USERS = { data: [{ id: "9", username: "alice", name: "Alice" }, { id: "10", username: "bob", name: "Bob" }], meta: { result_count: 2 } };
const EMPTY = { meta: { result_count: 0 } };
const LIST = { data: { id: "77", name: "Friends", member_count: 3, private: true } };

/** A fake X that answers every documented route these commands use. `override` replaces one answer. */
function fakeX(override: (call: Call) => ApiResponse | undefined = () => undefined) {
  return (call: Call): ApiResponse => {
    const special = override(call);
    if (special) return special;
    const url = new URL(call.path, "http://x");
    const route = `${call.method} ${url.pathname}`;
    switch (route) {
      case "GET /2/users/by/username/alice":
        return ok({ data: { id: "9", username: "alice" } });
      case "GET /2/tweets/50":
        return ok({ data: POST, includes: { users: [{ id: "9", username: "alice" }] } });
      case "GET /2/lists/77":
        return ok(LIST);
      case "GET /2/users/1/bookmarks":
      case "GET /2/users/1/liked_tweets":
      case "GET /2/users/9/liked_tweets":
      case "GET /2/lists/77/tweets":
        return ok(POSTS);
      case "GET /2/users/1/owned_lists":
      case "GET /2/users/9/owned_lists":
        return ok({ data: [{ id: "77", name: "Friends", member_count: 3, private: true }, { id: "78", name: "Work", member_count: 0, private: false }], meta: { result_count: 2 } });
      case "GET /2/lists/77/members":
      case "GET /2/users/1/muting":
      case "GET /2/users/1/blocking":
        return ok(USERS);
      case "GET /2/users/personalized_trends":
        return ok({ data: [{ trend_name: "#rust", category: "Technology", post_count: "12K posts", trending_since: "2026-11-03T08:00:00.000Z" }] });
      case "GET /2/trends/by/woeid/1":
        return ok({ data: [{ trend_name: "#one", tweet_count: 1200 }, { trend_name: "#two", tweet_count: 900 }] });
      case "POST /2/users/1/bookmarks":
        return ok({ data: { bookmarked: true } });
      case "DELETE /2/users/1/bookmarks/50":
        return ok({ data: { bookmarked: false } });
      case "POST /2/lists":
        return ok({ data: { id: "88", name: "Friends" } }, 201);
      case "DELETE /2/lists/77":
        return ok({ data: { deleted: true } });
      case "POST /2/lists/77/members":
        return ok({ data: { is_member: true } });
      case "DELETE /2/lists/77/members/9":
        return ok({ data: { is_member: false } });
      case "POST /2/users/1/muting":
        return ok({ data: { muting: true } });
      case "DELETE /2/users/1/muting/9":
        return ok({ data: { muting: false } });
      case "POST /2/tweets":
        return ok({ data: { id: "60", text: "posted" } }, 201);
      default:
        throw new Error(`unexpected ${call.method} ${call.path}`);
    }
  };
}

function harness(handler: (call: Call) => ApiResponse = fakeX(), options: { approval?: ApprovalResult; scopes?: string[] | undefined; platform?: NodeJS.Platform } = {}) {
  const calls: Call[] = [];
  const client: XClient = {
    request: async (method, path, body) => {
      const call: Call = { method, path, ...(body ? { body } : {}) };
      calls.push(call);
      if (path.startsWith("/2/users/me")) return ok({ data: { id: "1", username: "shreejit" } });
      return handler(call);
    },
  };
  const requests: ApprovalRequest[] = [];
  const approve = vi.fn(async (request: ApprovalRequest) => {
    requests.push(request);
    return options.approval ?? "approved";
  });
  const scopes = "scopes" in options ? options.scopes : SCOPES;
  const auth: AuthService = {
    accessToken: async () => "fake",
    login: () => Promise.reject(new Error("unused")),
    logout: () => Promise.reject(new Error("unused")),
    status: async () => ({ logged_in: true, storage: "fake", ...(scopes ? { scopes } : {}) }),
  };
  return {
    commands: buildCommands({ client, approve, auth, platform: options.platform ?? "darwin" }),
    calls,
    requests,
    approve,
    writes: () => calls.filter((c) => c.method !== "GET"),
    reads: () => calls.filter((c) => c.method === "GET"),
  };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "x-axi-one-stop-"));
  process.env["X_AXI_STATE_DIR"] = dir;
  process.env["XDG_CONFIG_HOME"] = join(dir, "config");
});
afterEach(() => {
  delete process.env["X_AXI_STATE_DIR"];
  delete process.env["XDG_CONFIG_HOME"];
  rmSync(dir, { recursive: true, force: true });
});

const ledger = (): { op: string; usd: number | null }[] =>
  existsSync(join(dir, "ledger.jsonl")) ? readFileSync(join(dir, "ledger.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as { op: string; usd: number | null }) : [];
const run = (h: ReturnType<typeof harness>, argv: string[]) => h.commands[argv[0]!]!(argv.slice(1));
const failure = (promise: Promise<unknown>) => promise.then(() => { throw new Error("expected a failure"); }, (e: { code: string; message: string; suggestions: string[] }) => e);
const query = (call: Call | undefined): URLSearchParams => new URL(call!.path, "http://x").searchParams;

interface WriteCase {
  name: string;
  argv: string[];
  /** The request the API reference documents for this action. */
  request: Call;
  writeCost: string;
  /** est_cost of a dry run: the reads that validate it, from the published rates. */
  dryRunReads: string;
  status: Json;
  /** A 200 that does not confirm the action. */
  unconfirmed: Json;
  newScope?: string;
  /** What the dialog must name. */
  shows: string[];
}

const WRITES: WriteCase[] = [
  // Account read $0.01, post read $0.005, its author $0.01.
  { name: "bookmark", argv: ["bookmark", "50"], request: { method: "POST", path: "/2/users/1/bookmarks", body: { tweet_id: "50" } }, writeCost: "$0.005", dryRunReads: "$0.025", status: { post: { id: "50", status: "bookmarked" } }, unconfirmed: { data: { bookmarked: false } }, newScope: "bookmark.write", shows: ["@alice: parent text"] },
  { name: "unbookmark", argv: ["unbookmark", "https://x.com/alice/status/50"], request: { method: "DELETE", path: "/2/users/1/bookmarks/50" }, writeCost: "$0.005", dryRunReads: "$0.025", status: { post: { id: "50", status: "not bookmarked" } }, unconfirmed: { data: { bookmarked: true } }, newScope: "bookmark.write", shows: ["@alice: parent text"] },
  // Account read only.
  { name: "list create", argv: ["list", "create", "Friends", "--description", "close ones", "--private"], request: { method: "POST", path: "/2/lists", body: { name: "Friends", description: "close ones", private: true } }, writeCost: "$0.010", dryRunReads: "$0.010", status: { list: { id: "88", name: "Friends", private: true, status: "created" } }, unconfirmed: { data: {} }, newScope: "list.write", shows: ["Friends", "close ones", "private"] },
  // Account read $0.01 and List read $0.005.
  { name: "list delete", argv: ["list", "delete", "https://x.com/i/lists/77"], request: { method: "DELETE", path: "/2/lists/77" }, writeCost: "$0.005", dryRunReads: "$0.015", status: { list: { id: "77", status: "deleted" } }, unconfirmed: { data: { deleted: false } }, newScope: "list.write", shows: ['List "Friends"', "3 members", "private"] },
  // Account read, List read, and the member lookup $0.01.
  { name: "list add", argv: ["list", "add", "77", "@alice"], request: { method: "POST", path: "/2/lists/77/members", body: { user_id: "9" } }, writeCost: "$0.005", dryRunReads: "$0.025", status: { list_member: { list: "77", handle: "@alice", status: "member" } }, unconfirmed: { data: { is_member: false } }, newScope: "list.write", shows: ["@alice", 'List "Friends"'] },
  { name: "list remove", argv: ["list", "remove", "77", "alice"], request: { method: "DELETE", path: "/2/lists/77/members/9" }, writeCost: "$0.005", dryRunReads: "$0.025", status: { list_member: { list: "77", handle: "@alice", status: "not a member" } }, unconfirmed: { data: { is_member: true } }, newScope: "list.write", shows: ["@alice", 'List "Friends"'] },
  // Account read and the target lookup.
  { name: "mute", argv: ["mute", "alice"], request: { method: "POST", path: "/2/users/1/muting", body: { target_user_id: "9" } }, writeCost: "$0.015", dryRunReads: "$0.020", status: { mute: { handle: "@alice", status: "muted" } }, unconfirmed: { data: { muting: false } }, newScope: "mute.write", shows: ["@alice"] },
  { name: "unmute", argv: ["unmute", "alice"], request: { method: "DELETE", path: "/2/users/1/muting/9" }, writeCost: "$0.005", dryRunReads: "$0.020", status: { unmute: { handle: "@alice", status: "not muted" } }, unconfirmed: { data: { muting: true } }, shows: ["@alice"], newScope: "mute.write" },
  { name: "post --poll", argv: ["post", "Which one?", "--poll", "Tea | Coffee|Water", "--poll-minutes", "60"], request: { method: "POST", path: "/2/tweets", body: { text: "Which one?", poll: { options: ["Tea", "Coffee", "Water"], duration_minutes: 60 } } }, writeCost: "$0.015", dryRunReads: "$0.010", status: { post: { id: "60", status: "published" } }, unconfirmed: {}, shows: ['"Tea" | "Coffee" | "Water"', "60 minutes", "Which one?"] },
];

describe.each(WRITES)("$name", (write) => {
  it("sends the documented request once, after an approval that names the target and cost", async () => {
    const h = harness();
    const out = await run(h, write.argv);
    expect(h.writes()).toEqual([write.request]);
    expect(h.approve).toHaveBeenCalledTimes(1);
    const shown = formatApproval(h.requests[0]!);
    for (const part of write.shows) expect(shown).toContain(part);
    expect(shown).toContain(`about ${write.writeCost}`);
    expect(out).toMatchObject({ ...write.status, est_cost: write.writeCost });
    expect(ledger().some((e) => e.usd === Number(write.writeCost.slice(1)))).toBe(true);
  });

  for (const result of ["cancelled", "timed_out", "unavailable"] as const) {
    it(`sends nothing when approval is ${result}`, async () => {
      const h = harness(fakeX(), { approval: result });
      await expect(run(h, write.argv)).rejects.toMatchObject({ code: result === "unavailable" ? "APPROVAL_UNAVAILABLE" : "NOT_APPROVED" });
      expect(h.writes()).toEqual([]);
    });
  }

  it("--dry-run prints the documented request and its cost, with no dialog and no write", async () => {
    const h = harness();
    const out = (await run(h, [...write.argv, "--dry-run"])) as { dry_run: { would_send: unknown[]; write_est_cost: string }; est_cost: string };
    expect(out.dry_run.would_send).toEqual([write.request]);
    expect(out.dry_run.write_est_cost).toBe(write.writeCost);
    expect(out.est_cost).toBe(write.dryRunReads);
    expect(h.writes()).toEqual([]);
    expect(h.approve).not.toHaveBeenCalled();
  });

  if (write.newScope) {
    it(`stops with MISSING_SCOPE on a login without ${write.newScope}, before any call, spend, or dialog`, async () => {
      const h = harness(fakeX(), { scopes: OLD_SCOPES });
      const error = await failure(run(h, write.argv));
      expect(error.code).toBe("MISSING_SCOPE");
      expect(error.message).toContain(write.newScope);
      expect(error.suggestions.join(" ")).toContain("x-axi login");
      expect(h.calls).toEqual([]);
      expect(h.approve).not.toHaveBeenCalled();
      expect(ledger()).toEqual([]);
    });

    it("goes ahead when the login's scopes are unknown, as under the test override", async () => {
      const h = harness(fakeX(), { scopes: undefined });
      await expect(run(h, write.argv)).resolves.toMatchObject(write.status);
    });
  }

  it("reports OUTCOME_UNKNOWN when X does not confirm, and bills it", async () => {
    const h = harness(fakeX((c) => (c.method === write.request.method && c.path === write.request.path ? ok(write.unconfirmed, 200) : undefined)));
    const error = await failure(run(h, write.argv));
    expect(error.code).toBe("OUTCOME_UNKNOWN");
    expect(h.writes()).toHaveLength(1);
    expect(ledger().some((e) => e.usd === Number(write.writeCost.slice(1)))).toBe(true);
  });

  it("reports OUTCOME_UNKNOWN on a 5xx and never retries", async () => {
    const h = harness(fakeX((c) => (c.method !== "GET" ? ok({ title: "Service Unavailable" }, 503) : undefined)));
    await expect(run(h, write.argv)).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    expect(h.writes()).toHaveLength(1);
  });

  it("maps a refusal from X to FORBIDDEN, sends it once, and bills nothing for the write", async () => {
    const h = harness(fakeX((c) => (c.method !== "GET" ? ok({ title: "Forbidden", detail: "You are not allowed to do this" }, 403) : undefined)));
    await expect(run(h, write.argv)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(h.writes()).toHaveLength(1);
    expect(ledger().some((e) => e.usd === Number(write.writeCost.slice(1)) && !["me", "user", "view", "list_lookup"].includes(e.op))).toBe(false);
  });
});

describe("write targets that do not exist", () => {
  it.each([
    ["bookmark", ["bookmark", "50"]],
    ["list add", ["list", "add", "77", "alice"]],
  ])("%s refuses a missing target before the dialog", async (_name, argv) => {
    const h = harness(fakeX((c) => (c.method === "GET" && /\/2\/(tweets|lists)\//.test(c.path) ? ok({ errors: [{ title: "Not Found Error", detail: "Could not find it" }] }) : undefined)));
    await expect(run(h, argv)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(h.approve).not.toHaveBeenCalled();
    expect(h.writes()).toEqual([]);
  });

  it("list delete of a List that is already gone is a no-op", async () => {
    const h = harness(fakeX((c) => (c.path.startsWith("/2/lists/77") ? ok({}, 404) : undefined)));
    await expect(run(h, ["list", "delete", "77"])).resolves.toMatchObject({ list: { id: "77", status: "already gone (no-op)" } });
    expect(h.approve).not.toHaveBeenCalled();
    expect(h.writes()).toEqual([]);
  });
});

describe("list arguments", () => {
  it.each([
    [["list", "create", "a".repeat(26)]],
    [["list", "create", ""]],
    [["list", "create", "two\nlines"]],
    [["list", "create", "Friends", "--description", "d".repeat(101)]],
    [["list", "create", "bad‮name"]],
    [["list", "create", "Friends", "--description", "x", "--description", "y"]],
    [["list", "view", "https://x.com/alice/status/50"]],
    [["list", "add", "77"]],
    [["list", "add", "77", "not a handle"]],
    [["list", "rename", "77"]],
    [["list"]],
  ])("refuses %j before any call", async (argv) => {
    const h = harness();
    await expect(run(h, argv)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(h.calls).toEqual([]);
  });

  it("sends private: false for a public List, and no description when none is given", async () => {
    const h = harness();
    await run(h, ["list", "create", "Open"]);
    expect(h.writes()[0]!.body).toEqual({ name: "Open", private: false });
    expect(formatApproval(h.requests[0]!)).toContain("Create public List");
  });
});

describe("post --poll", () => {
  it("defaults to 1440 minutes and shows that in the dialog and the dry run", async () => {
    const h = harness();
    await run(h, ["post", "Pick", "--poll", "yes|no"]);
    expect(h.writes()[0]!.body).toEqual({ text: "Pick", poll: { options: ["yes", "no"], duration_minutes: 1440 } });
    expect(formatApproval(h.requests[0]!)).toContain("open 1440 minutes");
    const dry = (await run(harness(), ["post", "Pick", "--poll", "yes|no", "--dry-run"])) as { dry_run: { poll: Json } };
    expect(dry.dry_run.poll).toEqual({ options: ["yes", "no"], duration_minutes: 1440 });
  });

  it.each([
    ["one option", ["post", "Pick", "--poll", "yes"]],
    ["five options", ["post", "Pick", "--poll", "a|b|c|d|e"]],
    ["an empty option", ["post", "Pick", "--poll", "a||b"]],
    ["an option over 25 characters", ["post", "Pick", "--poll", `a|${"b".repeat(26)}`]],
    ["an option with a hidden character", ["post", "Pick", "--poll", "a|b​"]],
    ["4 minutes", ["post", "Pick", "--poll", "a|b", "--poll-minutes", "4"]],
    ["10081 minutes", ["post", "Pick", "--poll", "a|b", "--poll-minutes", "10081"]],
    ["fractional minutes", ["post", "Pick", "--poll", "a|b", "--poll-minutes", "5.5"]],
    ["--poll-minutes without --poll", ["post", "Pick", "--poll-minutes", "60"]],
    ["--poll with --media", ["post", "Pick", "--poll", "a|b", "--media", "x.png"]],
    ["--poll with --quote", ["post", "Pick", "--poll", "a|b", "--quote", "50"]],
    ["--poll without text", ["post", "--poll", "a|b"]],
  ])("refuses %s before any call", async (_name, argv) => {
    const h = harness();
    await expect(run(h, argv)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(h.calls).toEqual([]);
  });

  it("accepts the documented bounds: 4 options of 25 characters for 5 and for 10080 minutes", async () => {
    for (const minutes of ["5", "10080"]) {
      const h = harness();
      const options = ["a", "b", "c", "d"].map((ch) => ch.repeat(25));
      await run(h, ["post", "Pick", "--poll", options.join("|"), "--poll-minutes", minutes]);
      expect(h.writes()[0]!.body).toMatchObject({ poll: { options, duration_minutes: Number(minutes) } });
    }
  });

  it("counts the options against the Linux dialog in a dry run on Linux", async () => {
    const real = harness(fakeX(), { platform: "linux" });
    const argv = ["post", "Pick", "--poll", "yes|no"];
    await run(real, argv);
    expect(linuxApprovalText(real.requests[0]!)).toContain('"yes" | "no"');
    const dry = await run(harness(fakeX(), { platform: "linux" }), [...argv, "--dry-run"]);
    expect("linux_dialog" in (dry["dry_run"] as Json)).toBe(false);
  });
});

interface ReadCase {
  name: string;
  argv: string[];
  path: string;
  /** Query parameters the reference documents, as this read must send them. */
  params: Record<string, string>;
  key: string;
  first: Json;
  count: number;
  /** From the published rates, lookups included. */
  cost: string;
  empty: string;
  newScope?: string;
}

const READS: ReadCase[] = [
  // Account read $0.01, two posts at the $0.001 Owned Read rate, and one author $0.01.
  { name: "bookmarks", argv: ["bookmarks", "--limit", "2"], path: "/2/users/1/bookmarks", params: { max_results: "2" }, key: "posts", first: { id: "50", author: "alice", text: "first" }, count: 2, cost: "$0.022", empty: "0 bookmarks found", newScope: "bookmark.read" },
  { name: "likes", argv: ["likes"], path: "/2/users/1/liked_tweets", params: { max_results: "20" }, key: "posts", first: { id: "50", author: "alice" }, count: 2, cost: "$0.022", empty: "0 liked posts found for @shreejit", newScope: "like.read" },
  // The handle lookup $0.01, two posts at the $0.001 Like rate, and one author.
  { name: "likes of another account", argv: ["likes", "@alice", "--limit", "5"], path: "/2/users/9/liked_tweets", params: { max_results: "5" }, key: "posts", first: { id: "50" }, count: 2, cost: "$0.022", empty: "0 liked posts found for @alice", newScope: "like.read" },
  // Account read and two Lists at the Owned Read rate.
  { name: "lists", argv: ["lists"], path: "/2/users/1/owned_lists", params: { max_results: "20", "list.fields": "member_count,private" }, key: "lists", first: { id: "77", name: "Friends", members: 3, private: true }, count: 2, cost: "$0.012", empty: "0 Lists owned by @shreejit", newScope: "list.read" },
  // The lookup and two Lists at the $0.005 List rate.
  { name: "lists of another account", argv: ["lists", "alice"], path: "/2/users/9/owned_lists", params: { "list.fields": "member_count,private" }, key: "lists", first: { id: "77" }, count: 2, cost: "$0.020", empty: "0 Lists owned by @alice", newScope: "list.read" },
  // Two posts at $0.005 and one author.
  { name: "list view", argv: ["list", "view", "https://x.com/i/lists/77", "--limit", "10"], path: "/2/lists/77/tweets", params: { max_results: "10" }, key: "posts", first: { id: "50", author: "alice" }, count: 2, cost: "$0.020", empty: "0 posts in this List", newScope: "list.read" },
  // Two members at the $0.01 User rate.
  { name: "list members", argv: ["list", "members", "77"], path: "/2/lists/77/members", params: { max_results: "20" }, key: "users", first: { id: "9", username: "alice", name: "Alice" }, count: 2, cost: "$0.020", empty: "0 members in this List", newScope: "list.read" },
  // Account read and two accounts at $0.001.
  { name: "mutes", argv: ["mutes", "--limit", "1000"], path: "/2/users/1/muting", params: { max_results: "1000" }, key: "users", first: { id: "9", username: "alice" }, count: 2, cost: "$0.012", empty: "0 accounts muted", newScope: "mute.read" },
  { name: "blocks", argv: ["blocks"], path: "/2/users/1/blocking", params: { max_results: "20" }, key: "users", first: { id: "9", username: "alice" }, count: 2, cost: "$0.012", empty: "0 accounts blocked", newScope: "block.read" },
  // One Trends request, $0.010, whatever it returns.
  { name: "trends", argv: ["trends"], path: "/2/users/personalized_trends", params: { "personalized_trend.fields": "category,post_count,trend_name,trending_since" }, key: "trends", first: { name: "#rust", category: "Technology", posts: "12K posts" }, count: 1, cost: "$0.010", empty: "0 trends found" },
  { name: "trends --woeid", argv: ["trends", "--woeid", "1", "--limit", "2"], path: "/2/trends/by/woeid/1", params: { max_trends: "2", "trend.fields": "trend_name,tweet_count" }, key: "trends", first: { name: "#one", posts: 1200 }, count: 2, cost: "$0.010", empty: "0 trends found" },
];

describe.each(READS)("$name", (read) => {
  const target = (c: Call) => new URL(c.path, "http://x").pathname === read.path;

  it("reads the documented endpoint and shows each row in a few fields, priced from the published rates", async () => {
    const h = harness();
    const out = await run(h, read.argv);
    const call = h.reads().find(target);
    for (const [name, value] of Object.entries(read.params)) expect(query(call).get(name)).toBe(value);
    expect(out).toMatchObject({ count: read.count, est_cost: read.cost });
    const rows = out[read.key] as Json[];
    expect(rows[0]).toMatchObject(read.first);
    expect(Object.keys(rows[0]!).length).toBeLessThanOrEqual(5);
    expect(h.approve).not.toHaveBeenCalled();
    expect(h.writes()).toEqual([]);
  });

  it("states an empty result definitively", async () => {
    const h = harness(fakeX((c) => (target(c) ? ok(read.key === "trends" ? { data: [] } : EMPTY) : undefined)));
    const out = await run(h, read.argv);
    expect(out[read.key]).toBe(read.empty);
    expect(out["count"]).toBeUndefined();
  });

  it("maps a rate limit to RATE_LIMITED", async () => {
    const h = harness(fakeX((c) => (target(c) ? ok({ title: "Too Many Requests", reset_at: "2026-11-03T12:00:00.000Z" }, 429) : undefined)));
    await expect(run(h, read.argv)).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });

  if (read.newScope) {
    it(`stops with MISSING_SCOPE on a login without ${read.newScope}, before any call or spend`, async () => {
      const h = harness(fakeX(), { scopes: OLD_SCOPES });
      const error = await failure(run(h, read.argv));
      expect(error.code).toBe("MISSING_SCOPE");
      expect(error.message).toContain(read.newScope);
      expect(error.suggestions.join(" ")).toContain("x-axi login");
      expect(h.calls).toEqual([]);
      expect(ledger()).toEqual([]);
    });
  }
});

describe("read details", () => {
  it("continues bookmarks from --next and prints the continuation", async () => {
    const h = harness(fakeX((c) => (c.path.startsWith("/2/users/1/bookmarks") ? ok({ ...POSTS, meta: { result_count: 2, next_token: "abc" } }) : undefined)));
    const out = await run(h, ["bookmarks", "--next", "zzz"]);
    expect(query(h.reads().at(-1)).get("pagination_token")).toBe("zzz");
    expect(out["next_token"]).toBe("abc");
    expect((out["help"] as string[]).join(" ")).toContain("x-axi bookmarks --limit 20 --next abc");
  });

  it("reports partial errors on a page", async () => {
    const h = harness(fakeX((c) => (c.path.startsWith("/2/users/1/muting") ? ok({ ...USERS, errors: [{ title: "Not Found Error", detail: "one account is gone" }] }) : undefined)));
    await expect(run(h, ["mutes"])).resolves.toMatchObject({ count: 2, partial_errors: expect.stringContaining("one account is gone") });
  });

  it("reports a List that does not exist as NOT_FOUND", async () => {
    const h = harness(fakeX((c) => (c.path.startsWith("/2/lists/77/tweets") ? ok({ errors: [{ title: "Not Found Error", detail: "Could not find list with id: [77]." }] }) : undefined)));
    await expect(run(h, ["list", "view", "77"])).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("refuses an empty answer that is not X's count", async () => {
    const h = harness(fakeX((c) => (c.path.startsWith("/2/users/1/blocking") ? ok({}) : undefined)));
    await expect(run(h, ["blocks"])).rejects.toMatchObject({ code: "X_UNAVAILABLE" });
  });

  it("trends maps an error-only answer to an error rather than an empty result", async () => {
    const h = harness(fakeX((c) => (c.path.startsWith("/2/users/personalized_trends") ? ok({ errors: [{ title: "Forbidden", detail: "not available" }] }) : undefined)));
    await expect(run(h, ["trends"])).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it.each([
    [["trends", "--limit", "5"]],
    [["trends", "--woeid", "0"]],
    [["trends", "--woeid", "abc"]],
    [["trends", "--woeid", "1", "--limit", "51"]],
    [["trends", "extra"]],
    [["likes", "--limit", "4"]],
    [["bookmarks", "--limit", "101"]],
    [["mutes", "--limit", "1001"]],
    [["blocks", "someone"]],
    [["bookmarks", "--bogus"]],
  ])("refuses %j before any call", async (argv) => {
    const h = harness();
    await expect(run(h, argv)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(h.calls).toEqual([]);
  });
});

describe("view metrics", () => {
  it("shows every public metric the reference documents, from the default read", async () => {
    const h = harness();
    const out = await run(h, ["view", "50"]);
    expect(out["post"]).toMatchObject({ replies: 1, likes: 2, reposts: 3, quotes: 4, bookmarks: 5, impressions: 600 });
    expect(query(h.reads()[0]).get("tweet.fields")).toContain("public_metrics");
    expect(h.reads()).toHaveLength(1);
    expect(out["est_cost"]).toBe("$0.015");
  });

  it("leaves out metrics X does not return, and reads the older retweet_count name", async () => {
    const h = harness(fakeX((c) => (c.path.startsWith("/2/tweets/50") ? ok({ data: { ...POST, public_metrics: { reply_count: 0, like_count: 1, retweet_count: 7 } }, includes: { users: [{ id: "9", username: "alice" }] } }) : undefined)));
    const post = (await run(h, ["view", "50"]))["post"] as Json;
    expect(post).toMatchObject({ reposts: 7 });
    for (const absent of ["quotes", "bookmarks", "impressions"]) expect(post).not.toHaveProperty(absent);
  });
});
