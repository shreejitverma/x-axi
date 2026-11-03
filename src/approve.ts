import { execFile, spawn, type ChildProcessByStdio } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import type { Readable } from "node:stream";

/** `text` is exactly what X will publish or deliver. `content` describes the target of any other write. */
export type ApprovalBody = { text: string } | { content: string };

export type ApprovalRequest = ApprovalBody & {
  action: string;
  account: string;
  context?: string;
  estCostUsd: number | null;
};

export type NoBackendReason = "no_graphical_session" | "no_dialog_tool" | "unsupported_platform";

export type ApprovalResult = "approved" | "cancelled" | "timed_out" | "unavailable" | "too_long" | NoBackendReason;

export type Approver = (request: ApprovalRequest) => Promise<ApprovalResult>;

type LinuxTool = "zenity" | "kdialog";

export type DialogBackend = { kind: "osascript" | LinuxTool; path: string };

export type Machine = {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  isExecutable: (path: string) => boolean;
  /** SYSTEM_DIRECTORIES outside tests. Nothing read from the environment can change it. */
  directories?: readonly string[];
};

const DEFAULT_TIMEOUT_SECONDS = 120;
// setTimeout fires at once for a delay over 2^31 - 1 milliseconds.
const MAX_TIMEOUT_SECONDS = 2_147_483;
const DIALOG_TITLE = "x-axi: approve this action";
// Room for a whole 280 character post after its "Replying to @handle: " prefix.
const MAX_UNWRAPPED_CONTEXT = 320;
export const SYSTEM_DIRECTORIES = ["/usr/bin", "/bin", "/usr/local/bin"] as const;
// zenity comes first because it can make Cancel the default button and kdialog cannot.
const LINUX_TOOLS: readonly LinuxTool[] = ["zenity", "kdialog"];

// Arguments reach AppleScript through argv, so post text can never be parsed as script.
const SCRIPT = `on run argv
  set answer to display dialog (item 1 of argv) with title "${DIALOG_TITLE}" buttons {"Cancel", "Approve"} default button "Cancel" cancel button "Cancel" with icon caution giving up after ((item 2 of argv) as integer)
  if gave up of answer then return "timed_out"
  return button returned of answer
end run`;

