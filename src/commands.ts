import { AxiError } from "axi-sdk-js";
import { errorDetail, SETUP_HINT, toApiError, type ApiResponse, type Json, type Method, type XClient } from "./api.js";
import { counted, type ApprovalBody, type ApprovalResult, type Approver } from "./approve.js";
import { displayText, onePositional, parseArgs, parseHandle, parseLimit, parseOutgoingText, parsePostId, usage } from "./args.js";
import type { AuthService } from "./auth.js";
import { configPath, DEFAULT_REDIRECT_URI, parseClientId, readConfig, writeConfig } from "./config.js";
import { readFileSync } from "node:fs";
import { assertFollowLogReadable, clearAccount, DAY_MS, logFollow, logFollowAttempt, logUnfollow, readAccount, readFollows, recordSpend, summarizeSpend, writeAccount, type Account } from "./ledger.js";
import { SCOPES } from "./oauth.js";
import { estimatePostCost, RATES } from "./rates.js";

export interface Deps {
  client: XClient;
  approve: Approver;
  auth: AuthService;
  sleep?: (ms: number) => Promise<void>;
}

// X allows 50 follows per 15 minutes and 400 per day. These stay under both.
const FOLLOW_INTERVAL_MS = 20_000;
const FOLLOW_DAILY_CAP = 400;
const FOLLOW_BATCH_DEFAULT = 100;

export type Output = Record<string, unknown>;

const PREVIEW = 280;
const POST_FIELDS = "tweet.fields=created_at,public_metrics,conversation_id,note_tweet,entities&expansions=author_id&user.fields=username";

// ---- reading -----------------------------------------------------------------

/** Unlike a write, a failed read changed nothing, so its outcome is known. */
async function read(deps: Deps, path: string): Promise<ApiResponse> {
  try {
    return await deps.client.request("GET", path);
  } catch (error) {
    if (error instanceof AxiError) throw error;
    throw new AxiError((error as Error).message, "X_UNAVAILABLE");
  }
}

async function get(deps: Deps, path: string): Promise<ApiResponse> {
  const response = await read(deps, path);
  if (response.status >= 300) throw toApiError(response);
  return response;
}

/** X reports a missing resource as a 200 whose error title says Not Found. Its other errors can carry a not-found type, as a suspension does. */
function saysNotFound(body: Json): boolean {
  const errors = body["errors"];
  return Array.isArray(errors) && (errors as Json[]).some((error) => /not.?found/i.test(String(error["title"])));
}

function unreadable(what: string, body: Json): AxiError {
  const code = Array.isArray(body["errors"]) ? "FORBIDDEN" : "X_UNAVAILABLE";
  return new AxiError(`X could not return ${what}: ${errorDetail(body)}`, code);
}

function foundUser(body: Json, handle: string): Json {
  const data = body["data"] as Json | undefined;
  if (data?.["id"]) return data;
  if (saysNotFound(body)) throw new AxiError(`no X user named @${handle}`, "NOT_FOUND");
  throw unreadable(`@${handle}`, body);
}

function money(usd: number): string {
  return `$${usd.toFixed(3)}`;
}

function usernames(body: Json): Map<string, string> {
  const includes = body["includes"] as { users?: Json[] } | undefined;
  return new Map((includes?.users ?? []).map((u) => [String(u["id"]), String(u["username"])]));
}

function fullText(post: Json): string {
  const note = post["note_tweet"] as { text?: string } | undefined;
  return note?.text ?? String(post["text"] ?? "");
}

function truncate(text: string, full: boolean): string {
  if (full || text.length <= PREVIEW) return text;
  return `${text.slice(0, PREVIEW)}... (truncated, ${text.length} chars total)`;
}

interface Row extends Output {
  id: string;
  author: string;
  text: string;
}

function postRows(body: Json, me: Account | undefined, full: boolean): Row[] {
  const names = usernames(body);
  return ((body["data"] as Json[] | undefined) ?? []).map((post) => {
    const metrics = post["public_metrics"] as { reply_count?: number; like_count?: number } | undefined;
    const row: Row = {
      id: String(post["id"]),
      author: names.get(String(post["author_id"])) ?? String(post["author_id"] ?? "?"),
      text: truncate(fullText(post), full),
      replies: metrics?.reply_count ?? 0,
      likes: metrics?.like_count ?? 0,
    };
    if (me) row["reply_via_api"] = replyChance(post, me);
    return row;
  });
}

/** A hint only. X decides, and it has not documented how implicit reply mentions count. */
function replyChance(post: Json, me: Account): "yes" | "likely" | "unlikely" {
  if (String(post["author_id"]) === me.id) return "yes";
  const entities = post["entities"] as { mentions?: { username?: string }[] } | undefined;
  const mentioned = entities?.mentions?.some((m) => m.username?.toLowerCase() === me.username.toLowerCase());
  return mentioned ? "likely" : "unlikely";
}

