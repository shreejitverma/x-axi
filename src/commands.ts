import { AxiError } from "axi-sdk-js";
import { errorDetail, SETUP_HINT, toApiError, type ApiResponse, type Json, type Method, type XClient } from "./api.js";
import { counted, linuxApprovalText, type ApprovalBody, type ApprovalRequest, type ApprovalResult, type Approver } from "./approve.js";
import { displayText, onePositional, parseArgs, parseHandle, parseLimit, parseListId, parseMaxSpend, parseOutgoingText, parsePollMinutes, parsePollOptions, parsePostId, parseShortText, shortenPath, usage, type Parsed } from "./args.js";
import type { AuthService } from "./auth.js";
import { configPath, DEFAULT_REDIRECT_URI, parseClientId, readConfig, writeConfig } from "./config.js";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { assertFollowLogReadable, clearAccount, DAY_MS, logFollow, logFollowAttempt, logUnfollow, readAccount, readFollows, recordSpend, summarizeSpend, writeAccount, type Account } from "./ledger.js";
import { chunkCount, describeMedia, inspectMedia, MEDIA_CHUNK_BYTES, readChunks, type MediaFile } from "./media.js";
import { SCOPES } from "./oauth.js";
import { DEFAULT_SPEND_CAP_USD, estimatePostCost, RATES } from "./rates.js";
import { NPM_PACKAGE, VERSION } from "./version.js";

export interface Deps {
  client: XClient;
  approve: Approver;
  auth: AuthService;
  sleep?: (ms: number) => Promise<void>;
  /** process.platform outside tests; decides whether a dry run warns about the Linux dialog. */
  platform?: NodeJS.Platform;
}

// X allows 50 follows per 15 minutes and 400 per day. These stay under both.
const FOLLOW_INTERVAL_MS = 20_000;
const FOLLOW_DAILY_CAP = 400;
// Sums of per-row rates carry float error, so 0.01 + 137 * 0.01 prints as 1.38 but compares above it.
const CAP_SLACK_USD = 1e-9;
const FOLLOW_BATCH_DEFAULT = 100;

// GET /2/users/{id}/following and /followers take max_results from 1 to 1000.
const USER_PAGE_MAX = 1000;
const MEDIA_WAIT_LIMIT_SECONDS = 600;
const MEDIA_ID_PLACEHOLDER = "<media id from finalize>";
const DRY_RUN = "--dry-run";

export type Output = Record<string, unknown>;

const PREVIEW = 280;
const POST_FIELDS = "tweet.fields=created_at,public_metrics,conversation_id,note_tweet,entities&expansions=author_id&user.fields=username";
// GET /2/users/{id}/muting and /blocking take max_results from 1 to 1000; list members and owned lists from 1 to 100.
const LIST_PAGE_MAX = 100;
const LIST_NAME_MAX = 25;
const LIST_DESCRIPTION_MAX = 100;
const WOEID_TRENDS_MAX = 50;

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

interface Poll {
  options: string[];
  duration_minutes: number;
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

function listOutput(key: string, rows: Output[], body: Json, emptyMessage: string, cost: Output): Output {
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

/** What a write would do. est_cost stays what was really spent, as everywhere else: here, the reads that validated it. */
function dryRunOutput(action: string, account: Account, wouldSend: Output[], usd: number | null, spent: number, extra: Output = {}): Output {
  return {
    dry_run: { action, account: `@${account.username}`, ...extra, would_send: wouldSend, write_est_cost: usd === null ? "unknown" : money(usd) },
    est_cost: money(spent),
    help: [
      "Nothing was written to X and no approval was asked; est_cost is the reads made to validate this, which X bills",
      "Run it again without --dry-run to open the approval dialog",
      ...(extra["linux_dialog"] ? ["On Linux, shorten the text first"] : []),
    ],
  };
}

function approvalRequest(action: string, account: Account, body: ApprovalBody, estCostUsd: number | null, context?: string): ApprovalRequest {
  return { action, account: account.username, ...body, estCostUsd, ...(context ? { context } : {}) };
}

/** A dry run never opens the dialog, so on Linux it asks the same question the Linux dialog would. Elsewhere that dialog is never used. */
function linuxDialogReport(request: ApprovalRequest, platform: NodeJS.Platform): Output {
  if (platform !== "linux") return {};
  return linuxApprovalText(request) === null ? { linux_dialog: "too long: the real run refuses this with APPROVAL_TEXT_TOO_LONG and sends nothing" } : {};
}

function userRows(body: Json): Output[] {
  return ((body["data"] as Json[] | undefined) ?? []).map((user) => ({ id: String(user["id"]), username: String(user["username"]), name: String(user["name"] ?? "") }));
}

function nextHelp(command: string, next: unknown): string[] {
  return typeof next === "string" ? [`Run \`${command} --next ${next}\` for more`] : [];
}

interface ListInfo {
  id: string;
  name: string;
  members: number | undefined;
  private: boolean;
}

function describeList(list: ListInfo): string {
  const members = list.members === undefined ? "member count unknown" : counted(list.members, "member");
  return `List "${displayText(list.name)}" (${list.private ? "private" : "public"}, ${members}, id ${list.id})`;
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
  view: "usage: x-axi view <post-id-or-url> [--full]\nThe post with its public metrics: replies, likes, reposts, and quotes, bookmarks, and impressions where X returns them. Costs about $0.005, plus $0.01 for the author.",
  search: "usage: x-axi search <query> [--limit 10-100] [--next TOKEN] [--full]\nRecent search, last 7 days. Each result costs about $0.005.",
  user: "usage: x-axi user <handle>",
  dm: "usage:\n  x-axi dm list [--limit 1-100] [--next TOKEN] [--full]\n  x-axi dm read <handle> [--limit 1-100] [--next TOKEN] [--full]\n  x-axi dm send <handle> <text> [--dry-run]   (needs your approval)\nEncrypted XChat conversations are not covered.",
  following: "usage: x-axi following [handle] [--limit 1-1000] [--next TOKEN] [--max-spend USD]\n       x-axi following [handle] --all --out file.json [--next TOKEN] [--max-spend USD]\nAccounts a user follows; yours without a handle. Shows the total. Each account costs about $0.01, or $0.001 on your own list when you own the app, plus $0.01 for the lookup that gives the total. A read estimated above $1 refuses without a --max-spend that covers it, and if X's total proves too low, a page is cut short at the cap and --all stops there. --all with --next cannot be priced in advance, so it always stops at the cap and prints how to continue. --all writes a JSON array and never overwrites a file. The export is unfiltered, so it can hold accounts you already follow; build a follow queue with `x-axi follow-plan`.",
  followers: "usage: x-axi followers [handle] [--limit 1-1000] [--next TOKEN] [--max-spend USD]\n       x-axi followers [handle] --all --out file.json [--next TOKEN] [--max-spend USD]\nAccounts following a user; yours without a handle. Costs, caps, and the unfiltered --all export as for `following`.",
  "follow-plan": "usage: x-axi follow-plan <handle> --out queue.json [--max-spend USD] [--include-protected]\nReads that account's following and your own following once, removes accounts you already follow and yourself, and writes a queue for follow-file. Protected accounts go to <out>.protected.json instead of the queue unless you pass --include-protected. Writes nothing to X. About $0.01 per account listed, $0.001 on your own list when you own the app, and $0.02 for the two lookups that give the totals. An estimate above $1 refuses without a --max-spend that covers it. Never overwrites a file. Writes no queue if either read stops early or your own list has partial errors; partial errors on their list, or X listing fewer of your follows than its count, still write the queue with a warning.",
  post: "usage: x-axi post <text> [--quote POST] [--media FILE] [--poll \"A|B[|C|D]\" [--poll-minutes 5-10080]] [--dry-run]\nOpens an approval dialog, then publishes. Costs about $0.015, or $0.20 with a URL. --media attaches one JPEG, PNG, WebP (5 MiB), GIF (15 MiB), or MP4, MOV, or WebM video (16 GiB, or 8 GB without Premium); the file is checked before any spend and uploaded only after approval, and the text may then be left out. Upload needs the media.write scope and X lists no price for it. --poll adds 2 to 4 options of 1 to 25 characters, separated by |, open --poll-minutes (default 1440, one day); it needs text and cannot be combined with --media or --quote, and the dialog shows every option and the duration. X's docs say --quote needs an Enterprise plan, so expect FORBIDDEN on self-serve. --dry-run prints what would be sent, with no approval and no write; reads made to validate it are billed.",
  reply: "usage: x-axi reply <post-id-or-url> <text> [--media FILE] [--dry-run]\nOpens an approval dialog showing the parent post. X allows this only on your own posts or when the author mentioned or quoted you. --media and --dry-run work as on `post`.",
  thread: "usage: x-axi thread <first> <second> ... [--dry-run]\nPosts each part as a reply to the part before it, after one approval dialog showing every part and the total cost. The Linux dialog has room for about 8 short parts. Each part costs as a post of its own: about $0.015, or $0.20 with a URL. If a part fails it stops, never retries, and reports the posted IDs and that part's outcome. Do not rerun a stopped thread: the posted parts are public.",
  delete: "usage: x-axi delete <post-id-or-url> [--dry-run]\nOpens an approval dialog showing the post. Already deleted is a no-op.",
  hide: "usage: x-axi hide <reply-id-or-url> [--dry-run]\nHides a reply on your own conversation, after approval.",
  unhide: "usage: x-axi unhide <reply-id-or-url> [--dry-run]",
  repost: "usage: x-axi repost <post-id-or-url> [--dry-run]\nOpens an approval dialog showing the post. X's pricing page lists no price for reposting, so the cost is unknown. No docs page names reposts on pay-per-use specifically, so X may refuse this.",
  unrepost: "usage: x-axi unrepost <post-id-or-url> [--dry-run]\nOpens an approval dialog showing the post. The cost is unknown, as for `repost`.",
  follow: "usage: x-axi follow <handle> [--dry-run]\nOpens an approval dialog. Costs about $0.015.",
  unfollow: "usage: x-axi unfollow <handle> [--dry-run]\nOpens an approval dialog. Costs about $0.01.",
  "follow-file": "usage: x-axi follow-file <file.json> [--max 1-400] [--dry-run]\nFollows the next accounts from a JSON array of {id, username}, after one approval for the whole batch. One follow every 20 seconds, at most 400 in 24 hours, default 100 per run. Stops at the first error. Rerun to continue. Skips only accounts this login followed through x-axi; build the file with `x-axi follow-plan` so accounts you already follow are not in it. Usernames are shown as the file gives them.",
  bookmarks: "usage: x-axi bookmarks [--limit 1-100] [--next TOKEN] [--full]\nYour bookmarked posts. About $0.001 per post at the Owned Read rate when you own the app, plus $0.01 per author. Needs the bookmark.read scope.",
  bookmark: "usage: x-axi bookmark <post-id-or-url> [--dry-run]\nOpens an approval dialog showing the post, then bookmarks it. Costs about $0.005, plus the post read. Needs the bookmark.write scope.",
  unbookmark: "usage: x-axi unbookmark <post-id-or-url> [--dry-run]\nOpens an approval dialog showing the post, then removes the bookmark. Costs about $0.005, plus the post read. Needs the bookmark.write scope.",
  likes: "usage: x-axi likes [handle] [--limit 5-100] [--next TOKEN] [--full]\nPosts a user liked; yours without a handle. About $0.001 per post, plus $0.01 per author and $0.01 for the lookup of another account. Needs the like.read scope.",
  lists: "usage: x-axi lists [handle] [--limit 1-100] [--next TOKEN]\nLists a user owns; yours without a handle. About $0.005 per List, or $0.001 on your own when you own the app, plus $0.01 for the lookup of another account. Needs the list.read scope.",
  list: "usage:\n  x-axi list view <list> [--limit 1-100] [--next TOKEN] [--full]          posts, about $0.005 each plus $0.01 per author\n  x-axi list members <list> [--limit 1-100] [--next TOKEN]                about $0.01 per member\n  x-axi list create <name> [--description TEXT] [--private] [--dry-run]   about $0.010\n  x-axi list delete <list> [--dry-run]                                    about $0.005\n  x-axi list add <list> <handle> [--dry-run]                              about $0.005\n  x-axi list remove <list> <handle> [--dry-run]                           about $0.005\n<list> is a List ID or a URL such as https://x.com/i/lists/123. A name is 1 to 25 characters and a description at most 100. Each write opens an approval dialog naming the List and the member; delete, add, and remove first read the List, about $0.005, and add and remove look up the handle, about $0.01. Needs the list.read and list.write scopes.",
  mutes: "usage: x-axi mutes [--limit 1-1000] [--next TOKEN]\nAccounts you muted. About $0.001 per account. Needs the mute.read scope.",
  mute: "usage: x-axi mute <handle> [--dry-run]\nOpens an approval dialog, then mutes the account. Costs about $0.015, plus $0.01 for the lookup. Needs the mute.write scope.",
  unmute: "usage: x-axi unmute <handle> [--dry-run]\nOpens an approval dialog, then unmutes the account. Costs about $0.005, plus $0.01 for the lookup. Needs the mute.write scope.",
  blocks: "usage: x-axi blocks [--limit 1-1000] [--next TOKEN]\nAccounts you blocked. About $0.001 per account. Read only: X's block and unblock endpoints are Enterprise only. Needs the block.read scope.",
  trends: "usage: x-axi trends [--woeid N [--limit 1-50]]\nTrends personalized for you, or for a place by its Yahoo WOEID, such as 1 for worldwide. About $0.010 per request, however many trends come back. X's docs say personalized trends need an X Premium subscription on the account, and they show WOEID trends with an app token, though the reference also lists user context, so either may return FORBIDDEN.",
  spend: "usage: x-axi spend\nLocal upper-bound estimate of API spend. No API call.",
  api: "usage: x-axi api </2/path?query>\nRaw GET for read endpoints without a command. Spend is not estimated. Writes are not available here.",
  setup: "usage: x-axi setup\nShows login state, the keystore, and the exact X portal steps. No API call.",
  login: "usage: x-axi login [--client-id ID]\nSigns in to X in your browser with OAuth 2.0 PKCE and stores the login in the OS keystore. Run it yourself in a terminal, never through an agent. The client ID comes from --client-id or the config file, and the flag's value is saved to the config file. Then fetches your account, about $0.01. A login that replaces another account's stored login revokes the old tokens; one that replaces the same account's leaves them live and says so, so run `x-axi logout` first after a suspected leak.",
  logout: "usage: x-axi logout\nRevokes the tokens at X and deletes the stored login. No approval dialog; deleting is reported even when revocation fails.",
  auth: "usage: x-axi auth status\nShows the account, scopes, access token expiry, and where the login is stored. Never shows a token. No API call.",
  update: `usage: x-axi update\nShows the installed version and how to update, with npm (${NPM_PACKAGE}) or from a git checkout. It installs nothing.`,
};

const EARLIER_TOKENS_LIVE = "The earlier login's tokens stay live at X, because revoking them could also end this login. After a suspected leak, run `x-axi logout` before `x-axi login`, which revokes them; to end them now, revoke the app at https://x.com/settings/connected_apps and log in again";

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
          "Run `x-axi bookmarks`, `x-axi lists`, or `x-axi trends` for your saved posts, Lists, and trends",
        ]
      : [SETUP_HINT],
  };
}

