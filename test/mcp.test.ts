// The MCP tools in process, through the protocol, against a fake X: each tool must reach the endpoint its command does.
// Each fake response follows the endpoint's API reference on docs.x.com, as in one-stop.test.ts.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResponse, Json, Method, XClient } from "../src/api.js";
import type { ApprovalRequest, ApprovalResult } from "../src/approve.js";
import type { AuthService } from "../src/auth.js";
import { createMcpServer, TOOLS } from "../src/mcp.js";
import { SCOPES } from "../src/oauth.js";
import { decoded, MemorySession, textOf } from "./mcp-rpc.js";

type Call = { method: Method; path: string; body?: Json | FormData };
const ok = (body: Json, status = 200): ApiResponse => ({ status, body });

const AUTHOR = { includes: { users: [{ id: "9", username: "alice" }] } };
const POSTS = { data: [{ id: "50", text: "first", author_id: "9" }], ...AUTHOR, meta: { result_count: 1 } };
const USERS = { data: [{ id: "9", username: "alice", name: "Alice" }], meta: { result_count: 1 } };
const ALICE = { data: { id: "9", username: "alice", name: "Alice", description: "bio", public_metrics: { followers_count: 3, following_count: 1 } } };

function route(call: Call): ApiResponse {
  const { pathname } = new URL(call.path, "http://x");
  const body = (call.body ?? {}) as Json;
  switch (`${call.method} ${pathname}`) {
    case "GET /2/users/me":
      return ok({ data: { id: "1", username: "shreejit", public_metrics: { following_count: 1, followers_count: 1 } } });
    case "GET /2/users/by/username/alice":
      return ok(ALICE);
    case "GET /2/tweets/50":
      return ok({ data: { id: "50", text: "parent text", author_id: "9", public_metrics: { reply_count: 1 } }, ...AUTHOR });
    case "GET /2/users/1/tweets":
    case "GET /2/users/1/mentions":
    case "GET /2/users/1/bookmarks":
    case "GET /2/users/9/liked_tweets":
    case "GET /2/tweets/search/recent":
    case "GET /2/lists/77/tweets":
      return ok(POSTS);
    case "GET /2/users/1/following":
    case "GET /2/users/9/followers":
    case "GET /2/lists/77/members":
    case "GET /2/users/1/muting":
    case "GET /2/users/1/blocking":
      return ok(USERS);
    case "GET /2/users/1/owned_lists":
      return ok({ data: [{ id: "77", name: "Friends", member_count: 3, private: true }], meta: { result_count: 1 } });
    case "GET /2/lists/77":
      return ok({ data: { id: "77", name: "Friends", member_count: 3, private: true } });
    case "GET /2/users/personalized_trends":
    case "GET /2/trends/by/woeid/1":
      return ok({ data: [{ trend_name: "#tests", tweet_count: 5 }] });
    case "GET /2/dm_events":
    case "GET /2/dm_conversations/with/9/dm_events":
      return ok({ data: [{ id: "d1", text: "hello", sender_id: "9", created_at: "2026-11-01T00:00:00Z" }], ...AUTHOR, meta: { result_count: 1 } });
    case "POST /2/tweets":
      return ok({ data: { id: String(60 + Math.floor(Math.random() * 1000)), text: body["text"] } }, 201);
    case "DELETE /2/tweets/50":
    case "DELETE /2/lists/77":
      return ok({ data: { deleted: true } });
    case "PUT /2/tweets/50/hidden":
      return ok({ data: { hidden: body["hidden"] } });
    case "POST /2/users/1/retweets":
      return ok({ data: { retweeted: true } });
    case "DELETE /2/users/1/retweets/50":
      return ok({ data: { retweeted: false } });
    case "POST /2/users/1/following":
      return ok({ data: { following: true } });
    case "DELETE /2/users/1/following/9":
      return ok({ data: { following: false } });
    case "POST /2/users/1/bookmarks":
      return ok({ data: { bookmarked: true } });
    case "DELETE /2/users/1/bookmarks/50":
      return ok({ data: { bookmarked: false } });
    case "POST /2/lists":
      return ok({ data: { id: "78", name: body["name"] } }, 201);
    case "POST /2/lists/77/members":
      return ok({ data: { is_member: true } });
    case "DELETE /2/lists/77/members/9":
      return ok({ data: { is_member: false } });
    case "POST /2/users/1/muting":
      return ok({ data: { muting: true } });
    case "DELETE /2/users/1/muting/9":
      return ok({ data: { muting: false } });
    case "POST /2/dm_conversations/with/9/messages":
      return ok({ data: { dm_event_id: "d2" } }, 201);
    default:
      return ok({ title: "Not Found Error", detail: `no fake for ${call.method} ${call.path}` }, 404);
  }
}