function listOutput(key: string, rows: Row[], body: Json, emptyMessage: string, cost: Output): Output {
  const meta = body["meta"] as { next_token?: string; result_count?: number } | undefined;
  // "0 results" must be X's answer, not the absence of one.
  if (!Array.isArray(body["data"]) && meta?.result_count === undefined) {
    throw new AxiError(`X returned no usable result: ${errorDetail(body)}`, "X_UNAVAILABLE");
  }
  // X can return HTTP 200 with partial errors, which must not look like a complete answer.
  const partial = Array.isArray(body["errors"]) ? (body["errors"] as Json[]).length : 0;
  return {
    ...(rows.length ? { count: rows.length, [key]: rows } : { [key]: emptyMessage }),
    ...(partial ? { partial_errors: `${partial}: ${errorDetail(body)}` } : {}),
    ...(meta?.next_token ? { next_token: meta.next_token } : {}),
    ...cost,
  };
}

function includedUsers(body: Json): number {
  return usernames(body).size;
}

function pagedQuery(limit: number, next: string | true | undefined): string {
  const token = typeof next === "string" ? `&pagination_token=${encodeURIComponent(next)}` : "";
  return `max_results=${limit}${token}`;
}

export const HELP: Record<string, string> = {
  me: "usage: x-axi me\nRefreshes and shows your account. Cost about $0.01.",
  timeline: "usage: x-axi timeline [--limit 5-100] [--next TOKEN] [--full]\nYour recent posts.",
  mentions: "usage: x-axi mentions [--limit 5-100] [--next TOKEN] [--full]\nPosts mentioning you, with a reply_via_api hint.",
  replies: "usage: x-axi replies <post-id-or-url> [--limit 10-100] [--next TOKEN] [--full]\nThe post's conversation. X recent search covers the last 7 days only.",
  view: "usage: x-axi view <post-id-or-url> [--full]",
  search: "usage: x-axi search <query> [--limit 10-100] [--next TOKEN] [--full]\nRecent search, last 7 days. Each result costs about $0.005.",
  user: "usage: x-axi user <handle>",
  dm: "usage:\n  x-axi dm list [--limit 1-100] [--next TOKEN] [--full]\n  x-axi dm read <handle> [--limit 1-100] [--next TOKEN] [--full]\n  x-axi dm send <handle> <text>   (needs your approval)\nEncrypted XChat conversations are not covered.",
  post: "usage: x-axi post <text>\nOpens an approval dialog, then publishes. Costs about $0.015, or $0.20 with a URL.",
  reply: "usage: x-axi reply <post-id-or-url> <text>\nOpens an approval dialog showing the parent post. X allows this only on your own posts or when the author mentioned or quoted you.",
  delete: "usage: x-axi delete <post-id-or-url>\nOpens an approval dialog showing the post. Already deleted is a no-op.",
  hide: "usage: x-axi hide <reply-id-or-url>\nHides a reply on your own conversation, after approval.",
  unhide: "usage: x-axi unhide <reply-id-or-url>",
  follow: "usage: x-axi follow <handle>\nOpens an approval dialog. Costs about $0.015.",
  unfollow: "usage: x-axi unfollow <handle>\nOpens an approval dialog. Costs about $0.01.",
  "follow-file": "usage: x-axi follow-file <file.json> [--max 1-400]\nFollows the next accounts from a JSON array of {id, username}, after one approval for the whole batch. One follow every 20 seconds, at most 400 in 24 hours, default 100 per run. Stops at the first error. Rerun to continue. Skips only accounts this login followed through x-axi, so filter the file against your real following list when you build it. Usernames are shown as the file gives them.",
  spend: "usage: x-axi spend\nLocal upper-bound estimate of API spend. No API call.",
  api: "usage: x-axi api </2/path?query>\nRaw GET for read endpoints without a command. Spend is not estimated. Writes are not available here.",
  setup: "usage: x-axi setup\nShows login state, the keystore, and the exact X portal steps. No API call.",
  login: "usage: x-axi login [--client-id ID]\nSigns in to X in your browser with OAuth 2.0 PKCE and stores the login in the OS keystore. Run it yourself in a terminal, never through an agent. The client ID comes from --client-id or the config file, and the flag's value is saved to the config file. Then fetches your account, about $0.01.",
  logout: "usage: x-axi logout\nRevokes the tokens at X and deletes the stored login. No approval dialog; deleting is reported even when revocation fails.",
  auth: "usage: x-axi auth status\nShows the account, scopes, access token expiry, and where the login is stored. Never shows a token. No API call.",
  update: "usage: x-axi update\nShows how to update from your git checkout. It installs nothing.",
};