export function counted(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function approvalHead(request: ApprovalRequest): string {
  const cost = request.estCostUsd === null ? "unknown" : `about $${request.estCostUsd.toFixed(3)}`;
  return `${request.action} as @${request.account} (${cost})`;
}

// The tool writes the counts, so outgoing text cannot pass part of itself off as not sent.
function textLabel(text: string): string {
  return `Text to send, all of it (${counted(Array.from(text).length, "character")}, ${counted(text.split("\n").length, "line")}):`;
}

const CONTEXT_RULE = "----- context from X, not sent -----";

const cutMarker = (text: string): string => `[cut to fit: ${counted(Array.from(text).length, "character")} in full]`;

/** The text for a dialog that has no line budget: macOS. */
export function formatApproval(request: ApprovalRequest): string {
  const body = "text" in request ? [textLabel(request.text), request.text] : [request.content];
  // The body comes first and context last, flattened, so text from X cannot pose as it.
  const lines = [approvalHead(request), "", ...body];
  if (request.context) {
    const characters = Array.from(request.context);
    const shown = characters.length <= MAX_UNWRAPPED_CONTEXT ? request.context : `${characters.slice(0, MAX_UNWRAPPED_CONTEXT).join("")}\n${cutMarker(request.context)}`;
    lines.push("", CONTEXT_RULE, shown);
  }
  return lines.join("\n");
}

/**
 * Picks the dialog for this machine. Linux tools are looked up only in fixed
 * system directories, never on PATH, so a PATH entry cannot answer the dialog.
 */
export function selectBackend(machine: Machine): DialogBackend | { kind: "none"; reason: NoBackendReason } {
  if (machine.platform === "darwin") return { kind: "osascript", path: "/usr/bin/osascript" };
  if (machine.platform !== "linux") return { kind: "none", reason: "unsupported_platform" };
  if (!machine.env["DISPLAY"] && !machine.env["WAYLAND_DISPLAY"]) return { kind: "none", reason: "no_graphical_session" };
  for (const kind of LINUX_TOOLS) {
    for (const directory of machine.directories ?? SYSTEM_DIRECTORIES) {
      const path = `${directory}/${kind}`;
      if (machine.isExecutable(path)) return { kind, path };
    }
  }
  return { kind: "none", reason: "no_dialog_tool" };
}

export function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function approvalTimeoutSeconds(env: NodeJS.ProcessEnv): number {
  const requested = Number(env["X_AXI_APPROVAL_TIMEOUT"]);
  return Number.isFinite(requested) && requested > 0 ? Math.min(Math.ceil(requested), MAX_TIMEOUT_SECONDS) : DEFAULT_TIMEOUT_SECONDS;
}

// GTK dialogs do not scroll on every zenity version, so an oversized one can push text and buttons off the screen.
// kdialog elides any word too wide for the screen, which would hide part of the text while still offering Approve.
// These limits are conservative estimates for a 1024x768 screen, not measurements of a real window.
const WRAP_CELLS = 50;
const MAX_WRAPPED_LINES = 25;
// Held back from the text whether or not this action has context, so context can never decide a refusal:
// one blank line, the context rule, and the context's cut marker.
const CONTEXT_RESERVE_LINES = 3;
const CONTINUES = "\u21b5";
const BREAKS_ANYWHERE = String.raw`\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Hangul}`;
const WIDE = new RegExp(`[${BREAKS_ANYWHERE}\\p{Extended_Pictographic}]`, "u");
const WRAP_UNITS = new RegExp(`[${BREAKS_ANYWHERE}]|[^\\s${BREAKS_ANYWHERE}]+|\\s+`, "gu");
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

const cellsOf = (text: string): number => Array.from(text).reduce((sum, ch) => sum + (WIDE.test(ch) ? 2 : 1), 0);

/** Splits a run too wide for one row, leaving each piece room for the continuation mark. */
function splitRun(run: string): string[] {
  const pieces: string[] = [];
  let piece = "";
  let used = 0;
  for (const { segment } of GRAPHEMES.segment(run)) {
    const cells = cellsOf(segment);
    if (used > 0 && used + cells > WRAP_CELLS - 1) {
      pieces.push(piece);
      piece = "";
      used = 0;
    }
    piece += segment;
    used += cells;
  }
  pieces.push(piece);
  return pieces;
}

/**
 * Greedy line wrapping. Each row keeps what ends it, so joining the rows gives the text back,
 * changed only by the marked breaks inside runs too wide for a row.
 */
function wrapRows(text: string): { rows: string[]; breaks: number } {
  const rows: string[] = [];
  let breaks = 0;
  for (const line of text.split("\n")) {
    let row = "";
    let used = 0;
    for (const unit of line.match(WRAP_UNITS) ?? []) {
      const blank = !unit.trim();
      const cells = cellsOf(unit);
      if (used > 0 && used + cells > WRAP_CELLS) {
        rows.push(blank ? row + unit : row); // Whitespace at a wrap point takes no room.
        row = "";
        used = 0;
        if (blank) continue;
      }
      if (!blank && cells > WRAP_CELLS) {
        const pieces = splitRun(unit);
        row = pieces.pop()!;
        used = cellsOf(row);
        rows.push(...pieces.map((piece) => `${piece}${CONTINUES}\n`));
        breaks += pieces.length;
      } else {
        row += unit;
        used += cells;
      }
    }
    rows.push(`${row}\n`);
  }
  return { rows, breaks };
}

const joinRows = (rows: string[]): string => rows.join("").slice(0, -1);

const rowCount = (text: string): number => wrapRows(text).rows.length;

/** Text the user cannot change gets whatever rows remain, and is cut with a marker instead of ever causing a refusal. */
function clipToRows(text: string, maxRows: number): string {
  const { rows } = wrapRows(text);
  if (rows.length <= maxRows) return joinRows(rows);
  const kept = rows.slice(0, maxRows - 1).join("").trimEnd();
  return kept ? `${kept}\n${cutMarker(text)}` : cutMarker(text);
}

/**
 * The text for a dialog that may not scroll, or null if the outgoing text cannot fit in it.
 * Outgoing text must be shown in full to be approved, so it is the only thing that can cause a refusal.
 */
export function linuxApprovalText(request: ApprovalRequest): string | null {
  const head = wrapRows(approvalHead(request));
  const opening = [joinRows(head.rows), ""];
  const marksNote = (breaks: number): string[] => (breaks ? [`This dialog splits long words at ${counted(breaks, "mark")} (${CONTINUES}), which are not sent.`] : []);
  const roomForBody = MAX_WRAPPED_LINES - CONTEXT_RESERVE_LINES;
  let shown: string;
  if ("text" in request) {
    const { rows, breaks } = wrapRows(request.text);
    shown = [...opening, textLabel(request.text), ...marksNote(head.breaks + breaks), joinRows(rows)].join("\n");
    if (rowCount(shown) > roomForBody) return null;
  } else {
    const intro = [...opening, ...marksNote(head.breaks)].join("\n");
    shown = [intro, clipToRows(request.content, roomForBody - rowCount(intro))].join("\n");
  }
  if (!request.context) return shown;
  return [shown, "", CONTEXT_RULE, clipToRows(request.context, MAX_WRAPPED_LINES - rowCount(shown) - 2)].join("\n");
}

const KDIALOG_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "\\": "&#92;", "\n": "<br>" };

/**
 * kdialog has no plain text option: Qt guesses whether a label is rich text, and
 * kdialog also expands backslash escapes. Always sending escaped rich text removes
 * the guess, and a backslash entity never reaches the escape parser.
 */