function harness(options: { approval?: ApprovalResult; delay?: (call: Call) => number; hold?: Promise<void> } = {}) {
  const calls: Call[] = [];
  const approvals: ApprovalRequest[] = [];
  const client: XClient = {
    request: async (method, path, body) => {
      const call = { method, path, ...(body ? { body } : {}) };
      calls.push(call);
      const wait = options.delay?.(call) ?? 0;
      if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
      return route(call);
    },
  };
  const auth: AuthService = {
    accessToken: async () => "fake-access-token",
    login: () => Promise.reject(new Error("login is not reachable through MCP")),
    logout: () => Promise.reject(new Error("logout is not reachable through MCP")),
    status: async () => ({ logged_in: true, storage: "fake keystore", scopes: [...SCOPES] }),
  };
  const approve = async (request: ApprovalRequest): Promise<ApprovalResult> => {
    approvals.push(request);
    await options.hold;
    return options.approval ?? "approved";
  };
  const server = createMcpServer({ client, approve, auth, sleep: async () => {} });
  return { server, calls, approvals, writes: () => calls.filter((c) => c.method !== "GET") };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "x-axi-mcp-"));
  process.env["X_AXI_STATE_DIR"] = dir;
  process.env["XDG_CONFIG_HOME"] = join(dir, "config");
});
afterEach(() => {
  delete process.env["X_AXI_STATE_DIR"];
  delete process.env["XDG_CONFIG_HOME"];
  rmSync(dir, { recursive: true, force: true });
});

async function session(options: Parameters<typeof harness>[0] = {}) {
  const h = harness(options);
  const s = await MemorySession.connect(h.server);
  await s.initialize();
  return { ...h, s };
}

describe("read tools reach the endpoint of their command", () => {
  it.each([
    ["x_me", {}, "/2/users/me"],
    ["x_timeline", { limit: 5, next: "tok", full: true }, "/2/users/1/tweets?max_results=5&pagination_token=tok"],
    ["x_mentions", { limit: 7 }, "/2/users/1/mentions?max_results=7"],
    ["x_replies", { post: "https://x.com/alice/status/50", limit: 10 }, `/2/tweets/search/recent?query=${encodeURIComponent("conversation_id:50")}&max_results=10`],
    ["x_view", { post: "50" }, "/2/tweets/50?"],
    ["x_search", { query: "from:alice -is:retweet", limit: 12 }, `/2/tweets/search/recent?query=${encodeURIComponent("from:alice -is:retweet")}&max_results=12`],
    ["x_user", { handle: "@alice" }, "/2/users/by/username/alice?"],
    ["x_following", { limit: 1 }, "/2/users/1/following?max_results=1"],
    ["x_followers", { handle: "alice", limit: 2 }, "/2/users/9/followers?max_results=2"],
    ["x_likes", { handle: "alice", limit: 5 }, "/2/users/9/liked_tweets?max_results=5"],
    ["x_bookmarks", { limit: 3 }, "/2/users/1/bookmarks?max_results=3"],
    ["x_lists", { limit: 4 }, "/2/users/1/owned_lists?max_results=4"],
    ["x_list_view", { list: "https://x.com/i/lists/77", limit: 6 }, "/2/lists/77/tweets?max_results=6"],
    ["x_list_members", { list: "77", next: "abc" }, "/2/lists/77/members?max_results=20&pagination_token=abc"],
    ["x_mutes", { limit: 1000 }, "/2/users/1/muting?max_results=1000"],
    ["x_blocks", {}, "/2/users/1/blocking?max_results=20"],
    ["x_trends", {}, "/2/users/personalized_trends?"],
    ["x_trends", { woeid: 1, limit: 3 }, "/2/trends/by/woeid/1?max_trends=3"],
    ["x_dm_list", { limit: 2 }, "/2/dm_events?max_results=2"],
    ["x_dm_read", { handle: "alice" }, "/2/dm_conversations/with/9/dm_events?max_results=20"],
  ])("%s %j", async (name, args, path) => {
    const { s, calls, approvals } = await session();
    const result = await s.call(name, args);
    expect(result.isError, textOf(result)).toBeFalsy();
    expect(calls.at(-1)?.path.startsWith(path), `${calls.at(-1)?.path} should start with ${path}`).toBe(true);
    expect(calls.every((c) => c.method === "GET")).toBe(true);
    expect(approvals).toEqual([]);
    expect(textOf(result)).toContain("est_cost:");
  });

  it("serves the local tools without any request", async () => {
    const { s, calls } = await session();
    expect(decoded(await s.call("x_spend"))).toHaveProperty("spend");
    expect(decoded(await s.call("x_auth_status"))).toMatchObject({ auth: { logged_in: true, storage: "fake keystore" } });
    expect(calls).toEqual([]);
  });
});