/** Setup must take a public user from nothing to a working login, so these name the exact portal fields. */
export function setupSteps(redirectUri: string): string[] {
  return [
    "At https://console.x.com create a project and an app on Pay-per-use and Production; add credits and set a spend limit",
    "In the app's User authentication settings turn on OAuth 2.0 with App permissions 'Read and write and Direct message' and Type of App 'Native App' (a public client; x-axi never uses a client secret)",
    `Set the Callback URI to exactly ${redirectUri} and any https website URL you own, then save`,
    "On the app's Keys and tokens page copy the OAuth 2.0 Client ID; if the portal also shows a Client Secret, the type is not Native App",
    "In your own terminal, never through an agent, run: x-axi login --client-id YOUR_CLIENT_ID",
    "Approve the request in the browser; the login is stored in your OS keystore, never in a file",
    "Verify with: x-axi auth status, then x-axi me",
    `Scopes requested: ${SCOPES.join(" ")}`,
    `Upgrading from a version that used xurl: change the app's Type of App to 'Native App', set its Callback URI to ${redirectUri}, run x-axi login --client-id YOUR_CLIENT_ID, then delete ~/.xurl if nothing else uses xurl, because it holds a plain-text token and client secret`,
  ];
}

export function homeOutput(): Output {
  const account = readAccount();
  return {
    account: account ? `@${account.username}` : "not connected",
    spend: summarizeSpend(),
    help: account
      ? [
          "Run `x-axi mentions` to see who mentioned you",
          "Run `x-axi timeline` for your posts, `x-axi replies <id>` for comments",
          "Run `x-axi post <text>` or `x-axi reply <id> <text>`; each opens an approval dialog",
        ]
      : [SETUP_HINT],
  };
}