export function kdialogText(text: string): string {
  const escaped = text.replace(/[&<>"\\\n]/g, (ch) => KDIALOG_ESCAPES[ch]!);
  return `<qt><div style="white-space: pre-wrap">${escaped}</div></qt>`;
}

function linuxDialogArgs(kind: LinuxTool, text: string, timeout: number): string[] {
  if (kind === "zenity") {
    // The --name=value form keeps text that starts with a dash from being read as a flag.
    // With --no-markup, zenity neither parses Pango markup nor expands backslash escapes.
    return [
      "--question",
      "--no-markup",
      "--default-cancel",
      `--title=${DIALOG_TITLE}`,
      "--ok-label=Approve",
      "--cancel-label=Cancel",
      `--timeout=${timeout}`,
      `--text=${text}`,
    ];
  }
  // kdialog has no flag for a timeout or for the default button.
  return ["--title", DIALOG_TITLE, "--yes-label", "Approve", "--no-label", "Cancel", "--warningyesno", kdialogText(text)];
}

// A dialog tool reads the environment too. zenity takes its exit codes from ZENITY_OK, ZENITY_CANCEL, and the like,
// so ZENITY_CANCEL=0 would turn Cancel into approval, and LD_PRELOAD or GTK_MODULES would load code into it.
const DIALOG_ENV = [
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XAUTHORITY",
  "XDG_RUNTIME_DIR",
  "XDG_SESSION_TYPE",
  "XDG_CURRENT_DESKTOP",
  "DBUS_SESSION_BUS_ADDRESS",
  "HOME",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "LC_MESSAGES",
];

function dialogEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const kept: NodeJS.ProcessEnv = { PATH: SYSTEM_DIRECTORIES.join(":") };
  for (const name of DIALOG_ENV) {
    const value = env[name];
    if (value !== undefined) kept[name] = value;
  }
  return kept;
}

// GTK exits 1 when it cannot open the display, the same code as the Cancel button. GTK 3 and 4 do not translate these.
const GTK_DISPLAY_FAILURE = /cannot open display|failed to open display/i;
const MAX_STDERR_CHARS = 64 * 1024;

function linuxResult(tool: LinuxTool, code: number | null, stderr: string): ApprovalResult {
  if (code === 0) return "approved";
  if (tool === "zenity" && code === 1 && GTK_DISPLAY_FAILURE.test(stderr)) return "unavailable";
  if (code === 1) return "cancelled";
  if (tool === "zenity" && code === 5) return "timed_out";
  return "unavailable"; // A crash, a signal, or any other failure.
}

function askLinux(tool: LinuxTool, path: string, text: string, env: NodeJS.ProcessEnv): Promise<ApprovalResult> {
  const timeout = approvalTimeoutSeconds(env);
  return new Promise((resolve) => {
    let child: ChildProcessByStdio<null, null, Readable>;
    try {
      // No shell and no stdin: the answer is the exit code, and nothing can type into the tool.
      child = spawn(path, linuxDialogArgs(tool, text, timeout), { stdio: ["ignore", "ignore", "pipe"], env: dialogEnvironment(env) });
    } catch {
      resolve("unavailable"); // For example, a NUL in the text.
      return;
    }
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < MAX_STDERR_CHARS) stderr += chunk;
    });
    // kdialog has no timeout of its own. The kill also covers a zenity that hangs or ignores its --timeout.
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve("timed_out");
    }, timeout * 1000);
    child.once("error", () => {
      clearTimeout(timer);
      resolve("unavailable");
    });
    // "close" rather than "exit", so all of stderr has arrived before the exit code is read.
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve(linuxResult(tool, code, stderr));
    });
  });
}

function askMac(path: string, text: string, env: NodeJS.ProcessEnv): Promise<ApprovalResult> {
  return new Promise((resolve) => {
    execFile(
      path, // Absolute, so a PATH entry cannot answer the dialog.
      ["-e", SCRIPT, text, String(approvalTimeoutSeconds(env))],
      (error, stdout, stderr) => {
        if (!error) {
          const answer = stdout.trim();
          if (answer === "Approve") resolve("approved");
          else if (answer === "timed_out") resolve("timed_out");
          else resolve("cancelled");
          return;
        }
        // AppleScript reports the Cancel button as user-canceled error -128.
        resolve(stderr.includes("-128") ? "cancelled" : "unavailable");
      },
    );
  });
}

/**
 * The human gate for every write. It runs in the tool rather than in a harness
 * hook so it holds under every agent harness and permission mode, and it fails
 * closed: anything other than an explicit click on Approve stops the write.
 * There is deliberately no terminal prompt or override, because an agent could answer those.
 */
export function createApprover(machine: Machine): Approver {
  return (request) => {
    const backend = selectBackend(machine);
    if (backend.kind === "none") return Promise.resolve(backend.reason);
    if (backend.kind === "osascript") return askMac(backend.path, formatApproval(request), machine.env);
    const text = linuxApprovalText(request);
    if (text === null) return Promise.resolve("too_long");
    return askLinux(backend.kind, backend.path, text, machine.env);
  };
}

export const approveWithDialog: Approver = createApprover({
  platform: process.platform,
  env: process.env,
  isExecutable: isExecutableFile,
});
