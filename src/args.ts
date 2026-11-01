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
      // The last value winning would silently drop an earlier one, such as a media file.
      if (parsed.flags.has(name)) throw usage(`${name} was given twice; \`${command}\` takes it once`);
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

/** A dollar cap on what one command may spend. Undefined when the flag is absent. */
export function parseMaxSpend(parsed: Parsed): number | undefined {
  const raw = parsed.flags.get("--max-spend");
  if (raw === undefined) return undefined;
  const usd = Number(raw);
  if (!Number.isFinite(usd) || usd <= 0) throw usage("--max-spend must be a positive amount in US dollars, such as 2.50");
  return usd;
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
// Viramas are listed by script because JavaScript has no property for them.
const VIRAMAS: Record<string, string> = {
  Devanagari: "\\u094d",
  Bengali: "\\u09cd",
  Gurmukhi: "\\u0a4d",
  Gujarati: "\\u0acd",
  Oriya: "\\u0b4d",
  Tamil: "\\u0bcd",
  Telugu: "\\u0c4d",
  Kannada: "\\u0ccd",
  Malayalam: "\\u0d4d",
  Sinhala: "\\u0dca",
};
const RTL_SCRIPTS = ["Arabic", "Hebrew", "Syriac", "Thaana", "Nko", "Adlam", "Hanifi_Rohingya", "Mandaic", "Samaritan"];
const letterOf = (script: string): string => `[\\p{L}&&\\p{sc=${script}}]`;
const RTL_LETTER = `[\\p{L}&&[${RTL_SCRIPTS.map((script) => `\\p{sc=${script}}`).join("")}]]`;

// The only places DECEPTIVE's characters are ordinary text. Everywhere else they stay refused,
// and bidi embeddings, overrides, and isolates have no exception, because they can reorder the dialog.
const ORDINARY_FORMAT = new RegExp(
  `(${[
    // U+200D between two emoji, after any U+FE0F or skin tone.
    String.raw`(?<=\p{Extended_Pictographic}[\u{fe0f}\u{1f3fb}-\u{1f3ff}]?)‍(?=\p{Extended_Pictographic})`,
    // U+200D after a virama, or between a letter and its script's virama, as in the Bengali ra-phala.
    `(?<=[${Object.values(VIRAMAS).join("")}])\\u200d`,
    ...Object.entries(VIRAMAS).map(([script, virama]) => `(?<=${letterOf(script)})\\u200d(?=${virama})`),
    // U+200C between letters of one script that uses it. The left letter may carry marks, such as a virama.
    ...["Arabic", ...Object.keys(VIRAMAS)].map((script) => `(?<=${letterOf(script)}\\p{M}*)\\u200c(?=${letterOf(script)})`),
    // Tag characters only in a well-formed subdivision flag, such as England's.
    String.raw`(?<=\u{1f3f4})[\u{e0030}-\u{e0039}\u{e0061}-\u{e007a}]{3,7}\u{e007f}`,
    // U+200E and U+200F only in text that has a right-to-left letter.
    `[\\u200e\\u200f](?:(?<=${RTL_LETTER}[\\s\\S]*)|(?=[\\s\\S]*${RTL_LETTER}))`,
    // Emoji newer than this runtime's Unicode tables.
    String.raw`[\p{Cn}&&\p{Extended_Pictographic}]`,
  ].join("|")})`,
  "gv",
);
const MAX_APPROVABLE = 4000;
const MAX_APPROVABLE_LINES = 40;
// Three blank lines in a row, or a long run of spaces, could push text out of view in the dialog.
const HIDING_GAP = /(?:[^\S\n]*\n){4}|[^\S\n]{40}/;
const ACCEPTED_BLANK = /[\u200d-\u200f\p{M}]/gu;

/** Length is left to X because the limit depends on the account. */
export function parseOutgoingText(value: string | undefined): string {
  const visible = (value ?? "").replace(ACCEPTED_BLANK, "");
  if (value === undefined || !visible.trim()) throw usage("the text must not be empty");
  if (DECEPTIVE.test(value.replace(ORDINARY_FORMAT, "").replaceAll("\n", ""))) throw usage("the text contains invisible or control characters; remove them");
  if (value.length > MAX_APPROVABLE || value.split("\n").length > MAX_APPROVABLE_LINES) {
    throw usage(`the text is over ${MAX_APPROVABLE} characters or ${MAX_APPROVABLE_LINES} lines, too long to review in the approval dialog`);
  }
  if (HIDING_GAP.test(visible)) throw usage("the text has a long run of blank lines or spaces; shorten it");
  return value;
}

/** Makes text from X safe to show in the approval dialog: one line, nothing invisible. */
export function displayText(value: string): string {
  return value
    .replace(/\s+/gu, " ")
    .split(ORDINARY_FORMAT)
    .map((part, index) => (index % 2 === 1 ? part : Array.from(part, (ch) => (DECEPTIVE.test(ch) ? "\ufffd" : ch)).join("")))
    .join("");
}

export function onePositional(parsed: Parsed, command: string): string | undefined {
  if (parsed.positional.length > 1) {
    throw usage(`\`${command}\` takes one argument; quote it if it contains spaces`);
  }
  return parsed.positional[0];
}