describe("write tools send what their command sends, only after approval", () => {
  const cases: [string, Record<string, unknown>, Omit<Call, "body"> & { body?: Json }][] = [
    ["x_post", { text: "hello" }, { method: "POST", path: "/2/tweets", body: { text: "hello" } }],
    ["x_post", { text: "--not a flag" }, { method: "POST", path: "/2/tweets", body: { text: "--not a flag" } }],
    ["x_post", { text: "Pick one", poll_options: ["yes", "no", "maybe"], poll_minutes: 60 }, { method: "POST", path: "/2/tweets", body: { text: "Pick one", poll: { options: ["yes", "no", "maybe"], duration_minutes: 60 } } }],
    ["x_reply", { post: "50", text: "my reply" }, { method: "POST", path: "/2/tweets", body: { text: "my reply", reply: { in_reply_to_tweet_id: "50" } } }],
    ["x_delete", { post: "50" }, { method: "DELETE", path: "/2/tweets/50" }],
    ["x_hide", { post: "50" }, { method: "PUT", path: "/2/tweets/50/hidden", body: { hidden: true } }],
    ["x_unhide", { post: "50" }, { method: "PUT", path: "/2/tweets/50/hidden", body: { hidden: false } }],
    ["x_repost", { post: "50" }, { method: "POST", path: "/2/users/1/retweets", body: { tweet_id: "50" } }],
    ["x_unrepost", { post: "50" }, { method: "DELETE", path: "/2/users/1/retweets/50" }],
    ["x_follow", { handle: "alice" }, { method: "POST", path: "/2/users/1/following", body: { target_user_id: "9" } }],
    ["x_unfollow", { handle: "alice" }, { method: "DELETE", path: "/2/users/1/following/9" }],
    ["x_bookmark", { post: "50" }, { method: "POST", path: "/2/users/1/bookmarks", body: { tweet_id: "50" } }],
    ["x_unbookmark", { post: "50" }, { method: "DELETE", path: "/2/users/1/bookmarks/50" }],
    ["x_list_create", { name: "Friends", description: "close ones", private: true }, { method: "POST", path: "/2/lists", body: { name: "Friends", description: "close ones", private: true } }],
    ["x_list_delete", { list: "77" }, { method: "DELETE", path: "/2/lists/77" }],
    ["x_list_add", { list: "77", handle: "alice" }, { method: "POST", path: "/2/lists/77/members", body: { user_id: "9" } }],
    ["x_list_remove", { list: "77", handle: "alice" }, { method: "DELETE", path: "/2/lists/77/members/9" }],
    ["x_mute", { handle: "alice" }, { method: "POST", path: "/2/users/1/muting", body: { target_user_id: "9" } }],
    ["x_unmute", { handle: "alice" }, { method: "DELETE", path: "/2/users/1/muting/9" }],
    ["x_dm_send", { handle: "alice", text: "hi there" }, { method: "POST", path: "/2/dm_conversations/with/9/messages", body: { text: "hi there" } }],
  ];

  it.each(cases)("%s %j", async (name, args, expected) => {
    const { s, writes, approvals } = await session();
    const result = await s.call(name, args);
    expect(result.isError, textOf(result)).toBeFalsy();
    expect(approvals).toHaveLength(1);
    expect(writes()).toEqual([expected.body ? expected : { method: expected.method, path: expected.path }]);
  });

  it.each(cases)("%s %j with dry_run sends nothing and asks nothing", async (name, args) => {
    const { s, writes, approvals } = await session();
    const result = await s.call(name, { ...args, dry_run: true });
    expect(result.isError, textOf(result)).toBeFalsy();
    expect(decoded(result)).toHaveProperty("dry_run");
    expect(writes()).toEqual([]);
    expect(approvals).toEqual([]);
  });

  it("posts a thread in order, each part replying to the one before, after one approval", async () => {
    const { s, writes, approvals } = await session();
    const result = await s.call("x_thread", { parts: ["one", "two", "three"] });
    expect(result.isError, textOf(result)).toBeFalsy();
    expect(approvals).toHaveLength(1);
    const sent = writes().map((w) => w.body as Json);
    expect(sent.map((b) => b["text"])).toEqual(["one", "two", "three"]);
    expect(sent[0]).not.toHaveProperty("reply");
    expect(sent[1]?.["reply"]).toBeDefined();
  });

  it("passes a media path through to the command, which inspects it locally on a dry run", async () => {
    const file = join(dir, "pic.png");
    writeFileSync(file, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]));
    const { s, writes } = await session();
    const result = await s.call("x_post", { text: "look", media: file, dry_run: true });
    expect(result.isError, textOf(result)).toBeFalsy();
    expect(textOf(result)).toContain("/2/media/upload/initialize");
    expect(textOf(result)).toContain("image/png");
    expect(writes()).toEqual([]);
  });

  it("returns the command's error code when approval is declined, and sends nothing", async () => {
    const { s, writes } = await session({ approval: "cancelled" });
    const result = await s.call("x_dm_send", { handle: "alice", text: "hi" });
    expect(result.isError).toBe(true);
    expect(decoded(result)).toMatchObject({ code: "NOT_APPROVED" });
    expect(writes()).toEqual([]);
  });
});

