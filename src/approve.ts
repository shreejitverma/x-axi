import { execFile, spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";

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
const MAX_TIMEOUT_SECONDS = 3600;
const DIALOG_TITLE = "x-axi: approve this action";
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

export function formatApproval(request: ApprovalRequest): string {
  const cost = request.estCostUsd === null ? "unknown" : `about $${request.estCostUsd.toFixed(3)}`;
  // The tool writes the counts, so outgoing text cannot pass part of itself off as not sent.
  const body = "text" in request
    ? [`Text to send, all of it (${counted(Array.from(request.text).length, "character")}, ${counted(request.text.split("\n").length, "line")}):`, request.text]
    : [request.content];
  // The body comes first and context last, flattened, so text from X cannot pose as it.
  const lines = [`${request.action} as @${request.account} (${cost})`, "", ...body];
  if (request.context) lines.push("", "----- context from X, not sent -----", request.context);
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
  return requested > 0 && requested <= MAX_TIMEOUT_SECONDS ? Math.ceil(requested) : DEFAULT_TIMEOUT_SECONDS;
}

// GTK dialogs do not scroll on every zenity version, so an oversized one can push text and buttons off the screen.
// kdialog elides any word too wide for the screen, which would hide part of the text while still offering Approve.
// These limits are conservative estimates for a 1024x768 screen, not measurements of a real window.
const WRAP_CELLS = 50;
const MAX_WRAPPED_LINES = 25;
const MAX_UNBROKEN_CELLS = 60;
const BREAKS_ANYWHERE = String.raw`\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Hangul}`;
const WIDE = new RegExp(`[${BREAKS_ANYWHERE}\\p{Extended_Pictographic}]`, "u");
const WRAP_UNITS = new RegExp(`[${BREAKS_ANYWHERE}]|[^\\s${BREAKS_ANYWHERE}]+|\\s+`, "gu");

const cellsOf = (text: string): number => Array.from(text).reduce((sum, ch) => sum + (WIDE.test(ch) ? 2 : 1), 0);

/** Whether a dialog that may not scroll can show all of this text, by greedy line wrapping. */
export function fitsInDialog(text: string): boolean {
  let lines = 0;
  for (const line of text.split("\n")) {
    lines += 1;
    let used = 0;
    for (const unit of line.match(WRAP_UNITS) ?? []) {
      const blank = !unit.trim();
      const cells = cellsOf(unit);
      if (!blank && cells > MAX_UNBROKEN_CELLS) return false;
      if (used > 0 && used + cells > WRAP_CELLS) {
        lines += 1;
        used = 0;
        if (blank) continue; // Whitespace at a wrap point takes no room.
      }
      used += cells;
    }
  }
  return lines <= MAX_WRAPPED_LINES;
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

function linuxResult(tool: LinuxTool, code: number | null): ApprovalResult {
  if (code === 0) return "approved";
  if (code === 1) return "cancelled";
  if (tool === "zenity" && code === 5) return "timed_out";
  return "unavailable"; // A crash, a signal, or a display that could not be opened.
}

function askLinux(tool: LinuxTool, path: string, text: string, env: NodeJS.ProcessEnv): Promise<ApprovalResult> {
  if (!fitsInDialog(text)) return Promise.resolve("too_long");
  const timeout = approvalTimeoutSeconds(env);
  return new Promise((resolve) => {
    let child;
    try {
      // No shell and no stdio: the answer is the exit code, and nothing can type into the tool.
      child = spawn(path, linuxDialogArgs(tool, text, timeout), { stdio: "ignore", env: dialogEnvironment(env) });
    } catch {
      resolve("unavailable"); // For example, a NUL in the text.
      return;
    }
    // kdialog has no timeout of its own. The kill also covers a zenity that hangs or ignores its --timeout.
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve("timed_out");
    }, timeout * 1000);
    child.once("error", () => {
      clearTimeout(timer);
      resolve("unavailable");
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(linuxResult(tool, code));
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
    const text = formatApproval(request);
    if (backend.kind === "osascript") return askMac(backend.path, text, machine.env);
    return askLinux(backend.kind, backend.path, text, machine.env);
  };
}

export const approveWithDialog: Approver = createApprover({
  platform: process.platform,
  env: process.env,
  isExecutable: isExecutableFile,
});
