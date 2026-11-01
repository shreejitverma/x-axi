import { AxiError } from "axi-sdk-js";

export interface Parsed {
  positional: string[];
  flags: Map<string, string | true>;
}

/** Fails loud on unknown flags. `valueFlags` take a value and `boolFlags` do not. */
export function parseArgs(args: string[], command: string, valueFlags: string[], boolFlags: string[] = []): Parsed {
  const parsed: Parsed = { positional: [], flags: new Map() };
  const valid = [...valueFlags, ...boolFlags].join(", ") || "none";
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === "--") {
      parsed.positional.push(...args.slice(i + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      parsed.positional.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg : arg.slice(0, eq);
    if (boolFlags.includes(name) && eq === -1) {
      parsed.flags.set(name, true);
    } else if (valueFlags.includes(name)) {
      const value = eq === -1 ? args[++i] : arg.slice(eq + 1);
      if (value === undefined) throw usage(`${name} needs a value`);
      parsed.flags.set(name, value);
    } else {
      throw usage(`unknown flag ${name} for \`${command}\`; valid flags: ${valid}`);
    }
  }
  return parsed;
}

export function usage(message: string, suggestions: string[] = []): AxiError {
  return new AxiError(message, "VALIDATION_ERROR", suggestions);
}

export function parseLimit(parsed: Parsed, fallback: number, min: number, max: number): number {
  const raw = parsed.flags.get("--limit");
  if (raw === undefined) return fallback;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < min || limit > max) {
    throw usage(`--limit must be an integer from ${min} to ${max}`);
  }
  return limit;
}

/** Accepts a numeric post ID or a post URL. */
export function parsePostId(value: string | undefined): string {
  const match = value?.match(/^(?:https?:\/\/(?:www\.)?(?:x|twitter)\.com\/\w+\/status\/)?(\d{1,25})(?:[/?].*)?$/);
  if (!match?.[1]) throw usage(`expected a post ID or URL, got: ${value ?? "nothing"}`);
  return match[1];
}

export function parseHandle(value: string | undefined): string {
  const handle = value?.replace(/^@/, "") ?? "";
  if (!/^\w{1,15}$/.test(handle)) throw usage(`expected an X handle, got: ${value ?? "nothing"}`);
  return handle;
}

// Control and bidi-override characters could make the approval dialog show
// something other than what gets sent.
// This covers format, control, separator, private-use, and unassigned code points
// (tag characters included), plus blank fillers and hidden variation selectors.
const DECEPTIVE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cn}\p{Cs}͏ᅟᅠ឴឵᠋-᠍⠀ㅤ︀-︎ﾠ\u{e0100}-\u{e01ef}]/u;
const MAX_APPROVABLE = 4000;
const MAX_APPROVABLE_LINES = 40;
// Three blank lines in a row, or a long run of spaces, could push text out of view in the dialog.
const HIDING_GAP = /(?:[^\S\n]*\n){4}|[^\S\n]{40}/;

/** Length is left to X because the limit depends on the account. */
export function parseOutgoingText(value: string | undefined): string {
  if (!value?.trim()) throw usage("the text must not be empty");
  if (DECEPTIVE.test(value.replaceAll("\n", ""))) throw usage("the text contains invisible or control characters; remove them");
  if (value.length > MAX_APPROVABLE || value.split("\n").length > MAX_APPROVABLE_LINES) {
    throw usage(`the text is over ${MAX_APPROVABLE} characters or ${MAX_APPROVABLE_LINES} lines, too long to review in the approval dialog`);
  }
  if (HIDING_GAP.test(value)) throw usage("the text has a long run of blank lines or spaces; shorten it");
  return value;
}

/** Makes text from X safe to show in the approval dialog: one line, nothing invisible. */
export function displayText(value: string): string {
  return Array.from(value.replace(/\s+/gu, " "), (ch) => (DECEPTIVE.test(ch) ? "\ufffd" : ch)).join("");
}

export function onePositional(parsed: Parsed, command: string): string | undefined {
  if (parsed.positional.length > 1) {
    throw usage(`\`${command}\` takes one argument; quote it if it contains spaces`);
  }
  return parsed.positional[0];
}
