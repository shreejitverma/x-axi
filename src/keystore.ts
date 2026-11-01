import { AxiError } from "axi-sdk-js";
import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

/** One OS credential record, read and written whole. The value is opaque to the store. */
export interface Keystore {
  /** Named in status output, so a user can see where the login lives. */
  readonly backend: string;
  read(): Promise<string | undefined>;
  write(secret: string): Promise<void>;
  /** Deleting an absent record is not an error. */
  delete(): Promise<void>;
}

export interface CommandSpec {
  file: string;
  args: string[];
  /** The only channel a secret may travel on: stdin is not visible in `ps`, argv is. */
  stdin?: string;
}

export interface CommandResult {
  /** The exit code, or null when the process did not exit normally. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** The binary does not exist. */
  missing: boolean;
}

export type CommandRunner = (spec: CommandSpec) => Promise<CommandResult>;

const COMMAND_TIMEOUT_MS = 30_000;

export const runCommand: CommandRunner = (spec) =>
  new Promise((resolve) => {
    const child = execFile(spec.file, spec.args, { timeout: COMMAND_TIMEOUT_MS, maxBuffer: 1 << 20 }, (error, stdout, stderr) => {
      const failure = error as (NodeJS.ErrnoException & { killed?: boolean }) | null;
      resolve({
        code: failure ? (typeof failure.code === "number" ? failure.code : null) : 0,
        stdout,
        stderr: failure?.killed ? `timed out after ${COMMAND_TIMEOUT_MS / 1000} seconds\n${stderr}` : stderr,
        missing: failure?.code === "ENOENT",
      });
    });
    // A child that exits before reading stdin raises EPIPE here; its exit code already carries the failure.
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(spec.stdin ?? "");
  });

const SERVICE = "x-axi";
const ACCOUNT = "oauth2";
const SECURITY = "/usr/bin/security";
// `security -i` splits a line near 4096 bytes and runs each fragment as its own command, which
// in the experiment wrote a fragment to the default keychain. Refusing well below that bound
// keeps a record from ever being split.
const MAX_SECURITY_LINE = 3000;
const ERR_SEC_ITEM_NOT_FOUND = 44;
const ERR_SEC_ITEM_NOT_FOUND_STATUS = "-25300";
const ERR_SEC_INTERACTION_NOT_ALLOWED = 36;

/** Base64 keeps the record to one shell-safe token with no quoting rules to get wrong. */
function encode(secret: string): string {
  return Buffer.from(secret, "utf8").toString("base64");
}

/** KEYSTORE_CORRUPT is the one read failure logout may treat as "a record exists": the backend worked, the content did not. */
function decode(stored: string, backend: string): string {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(stored)) {
    throw new AxiError(`the ${backend} record for x-axi is not one this version wrote`, "KEYSTORE_CORRUPT", [
      "Run `x-axi logout` to delete it, then `x-axi login`",
    ]);
  }
  return Buffer.from(stored, "base64").toString("utf8");
}

/**
 * `security` exits with the low byte of an OSStatus, so the text is checked too before a failure counts as "no record".
 * That text follows the system language, so `security error` supplies it. It exits 1 even when it prints the message.
 */
async function keychainSaysNotFound(result: CommandResult, run: CommandRunner): Promise<boolean> {
  if (result.code !== ERR_SEC_ITEM_NOT_FOUND) return false;
  const explained = await run({ file: SECURITY, args: ["error", ERR_SEC_ITEM_NOT_FOUND_STATUS] });
  const message = new RegExp(`^Error: \\S+ ${ERR_SEC_ITEM_NOT_FOUND_STATUS} (.+)$`).exec(explained.stdout.trim())?.[1];
  return message !== undefined && result.stderr.includes(message);
}

/** Only the first line of stderr, with the secret removed in case a tool echoed its input. */
function stderrSummary(result: CommandResult, secrets: string[]): string {
  let line = result.stderr.split("\n").find((l) => l.trim()) ?? "";
  for (const secret of secrets) if (secret) line = line.replaceAll(secret, "[redacted]");
  return line.slice(0, 160) || `exit code ${String(result.code)}`;
}

function keystoreFailure(backend: string, action: string, result: CommandResult, secrets: string[] = []): AxiError {
  return new AxiError(`${backend} could not ${action} the x-axi login: ${stderrSummary(result, secrets)}`, "KEYSTORE_ERROR");
}

/**
 * macOS Keychain through the system `security` tool at its absolute path. Writes go through
 * `security -i`, which reads the whole command from stdin, so the record never appears in argv.
 * The optional keychain path exists for tests, which use a temporary keychain and never the login keychain.
 */
