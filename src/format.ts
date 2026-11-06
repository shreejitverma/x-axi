import { encode } from "@toon-format/toon";
import { AxiError, exitCodeForError } from "axi-sdk-js";

export const EXIT_USAGE = 2;

/** The structured TOON error the CLI prints and the MCP server returns: the message, a code, and help when there is any. */
export function errorText(error: unknown): { text: string; code: string } {
  const known = error instanceof AxiError;
  const code = known ? error.code : "UNKNOWN";
  const message = error instanceof Error ? error.message : String(error);
  const suggestions = known ? error.suggestions : [];
  return { text: encode({ error: message, code, ...(suggestions.length ? { help: suggestions } : {}) }), code };
}

export function formatError(error: unknown): { output: string; exitCode: number } {
  const { text, code } = errorText(error);
  return { output: `${text}\n`, exitCode: code === "VALIDATION_ERROR" ? EXIT_USAGE : exitCodeForError(error) || 1 };
}
