// Runs the built binary against a loopback X API. The override uses a fixed test token and never touches the keystore.
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";

const BIN = resolve("dist/bin/x-axi.js");
let dir: string;
let server: Server;
let base: string;
const seen: { method: string; url: string; auth: string | undefined }[] = [];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "x-axi-e2e-"));
  server = createServer((req, res) => {
    seen.push({ method: req.method ?? "", url: req.url ?? "", auth: req.headers.authorization });
    res.setHeader("content-type", "application/json");
    if (req.url === "/2/users/me") res.end('{"data":{"id":"1","username":"shreejit"}}');
    else if (req.url?.startsWith("/2/users/1/mentions")) res.end('{"data":[{"id":"5","text":"@shreejit hi","author_id":"9"}],"includes":{"users":[{"id":"9","username":"alice"}]}}');
    else if (req.url === "/2/users/me?user.fields=public_metrics") res.end('{"data":{"id":"1","username":"shreejit","public_metrics":{"following_count":2}}}');
    else if (req.url?.startsWith("/2/users/1/following")) res.end('{"data":[{"id":"9","username":"alice","name":"Alice"},{"id":"10","username":"bob","name":"Bob","protected":true}],"meta":{"result_count":2}}');
    else if (req.url === "/2/redir") { res.statusCode = 307; res.setHeader("location", "/2/users/me"); res.end(); }
    else { res.statusCode = 500; res.end("{}"); }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

function run(args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ out: string; code: number }> {
  return new Promise((done) => {
    execFile(
      process.execPath,
      [BIN, ...args],
      { env: { ...process.env, X_AXI_API_BASE: base, X_AXI_STATE_DIR: dir, XDG_CONFIG_HOME: join(dir, "config"), ...env } },
      (error, stdout) => done({ out: stdout, code: error ? Number(error.code) : 0 }),
    );
  });
}

it("reads through the binary with the fixed test token under an override", async () => {
  const { out, code } = await run(["mentions"]);
  expect(code).toBe(0);
  expect(out).toContain("alice");
  expect(seen.at(-1)?.auth).toBe("Bearer x-axi-test-token");
});

it("reports the override as the storage and refuses login and logout under it", async () => {
  const status = await run(["auth", "status"]);
  expect(status.code).toBe(0);
  expect(status.out).toContain("X_AXI_API_BASE");
  expect(status.out).toContain("logged_in: false");
  for (const args of [["login", "--client-id", "client-id-1234"], ["logout"]]) {
    const before = seen.length;
    const { out, code } = await run(args);
    expect(code).toBe(2);
    expect(out).toContain("not available under X_AXI_API_BASE");
    expect(seen.length).toBe(before);
  }
});

it("lists the account commands in help and shows login help without a secret", async () => {
  const top = await run(["--help"]);
  expect(top.out).toContain("login");
  expect(top.out).toContain("auth status");
  const login = await run(["login", "--help"]);
  expect(login.code).toBe(0);
  expect(login.out).toContain("--client-id");
  expect(login.out.toLowerCase()).not.toContain("secret");
});

it("refuses to send the token to a non-loopback override", async () => {
  const { out, code } = await run(["me"], { X_AXI_API_BASE: "https://evil.example" });
  expect(code).not.toBe(0);
  expect(out).toContain("loopback");
});

it.each([[["update"]], [["update", "--check"]]])("%j points at git and never touches a package manager", async (args) => {
  const marker = join(dir, "npm-ran");
  for (const tool of ["npm", "pnpm"]) {
    writeFileSync(join(dir, tool), `#!/bin/sh\ntouch "${marker}"\n`);
    chmodSync(join(dir, tool), 0o755);
  }
  const before = seen.length;
  const { out, code } = await run(args, { PATH: `${dir}:${process.env["PATH"]}` });
  expect(code).toBe(1);
  expect(out).toContain("UPDATE_FROM_GIT");
  expect(out).toContain("git pull");
  expect(out).not.toContain("x-axi@latest");
  expect(existsSync(marker)).toBe(false);
  expect(seen.length).toBe(before);
});

it("does not advertise a registry upgrade in help", async () => {
  const { out, code } = await run(["--help"]);
  expect(code).toBe(0);
  expect(out).not.toContain("latest published version");
});

it("exits 2 on bad usage and does not call the API", async () => {
  const before = seen.length;
  const { code } = await run(["post", "--bogus"]);
  expect(code).toBe(2);
  expect(seen.length).toBe(before);
});

it("prints a dry run as TOON through the binary, opens no dialog, and sends no write", async () => {
  const before = seen.length;
  const { out, code } = await run(["thread", "first part", "second part", "--dry-run"]);
  expect(code).toBe(0);
  expect(out).toContain("dry_run:");
  expect(out).toContain("first part");
  expect(out).toContain("<id of part 1>");
  expect(out).toContain("write_est_cost: $0.030");
  expect(seen.slice(before).map((s) => s.method)).toEqual(["GET"]);
});

it("exports the following list through the binary and refuses to overwrite it", async () => {
  const file = join(dir, "export.json");
  const first = await run(["following", "--all", "--out", file]);
  expect(first.code).toBe(0);
  expect(first.out).toContain("written: 2");
  expect(JSON.parse(readFileSync(file, "utf8"))).toHaveLength(2);
  const second = await run(["following", "--all", "--out", file]);
  expect(second.code).toBe(2);
  expect(second.out).toContain("already exists");
});

it("documents the new commands in help", async () => {
  const top = await run(["--help"]);
  for (const name of ["following", "followers", "follow-plan", "thread", "repost", "--dry-run"]) expect(top.out).toContain(name);
  for (const [command, flag] of [["post", "--media"], ["post", "--quote"], ["follow-plan", "--max-spend"], ["following", "--all"], ["delete", "--dry-run"]]) {
    expect((await run([command as string, "--help"])).out).toContain(flag);
  }
});

it("does not follow redirects, and reports them", async () => {
  const before = seen.length;
  const { out, code } = await run(["api", "/2/redir"]);
  expect(code).not.toBe(0);
  expect(out).toContain("307");
  expect(seen.length).toBe(before + 1);
});

// These two run only on Linux, where the binary cannot reach osascript. No real dialog can open:
// the first has no display. The second names a display under its temp directory, so it cannot be a live one such as xvfb-run's :99.
// Any real zenity exits 1 there, as Cancel does,
// and x-axi reads its display error to report the machine as unavailable rather than a cancel nobody made.
it.runIf(process.platform === "linux")("refuses a write in a headless session and says what to install", async () => {
  const { out, code } = await run(["post", "headless test, never sent"], { DISPLAY: "", WAYLAND_DISPLAY: "" });
  expect(code).toBe(1);
  expect(out).toContain("APPROVAL_UNAVAILABLE");
  expect(out).toContain("zenity");
  expect(seen.filter((s) => s.method === "POST")).toEqual([]);
});

it.runIf(process.platform === "linux")("ignores a zenity planted on PATH", async () => {
  writeFileSync(join(dir, "zenity"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(dir, "zenity"), 0o755);
  const { out, code } = await run(["post", "planted test, never sent"], {
    PATH: `${dir}:${process.env["PATH"]}`,
    DISPLAY: join(dir, "no-such-display"),
    WAYLAND_DISPLAY: "",
  });
  expect(code).toBe(1);
  expect(out).toContain("APPROVAL_UNAVAILABLE");
  expect(seen.filter((s) => s.method === "POST")).toEqual([]);
});

// A fake osascript on PATH must not be able to answer the dialog.
it.runIf(process.platform === "darwin" && process.env["X_AXI_TEST_DIALOG"] === "1")(
  "ignores an osascript planted on PATH",
  async () => {
    writeFileSync(join(dir, "osascript"), "#!/bin/sh\necho Approve\n");
    chmodSync(join(dir, "osascript"), 0o755);
    const { out } = await run(["post", "planted test, never sent"], {
      PATH: `${dir}:${process.env["PATH"]}`,
      X_AXI_APPROVAL_TIMEOUT: "1",
    });
    expect(out).toContain("NOT_APPROVED");
    expect(seen.filter((s) => s.method === "POST")).toEqual([]);
  },
  20_000,
);

// Opens a real macOS dialog for one second and lets it expire.
it.runIf(process.platform === "darwin" && process.env["X_AXI_TEST_DIALOG"] === "1")(
  "publishes nothing when the real dialog goes unanswered",
  async () => {
    const { out, code } = await run(["post", "dialog test, never sent"], { X_AXI_APPROVAL_TIMEOUT: "1" });
    expect(code).toBe(1);
    expect(out).toContain("NOT_APPROVED");
    expect(seen.filter((s) => s.method === "POST")).toEqual([]);
  },
  20_000,
);
