import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { keychainStore, runCommand, secretServiceStore, selectKeystore, type CommandResult, type CommandRunner, type CommandSpec } from "../src/keystore.js";

const SECRET = '{"access_token":"SECRET_ACCESS","refresh_token":"SECRET_REFRESH"}';
const ENCODED = Buffer.from(SECRET).toString("base64");

/** Records every command and answers with a scripted result. */
function recorder(answer: (spec: CommandSpec) => Partial<CommandResult>) {
  const specs: CommandSpec[] = [];
  const run: CommandRunner = async (spec) => {
    specs.push(spec);
    return { code: 0, stdout: "", stderr: "", missing: false, ...answer(spec) };
  };
  return { run, specs };
}

describe("macOS Keychain command construction", () => {
  it("writes through security -i on stdin, with the secret absent from argv", async () => {
    const r = recorder(() => ({}));
    await keychainStore(r.run).write(SECRET);
    const [spec] = r.specs;
    expect(spec!.file).toBe("/usr/bin/security");
    expect(spec!.args).toEqual(["-i"]);
    expect(spec!.args.join(" ")).not.toContain("SECRET");
    expect(spec!.args.join(" ")).not.toContain(ENCODED);
    expect(spec!.stdin).toBe(`add-generic-password -a oauth2 -s x-axi -w ${ENCODED} -U \n`);
  });

  it("targets a named keychain only when given one, and only a plain path", async () => {
    const r = recorder(() => ({}));
    await keychainStore(r.run, "/tmp/t.keychain-db").write(SECRET);
    expect(r.specs[0]!.stdin).toMatch(/ -U \/tmp\/t\.keychain-db\n$/);
    await keychainStore(r.run, "/tmp/t.keychain-db").read();
    expect(r.specs[1]!.args).toEqual(["find-generic-password", "-a", "oauth2", "-s", "x-axi", "-w", "/tmp/t.keychain-db"]);
    expect(() => keychainStore(r.run, '/tmp/x" -w evil')).toThrow();
  });

  it("refuses a record that could be split by the 4 KB line limit, without running security", async () => {
    const r = recorder(() => ({}));
    await expect(keychainStore(r.run).write("a".repeat(2500))).rejects.toMatchObject({ code: "KEYSTORE_ERROR" });
    expect(r.specs).toEqual([]);
  });

  it("decodes what it stored and treats exit 44 as no record", async () => {
    const r = recorder((spec) => (spec.args[0] === "find-generic-password" ? { stdout: `${ENCODED}\n` } : {}));
    await expect(keychainStore(r.run).read()).resolves.toBe(SECRET);
    const missing = recorder(() => ({ code: 44, stderr: "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain." }));
    await expect(keychainStore(missing.run).read()).resolves.toBeUndefined();
    await expect(keychainStore(missing.run).delete()).resolves.toBeUndefined();
  });

  it("maps a locked keychain in a headless session to its own code", async () => {
    const r = recorder(() => ({ code: 36, stderr: "security: SecKeychainSearchCopyNext: User interaction is not allowed." }));
    await expect(keychainStore(r.run).read()).rejects.toMatchObject({ code: "KEYSTORE_LOCKED" });
  });

  it("keeps the secret out of a write error even when security echoes its input", async () => {
    const r = recorder(() => ({ code: 1, stderr: `security: unknown command "${ENCODED}"\nmore` }));
    const error = await keychainStore(r.run).write(SECRET).catch((e: Error) => e);
    expect(error).toMatchObject({ code: "KEYSTORE_ERROR" });
    expect(error.message).not.toContain(ENCODED);
    expect(error.message).not.toContain("SECRET");
    expect(error.message).toContain("[redacted]");
  });

  it("rejects a record it did not write instead of returning garbage", async () => {
    const r = recorder(() => ({ stdout: "not base64!\n" }));
    await expect(keychainStore(r.run).read()).rejects.toMatchObject({ code: "KEYSTORE_CORRUPT" });
  });

  it("does not take an unrelated exit status with the same low byte for a missing record", async () => {
    const r = recorder(() => ({ code: 44, stderr: "security: SecKeychainSearchCopyNext: some other failure." }));
    await expect(keychainStore(r.run).read()).rejects.toMatchObject({ code: "KEYSTORE_ERROR" });
    await expect(keychainStore(r.run).delete()).rejects.toMatchObject({ code: "KEYSTORE_ERROR" });
  });
});

describe("Secret Service command construction", () => {
  it("stores through stdin with only attributes on argv", async () => {
    const r = recorder(() => ({}));
    await secretServiceStore(r.run, "/usr/bin/secret-tool").write(SECRET);
    expect(r.specs[0]).toEqual({
      file: "/usr/bin/secret-tool",
      args: ["store", "--label=x-axi", "service", "x-axi", "account", "oauth2"],
      stdin: ENCODED,
    });
  });

  it("reads, tells a missing item from a missing daemon, and clears", async () => {
    const found = recorder(() => ({ stdout: ENCODED }));
    await expect(secretServiceStore(found.run, "secret-tool").read()).resolves.toBe(SECRET);
    const absent = recorder(() => ({ code: 1 }));
    await expect(secretServiceStore(absent.run, "secret-tool").read()).resolves.toBeUndefined();
    const noDaemon = recorder(() => ({ code: 1, stderr: "secret-tool: Cannot autolaunch D-Bus without X11 $DISPLAY" }));
    await expect(secretServiceStore(noDaemon.run, "secret-tool").read()).rejects.toMatchObject({ code: "KEYSTORE_UNAVAILABLE" });
    const gone = recorder(() => ({ code: 127, missing: true }));
    await expect(secretServiceStore(gone.run, "secret-tool").write(SECRET)).rejects.toMatchObject({ code: "KEYSTORE_UNAVAILABLE" });
    const cleared = recorder(() => ({}));
    await secretServiceStore(cleared.run, "secret-tool").delete();
    expect(cleared.specs[0]!.args).toEqual(["clear", "service", "x-axi", "account", "oauth2"]);
  });
});