export function buildCommands(deps: Deps): Record<string, (args: string[]) => Promise<Output>> {
  const flagsForList = ["--limit", "--next"];

  // Local bookkeeping problems surface here, because they must never hide or fail a write that X confirmed.
  const warnings = new Set<string>();
  // What the running command has added to the ledger, so a read's est_cost matches it, lookups included.
  let recorded = 0;

  const spend = (op: string, usd: number | null): void => {
    recorded += usd ?? 0;
    const warning = recordSpend(op, usd);
    if (warning) warnings.add(warning);
  };

  const charge = (op: string, usd: number): Output => {
    spend(op, usd);
    return { est_cost: money(recorded) };
  };

  const persistFollowLog = (update: () => void): void => {
    try {
      update();
    } catch (error) {
      warnings.add(`follow log not updated: ${String(error)}`);
    }
  };

  /** Writes call this directly so the approval dialog names the account the token really belongs to. */
  const refreshAccount = async (): Promise<Account> => {
    const response = await get(deps, "/2/users/me");
    const data = response.body["data"] as Json | undefined;
    if (!data?.["id"] || !data["username"]) {
      throw new AxiError(`X returned no account: ${errorDetail(response.body)}`, "X_UNAVAILABLE");
    }
    const account = { id: String(data["id"]), username: String(data["username"]) };
    writeAccount(account);
    spend("me", RATES.userRead);
    return account;
  };

  const me = async (): Promise<Account> => readAccount() ?? refreshAccount();

  const ownedList = async (args: string[], name: string, endpoint: string): Promise<Output> => {
    const parsed = parseArgs(args, name, flagsForList, ["--full"]);
    if (parsed.positional.length) throw usage(`\`${name}\` takes no arguments`);
    const limit = parseLimit(parsed, 20, 5, 100);
    const account = await me();
    const q = pagedQuery(limit, parsed.flags.get("--next"));
    const response = await get(deps, `/2/users/${account.id}/${endpoint}?${q}&${POST_FIELDS}`);
    const rows = postRows(response.body, name === "mentions" ? account : undefined, parsed.flags.has("--full"));
    const usd = rows.length * RATES.ownedRead + includedUsers(response.body) * RATES.userRead;
    return { account: `@${account.username}`, ...listOutput("posts", rows, response.body, `0 ${name} found`, charge(name, usd)) };
  };

  const recentSearch = async (query: string, op: string, args: string[]): Promise<Output> => {
    const parsed = parseArgs(args, op, flagsForList, ["--full"]);
    if (parsed.positional.length) throw usage(`\`${op}\` got extra arguments; quote the query as one argument`);
    const limit = parseLimit(parsed, 20, 10, 100);
    const account = readAccount();
    const token = parsed.flags.get("--next");
    const page = typeof token === "string" ? `&next_token=${encodeURIComponent(token)}` : "";
    const path = `/2/tweets/search/recent?query=${encodeURIComponent(query)}&max_results=${limit}${page}&sort_order=recency&${POST_FIELDS}`;
    const response = await get(deps, path);
    const rows = postRows(response.body, account, parsed.flags.has("--full"));
    const usd = rows.length * RATES.postRead + includedUsers(response.body) * RATES.userRead;
    return {
      ...(account ? { account: `@${account.username}` } : {}),
      ...listOutput("posts", rows, response.body, `0 posts found in the last 7 days`, charge(op, usd)),
    };
  };

  const fetchPost = async (id: string): Promise<{ post: Json; author: string } | undefined> => {
    const response = await read(deps, `/2/tweets/${id}?${POST_FIELDS}`);
    if (response.status === 404) return undefined;
    if (response.status >= 300) throw toApiError(response);
    const post = response.body["data"] as Json | undefined;
    if (!post) {
      if (saysNotFound(response.body)) return undefined;
      throw unreadable(`post ${id}`, response.body);
    }
    spend("view", RATES.postRead + includedUsers(response.body) * RATES.userRead);
    const author = usernames(response.body).get(String(post["author_id"])) ?? "?";
    return { post, author };
  };

  const resolveUser = async (handle: string): Promise<Account> => {
    const response = await get(deps, `/2/users/by/username/${handle}`);
    const data = foundUser(response.body, handle);
    spend("user", RATES.userRead);
    return { id: String(data["id"]), username: String(data["username"]) };
  };

  const gate = async (
    action: string,
    account: Account,
    body: ApprovalBody,
    estCostUsd: number | null,
    context?: string,
  ): Promise<void> => {
    const result: ApprovalResult = await deps.approve({
      action,
      account: account.username,
      ...body,
      estCostUsd,
      ...(context ? { context } : {}),
    });
    if (result === "approved") return;
    const reasons: Record<Exclude<ApprovalResult, "approved">, [string, string]> = {
      cancelled: ["the user cancelled this action; nothing was sent", "NOT_APPROVED"],
      timed_out: ["nobody answered the approval dialog; nothing was sent", "NOT_APPROVED"],
      unavailable: ["no approval dialog is available on this machine; nothing was sent", "APPROVAL_UNAVAILABLE"],
    };
    const [message, code] = reasons[result];
    throw new AxiError(message, code, ["Do not retry unless the user asks; never call the X API another way to get around this"]);
  };

  /** Writes are never retried: after a lost response, a retry could publish twice. */
  const send = async (
    method: Method,
    path: string,
    body: Json | undefined,
    op: string,
    usd: number | null,
    check: string,
    errorContext: { replyTo?: string; text?: string } = {},
  ): Promise<ApiResponse> => {
    let response: ApiResponse;
    try {
      response = await deps.client.request(method, path, body);
    } catch (error) {
      if (error instanceof AxiError) throw error;
      spend(op, usd);
      throw outcomeUnknown(String(error), check);
    }
    if (response.status >= 500 || (response.status >= 300 && response.status < 400)) {
      spend(op, usd);
      throw outcomeUnknown(`X returned ${response.status}`, check);
    }
    if (response.status >= 400) throw toApiError(response, errorContext);
    spend(op, usd);
    return response;
  };

  /** Returns X's confirmation. Every unknown outcome counts against the cap, because X may have applied that follow. */
  const sendFollow = async (account: Account, target: Account): Promise<Json> => {
    const check = checkProfile(target.username);
    try {
      const response = await send("POST", `/2/users/${account.id}/following`, { target_user_id: target.id }, "follow", RATES.userInteraction, check);
      const data = response.body["data"] as Json | undefined;
      if (data?.["following"] !== true && data?.["pending_follow"] !== true) throw outcomeUnknown("X did not confirm the follow", check);
      return data;
    } catch (error) {
      if (error instanceof AxiError && error.code === "OUTCOME_UNKNOWN") persistFollowLog(() => logFollowAttempt(account.id));
      throw error;
    }
  };

  const createPost = async (text: string, replyTo: string | undefined, account: Account, usd: number, context?: string): Promise<Output> => {
    const op = replyTo ? "reply" : "post";
    const check = "Check with `x-axi timeline`";
    await gate(replyTo ? "Reply" : "Post", account, { text }, usd, context);
    const response = await send(
      "POST",
      "/2/tweets",
      { text, ...(replyTo ? { reply: { in_reply_to_tweet_id: replyTo } } : {}) },
      op,
      usd,
      check,
      replyTo ? { replyTo, text } : {},
    );
    const data = response.body["data"] as Json | undefined;
    if (!data?.["id"]) throw outcomeUnknown("X accepted the request but returned no post ID", check);
    return {
      [op]: { id: String(data["id"]), url: `https://x.com/${account.username}/status/${String(data["id"])}`, status: "published" },
      est_cost: money(usd),
    };
  };

  const hideReply = async (args: string[], hidden: boolean): Promise<Output> => {
    const name = hidden ? "hide" : "unhide";
    const parsed = parseArgs(args, name, []);
    const id = parsePostId(onePositional(parsed, name));
    const account = await refreshAccount();
    const found = await fetchPost(id);
    if (!found) throw new AxiError(`post ${id} not found`, "NOT_FOUND");
    await gate(hidden ? "Hide reply" : "Unhide reply", account, { content: `@${found.author}: ${displayText(fullText(found.post))}` }, null);
    const check = `Check the reply at https://x.com/i/status/${id}, because x-axi cannot read whether a reply is hidden`;
    const response = await send("PUT", `/2/tweets/${id}/hidden`, { hidden }, name, null, check);
    const state = (response.body["data"] as Json | undefined)?.["hidden"];
    if (state !== hidden) throw outcomeUnknown(`X answered hidden=${String(state)}`, check);
    return { reply: { id, hidden } };
  };

  const commands: Record<string, (args: string[]) => Promise<Output> | Output> = {
    me: async (args) => {
      parseArgs(args, "me", []);
      const account = await refreshAccount();
      return { account: { id: account.id, handle: `@${account.username}` }, est_cost: money(recorded), help: ["Run `x-axi mentions` to see who mentioned you"] };
    },
    timeline: (args) => ownedList(args, "timeline", "tweets"),
    mentions: (args) => ownedList(args, "mentions", "mentions"),
    replies: (args) => {
      const [target, ...rest] = args;
      const id = parsePostId(target);
      return recentSearch(`conversation_id:${id}`, "replies", rest);
    },
    search: (args) => {
      const [query, ...rest] = args;
      if (!query || query.startsWith("--")) throw usage("search needs a query", [HELP["search"] as string]);
      return recentSearch(query, "search", rest);
    },
    view: async (args) => {
      const parsed = parseArgs(args, "view", [], ["--full"]);
      const id = parsePostId(onePositional(parsed, "view"));
      const found = await fetchPost(id);
      if (!found) throw new AxiError(`post ${id} not found`, "NOT_FOUND");
      const metrics = (found.post["public_metrics"] ?? {}) as Json;
      return {
        post: {
          id,
          author: found.author,
          created_at: found.post["created_at"],
          text: truncate(fullText(found.post), parsed.flags.has("--full")),
          replies: metrics["reply_count"] ?? 0,
          likes: metrics["like_count"] ?? 0,
          reposts: metrics["retweet_count"] ?? 0,
          conversation: found.post["conversation_id"],
        },
        est_cost: money(recorded),
        help: [`Run \`x-axi replies ${id}\` for its comments`],
      };
    },
    user: async (args) => {
      const parsed = parseArgs(args, "user", []);
      const handle = parseHandle(onePositional(parsed, "user"));
      const response = await get(deps, `/2/users/by/username/${handle}?user.fields=description,public_metrics`);
      const data = foundUser(response.body, handle);
      const metrics = (data["public_metrics"] ?? {}) as Json;
      return {
        user: {
          id: data["id"],
          handle: `@${String(data["username"])}`,
          name: data["name"],
          bio: truncate(String(data["description"] ?? ""), false),
          followers: metrics["followers_count"] ?? 0,
        },
        ...charge("user", RATES.userRead),
      };
    },
    dm: async (args) => {
      const [sub, ...rest] = args;
      if (sub === "send") {
        const parsed = parseArgs(rest, "dm send", []);
        const handle = parseHandle(parsed.positional[0]);
        const text = parseOutgoingText(parsed.positional[1]);
        if (parsed.positional.length > 2) throw usage("quote the message text as one argument");
        const account = await refreshAccount();
        const target = await resolveUser(handle);
        await gate(`DM to @${target.username}`, account, { text }, RATES.dmCreate);
        const check = `Check with \`x-axi dm read ${target.username}\``;
        const response = await send("POST", `/2/dm_conversations/with/${target.id}/messages`, { text }, "dm_send", RATES.dmCreate, check);
        const data = response.body["data"] as Json | undefined;
        if (!data?.["dm_event_id"]) throw outcomeUnknown("X accepted the request but returned no message ID", check);
        return { dm: { id: data["dm_event_id"], to: `@${target.username}`, status: "sent" }, est_cost: money(RATES.dmCreate) };
      }
      if (sub === "list" || sub === "read") {
        const parsed = parseArgs(rest, `dm ${sub}`, flagsForList, ["--full"]);
        if (sub === "list" && parsed.positional.length) throw usage("`dm list` takes no arguments");
        const limit = parseLimit(parsed, 20, 1, 100);
        const q = `${pagedQuery(limit, parsed.flags.get("--next"))}&dm_event.fields=created_at,sender_id,text&expansions=sender_id&user.fields=username&event_types=MessageCreate`;
        let path = `/2/dm_events?${q}`;
        if (sub === "read") {
          const target = await resolveUser(parseHandle(onePositional(parsed, "dm read")));
          path = `/2/dm_conversations/with/${target.id}/dm_events?${q}`;
        }
        const response = await get(deps, path);
        const names = usernames(response.body);
        const rows = ((response.body["data"] as Json[] | undefined) ?? []).map((event) => ({
          id: String(event["id"]),
          author: names.get(String(event["sender_id"])) ?? String(event["sender_id"]),
          text: truncate(String(event["text"] ?? ""), parsed.flags.has("--full")),
          at: String(event["created_at"] ?? ""),
        }));
        const usd = rows.length * RATES.dmRead + includedUsers(response.body) * RATES.userRead;
        return listOutput("messages", rows, response.body, "0 messages found", charge("dm", usd));
      }
      throw usage("expected `dm list`, `dm read`, or `dm send`", [HELP["dm"] as string]);
    },
    post: async (args) => {
      const parsed = parseArgs(args, "post", []);
      if (parsed.positional.length !== 1) throw usage("quote the post text as one argument", [HELP["post"] as string]);
      const text = parseOutgoingText(parsed.positional[0]);
      return createPost(text, undefined, await refreshAccount(), estimatePostCost(text, false));
    },
    reply: async (args) => {
      const parsed = parseArgs(args, "reply", []);
      if (parsed.positional.length !== 2) throw usage("expected a post and one quoted text argument", [HELP["reply"] as string]);
      const id = parsePostId(parsed.positional[0]);
      const text = parseOutgoingText(parsed.positional[1]);
      const account = await refreshAccount();
      const parent = await fetchPost(id);
      if (!parent) throw new AxiError(`post ${id} not found`, "NOT_FOUND");
      const usd = estimatePostCost(text, String(parent.post["author_id"]) !== account.id);
      return createPost(text, id, account, usd, `Replying to @${parent.author}: ${displayText(truncate(fullText(parent.post), false))}`);
    },
    delete: async (args) => {
      const parsed = parseArgs(args, "delete", []);
      const id = parsePostId(onePositional(parsed, "delete"));
      const account = await refreshAccount();
      const found = await fetchPost(id);
      if (!found) return { post: { id, status: "already gone (no-op)" } };
      await gate("Delete post", account, { content: displayText(fullText(found.post)) }, RATES.interactionDelete);
      const check = `Check with \`x-axi view ${id}\``;
      const response = await send("DELETE", `/2/tweets/${id}`, undefined, "delete", RATES.interactionDelete, check);
      if ((response.body["data"] as Json | undefined)?.["deleted"] !== true) {
        throw outcomeUnknown("X did not confirm the deletion", check);
      }
      return { post: { id, status: "deleted" }, est_cost: money(RATES.interactionDelete) };
    },
    follow: async (args) => {
      const parsed = parseArgs(args, "follow", []);
      const handle = parseHandle(onePositional(parsed, "follow"));
      const account = await refreshAccount();
      assertFollowLogReadable();
      const target = await resolveUser(handle);
      await gate("Follow", account, { content: `@${target.username}` }, RATES.userInteraction);
      const data = await sendFollow(account, target);
      persistFollowLog(() => logFollow(account.id, target.id));
      return { follow: { handle: `@${target.username}`, status: data["pending_follow"] === true ? "requested" : "following" }, est_cost: money(RATES.userInteraction) };
    },
    unfollow: async (args) => {
      const parsed = parseArgs(args, "unfollow", []);
      const handle = parseHandle(onePositional(parsed, "unfollow"));
      const account = await refreshAccount();
      assertFollowLogReadable();
      const target = await resolveUser(handle);
      await gate("Unfollow", account, { content: `@${target.username}` }, RATES.interactionDelete);
      const check = checkProfile(target.username);
      const response = await send("DELETE", `/2/users/${account.id}/following/${target.id}`, undefined, "unfollow", RATES.interactionDelete, check);
      if ((response.body["data"] as Json | undefined)?.["following"] !== false) throw outcomeUnknown("X did not confirm the unfollow", check);
      persistFollowLog(() => logUnfollow(account.id, target.id));
      return { unfollow: { handle: `@${target.username}`, status: "not following" }, est_cost: money(RATES.interactionDelete) };
    },
    "follow-file": async (args) => {
      const parsed = parseArgs(args, "follow-file", ["--max"]);
      const file = onePositional(parsed, "follow-file");
      if (!file) throw usage("expected a JSON file", [HELP["follow-file"] as string]);
      const raw = parsed.flags.get("--max");
      const max = raw === undefined ? FOLLOW_BATCH_DEFAULT : Number(raw);
      if (!Number.isInteger(max) || max < 1 || max > FOLLOW_DAILY_CAP) throw usage(`--max must be an integer from 1 to ${FOLLOW_DAILY_CAP}`);
      const queue = parseFollowQueue(file);
      if (!queue.length) return { follow_file: { followed: 0, remaining: 0, status: "the file lists no accounts (no-op)" } };
      const account = await refreshAccount();
      const log = readFollows(account.id);
      const remaining = queue.filter((u) => !log.following[u.id]);
      if (!remaining.length) return { follow_file: { followed: 0, remaining: 0, status: "every account in this file is already followed through x-axi (no-op)" } };
      const recent = recentFollows(log.events);
      const room = FOLLOW_DAILY_CAP - recent.length;
      if (room <= 0) {
        throw new AxiError(`the ${FOLLOW_DAILY_CAP} follows per 24 hours limit is used up until ${capReopensAt(recent)}`, "DAILY_LIMIT");
      }
      const batch = remaining.slice(0, Math.min(max, room));
      const usd = batch.length * RATES.userInteraction;
      const names = batch.slice(0, 10).map((u) => `@${u.username}`).join(", ");
      const more = batch.length > 10 ? `, and ${batch.length - 10} more` : "";
      const provenance = `Usernames come from ${displayText(file)} and were not verified with X.`;
      await gate(`Follow ${counted(batch.length, "account")} over about ${counted(Math.ceil((batch.length * FOLLOW_INTERVAL_MS) / 60_000), "minute")}`, account, { content: `${names}${more}\n\n${provenance}` }, usd);
      const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
      let followed = 0;
      let requested = 0;
      let stopped: Output | undefined;
      let stoppedHelp: string[] = [];
      for (const [index, user] of batch.entries()) {
        if (index > 0) await sleep(FOLLOW_INTERVAL_MS);
        try {
          const data = await sendFollow(account, user);
          if (data["pending_follow"] === true) requested += 1;
          else followed += 1;
        } catch (error) {
          if (!(error instanceof AxiError)) throw error;
          stopped = { at: `@${user.username}`, code: error.code, reason: error.message };
          stoppedHelp = error.suggestions;
          break;
        }
        recent.push(Date.now());
        try {
          logFollow(account.id, user.id);
        } catch (error) {
          stopped = { at: `@${user.username}`, code: "FOLLOW_LOG_FAILED", reason: `X confirmed this follow, but the log was not updated: ${String(error)}` };
          break;
        }
      }
      const done = followed + requested;
      const billable = done + (stopped?.["code"] === "OUTCOME_UNKNOWN" ? 1 : 0);
      const left = remaining.length - done;
      const again = `Run \`x-axi follow-file ${file}\``;
      const stillRecent = recentFollows(recent);
      let help: string[] = [];
      if (stopped) help = [...stoppedHelp, "Fix the reason above before running again; do not retry in a loop"];
      else if (left > 0 && stillRecent.length < FOLLOW_DAILY_CAP) help = [`${again} to continue; ${counted(FOLLOW_DAILY_CAP - stillRecent.length, "follow")} left in the rolling 24 hours`];
      else if (left > 0) help = [`${again} after ${capReopensAt(stillRecent)} to continue`];
      return {
        follow_file: { followed, requested, remaining: left, status: stopped ? "stopped early" : "batch complete" },
        ...(stopped ? { stopped } : {}),
        est_cost: money(billable * RATES.userInteraction),
        ...(help.length ? { help } : {}),
      };
    },
    hide: (args) => hideReply(args, true),
    unhide: (args) => hideReply(args, false),
    spend: (args) => {
      parseArgs(args, "spend", []);
      return { spend: summarizeSpend(), help: ["This is a local upper bound. Billing truth is at https://console.x.com"] };
    },
    api: async (args) => {
      const parsed = parseArgs(args, "api", []);
      const path = parsed.positional[0];
      if (parsed.positional.length !== 1 || !path?.startsWith("/2/")) throw usage("expected one path starting with /2/", [HELP["api"] as string]);
      const response = await get(deps, path);
      if (response.body["data"] === undefined && response.body["meta"] === undefined) {
        throw new AxiError(`X returned no usable result: ${errorDetail(response.body)}`, "X_UNAVAILABLE");
      }
      spend("api", null);
      return response.body;
    },
    update: () => {
      throw new AxiError("x-axi is not published to a package registry and does not update itself", "UPDATE_FROM_GIT", [
        "In your x-axi checkout, run `git pull && pnpm install --frozen-lockfile && pnpm run build`",
      ]);
    },
    setup: async (args) => {
      parseArgs(args, "setup", []);
      const config = readConfig();
      const redirectUri = config.redirect_uri ?? DEFAULT_REDIRECT_URI;
      const status = await deps.auth.status();
      const account = readAccount();
      return {
        account: account ? `@${account.username}` : "not connected",
        login: status.logged_in ? "stored" : status.problem ? "unknown, the keystore could not be read" : "none",
        storage: status.storage,
        ...(status.problem ? { storage_problem: status.problem } : {}),
        client_id: config.client_id ? `configured in ${configPath()}` : `not configured; pass --client-id to login, saved to ${configPath()}`,
        callback_url: redirectUri,
        steps: setupSteps(redirectUri),
        ...(status.help ? { help: status.help } : {}),
      };
    },
    login: async (args) => {
      const parsed = parseArgs(args, "login", ["--client-id"]);
      if (parsed.positional.length) throw usage("`login` takes only --client-id", [HELP["login"] as string]);
      const config = readConfig();
      const flag = parsed.flags.get("--client-id");
      const clientId = flag !== undefined ? parseClientId(flag, "--client-id") : config.client_id;
      if (!clientId) throw usage("no client ID: pass --client-id, or put client_id in the config file", [SETUP_HINT]);
      const status = await deps.auth.login(clientId);
      // From here the login is stored, so every later problem is reported as a warning or with that fact attached.
      try {
        clearAccount(); // The cache may name the previous login's account.
      } catch (error) {
        warnings.add(`cached account not cleared: ${String(error)}`);
      }
      if (config.client_id !== clientId) {
        try {
          writeConfig({ ...config, client_id: clientId });
        } catch (error) {
          warnings.add(`client ID not saved to ${configPath()}: ${String(error)}; the stored login carries it, so refreshes still work`);
        }
      }
      let account: Account;
      try {
        account = await refreshAccount();
      } catch (error) {
        const known = error instanceof AxiError;
        throw new AxiError(
          `signed in and stored the login, but could not read the account: ${known ? error.message : String(error)}`,
          known ? error.code : "X_UNAVAILABLE",
          [...(known ? error.suggestions : []), "The login is stored; run `x-axi me` once the cause above is fixed"],
        );
      }
      return {
        login: { account: `@${account.username}`, scopes: status.scopes, access_token_expires_at: status.access_token_expires_at, storage: status.storage },
        est_cost: money(recorded),
        help: ["Run `x-axi mentions` to see who mentioned you", "Run `x-axi auth status` any time to see this login without an API call"],
      };
    },
    logout: async (args) => {
      parseArgs(args, "logout", []);
      const report = await deps.auth.logout();
      try {
        clearAccount();
      } catch (error) {
        warnings.add(`cached account not cleared: ${String(error)}`);
      }
      const failed = Object.entries(report.revoke_failed);
      return {
        logout: {
          stored_login: report.had_login ? "deleted" : "none was stored",
          revoked_at_x: report.revoked.length ? report.revoked.join(", ") : "nothing",
          ...(failed.length ? { revoke_failed: Object.fromEntries(failed) } : {}),
        },
        ...(failed.length ? { help: ["The local login is gone, but X may still consider the token valid until it expires; revoke the app at https://x.com/settings/connected_apps to be sure"] } : {}),
      };
    },
    auth: async (args) => {
      const [sub, ...rest] = args;
      if (sub !== "status") throw usage("expected `auth status`", [HELP["auth"] as string]);
      parseArgs(rest, "auth status", []);
      const status = await deps.auth.status();
      const account = readAccount();
      const { help, ...shown } = status;
      return { auth: { ...(account ? { account: `@${account.username}` } : {}), ...shown }, ...(help ? { help } : {}) };
    },
  };

  return Object.fromEntries(
    Object.entries(commands).map(([name, run]) => [
      name,
      async (args: string[]) => {
        warnings.clear();
        recorded = 0;
        try {
          const output = await run(args);
          return warnings.size ? { ...output, warning: [...warnings].join("; ") } : output;
        } catch (error) {
          if (error instanceof AxiError && warnings.size) throw new AxiError(error.message, error.code, [...error.suggestions, ...warnings]);
          throw error;
        }
      },
    ]),
  );
}

