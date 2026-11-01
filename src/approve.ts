import { execFile } from "node:child_process";

/** `text` is exactly what X will publish or deliver. `content` describes the target of any other write. */
export type ApprovalBody = { text: string } | { content: string };

export type ApprovalRequest = ApprovalBody & {
  action: string;
  account: string;
  context?: string;
  estCostUsd: number | null;
};

export type ApprovalResult = "approved" | "cancelled" | "timed_out" | "unavailable";

export type Approver = (request: ApprovalRequest) => Promise<ApprovalResult>;

const DEFAULT_TIMEOUT_SECONDS = 120;

// Arguments reach AppleScript through argv, so post text can never be parsed as script.
const SCRIPT = `on run argv
  set answer to display dialog (item 1 of argv) with title "x-axi: approve this action" buttons {"Cancel", "Approve"} default button "Cancel" cancel button "Cancel" with icon caution giving up after ((item 2 of argv) as integer)
  if gave up of answer then return "timed_out"
  return button returned of answer
end run`;

function counted(count: number, noun: string): string {
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
 * The human gate for every write. It runs in the tool rather than in a harness
 * hook so it holds under every agent harness and permission mode, and it fails
 * closed: anything other than an explicit click on Approve stops the write.
 */
export const approveWithDialog: Approver = (request) => {
  if (process.platform !== "darwin") return Promise.resolve("unavailable");
  const requested = Number(process.env["X_AXI_APPROVAL_TIMEOUT"]);
  const timeout = requested > 0 ? requested : DEFAULT_TIMEOUT_SECONDS;
  return new Promise((resolve) => {
    execFile(
      "/usr/bin/osascript", // Absolute, so a PATH entry cannot answer the dialog.
      ["-e", SCRIPT, formatApproval(request), String(timeout)],
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
};