// Results carry the commands' CLI help, so the server's instructions tell a client how to read it as tools:
// `x-axi list view` is x_list_view, and --max-spend is max_spend. These hold that rule true for every tool.
describe("each tool is named for its command, and each flag it passes for an argument", () => {
  const FLAG_ARGUMENTS: Record<string, string> = { "--poll": "poll_options" };
  // Every argument each tool advertises, with values distinct enough that one cannot stand in for another in argv.
  // These are only parsed, never run, so x_post may combine arguments its command would refuse together.
  const page = { limit: 10, next: "tok", full: true };
  const SAMPLES: Record<string, Record<string, unknown>> = {
    x_me: {},
    x_timeline: { ...page },
    x_mentions: { ...page },
    x_replies: { post: "501", ...page },
    x_view: { post: "501", full: true },
    x_search: { query: "from:alice", ...page },
    x_user: { handle: "alice" },
    x_following: { handle: "alice", limit: 10, next: "tok", max_spend: 2.5 },
    x_followers: { handle: "alice", limit: 10, next: "tok", max_spend: 2.5 },
    x_likes: { handle: "alice", ...page },
    x_bookmarks: { ...page },
    x_lists: { handle: "alice", limit: 10, next: "tok" },
    x_list_view: { list: "77", ...page },
    x_list_members: { list: "77", limit: 10, next: "tok" },
    x_mutes: { limit: 10, next: "tok" },
    x_blocks: { limit: 10, next: "tok" },
    x_trends: { woeid: 1, limit: 10 },
    x_dm_list: { ...page },
    x_dm_read: { handle: "alice", ...page },
    x_spend: {},
    x_auth_status: {},
    x_post: { text: "hello", quote: "502", media: "/tmp/photo.png", poll_options: ["yes", "no"], poll_minutes: 60, dry_run: true },
    x_reply: { post: "501", text: "my reply", media: "/tmp/photo.png", dry_run: true },
    x_thread: { parts: ["one", "two"], dry_run: true },
    x_delete: { post: "501", dry_run: true },
    x_hide: { post: "501", dry_run: true },
    x_unhide: { post: "501", dry_run: true },
    x_repost: { post: "501", dry_run: true },
    x_unrepost: { post: "501", dry_run: true },
    x_follow: { handle: "alice", dry_run: true },
    x_unfollow: { handle: "alice", dry_run: true },
    x_bookmark: { post: "501", dry_run: true },
    x_unbookmark: { post: "501", dry_run: true },
    x_list_create: { name: "Friends", description: "close ones", private: true, dry_run: true },
    x_list_delete: { list: "77", dry_run: true },
    x_list_add: { list: "77", handle: "alice", dry_run: true },
    x_list_remove: { list: "77", handle: "alice", dry_run: true },
    x_mute: { handle: "alice", dry_run: true },
    x_unmute: { handle: "alice", dry_run: true },
    x_dm_send: { handle: "alice", text: "hi there", dry_run: true },
  };

  it("has a sample call for every tool", () => {
    expect(Object.keys(SAMPLES).sort()).toEqual(Object.keys(TOOLS).sort());
  });

  it.each(Object.keys(TOOLS))("%s", (name) => {
    const sample = SAMPLES[name]!;
    const advertised = Object.keys(TOOLS[name]!.input.shape).sort();
    expect(Object.keys(sample).sort(), "the sample sets every advertised argument").toEqual(advertised);
    const { argv } = TOOLS[name]!.parse(sample);
    const words = name.slice("x_".length).split("_");
    expect(argv.slice(0, words.length)).toEqual(words);
    const end = argv.indexOf("--");
    const flagged = (end === -1 ? argv : argv.slice(0, end)).filter((token) => token.startsWith("--")).map((flag) => FLAG_ARGUMENTS[flag] ?? flag.slice(2).replaceAll("-", "_"));
    for (const argument of flagged) expect(advertised).toContain(argument);
    const rest = argv.slice(words.length);
    for (const argument of advertised.filter((key) => key !== "dry_run" && !flagged.includes(key))) {
      const value = sample[argument];
      for (const item of Array.isArray(value) ? value : [value]) expect(rest, `${argument} reaches argv`).toContain(String(item));
    }
  });
});