function recentFollows(events: (string | number)[]): number[] {
  const cutoff = Date.now() - DAY_MS;
  return events.map((at) => new Date(at).getTime()).filter((at) => at > cutoff).sort((a, b) => a - b);
}

/** The cap reopens when enough of the oldest follows age out to leave the count under it. */
function capReopensAt(recent: number[]): string {
  return new Date((recent[recent.length - FOLLOW_DAILY_CAP] as number) + DAY_MS).toISOString();
}

function parseFollowQueue(file: string): { id: string; username: string }[] {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw usage(`cannot read ${file}: ${(error as Error).message}`);
  }
  if (!Array.isArray(value)) throw usage(`${file} must be a JSON array`);
  const queue = new Map<string, { id: string; username: string }>();
  for (const entry of value as { id?: unknown; username?: unknown }[]) {
    if (typeof entry?.id !== "string" || !/^\d{1,19}$/.test(entry.id) || typeof entry.username !== "string" || !/^\w{1,15}$/.test(entry.username)) {
      throw usage(`${file} has an entry without a valid id and username`);
    }
    if (!queue.has(entry.id)) queue.set(entry.id, { id: entry.id, username: entry.username });
  }
  return [...queue.values()];
}

function checkProfile(username: string): string {
  return `Check the profile at https://x.com/${username}`;
}

function outcomeUnknown(reason: string, check: string): AxiError {
  return new AxiError(`${reason}; the write may or may not have gone through`, "OUTCOME_UNKNOWN", [
    `${check} before trying again; a blind retry can repeat the write`,
  ]);
}