export function keychainStore(run: CommandRunner, keychain?: string): Keystore {
  const backend = "macOS Keychain";
  if (keychain !== undefined && !/^[\w./-]+$/.test(keychain)) {
    throw new AxiError("the keychain path may contain only letters, digits, and ./_-", "VALIDATION_ERROR");
  }
  const target = keychain === undefined ? [] : [keychain];
  const fail = (action: string, result: CommandResult, secrets?: string[]): AxiError => {
    if (result.code === ERR_SEC_INTERACTION_NOT_ALLOWED) {
      return new AxiError(`the keychain is locked and this session cannot show an unlock prompt, so the x-axi login could not be ${action}`, "KEYSTORE_LOCKED", [
        "Unlock it with `security unlock-keychain` in that session, or log in to the Mac's desktop session",
      ]);
    }
    return keystoreFailure(backend, action, result, secrets);
  };
  return {
    backend,
    async read() {
      const result = await run({ file: SECURITY, args: ["find-generic-password", "-a", ACCOUNT, "-s", SERVICE, "-w", ...target] });
      if (await keychainSaysNotFound(result, run)) return undefined;
      if (result.code !== 0) throw fail("read", result);
      return decode(result.stdout.trim(), backend);
    },
    async write(secret) {
      const encoded = encode(secret);
      const line = `add-generic-password -a ${ACCOUNT} -s ${SERVICE} -w ${encoded} -U ${target.join(" ")}\n`;
      if (Buffer.byteLength(line) > MAX_SECURITY_LINE) {
        throw new AxiError("the login record is too large to store in the keychain safely; nothing was written", "KEYSTORE_ERROR");
      }
      const result = await run({ file: SECURITY, args: ["-i"], stdin: line });
      if (result.code !== 0) throw fail("stored", result, [secret, encoded]);
    },
    async delete() {
      const result = await run({ file: SECURITY, args: ["delete-generic-password", "-a", ACCOUNT, "-s", SERVICE, ...target] });
      if (result.code !== 0 && !(await keychainSaysNotFound(result, run))) throw fail("deleted", result);
    },
  };
}

export const SECRET_SERVICE_INSTALL = [
  "Install secret-tool: `sudo apt install libsecret-tools` (Debian, Ubuntu), `sudo dnf install libsecret` (Fedora), or `sudo pacman -S libsecret` (Arch)",
  "Make sure a Secret Service is running, such as GNOME Keyring or KeePassXC with Secret Service integration enabled",
];

/** Linux Secret Service through `secret-tool`, which reads the secret from stdin when stdin is not a terminal. */
export function secretServiceStore(run: CommandRunner, tool: string): Keystore {
  const backend = "Secret Service";
  const attrs = ["service", SERVICE, "account", ACCOUNT];
  const unavailable = (result: CommandResult): AxiError =>
    new AxiError(`secret-tool failed: ${stderrSummary(result, [])}`, "KEYSTORE_UNAVAILABLE", SECRET_SERVICE_INSTALL);
  return {
    backend,
    async read() {
      const result = await run({ file: tool, args: ["lookup", ...attrs] });
      if (result.missing) throw unavailable(result);
      // secret-tool exits 1 both for a missing item and for a missing daemon; only the daemon case writes to stderr.
      if (result.code === 1 && !result.stderr.trim()) return undefined;
      if (result.code !== 0) throw unavailable(result);
      return decode(result.stdout.trim(), backend);
    },
    async write(secret) {
      const encoded = encode(secret);
      const result = await run({ file: tool, args: ["store", `--label=${SERVICE}`, ...attrs], stdin: encoded });
      if (result.missing) throw unavailable(result);
      if (result.code !== 0) throw keystoreFailure(backend, "store", result, [secret, encoded]);
    },
    async delete() {
      const result = await run({ file: tool, args: ["clear", ...attrs] });
      if (result.missing) throw unavailable(result);
      if (result.code !== 0) throw keystoreFailure(backend, "delete", result);
    },
  };
}

/** Every call fails with the reason the platform has no keystore. There is no plaintext fallback. */
export function unavailableKeystore(error: AxiError): Keystore {
  const reject = (): Promise<never> => Promise.reject(error);
  return { backend: `unavailable (${error.message})`, read: reject, write: reject, delete: reject };
}

export function findOnPath(name: string, path = process.env["PATH"] ?? ""): string | undefined {
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not here; keep looking.
    }
  }
  return undefined;
}

export interface KeystoreEnvironment {
  platform: NodeJS.Platform;
  run: CommandRunner;
  which: (name: string) => string | undefined;
}

export function selectKeystore(env: KeystoreEnvironment = { platform: process.platform, run: runCommand, which: findOnPath }): Keystore {
  if (env.platform === "darwin") return keychainStore(env.run);
  if (env.platform === "linux") {
    const tool = env.which("secret-tool");
    if (tool) return secretServiceStore(env.run, tool);
    return unavailableKeystore(new AxiError("no OS keystore is available: secret-tool is not installed, and x-axi never stores a login in a plain file", "KEYSTORE_UNAVAILABLE", SECRET_SERVICE_INSTALL));
  }
  if (env.platform === "win32") {
    return unavailableKeystore(new AxiError("Windows is not supported: x-axi has no Windows Credential Manager backend yet, and it never stores a login in a plain file", "KEYSTORE_UNAVAILABLE", [
      "Run x-axi on macOS or Linux, or add a Credential Manager backend",
    ]));
  }
  return unavailableKeystore(new AxiError(`no OS keystore backend exists for ${env.platform}, and x-axi never stores a login in a plain file`, "KEYSTORE_UNAVAILABLE"));
}