describe("argument validation", () => {
  it.each([
    ["x_timeline", { limit: 3 }, "limit"],
    ["x_timeline", { surprise: true }, "surprise"],
    ["x_post", { text: "poll", poll_options: ["a|b", "c"] }, "cannot contain |"],
    ["x_post", { text: "pic", media: "relative/pic.png" }, "absolute path"],
    ["x_thread", { parts: ["only one"] }, "parts"],
    ["x_list_create", { name: "x".repeat(26) }, "at most 25 characters"],
    ["x_view", {}, "post"],
  ])("%s %j is a VALIDATION_ERROR before any request", async (name, args, mentions) => {
    const { s, calls } = await session();
    const result = await s.call(name, args);
    expect(result.isError).toBe(true);
    const error = decoded(result);
    expect(error["code"]).toBe("VALIDATION_ERROR");
    expect(String(error["error"])).toContain(mentions);
    expect(calls).toEqual([]);
  });

  it("counts characters as code points, as the command does", async () => {
    const { s } = await session();
    const name = "\u{1f389}".repeat(25);
    const result = await s.call("x_list_create", { name, dry_run: true });
    expect(result.isError, textOf(result)).toBeFalsy();
  });
});

it("keeps each call's spend separate when calls overlap", async () => {
  // Both answers are held back, so the two commands are in flight at once.
  const { s } = await session({ delay: (call) => (call.path.startsWith("/2/tweets/50") || call.path.startsWith("/2/users/by/username") ? 50 : 0) });
  const [view, user] = await Promise.all([s.call("x_view", { post: "50" }), s.call("x_user", { handle: "alice" })]);
  expect(decoded(view)["est_cost"]).toBe("$0.015");
  expect(decoded(user)["est_cost"]).toBe("$0.010");
});

it("drops a queued write whose call is cancelled before its turn, with no dialog", async () => {
  let release = (): void => {};
  const hold = new Promise<void>((resolve) => (release = resolve));
  const { s, approvals, writes } = await session({ hold });
  const first = s.call("x_post", { text: "first" });
  const queuedId = s.upcomingId;
  void s.call("x_post", { text: "cancelled while queued" });
  await vi.waitFor(() => expect(approvals).toHaveLength(1));
  s.notify("notifications/cancelled", { requestId: queuedId, reason: "test" });
  // Give the cancellation time to arrive before the first dialog closes.
  await new Promise((resolve) => setTimeout(resolve, 20));
  release();
  expect((await first).isError).toBeFalsy();
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(approvals.map((a) => "text" in a && a.text)).toEqual(["first"]);
  expect(writes()).toHaveLength(1);
});
