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
  writeFileSync(join(ensureDir(), "account.json"), JSON.stringify(account), { mode: 0o600 });
}

/** Accounts followed through this tool, by user ID, with the time of each follow. */
export type FollowLog = Record<string, string>;

export function readFollowLog(): FollowLog {
  try {
    return JSON.parse(readFileSync(join(stateDir(), "follows.json"), "utf8")) as FollowLog;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error; // A corrupt log must stop a batch, or the daily cap would silently reset.
  }
}

export function writeFollowLog(log: FollowLog): void {
  const dir = ensureDir();
  const temp = join(dir, "follows.json.tmp");
  writeFileSync(temp, JSON.stringify(log), { mode: 0o600 });
  renameSync(temp, join(dir, "follows.json"));
}
