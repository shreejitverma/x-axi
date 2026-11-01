import { AxiError } from "axi-sdk-js";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Non-secret settings. The login itself lives in the OS keystore, never here. */
export interface Config {
  client_id?: string;
  redirect_uri?: string;
}

/** Fixed, because X matches the registered callback exactly. 127.0.0.1 follows RFC 8252 section 7.3. */
export const DEFAULT_REDIRECT_URI = "http://127.0.0.1:8711/callback";

export function configDir(): string {
  const xdg = process.env["XDG_CONFIG_HOME"];
  return join(xdg || join(homedir(), ".config"), "x-axi");
}

export function configPath(): string {
  return join(configDir(), "config.json");
}

export function readConfig(): Config {
  let raw: string;
  try {
    raw = readFileSync(configPath(), "utf8");
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return {};
    throw new AxiError(`cannot read ${configPath()}: ${(error as Error).message}`, "CONFIG_INVALID");
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new AxiError(`${configPath()} is not valid JSON: ${(error as Error).message}`, "CONFIG_INVALID", ["Fix or delete the file, then run `x-axi login --client-id YOUR_CLIENT_ID`"]);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AxiError(`${configPath()} must hold a JSON object`, "CONFIG_INVALID");
  const config = value as Record<string, unknown>;
  const result: Config = {};
  if (config["client_id"] !== undefined) result.client_id = parseClientId(config["client_id"], configPath());
  if (config["redirect_uri"] !== undefined) result.redirect_uri = parseRedirectUri(config["redirect_uri"], configPath());
  return result;
}

export function writeConfig(config: Config): void {
  const dir = configDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = join(dir, "config.json.tmp");
  writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, configPath());
}

/** X client IDs are URL-safe tokens. Anything else is a paste error, and must not reach a URL. */
export function parseClientId(value: unknown, source: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{8,200}$/.test(value)) {
    throw new AxiError(`${source} does not hold a valid OAuth 2.0 client ID`, "VALIDATION_ERROR", [
      "Copy the OAuth 2.0 Client ID from your app's Keys and tokens page at https://console.x.com",
    ]);
  }
  return value;
}

/** Only a 127.0.0.1 callback on an unprivileged port: the browser must come back to this machine, and X must match it exactly. */
export function parseRedirectUri(value: unknown, source: string): string {
  const port = typeof value === "string" ? /^http:\/\/127\.0\.0\.1:([1-9]\d{3,4})\/[\w/-]*$/.exec(value)?.[1] : undefined;
  if (port === undefined || Number(port) < 1024 || Number(port) > 65535) {
    throw new AxiError(`${source} redirect_uri must be an http://127.0.0.1 URL with a port from 1024 to 65535, like ${DEFAULT_REDIRECT_URI}`, "VALIDATION_ERROR", [
      "Register the same URI as the app's Callback URI in the X portal; X matches it character for character",
    ]);
  }
  return value as string;
}