describe("keystore selection", () => {
  const never: CommandRunner = async () => { throw new Error("must not run"); };

  it("fails closed with install steps on Linux without secret-tool", async () => {
    const store = selectKeystore({ platform: "linux", run: never, which: () => undefined });
    expect(store.backend).toContain("unavailable");
    for (const call of [store.read(), store.write("x"), store.delete()]) {
      await expect(call).rejects.toMatchObject({ code: "KEYSTORE_UNAVAILABLE", suggestions: [expect.stringContaining("libsecret"), expect.any(String)] });
    }
  });

  it("uses secret-tool where it is found on Linux", async () => {
    const r = recorder(() => ({ code: 1 }));
    const store = selectKeystore({ platform: "linux", run: r.run, which: (name) => (name === "secret-tool" ? "/nix/store/abc/bin/secret-tool" : undefined) });
    await expect(store.read()).resolves.toBeUndefined();
    expect(r.specs[0]!.file).toBe("/nix/store/abc/bin/secret-tool");
  });

  it("names Windows as unsupported", async () => {
    const store = selectKeystore({ platform: "win32", run: never, which: () => "C:\\\\secret-tool.exe" });
    await expect(store.read()).rejects.toMatchObject({ code: "KEYSTORE_UNAVAILABLE", message: expect.stringContaining("Windows") });
  });

  it("uses the Keychain on macOS regardless of PATH", async () => {
    const r = recorder(() => ({ code: 44, stderr: "The specified item could not be found in the keychain." }));
    await selectKeystore({ platform: "darwin", run: r.run, which: () => "/evil/secret-tool" }).read();
    expect(r.specs[0]!.file).toBe("/usr/bin/security");
  });
});

/** The real runner must deliver stdin and report ENOENT. */
describe("command runner", () => {
  it("passes stdin through and reports exit codes", async () => {
    const echoed = await runCommand({ file: "/bin/cat", args: [], stdin: "from stdin" });
    expect(echoed).toMatchObject({ code: 0, stdout: "from stdin", missing: false });
    const failed = await runCommand({ file: "/bin/sh", args: ["-c", "echo err >&2; exit 44"] });
    expect(failed).toMatchObject({ code: 44, stderr: "err\n" });
    const absent = await runCommand({ file: "/nonexistent/x-axi-tool", args: [] });
    expect(absent.missing).toBe(true);
  });
});

/**
 * Opt in with X_AXI_TEST_KEYCHAIN=1 on macOS. It creates a temporary keychain under a temp
 * directory, never the login keychain, and deletes it afterwards. Items created by `security`
 * are readable by `security` without a prompt, so this opens no dialog.
 */
describe.runIf(process.platform === "darwin" && process.env["X_AXI_TEST_KEYCHAIN"] === "1")("temporary macOS keychain", () => {
  let dir: string;
  let keychain: string;
  const security = (args: string[]) =>
    new Promise<string>((resolve, reject) => execFile("/usr/bin/security", args, (error, stdout, stderr) => (error ? reject(new Error(stderr)) : resolve(stdout))));

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "x-axi-keychain-"));
    keychain = join(dir, "test.keychain-db");
    await security(["create-keychain", "-p", "test-password", keychain]);
    await security(["set-keychain-settings", keychain]);
    await security(["unlock-keychain", "-p", "test-password", keychain]);
  });
  afterAll(async () => {
    await security(["delete-keychain", keychain]).catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips a JSON record, updates it, and deletes it", async () => {
    const store = keychainStore(runCommand, keychain);
    await expect(store.read()).resolves.toBeUndefined();
    await store.write(SECRET);
    await expect(store.read()).resolves.toBe(SECRET);
    await store.write('{"v":2,"text":"quotes \\" and spaces"}');
    await expect(store.read()).resolves.toBe('{"v":2,"text":"quotes \\" and spaces"}');
    await store.delete();
    await expect(store.read()).resolves.toBeUndefined();
    await store.delete();
  });

  it("shows only `security -i` in the process table during a write", async () => {
    const seen: string[] = [];
    const spy: CommandRunner = (spec) => {
      const promise = runCommand(spec);
      // Sample the process table while the write is in flight.
      const sample = new Promise<void>((resolve) => {
        execFile("/bin/ps", ["-axo", "args"], (_error, stdout) => {
          seen.push(...stdout.split("\n").filter((l) => l.includes("/usr/bin/security")));
          resolve();
        });
      });
      return Promise.all([promise, sample]).then(([result]) => result);
    };
    await keychainStore(spy, keychain).write(SECRET);
    expect(seen.join("\n")).not.toContain(ENCODED);
    expect(seen.join("\n")).not.toContain("SECRET");
    vi.restoreAllMocks();
  });
});
