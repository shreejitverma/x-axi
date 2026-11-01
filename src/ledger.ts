import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface LedgerEntry {
  at: string;
  op: string;
  usd: number | null;
}

export interface Account {
  id: string;
  username: string;
}

export function stateDir(): string {
  return process.env["X_AXI_STATE_DIR"] ?? join(homedir(), ".local", "state", "x-axi");
}

function ensureDir(): string {
  const dir = stateDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** Returns a warning instead of throwing: a ledger problem must never hide that a write succeeded. */
export function recordSpend(op: string, usd: number | null, now = new Date()): string | undefined {
  try {
    const entry: LedgerEntry = { at: now.toISOString(), op, usd };
    appendFileSync(join(ensureDir(), "ledger.jsonl"), `${JSON.stringify(entry)}\n`);
    return undefined;
  } catch (error) {
    return `spend ledger not updated: ${String(error)}`;
  }
}

export interface SpendSummary {
  today_usd: string;
  last_30d_usd: string;
  calls_30d: number;
  unpriced_calls_30d: number;
  corrupt_lines: number;
}

export function summarizeSpend(now = new Date()): SpendSummary {
  let raw = "";
  try {
    raw = readFileSync(join(stateDir(), "ledger.jsonl"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const day = now.toISOString().slice(0, 10);
  const cutoff = now.getTime() - 30 * 24 * 3600 * 1000;
  let today = 0;
  let month = 0;
  let calls = 0;
  let unpriced = 0;
  let corrupt = 0;
  for (const line of raw.split("\n")) {
    if (!line) continue;
    let entry: LedgerEntry;
    try {
      entry = JSON.parse(line) as LedgerEntry;
    } catch {
      corrupt += 1;
      continue;
    }
    if (new Date(entry.at).getTime() < cutoff) continue;
    calls += 1;
    if (entry.usd === null) unpriced += 1;
    month += entry.usd ?? 0;
    if (entry.at.startsWith(day)) today += entry.usd ?? 0;
  }
  return {
    today_usd: today.toFixed(3),
    last_30d_usd: month.toFixed(3),
    calls_30d: calls,
    unpriced_calls_30d: unpriced,
    corrupt_lines: corrupt,
  };
}

export function readAccount(): Account | undefined {
  try {
    return JSON.parse(readFileSync(join(stateDir(), "account.json"), "utf8")) as Account;
  } catch {
    return undefined;
  }
}

export function writeAccount(account: Account): void {
  migrateFollowLog(readAccount() ?? account);
  writeFileSync(join(ensureDir(), "account.json"), JSON.stringify(account), { mode: 0o600 });
}

export const DAY_MS = 24 * 3600 * 1000;

/** What one X account did through this tool. */
export interface FollowRecord {
  /** Accounts currently followed, by user ID. This is the resume state, so an unfollow removes the entry. */
  following: Record<string, string>;
  /** The time of every follow in the last 24 hours. This is the rate history, so an unfollow keeps it. */
  events: string[];
}

interface FollowFile {
  version: 2;
  accounts: Record<string, FollowRecord>;
}

/**
 * Version 1 was a flat map of user ID to time, with no owner. Only account.json
 * can name that owner, so this must run before account.json is overwritten.
 * A missing or corrupt file is left for readFollows to handle.
 */
function migrateFollowLog(owner: Account): void {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(join(stateDir(), "follows.json"), "utf8"));
  } catch {
    return;
  }
  if (!value || typeof value !== "object" || Array.isArray(value) || "version" in value) return;
  const following = value as Record<string, string>;
  saveFollowFile({ version: 2, accounts: { [owner.id]: { following, events: Object.values(following) } } });
}

function loadFollowFile(): FollowFile {
  let raw: string;
  try {
    raw = readFileSync(join(stateDir(), "follows.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 2, accounts: {} };
    throw error;
  }
  // A corrupt log must stop a batch, or the daily cap would silently reset.
  const file = JSON.parse(raw) as FollowFile | null;
  if (file?.version !== 2 || !file.accounts) throw new Error("follows.json is not a version 2 follow log");
  return file;
}

function saveFollowFile(file: FollowFile): void {
  const dir = ensureDir();
  const temp = join(dir, "follows.json.tmp");
  writeFileSync(temp, JSON.stringify(file), { mode: 0o600 });
  renameSync(temp, join(dir, "follows.json"));
}

export function readFollows(accountId: string): FollowRecord {
  return loadFollowFile().accounts[accountId] ?? { following: {}, events: [] };
}

/** Throws if a later log update would fail on the current file, so a problem can stop a write before it is sent. */
export function assertFollowLogReadable(): void {
  loadFollowFile();
}

export function logFollow(accountId: string, targetId: string, now = new Date()): void {
  const file = loadFollowFile();
  const record = file.accounts[accountId] ?? { following: {}, events: [] };
  const at = now.toISOString();
  record.following[targetId] = at;
  record.events = [...record.events.filter((event) => now.getTime() - new Date(event).getTime() < DAY_MS), at];
  file.accounts[accountId] = record;
  saveFollowFile(file);
}

export function logUnfollow(accountId: string, targetId: string): void {
  const file = loadFollowFile();
  const record = file.accounts[accountId];
  if (!record) return;
  delete record.following[targetId];
  saveFollowFile(file);
}