export function buildCommands(deps: Deps): Record<string, (args: string[]) => Promise<Output>> {
  const flagsForList = ["--limit", "--next"];
  const platform = deps.platform ?? process.platform;

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
  const refreshAccount = async (query = ""): Promise<Account & { data: Json }> => {
    const response = await get(deps, `/2/users/me${query}`);
    const data = response.body["data"] as Json | undefined;
    if (!data?.["id"] || !data["username"]) {
      throw new AxiError(`X returned no account: ${errorDetail(response.body)}`, "X_UNAVAILABLE");
    }
    const account = { id: String(data["id"]), username: String(data["username"]) };
    writeAccount(account);
    spend("me", RATES.userRead);
    return { ...account, data };
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
    const result: ApprovalResult = await deps.approve(approvalRequest(action, account, body, estCostUsd, context));
    if (result === "approved") return;
    const reasons: Record<Exclude<ApprovalResult, "approved">, [string, string, string?]> = {
      cancelled: ["the user cancelled this action; nothing was sent", "NOT_APPROVED"],
      timed_out: ["nobody answered the approval dialog; nothing was sent", "NOT_APPROVED"],
      unavailable: ["no approval dialog is available on this machine; nothing was sent", "APPROVAL_UNAVAILABLE"],
      no_graphical_session: [
        "writes need a dialog on a graphical desktop, and this session has neither DISPLAY nor WAYLAND_DISPLAY; nothing was sent",
        "APPROVAL_UNAVAILABLE",
        "Run x-axi from a desktop session with zenity or kdialog installed; there is no terminal prompt or override",
      ],
      no_dialog_tool: [
        "writes need zenity or kdialog, and neither is in /usr/bin, /bin, or /usr/local/bin; nothing was sent",
        "APPROVAL_UNAVAILABLE",
        "Ask the user to install zenity (or kdialog) from their distribution; there is no terminal prompt or override",
      ],
      unsupported_platform: [
        `writes need a native approval dialog, which x-axi has only on macOS and Linux, not on ${platform}; nothing was sent`,
        "APPROVAL_UNSUPPORTED_PLATFORM",
        "Run writes on macOS or Linux; there is no terminal prompt or override",
      ],
      too_long: [
        "this text is too long for the Linux approval dialog, which must show all of it and has room for about 19 rows of 50 columns of text once wrapped, or about 950 characters of plain text; nothing was sent",
        "APPROVAL_TEXT_TOO_LONG",
        "Shorten the text; parent posts and other context never cause this, and a URL wider than one row is split only for display and sent unchanged",
      ],
    };
    const [message, code, advice] = reasons[result];
    throw new AxiError(message, code, [...(advice ? [advice] : []), "Do not retry unless the user asks; never call the X API another way to get around this"]);
  };

  /** Writes are never retried: after a lost response, a retry could publish twice. */
  const send = async (
    method: Method,
    path: string,
    body: Json | FormData | undefined,
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

  const pause = (ms: number): Promise<void> => (deps.sleep ?? ((wait: number) => new Promise<void>((done) => setTimeout(done, wait))))(ms);

  /**
   * Logins made before x-axi asked for a scope lack it, and X would refuse the call after a lookup was billed.
   * This reads only the stored login, so it stops before any spend or dialog. A login whose scopes are unknown is let through.
   */
  const requireScopes = async (needed: readonly string[], what: string): Promise<void> => {
    const { scopes } = await deps.auth.status();
    const missing = scopes ? needed.filter((scope) => !scopes.includes(scope)) : [];
    if (!missing.length) return;
    throw new AxiError(
      `this login has no ${missing.join(" ")} ${missing.length === 1 ? "scope" : "scopes"}, which ${what} needs, because it was granted before x-axi asked for ${missing.length === 1 ? "it" : "them"}`,
      "MISSING_SCOPE",
      ["Run `x-axi login` in your own terminal to grant it; nothing was sent to X and nothing was spent"],
    );
  };

  const prepareMedia = async (parsed: Parsed): Promise<MediaFile | undefined> => {
    const file = parsed.flags.get("--media");
    if (file === undefined) return undefined;
    const media = inspectMedia(String(file));
    await requireScopes(["media.write"], "--media");
    return media;
  };

  const waitForMedia = async (id: string, finalized: Json, name: string): Promise<void> => {
    let body = finalized;
    let waited = 0;
    for (;;) {
      const data = body["data"] as Json | undefined;
      if (!data) throw new AxiError(`X returned no media status: ${errorDetail(body)}`, "X_UNAVAILABLE");
      const info = data["processing_info"] as { state?: string; check_after_secs?: number } | undefined;
      if (!info || info.state === "succeeded") return;
      if (info.state === "failed") throw new AxiError(`X could not process ${displayText(name)}: ${errorDetail(body)}`, "MEDIA_FAILED");
      if (info.state !== "pending" && info.state !== "in_progress") throw new AxiError(`X reported media state ${String(info.state)}`, "X_UNAVAILABLE");
      const wait = Math.min(Math.max(Number(info.check_after_secs) || 5, 1), 60);
      if (waited + wait > MEDIA_WAIT_LIMIT_SECONDS) throw new AxiError(`X was still processing ${displayText(name)} after ${waited} seconds`, "MEDIA_TIMEOUT");
      await pause(wait * 1000);
      waited += wait;
      body = (await get(deps, `/2/media/upload?command=STATUS&media_id=${id}`)).body;
      spend("media_status", null);
    }
  };

  /** Runs only after approval. Every failure here happens before the post, so its outcome is known: nothing was posted. */
  const uploadMedia = async (media: MediaFile): Promise<string> => {
    const op = "media_upload";
    try {
      const init = await send("POST", "/2/media/upload/initialize", { media_type: media.mediaType, total_bytes: media.size, media_category: media.category }, op, null, "");
      const id = (init.body["data"] as Json | undefined)?.["id"];
      if (typeof id !== "string" || !/^\d{1,19}$/.test(id)) throw new AxiError(`X returned no media ID: ${errorDetail(init.body)}`, "X_UNAVAILABLE");
      let index = 0;
      for (const chunk of readChunks(media)) {
        const form = new FormData();
        form.append("segment_index", String(index));
        form.append("media", new Blob([new Uint8Array(chunk)]), media.name);
        await send("POST", `/2/media/upload/${id}/append`, form, op, null, "");
        index += 1;
      }
      const finalized = await send("POST", `/2/media/upload/${id}/finalize`, undefined, op, null, "");
      await waitForMedia(id, finalized.body, media.name);
      return id;
    } catch (error) {
      const known = error instanceof AxiError;
      const reason = known ? error.message.replace(/; the write may or may not have gone through$/, "") : String(error);
      const code = !known || error.code === "OUTCOME_UNKNOWN" ? "MEDIA_UPLOAD_FAILED" : error.code;
      const suggestions = known && error.code !== "OUTCOME_UNKNOWN" ? error.suggestions : [];
      throw new AxiError(`the media upload stopped, so nothing was posted: ${reason}`, code, suggestions);
    }
  };

  const createPost = async (draft: { text?: string; replyTo?: string; quote?: string; media?: MediaFile; poll?: Poll; context?: string; dryRun: boolean }, account: Account, usd: number): Promise<Output> => {
    const { text, replyTo, quote, media, poll, context } = draft;
    const op = replyTo ? "reply" : "post";
    const check = "Check with `x-axi timeline`";
    const verb = replyTo ? "Reply" : quote ? "Quote post" : "Post";
    // Options are quoted as JSON strings in the tool-written first line, so one option cannot pose as two or as the duration.
    const pollShown = poll ? ` with a poll of ${counted(poll.options.length, "option")}, ${poll.options.map((option) => JSON.stringify(option)).join(" | ")}, open ${counted(poll.duration_minutes, "minute")},` : "";
    const action = media ? `${verb} with media ${describeMedia(media)}, upload price not listed by X,` : `${verb}${pollShown}`;
    const fields: Json = {
      ...(text !== undefined ? { text } : {}),
      ...(replyTo ? { reply: { in_reply_to_tweet_id: replyTo } } : {}),
      ...(quote ? { quote_tweet_id: quote } : {}),
      ...(poll ? { poll: { options: poll.options, duration_minutes: poll.duration_minutes } } : {}),
    };
    const approvalBody: ApprovalBody = text !== undefined ? { text } : { content: "No text; only the media named above is posted." };
    if (draft.dryRun) {
      const upload: Output[] = media
        ? [
            { method: "POST", path: "/2/media/upload/initialize", body: { media_type: media.mediaType, total_bytes: media.size, media_category: media.category } },
            { method: "POST", path: `/2/media/upload/${MEDIA_ID_PLACEHOLDER}/append`, chunks: chunkCount(media.size), chunk_bytes: `at most ${MEDIA_CHUNK_BYTES}` },
            { method: "POST", path: `/2/media/upload/${MEDIA_ID_PLACEHOLDER}/finalize` },
          ]
        : [];
      const post = { method: "POST", path: "/2/tweets", body: { ...fields, ...(media ? { media: { media_ids: [MEDIA_ID_PLACEHOLDER] } } : {}) } };
      return dryRunOutput(action, account, [...upload, post], usd, recorded, {
        ...(media ? { media: describeMedia(media) } : {}),
        ...(context ? { context: truncate(context, false) } : {}),
        ...(poll ? { poll: { options: poll.options, duration_minutes: poll.duration_minutes } } : {}),
        ...linuxDialogReport(approvalRequest(action, account, approvalBody, usd, context), platform),
      });
    }
    await gate(action, account, approvalBody, usd, context);
    const mediaId = media ? await uploadMedia(media) : undefined;
    let response: ApiResponse;
    try {
      response = await send(
        "POST",
        "/2/tweets",
        { ...fields, ...(mediaId ? { media: { media_ids: [mediaId] } } : {}) },
        op,
        usd,
        check,
        replyTo ? { replyTo, text: text ?? "" } : {},
      );
    } catch (error) {
      if (!(error instanceof AxiError)) throw error;
      const hints: string[] = [];
      if (quote && (error.code === "FORBIDDEN" || error.code === "APP_NOT_ENROLLED")) hints.push("X's create-post docs say quote-posting needs an Enterprise plan and is not on self-serve tiers");
      if (mediaId) hints.push(`Media ${mediaId} finished uploading; X checks its limits again when it is attached to a post, including a video's duration`);
      throw hints.length ? new AxiError(error.message, error.code, [...error.suggestions, ...hints]) : error;
    }
    const data = response.body["data"] as Json | undefined;
    if (!data?.["id"]) throw outcomeUnknown("X accepted the request but returned no post ID", check);
    return {
      [op]: { id: String(data["id"]), url: `https://x.com/${account.username}/status/${String(data["id"])}`, status: "published" },
      est_cost: money(usd),
    };
  };

  type ListSide = "following" | "followers";
  interface ListTarget extends Account {
    total: number | undefined;
    rate: number;
  }
  interface UserRow extends Output {
    id: string;
    username: string;
    name: string;
    protected: boolean;
  }
  interface ReadAll {
    rows: UserRow[];
    partial: number;
    next?: string;
    stopped?: AxiError;
  }

  const listCount = (data: Json, side: ListSide): number | undefined => {
    const count = (data["public_metrics"] as Json | undefined)?.[`${side}_count`];
    return typeof count === "number" ? count : undefined;
  };

  /** Your own list is priced at the Owned Read rate, which X gives when the login also owns the app. */
  const listTarget = async (handle: string | undefined, side: ListSide): Promise<ListTarget> => {
    if (!handle) {
      const account = await refreshAccount("?user.fields=public_metrics");
      return { id: account.id, username: account.username, total: listCount(account.data, side), rate: RATES.ownedRead };
    }
    const known = readAccount();
    const response = await get(deps, `/2/users/by/username/${handle}?user.fields=public_metrics`);
    const data = foundUser(response.body, handle);
    spend("user", RATES.userRead);
    const id = String(data["id"]);
    return { id, username: String(data["username"]), total: listCount(data, side), rate: id === known?.id ? RATES.ownedRead : RATES.followListRead };
  };

  const userPage = async (target: ListTarget, side: ListSide, size: number, token: string | undefined, op: string): Promise<{ rows: UserRow[]; next?: string; partial: number; body: Json }> => {
    const { body } = await get(deps, `/2/users/${target.id}/${side}?${pagedQuery(size, token)}&user.fields=protected`);
    const meta = body["meta"] as { next_token?: string; result_count?: number } | undefined;
    if (!Array.isArray(body["data"]) && meta?.result_count === undefined) throw unreadable(`the ${side} of @${target.username}`, body);
    const rows = ((body["data"] as Json[] | undefined) ?? []).map((user) => ({
      id: String(user["id"]),
      username: String(user["username"]),
      name: String(user["name"] ?? ""),
      protected: user["protected"] === true,
    }));
    spend(op, rows.length * target.rate);
    return { rows, ...(meta?.next_token ? { next: meta.next_token } : {}), partial: Array.isArray(body["errors"]) ? (body["errors"] as Json[]).length : 0, body };
  };

  /** How many rows the cap still allows, so even a wrong total from X cannot spend past it. */
  const rowsWithinCap = (target: ListTarget, cap: number): number => Math.floor((cap - recorded + CAP_SLACK_USD) / target.rate);

  /** A failure keeps what was already paid for. */
  const readAllUsers = async (target: ListTarget, side: ListSide, op: string, cap: number, start?: string): Promise<ReadAll> => {
    const out: ReadAll = { rows: [], partial: 0 };
    let token = start;
    for (;;) {
      const room = rowsWithinCap(target, cap);
      if (room < 1) return { ...out, ...(token ? { next: token } : {}), stopped: new AxiError(`the ${money(cap)} spend cap was reached`, "SPEND_CAP", ["Raise --max-spend to read further"]) };
      let page;
      try {
        page = await userPage(target, side, Math.min(USER_PAGE_MAX, room), token, op);
      } catch (error) {
        if (!(error instanceof AxiError)) throw error;
        return { ...out, ...(token ? { next: token } : {}), stopped: error };
      }
      out.rows.push(...page.rows);
      out.partial += page.partial;
      if (!page.next) return out;
      token = page.next;
      if (!page.rows.length) return { ...out, next: token, stopped: new AxiError("X returned an empty page with a next token", "X_UNAVAILABLE") };
    }
  };

  const overCap = (usd: number, cap: number): boolean => usd > cap + CAP_SLACK_USD;

  const spendCapError = (what: string, estimate: number, cap: number): AxiError => {
    const needed = (Math.ceil((estimate - CAP_SLACK_USD) * 100) / 100).toFixed(2);
    return new AxiError(`${what} would cost about ${money(estimate)}, above the ${money(cap)} cap; nothing more was read`, "SPEND_CAP", [
      `Pass --max-spend ${needed} if that is acceptable`,
      `Finding that out cost ${money(recorded)} in lookups`,
    ]);
  };

  const refuseExisting = (path: string): void => {
    if (existsSync(path)) throw usage(`${path} already exists; choose a new file`);
  };

  /** Fails before any paid page if the file cannot be created, so paid results always have somewhere to go. */
  const reserveFile = (path: string): void => {
    try {
      writeFileSync(path, "", { flag: "wx", mode: 0o600 });
    } catch (error) {
      throw usage(`cannot create ${path}: ${(error as Error).message}; choose a new file`);
    }
  };

  const writeJson = (path: string, value: unknown): void => {
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  };

  const listUsers = async (args: string[], side: ListSide): Promise<Output> => {
    const parsed = parseArgs(args, side, ["--limit", "--next", "--out", "--max-spend"], ["--all"]);
    const positional = onePositional(parsed, side);
    const handle = positional === undefined ? undefined : parseHandle(positional);
    const limit = parseLimit(parsed, 20, 1, USER_PAGE_MAX);
    const maxSpend = parseMaxSpend(parsed);
    const cap = maxSpend ?? DEFAULT_SPEND_CAP_USD;
    const all = parsed.flags.has("--all");
    const out = parsed.flags.get("--out");
    const nextFlag = parsed.flags.get("--next");
    const next = nextFlag === undefined ? undefined : String(nextFlag);
    if (all !== (out !== undefined)) throw usage("--all and --out go together", [HELP[side] as string]);
    if (all && parsed.flags.has("--limit")) throw usage("--limit does not apply to --all; --max-spend bounds it");
    if (out !== undefined) refuseExisting(String(out));
    const target = await listTarget(handle, side);
    const name = `@${target.username}`;
    const rerun = `x-axi ${side}${handle ? ` ${handle}` : ""}`;
    const keepCap = maxSpend === undefined ? "" : ` --max-spend ${maxSpend}`;
    const total = target.total ?? "unknown";
    const resuming = all && next !== undefined;
    if (!resuming) {
      const count = all ? target.total : Math.min(limit, target.total ?? limit);
      const estimate = count === undefined ? undefined : recorded + count * target.rate;
      if (estimate === undefined && maxSpend === undefined) {
        throw new AxiError("X did not return the size of this list, so its cost cannot be estimated; nothing more was read", "SPEND_CAP", ["Pass --max-spend USD to read it up to that amount"]);
      }
      if (estimate !== undefined && overCap(estimate, cap)) throw spendCapError(`Reading ${count} of the ${total} ${side} of ${name}`, estimate, cap);
    }
    if (out === undefined) {
      const room = rowsWithinCap(target, cap);
      if (room < 1) throw spendCapError(`Reading a page of the ${total} ${side} of ${name}`, recorded + target.rate, cap);
      const page = await userPage(target, side, Math.min(limit, room), next, side);
      return {
        target: name,
        total,
        ...(page.rows.length ? { count: page.rows.length, users: page.rows } : { users: "0 accounts found" }),
        ...(page.partial ? { partial_errors: `${page.partial}: ${errorDetail(page.body)}` } : {}),
        ...(page.next ? { next_token: page.next } : {}),
        est_cost: money(recorded),
        ...(page.next ? { help: [`Run \`${rerun} --limit ${limit} --next ${page.next}${keepCap}\` for more, or \`${rerun} --all --out FILE --next ${page.next}${keepCap}\` to export the rest, which stops at the ${money(cap)} cap`] } : {}),
      };
    }
    const file = String(out);
    reserveFile(file);
    const result = await readAllUsers(target, side, side, cap, next);
    if (result.stopped && !result.rows.length && result.stopped.code !== "SPEND_CAP") {
      rmSync(file, { force: true });
      throw result.stopped;
    }
    writeJson(file, result.rows);
    return {
      export: { target: name, total, written: result.rows.length, file, complete: !result.stopped && !result.partial },
      ...(result.partial ? { partial_errors: result.partial } : {}),
      ...(result.stopped ? { stopped: { code: result.stopped.code, reason: result.stopped.message } } : {}),
      ...(result.next ? { next_token: result.next } : {}),
      est_cost: money(recorded),
      help: [
        ...(resuming ? [`What remains after --next cannot be priced in advance, so this read was held to the ${money(cap)} cap instead of being refused up front`] : []),
        ...(result.stopped ? [...result.stopped.suggestions, result.next ? `The file holds what was read. Continue into a new file with \`${rerun} --all --out NEW_FILE --next ${result.next}${keepCap}\`` : "The file holds what was read"] : []),
        "This export is unfiltered, so it can hold accounts you already follow; build a follow queue with `x-axi follow-plan <handle> --out queue.json`",
      ],
    };
  };

  const followPlan = async (args: string[]): Promise<Output> => {
    const parsed = parseArgs(args, "follow-plan", ["--out", "--max-spend"], ["--include-protected"]);
    const handle = parseHandle(onePositional(parsed, "follow-plan"));
    const outFlag = parsed.flags.get("--out");
    if (outFlag === undefined) throw usage("follow-plan needs --out FILE", [HELP["follow-plan"] as string]);
    const out = String(outFlag);
    const holdProtected = !parsed.flags.has("--include-protected");
    const protectedFile = `${out.replace(/\.json$/i, "")}.protected.json`;
    const maxSpend = parseMaxSpend(parsed);
    const cap = maxSpend ?? DEFAULT_SPEND_CAP_USD;
    refuseExisting(out);
    if (holdProtected) refuseExisting(protectedFile);
    const mine = await listTarget(undefined, "following");
    const theirs = await listTarget(handle, "following");
    if (theirs.id === mine.id) throw usage("that is your own account; a plan copies another account's following");
    if ((mine.total === undefined || theirs.total === undefined) && maxSpend === undefined) {
      throw new AxiError("X did not return the size of these lists, so the cost cannot be estimated; nothing more was read", "SPEND_CAP", ["Pass --max-spend USD to read them up to that amount"]);
    }
    if (mine.total !== undefined && theirs.total !== undefined) {
      const estimate = recorded + mine.total * mine.rate + theirs.total * theirs.rate;
      if (overCap(estimate, cap)) throw spendCapError(`Reading the ${theirs.total} accounts @${theirs.username} follows and the ${mine.total} you follow`, estimate, cap);
    }
    reserveFile(out);
    const incomplete = (whose: string, result: ReadAll): AxiError => {
      rmSync(out, { force: true });
      return new AxiError(
        `${whose} could not be read in full (${result.stopped?.message ?? `X reported ${result.partial} partial errors`}), so no queue was written; ${money(recorded)} was spent`,
        result.stopped?.code ?? "INCOMPLETE_READ",
        [...(result.stopped?.suggestions ?? []), "A queue from a partial list could hold accounts you already follow. X does not re-bill what it served within a UTC day, so a rerun that day should cost little"],
      );
    };
    // Your own list comes first and must be whole: it is what keeps already-followed accounts out of the queue.
    const own = await readAllUsers(mine, "following", "follow_plan", cap);
    if (own.stopped || own.partial) throw incomplete("Your following list", own);
    const source = await readAllUsers(theirs, "following", "follow_plan", cap);
    if (source.stopped) throw incomplete(`The following list of @${theirs.username}`, source);
    if (mine.total !== undefined && own.rows.length < mine.total) {
      warnings.add(`X listed ${own.rows.length} of the ${mine.total} accounts its count says you follow, so one you already follow could still be in the queue`);
    }
    if (source.partial) warnings.add(`X reported ${source.partial} partial errors reading @${theirs.username}, so the queue may be missing accounts`);
    const already = new Set(own.rows.map((user) => user.id));
    const seen = new Set<string>();
    const queue: { id: string; username: string }[] = [];
    const held: { id: string; username: string }[] = [];
    let alreadyFollowed = 0;
    let selfExcluded = 0;
    let unusable = 0;
    for (const user of source.rows) {
      if (seen.has(user.id)) continue;
      seen.add(user.id);
      const entry = { id: user.id, username: user.username };
      // follow-file refuses a whole file over one bad entry.
      if (!/^\d{1,19}$/.test(user.id) || !/^\w{1,15}$/.test(user.username)) unusable += 1;
      else if (user.id === mine.id) selfExcluded += 1;
      else if (already.has(user.id)) alreadyFollowed += 1;
      else if (user.protected && holdProtected) held.push(entry);
      else queue.push(entry);
    }
    writeJson(out, queue);
    if (held.length) writeJson(protectedFile, held);
    return {
      follow_plan: {
        target: `@${theirs.username}`,
        target_following: seen.size,
        your_following: already.size,
        already_followed: alreadyFollowed,
        self_excluded: selfExcluded,
        protected_held: held.length,
        ...(unusable ? { unusable } : {}),
        queued: queue.length,
        queue_file: out,
        ...(held.length ? { protected_file: protectedFile } : {}),
      },
      est_cost: money(recorded),
      following_them_would_cost: money(queue.length * RATES.userInteraction),
      help: queue.length
        ? [`Run \`x-axi follow-file ${out} --dry-run\` to review the first batch, then without --dry-run to follow after approval`]
        : ["0 accounts to follow: you already follow all of them, or they are held out"],
    };
  };

  const hideReply = async (args: string[], hidden: boolean): Promise<Output> => {
    const name = hidden ? "hide" : "unhide";
    const parsed = parseArgs(args, name, [], [DRY_RUN]);
    const id = parsePostId(onePositional(parsed, name));
    const account = await refreshAccount();
    const found = await fetchPost(id);
    if (!found) throw new AxiError(`post ${id} not found`, "NOT_FOUND");
    const action = hidden ? "Hide reply" : "Unhide reply";
    const content = `@${found.author}: ${displayText(fullText(found.post))}`;
    if (parsed.flags.has(DRY_RUN)) return dryRunOutput(action, account, [{ method: "PUT", path: `/2/tweets/${id}/hidden`, body: { hidden } }], null, recorded, { target: content });
    await gate(action, account, { content }, null);
    const check = `Check the reply at https://x.com/i/status/${id}, because x-axi cannot read whether a reply is hidden`;
    const response = await send("PUT", `/2/tweets/${id}/hidden`, { hidden }, name, null, check);
    const state = (response.body["data"] as Json | undefined)?.["hidden"];
    if (state !== hidden) throw outcomeUnknown(`X answered hidden=${String(state)}`, check);
    return { reply: { id, hidden } };
  };

  const setRepost = async (args: string[], reposted: boolean): Promise<Output> => {
    const name = reposted ? "repost" : "unrepost";
    const parsed = parseArgs(args, name, [], [DRY_RUN]);
    const id = parsePostId(onePositional(parsed, name));
    const account = await refreshAccount();
    const found = await fetchPost(id);
    if (!found) throw new AxiError(`post ${id} not found`, "NOT_FOUND");
    const action = reposted ? "Repost" : "Undo repost";
    const content = `@${found.author}: ${displayText(truncate(fullText(found.post), false))}`;
    const method = reposted ? "POST" : "DELETE";
    const path = reposted ? `/2/users/${account.id}/retweets` : `/2/users/${account.id}/retweets/${id}`;
    const body = reposted ? { tweet_id: id } : undefined;
    if (parsed.flags.has(DRY_RUN)) return dryRunOutput(action, account, [{ method, path, ...(body ? { body } : {}) }], null, recorded, { target: content });
    await gate(action, account, { content }, null);
    const check = `\`x-axi view\` shows only the post's total repost count, so check your reposts at https://x.com/${account.username}`;
    const response = await send(method, path, body, name, null, check);
    if ((response.body["data"] as Json | undefined)?.["retweeted"] !== reposted) throw outcomeUnknown(`X did not confirm the ${name}`, check);
    return { post: { id, status: reposted ? "reposted" : "not reposted" } };
  };

  // Scopes from each endpoint's API reference on docs.x.com, read 2026-11-03.
  const SCOPES_FOR = {
    bookmarks: ["tweet.read", "users.read", "bookmark.read"],
    bookmarkWrite: ["tweet.read", "users.read", "bookmark.write"],
    likes: ["tweet.read", "users.read", "like.read"],
    listRead: ["tweet.read", "users.read", "list.read"],
    // Writes that name the List in the dialog read it first.
    listWrite: ["tweet.read", "users.read", "list.read", "list.write"],
    mutes: ["tweet.read", "users.read", "mute.read"],
    muteWrite: ["tweet.read", "users.read", "mute.write"],
    blocks: ["tweet.read", "users.read", "block.read"],
  } as const;

  /** Your own account without a handle; another account costs a lookup. Owned Read pricing applies only to your own. */
  const whose = async (handle: string | undefined): Promise<Account & { own: boolean }> => {
    if (!handle) return { ...(await me()), own: true };
    const target = await resolveUser(handle);
    return { ...target, own: target.id === readAccount()?.id };
  };

  /** One page of posts, priced per post at `rate` plus each author X includes. */
  const postPage = async (path: string, rate: number, op: string, empty: string, full: boolean, account?: Account): Promise<Output> => {
    const response = await get(deps, path);
    if (!Array.isArray(response.body["data"]) && saysNotFound(response.body)) throw new AxiError(errorDetail(response.body), "NOT_FOUND");
    const rows = postRows(response.body, account, full);
    const usd = rows.length * rate + includedUsers(response.body) * RATES.userRead;
    return listOutput("posts", rows, response.body, empty, charge(op, usd));
  };

  const userPageOf = async (path: string, rate: number, op: string, empty: string): Promise<Output> => {
    const response = await get(deps, path);
    if (!Array.isArray(response.body["data"]) && saysNotFound(response.body)) throw new AxiError(errorDetail(response.body), "NOT_FOUND");
    const rows = userRows(response.body);
    return listOutput("users", rows, response.body, empty, charge(op, rows.length * rate));
  };

  /** Lists of accounts only X shows you: mutes and blocks. */
  const ownUsers = async (args: string[], name: "mutes" | "blocks", endpoint: string, rate: number, scopes: readonly string[]): Promise<Output> => {
    const parsed = parseArgs(args, name, flagsForList);
    if (parsed.positional.length) throw usage(`\`${name}\` takes no arguments`);
    const limit = parseLimit(parsed, 20, 1, USER_PAGE_MAX);
    await requireScopes(scopes, `\`${name}\``);
    const account = await me();
    const out = await userPageOf(`/2/users/${account.id}/${endpoint}?${pagedQuery(limit, parsed.flags.get("--next"))}`, rate, name, `0 accounts ${name === "mutes" ? "muted" : "blocked"}`);
    const action = name === "mutes"
      ? "Run `x-axi mute <handle>` to mute an account, or `x-axi unmute <handle>`, after approval"
      : "Blocking through the API needs an Enterprise plan, so block or unblock at https://x.com";
    return { account: `@${account.username}`, ...out, help: [...nextHelp(`x-axi ${name} --limit ${limit}`, out["next_token"]), action] };
  };

  /** The List a write names in its dialog, or undefined when X says it does not exist. Billed as a List read. */
  const fetchList = async (id: string): Promise<ListInfo | undefined> => {
    const response = await read(deps, `/2/lists/${id}?list.fields=member_count,private`);
    if (response.status === 404) return undefined;
    if (response.status >= 300) throw toApiError(response);
    const data = response.body["data"] as Json | undefined;
    if (!data?.["id"]) {
      if (saysNotFound(response.body)) return undefined;
      throw unreadable(`List ${id}`, response.body);
    }
    spend("list_lookup", RATES.listRead);
    const members = data["member_count"];
    return { id: String(data["id"]), name: String(data["name"] ?? ""), members: typeof members === "number" ? members : undefined, private: data["private"] === true };
  };

  const setBookmark = async (args: string[], bookmarked: boolean): Promise<Output> => {
    const name = bookmarked ? "bookmark" : "unbookmark";
    const parsed = parseArgs(args, name, [], [DRY_RUN]);
    const id = parsePostId(onePositional(parsed, name));
    await requireScopes(SCOPES_FOR.bookmarkWrite, `\`${name}\``);
    const account = await refreshAccount();
    const found = await fetchPost(id);
    if (!found) throw new AxiError(`post ${id} not found`, "NOT_FOUND");
    const action = bookmarked ? "Bookmark" : "Remove bookmark";
    const content = `@${found.author}: ${displayText(truncate(fullText(found.post), false))}`;
    const method = bookmarked ? "POST" : "DELETE";
    const path = bookmarked ? `/2/users/${account.id}/bookmarks` : `/2/users/${account.id}/bookmarks/${id}`;
    const body = bookmarked ? { tweet_id: id } : undefined;
    if (parsed.flags.has(DRY_RUN)) return dryRunOutput(action, account, [{ method, path, ...(body ? { body } : {}) }], RATES.bookmark, recorded, { target: content });
    await gate(action, account, { content }, RATES.bookmark);
    const check = "Check with `x-axi bookmarks`";
    const response = await send(method, path, body, name, RATES.bookmark, check);
    if ((response.body["data"] as Json | undefined)?.["bookmarked"] !== bookmarked) throw outcomeUnknown(`X did not confirm the ${name}`, check);
    return { post: { id, status: bookmarked ? "bookmarked" : "not bookmarked" }, est_cost: money(RATES.bookmark) };
  };

  const setMute = async (args: string[], muted: boolean): Promise<Output> => {
    const name = muted ? "mute" : "unmute";
    const parsed = parseArgs(args, name, [], [DRY_RUN]);
    const handle = parseHandle(onePositional(parsed, name));
    await requireScopes(SCOPES_FOR.muteWrite, `\`${name}\``);
    const account = await refreshAccount();
    const target = await resolveUser(handle);
    const usd = muted ? RATES.userInteraction : RATES.muteDelete;
    const action = muted ? "Mute" : "Unmute";
    const method = muted ? "POST" : "DELETE";
    const path = muted ? `/2/users/${account.id}/muting` : `/2/users/${account.id}/muting/${target.id}`;
    const body = muted ? { target_user_id: target.id } : undefined;
    if (parsed.flags.has(DRY_RUN)) return dryRunOutput(action, account, [{ method, path, ...(body ? { body } : {}) }], usd, recorded, { target: `@${target.username}` });
    await gate(action, account, { content: `@${target.username}` }, usd);
    const check = "Check with `x-axi mutes`";
    const response = await send(method, path, body, name, usd, check);
    if ((response.body["data"] as Json | undefined)?.["muting"] !== muted) throw outcomeUnknown(`X did not confirm the ${name}`, check);
    return { [name]: { handle: `@${target.username}`, status: muted ? "muted" : "not muted" }, est_cost: money(usd) };
  };

  const listCommand = async (args: string[]): Promise<Output> => {
    const [sub, ...rest] = args;
    const command = `list ${sub ?? ""}`.trim();
    if (sub === "view" || sub === "members") {
      const parsed = parseArgs(rest, command, flagsForList, sub === "view" ? ["--full"] : []);
      const id = parseListId(onePositional(parsed, command));
      const limit = parseLimit(parsed, 20, 1, LIST_PAGE_MAX);
      await requireScopes(SCOPES_FOR.listRead, `\`${command}\``);
      const q = pagedQuery(limit, parsed.flags.get("--next"));
      const out = sub === "view"
        ? await postPage(`/2/lists/${id}/tweets?${q}&${POST_FIELDS}`, RATES.postRead, "list_view", "0 posts in this List", parsed.flags.has("--full"))
        : await userPageOf(`/2/lists/${id}/members?${q}`, RATES.userRead, "list_members", "0 members in this List");
      const action = sub === "view"
        ? `Run \`x-axi list members ${id}\` for who is in it`
        : `Run \`x-axi list add ${id} <handle>\` or \`x-axi list remove ${id} <handle>\`, after approval`;
      return { list: id, ...out, help: [...nextHelp(`x-axi ${command} ${id} --limit ${limit}`, out["next_token"]), action] };
    }
    if (sub === "create") {
      const parsed = parseArgs(rest, command, ["--description"], ["--private", DRY_RUN]);
      if (parsed.positional.length !== 1) throw usage("`list create` takes one name; quote it if it contains spaces", [HELP["list"] as string]);
      const name = parseShortText(parsed.positional[0], "the List name", LIST_NAME_MAX);
      const rawDescription = parsed.flags.get("--description");
      const description = rawDescription === undefined ? undefined : parseShortText(String(rawDescription), "--description", LIST_DESCRIPTION_MAX);
      const isPrivate = parsed.flags.has("--private");
      await requireScopes(SCOPES_FOR.listWrite, "`list create`");
      const account = await refreshAccount();
      const body = { name, ...(description !== undefined ? { description } : {}), private: isPrivate };
      const action = `Create ${isPrivate ? "private" : "public"} List`;
      const content = [`Name: ${name}`, `Description: ${description ?? "(none)"}`].join("\n");
      if (parsed.flags.has(DRY_RUN)) return dryRunOutput(action, account, [{ method: "POST", path: "/2/lists", body }], RATES.listCreate, recorded, { target: content });
      await gate(action, account, { content }, RATES.listCreate);
      const check = "Check with `x-axi lists`";
      const response = await send("POST", "/2/lists", body, "list_create", RATES.listCreate, check);
      const data = response.body["data"] as Json | undefined;
      if (!data?.["id"]) throw outcomeUnknown("X accepted the request but returned no List ID", check);
      const id = String(data["id"]);
      return {
        list: { id, name: String(data["name"] ?? name), private: isPrivate, status: "created" },
        est_cost: money(RATES.listCreate),
        help: [`Run \`x-axi list add ${id} <handle>\` to add a member`],
      };
    }
    if (sub === "delete") {
      const parsed = parseArgs(rest, command, [], [DRY_RUN]);
      const id = parseListId(onePositional(parsed, command));
      await requireScopes(SCOPES_FOR.listWrite, "`list delete`");
      const account = await refreshAccount();
      const list = await fetchList(id);
      if (!list) return { list: { id, status: "already gone (no-op)" }, est_cost: money(recorded) };
      const content = describeList(list);
      if (parsed.flags.has(DRY_RUN)) return dryRunOutput("Delete List", account, [{ method: "DELETE", path: `/2/lists/${id}` }], RATES.listManage, recorded, { target: content });
      await gate("Delete List", account, { content }, RATES.listManage);
      const check = "Check with `x-axi lists`";
      const response = await send("DELETE", `/2/lists/${id}`, undefined, "list_delete", RATES.listManage, check);
      if ((response.body["data"] as Json | undefined)?.["deleted"] !== true) throw outcomeUnknown("X did not confirm the deletion", check);
      return { list: { id, status: "deleted" }, est_cost: money(RATES.listManage) };
    }
    if (sub === "add" || sub === "remove") {
      const parsed = parseArgs(rest, command, [], [DRY_RUN]);
      if (parsed.positional.length !== 2) throw usage(`\`${command}\` takes a List and a handle`, [HELP["list"] as string]);
      const id = parseListId(parsed.positional[0]);
      const handle = parseHandle(parsed.positional[1]);
      await requireScopes(SCOPES_FOR.listWrite, `\`${command}\``);
      const account = await refreshAccount();
      const list = await fetchList(id);
      if (!list) throw new AxiError(`List ${id} not found`, "NOT_FOUND");
      const target = await resolveUser(handle);
      const adding = sub === "add";
      const action = adding ? "Add member to List" : "Remove member from List";
      const content = `@${target.username} ${adding ? "to" : "from"} ${describeList(list)}`;
      const method = adding ? "POST" : "DELETE";
      const path = adding ? `/2/lists/${id}/members` : `/2/lists/${id}/members/${target.id}`;
      const body = adding ? { user_id: target.id } : undefined;
      if (parsed.flags.has(DRY_RUN)) return dryRunOutput(action, account, [{ method, path, ...(body ? { body } : {}) }], RATES.listManage, recorded, { target: content });
      await gate(action, account, { content }, RATES.listManage);
      const check = `Check with \`x-axi list members ${id}\``;
      const response = await send(method, path, body, adding ? "list_add" : "list_remove", RATES.listManage, check);
      if ((response.body["data"] as Json | undefined)?.["is_member"] !== adding) throw outcomeUnknown(`X did not confirm the ${adding ? "addition" : "removal"}`, check);
      return { list_member: { list: id, handle: `@${target.username}`, status: adding ? "member" : "not a member" }, est_cost: money(RATES.listManage) };
    }
    throw usage("expected `list view`, `list members`, `list create`, `list delete`, `list add`, or `list remove`", [HELP["list"] as string]);
  };

  const trends = async (args: string[]): Promise<Output> => {
    const parsed = parseArgs(args, "trends", ["--woeid", "--limit"]);
    if (parsed.positional.length) throw usage("`trends` takes no arguments; pass --woeid N for a place", [HELP["trends"] as string]);
    const rawWoeid = parsed.flags.get("--woeid");
    const woeid = rawWoeid === undefined ? undefined : Number(rawWoeid);
    if (woeid !== undefined && (!Number.isInteger(woeid) || woeid < 1 || woeid > 2_147_483_647)) throw usage("--woeid must be a positive integer, such as 1 for worldwide or 23424977 for the United States");
    if (woeid === undefined && parsed.flags.has("--limit")) throw usage("--limit applies only with --woeid; personalized trends come as X returns them");
    const limit = parseLimit(parsed, 20, 1, WOEID_TRENDS_MAX);
    const path = woeid === undefined
      ? "/2/users/personalized_trends?personalized_trend.fields=category,post_count,trend_name,trending_since"
      : `/2/trends/by/woeid/${woeid}?max_trends=${limit}&trend.fields=trend_name,tweet_count`;
    const { body } = await get(deps, path);
    const data = body["data"];
    // These responses have no meta to count with; a data array, or a body with neither data nor errors, is X's answer.
    if (!Array.isArray(data) && Array.isArray(body["errors"])) throw unreadable("trends", body);
    const rows: Output[] = ((Array.isArray(data) ? data : []) as Json[]).map((trend) =>
      woeid === undefined
        ? { name: String(trend["trend_name"] ?? ""), category: String(trend["category"] ?? ""), posts: String(trend["post_count"] ?? ""), since: String(trend["trending_since"] ?? "") }
        : { name: String(trend["trend_name"] ?? ""), posts: typeof trend["tweet_count"] === "number" ? trend["tweet_count"] : "unknown" },
    );
    const partial = Array.isArray(data) && Array.isArray(body["errors"]) ? (body["errors"] as Json[]).length : 0;
    return {
      ...(woeid === undefined ? { trends_for: "you (personalized)" } : { woeid }),
      ...(rows.length ? { count: rows.length, trends: rows } : { trends: "0 trends found" }),
      ...(partial ? { partial_errors: `${partial}: ${errorDetail(body)}` } : {}),
      ...charge("trends", RATES.trends),
      help: [rows.length ? "Run `x-axi search <trend name>` for recent posts on one; each result costs about $0.005" : "X billed this request although it returned no trends"],
    };
  };

  const commands: Record<string, (args: string[]) => Promise<Output> | Output> = {
    me: async (args) => {
      parseArgs(args, "me", []);
      const account = await refreshAccount();
      return { account: { id: account.id, handle: `@${account.username}` }, est_cost: money(recorded), help: ["Run `x-axi mentions` to see who mentioned you"] };
    },
    following: (args) => listUsers(args, "following"),
    followers: (args) => listUsers(args, "followers"),
    "follow-plan": followPlan,
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
      // public_metrics comes with tweet.fields and needs no other scope or read. The reference names reposts repost_count; X has also sent retweet_count.
      const returned = (name: string, field: string): Output => (typeof metrics[field] === "number" ? { [name]: metrics[field] } : {});
      return {
        post: {
          id,
          author: found.author,
          created_at: found.post["created_at"],
          text: truncate(fullText(found.post), parsed.flags.has("--full")),
          replies: metrics["reply_count"] ?? 0,
          likes: metrics["like_count"] ?? 0,
          reposts: metrics["repost_count"] ?? metrics["retweet_count"] ?? 0,
          ...returned("quotes", "quote_count"),
          ...returned("bookmarks", "bookmark_count"),
          ...returned("impressions", "impression_count"),
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
        const parsed = parseArgs(rest, "dm send", [], [DRY_RUN]);
        const handle = parseHandle(parsed.positional[0]);
        const text = parseOutgoingText(parsed.positional[1]);
        if (parsed.positional.length > 2) throw usage("quote the message text as one argument");
        const account = await refreshAccount();
        const target = await resolveUser(handle);
        if (parsed.flags.has(DRY_RUN)) {
          return dryRunOutput(`DM to @${target.username}`, account, [{ method: "POST", path: `/2/dm_conversations/with/${target.id}/messages`, body: { text } }], RATES.dmCreate, recorded, linuxDialogReport(approvalRequest(`DM to @${target.username}`, account, { text }, RATES.dmCreate), platform));
        }
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
      const parsed = parseArgs(args, "post", ["--quote", "--media", "--poll", "--poll-minutes"], [DRY_RUN]);
      const count = parsed.positional.length;
      if (count > 1 || (count === 0 && !parsed.flags.has("--media"))) throw usage("quote the post text as one argument", [HELP["post"] as string]);
      const text = count ? parseOutgoingText(parsed.positional[0]) : undefined;
      const quoteFlag = parsed.flags.get("--quote");
      const quote = quoteFlag === undefined ? undefined : parsePostId(String(quoteFlag));
      if (quote && text === undefined) throw usage("--quote needs text");
      const pollFlag = parsed.flags.get("--poll");
      if (pollFlag === undefined && parsed.flags.has("--poll-minutes")) throw usage("--poll-minutes needs --poll");
      if (pollFlag !== undefined && (parsed.flags.has("--media") || quote)) throw usage("--poll cannot be combined with --media or --quote; X attaches one kind of thing to a post");
      const poll: Poll | undefined = pollFlag === undefined ? undefined : { options: parsePollOptions(String(pollFlag)), duration_minutes: parsePollMinutes(parsed.flags.get("--poll-minutes")) };
      const media = await prepareMedia(parsed);
      const account = await refreshAccount();
      let context: string | undefined;
      if (quote) {
        const quoted = await fetchPost(quote);
        if (!quoted) throw new AxiError(`post ${quote} not found`, "NOT_FOUND");
        context = `Quoting @${quoted.author}: ${displayText(fullText(quoted.post))}`;
      }
      const draft = { ...(text !== undefined ? { text } : {}), ...(quote ? { quote } : {}), ...(media ? { media } : {}), ...(poll ? { poll } : {}), ...(context ? { context } : {}), dryRun: parsed.flags.has(DRY_RUN) };
      return createPost(draft, account, estimatePostCost(text ?? "", false));
    },
    reply: async (args) => {
      const parsed = parseArgs(args, "reply", ["--media"], [DRY_RUN]);
      const count = parsed.positional.length;
      if (count < 1 || count > 2 || (count === 1 && !parsed.flags.has("--media"))) throw usage("expected a post and one quoted text argument", [HELP["reply"] as string]);
      const id = parsePostId(parsed.positional[0]);
      const text = count === 2 ? parseOutgoingText(parsed.positional[1]) : undefined;
      const media = await prepareMedia(parsed);
      const account = await refreshAccount();
      const parent = await fetchPost(id);
      if (!parent) throw new AxiError(`post ${id} not found`, "NOT_FOUND");
      const usd = estimatePostCost(text ?? "", String(parent.post["author_id"]) !== account.id);
      const context = `Replying to @${parent.author}: ${displayText(fullText(parent.post))}`;
      return createPost({ ...(text !== undefined ? { text } : {}), replyTo: id, ...(media ? { media } : {}), context, dryRun: parsed.flags.has(DRY_RUN) }, account, usd);
    },
    thread: async (args) => {
      const parsed = parseArgs(args, "thread", [], [DRY_RUN]);
      if (parsed.positional.length < 2) throw usage("a thread needs at least two parts, each quoted as one argument", [HELP["thread"] as string]);
      const parts = parsed.positional.map((part) => parseOutgoingText(part));
      const costs = parts.map((part) => estimatePostCost(part, false));
      const total = costs.reduce((sum, usd) => sum + usd, 0);
      const content = [
        `All ${parts.length} parts are published, in this order, each replying to the one before:`,
        ...parts.flatMap((part, index) => [`Part ${index + 1} of ${parts.length} (${counted(Array.from(part).length, "character")}, ${money(costs[index] as number)}):`, part]),
      ].join("\n");
      // The dialog must fit on screen, so the whole thread answers to the same limits as one text.
      parseOutgoingText(content);
      const action = `Thread of ${parts.length} posts`;
      const account = await refreshAccount();
      if (parsed.flags.has(DRY_RUN)) {
        const wouldSend = parts.map((text, index) => ({
          method: "POST",
          path: "/2/tweets",
          body: { text, ...(index ? { reply: { in_reply_to_tweet_id: `<id of part ${index}>` } } : {}) },
        }));
        return dryRunOutput(action, account, wouldSend, total, recorded, linuxDialogReport(approvalRequest(action, account, { text: content }, total), platform));
      }
      // As text, not content: a dialog may clip content, but every part of a thread is published, so it must show whole or be refused.
      await gate(action, account, { text: content }, total);
      const check = "Check with `x-axi timeline`";
      const posted: Output[] = [];
      let billed = 0;
      let previous: string | undefined;
      for (const [index, text] of parts.entries()) {
        const usd = costs[index] as number;
        const body = { text, ...(previous ? { reply: { in_reply_to_tweet_id: previous } } : {}) };
        let failure: AxiError;
        try {
          const response = await send("POST", "/2/tweets", body, "thread", usd, check);
          const id = (response.body["data"] as Json | undefined)?.["id"];
          if (id) {
            billed += usd;
            previous = String(id);
            posted.push({ part: index + 1, id: previous, url: `https://x.com/${account.username}/status/${previous}` });
            continue;
          }
          failure = outcomeUnknown("X accepted the request but returned no post ID", check);
        } catch (error) {
          if (!(error instanceof AxiError)) throw error;
          failure = error;
        }
        // Nothing is public yet, so this is an ordinary failed post, with its usual code and exit status.
        if (!posted.length) throw failure;
        const unknown = failure.code === "OUTCOME_UNKNOWN";
        if (unknown) billed += usd;
        return {
          thread: { posted, total: parts.length, status: "stopped early" },
          stopped: { part: index + 1, outcome: unknown ? "unknown, it may have been posted" : "not posted", code: failure.code, reason: failure.message, not_attempted: parts.length - index - 1 },
          est_cost: money(billed),
          help: [...failure.suggestions, "Do not rerun the whole thread, because the posted parts are public; to continue, reply to the last posted ID"],
        };
      }
      return { thread: { posted, total: parts.length, status: "published" }, est_cost: money(billed) };
    },
    repost: (args) => setRepost(args, true),
    unrepost: (args) => setRepost(args, false),
    bookmarks: async (args) => {
      const parsed = parseArgs(args, "bookmarks", flagsForList, ["--full"]);
      if (parsed.positional.length) throw usage("`bookmarks` takes no arguments");
      const limit = parseLimit(parsed, 20, 1, 100);
      await requireScopes(SCOPES_FOR.bookmarks, "`bookmarks`");
      const account = await me();
      const q = pagedQuery(limit, parsed.flags.get("--next"));
      const out = await postPage(`/2/users/${account.id}/bookmarks?${q}&${POST_FIELDS}`, RATES.ownedRead, "bookmarks", "0 bookmarks found", parsed.flags.has("--full"));
      return { account: `@${account.username}`, ...out, help: [...nextHelp(`x-axi bookmarks --limit ${limit}`, out["next_token"]), "Run `x-axi unbookmark <post>` to remove one, after approval"] };
    },
    bookmark: (args) => setBookmark(args, true),
    unbookmark: (args) => setBookmark(args, false),
    likes: async (args) => {
      const parsed = parseArgs(args, "likes", flagsForList, ["--full"]);
      const positional = onePositional(parsed, "likes");
      const handle = positional === undefined ? undefined : parseHandle(positional);
      const limit = parseLimit(parsed, 20, 5, 100);
      await requireScopes(SCOPES_FOR.likes, "`likes`");
      const target = await whose(handle);
      const q = pagedQuery(limit, parsed.flags.get("--next"));
      const out = await postPage(`/2/users/${target.id}/liked_tweets?${q}&${POST_FIELDS}`, target.own ? RATES.ownedRead : RATES.likeRead, "likes", `0 liked posts found for @${target.username}`, parsed.flags.has("--full"));
      return { target: `@${target.username}`, ...out, help: [...nextHelp(`x-axi likes${handle ? ` ${handle}` : ""} --limit ${limit}`, out["next_token"]), "Run `x-axi view <post>` for one post's metrics"] };
    },
    lists: async (args) => {
      const parsed = parseArgs(args, "lists", flagsForList);
      const positional = onePositional(parsed, "lists");
      const handle = positional === undefined ? undefined : parseHandle(positional);
      const limit = parseLimit(parsed, 20, 1, LIST_PAGE_MAX);
      await requireScopes(SCOPES_FOR.listRead, "`lists`");
      const target = await whose(handle);
      const { body } = await get(deps, `/2/users/${target.id}/owned_lists?${pagedQuery(limit, parsed.flags.get("--next"))}&list.fields=member_count,private`);
      const rows = ((body["data"] as Json[] | undefined) ?? []).map((list) => ({
        id: String(list["id"]),
        name: String(list["name"] ?? ""),
        members: typeof list["member_count"] === "number" ? list["member_count"] : "unknown",
        private: list["private"] === true,
      }));
      const out = listOutput("lists", rows, body, `0 Lists owned by @${target.username}`, charge("lists", rows.length * (target.own ? RATES.ownedRead : RATES.listRead)));
      return {
        target: `@${target.username}`,
        ...out,
        help: [...nextHelp(`x-axi lists${handle ? ` ${handle}` : ""} --limit ${limit}`, out["next_token"]), rows.length ? "Run `x-axi list view <id>` for a List's posts, or `x-axi list members <id>`" : "Run `x-axi list create <name>` to make one, after approval"],
      };
    },
    list: listCommand,
    mutes: (args) => ownUsers(args, "mutes", "muting", RATES.muteRead, SCOPES_FOR.mutes),
    mute: (args) => setMute(args, true),
    unmute: (args) => setMute(args, false),
    blocks: (args) => ownUsers(args, "blocks", "blocking", RATES.blockRead, SCOPES_FOR.blocks),
    trends,
    delete: async (args) => {
      const parsed = parseArgs(args, "delete", [], [DRY_RUN]);
      const id = parsePostId(onePositional(parsed, "delete"));
      const account = await refreshAccount();
      const found = await fetchPost(id);
      if (!found) return { post: { id, status: "already gone (no-op)" } };
      if (parsed.flags.has(DRY_RUN)) {
        return dryRunOutput("Delete post", account, [{ method: "DELETE", path: `/2/tweets/${id}` }], RATES.interactionDelete, recorded, { target: displayText(fullText(found.post)) });
      }
      await gate("Delete post", account, { content: displayText(fullText(found.post)) }, RATES.interactionDelete);
      const check = `Check with \`x-axi view ${id}\``;
      const response = await send("DELETE", `/2/tweets/${id}`, undefined, "delete", RATES.interactionDelete, check);
      if ((response.body["data"] as Json | undefined)?.["deleted"] !== true) {
        throw outcomeUnknown("X did not confirm the deletion", check);
      }
      return { post: { id, status: "deleted" }, est_cost: money(RATES.interactionDelete) };
    },
    follow: async (args) => {
      const parsed = parseArgs(args, "follow", [], [DRY_RUN]);
      const handle = parseHandle(onePositional(parsed, "follow"));
      const account = await refreshAccount();
      assertFollowLogReadable();
      const target = await resolveUser(handle);
      if (parsed.flags.has(DRY_RUN)) {
        return dryRunOutput("Follow", account, [{ method: "POST", path: `/2/users/${account.id}/following`, body: { target_user_id: target.id } }], RATES.userInteraction, recorded, { target: `@${target.username}` });
      }
      await gate("Follow", account, { content: `@${target.username}` }, RATES.userInteraction);
      const data = await sendFollow(account, target);
      persistFollowLog(() => logFollow(account.id, target.id));
      return { follow: { handle: `@${target.username}`, status: data["pending_follow"] === true ? "requested" : "following" }, est_cost: money(RATES.userInteraction) };
    },
    unfollow: async (args) => {
      const parsed = parseArgs(args, "unfollow", [], [DRY_RUN]);
      const handle = parseHandle(onePositional(parsed, "unfollow"));
      const account = await refreshAccount();
      assertFollowLogReadable();
      const target = await resolveUser(handle);
      if (parsed.flags.has(DRY_RUN)) {
        return dryRunOutput("Unfollow", account, [{ method: "DELETE", path: `/2/users/${account.id}/following/${target.id}` }], RATES.interactionDelete, recorded, { target: `@${target.username}` });
      }
      await gate("Unfollow", account, { content: `@${target.username}` }, RATES.interactionDelete);
      const check = checkProfile(target.username);
      const response = await send("DELETE", `/2/users/${account.id}/following/${target.id}`, undefined, "unfollow", RATES.interactionDelete, check);
      if ((response.body["data"] as Json | undefined)?.["following"] !== false) throw outcomeUnknown("X did not confirm the unfollow", check);
      persistFollowLog(() => logUnfollow(account.id, target.id));
      return { unfollow: { handle: `@${target.username}`, status: "not following" }, est_cost: money(RATES.interactionDelete) };
    },
    "follow-file": async (args) => {
      const parsed = parseArgs(args, "follow-file", ["--max"], [DRY_RUN]);
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
      const provenance = `Usernames come from ${shortenPath(displayText(file))} and were not verified with X.`;
      const action = `Follow ${counted(batch.length, "account")} over about ${counted(Math.ceil((batch.length * FOLLOW_INTERVAL_MS) / 60_000), "minute")}`;
      if (parsed.flags.has(DRY_RUN)) {
        return dryRunOutput(action, account, [{ method: "POST", path: `/2/users/${account.id}/following`, body: "one request per account in batch, as {target_user_id}" }], usd, recorded, { batch, remaining_after: remaining.length - batch.length, provenance });
      }
      await gate(action, account, { content: `${names}${more}\n\n${provenance}` }, usd);
      let followed = 0;
      let requested = 0;
      let stopped: Output | undefined;
      let stoppedHelp: string[] = [];
      for (const [index, user] of batch.entries()) {
        if (index > 0) await pause(FOLLOW_INTERVAL_MS);
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
    update: (args) => {
      parseArgs(args, "update", []);
      return {
        update: {
          installed: VERSION,
          from_npm: `npm install -g ${NPM_PACKAGE}@latest`,
          from_source: "git pull && pnpm install --frozen-lockfile && pnpm run build",
        },
        help: ["x-axi installs nothing itself; run the line for how you installed it, in your own terminal", "Run `x-axi --version` afterwards to confirm"],
      };
    },
    setup: async (args) => {
      parseArgs(args, "setup", []);
      const config = readConfig();
      const redirectUri = config.redirect_uri ?? DEFAULT_REDIRECT_URI;
      const status = await deps.auth.status();
      const account = readAccount();
      return {
        account: account ? `@${account.username}` : "not connected",
        login: status.logged_in ? "stored" : status.problem ? "unknown, see storage_problem" : "none",
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
      const previous = readAccount();
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
        if (status.revokeReplaced) warnings.add(EARLIER_TOKENS_LIVE);
        const known = error instanceof AxiError;
        throw new AxiError(
          `signed in and stored the login, but could not read the account: ${known ? error.message : String(error)}`,
          known ? error.code : "X_UNAVAILABLE",
          [...(known ? error.suggestions : []), "The login is stored; run `x-axi me` once the cause above is fixed"],
        );
      }
      let earlierLogin: string | undefined;
      if (status.revokeReplaced) {
        if (previous?.id && previous.id !== account.id) {
          const { revoke_failed: failed } = await status.revokeReplaced();
          const failures = Object.entries(failed).map(([kind, reason]) => `${kind}: ${reason}`);
          earlierLogin = failures.length
            ? `could not revoke every token of @${previous.username} at X (${failures.join("; ")}); revoke the app at https://x.com/settings/connected_apps while signed in to that account`
            : `revoked the tokens of @${previous.username} at X`;
        } else {
          earlierLogin = EARLIER_TOKENS_LIVE;
        }
      }
      return {
        login: { account: `@${account.username}`, scopes: status.scopes, access_token_expires_at: status.access_token_expires_at, storage: status.storage },
        ...(earlierLogin ? { earlier_login: earlierLogin } : {}),
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
