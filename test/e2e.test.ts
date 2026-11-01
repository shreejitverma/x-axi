// Runs the built binary with a fake xurl and a loopback X API.
import { execFile } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  writeFileSync(join(dir, "xurl"), "#!/bin/sh\necho SECRET_TOKEN_VALUE\n");
  chmodSync(join(dir, "xurl"), 0o755);
  server = createServer((req, res) => {
    seen.push({ method: req.method ?? "", url: req.url ?? "", auth: req.headers.authorization });
    res.setHeader("content-type", "application/json");
    if (req.url === "/2/users/me") res.end('{"data":{"id":"1","username":"shreejit"}}');
    else if (req.url?.startsWith("/2/users/1/mentions")) res.end('{"data":[{"id":"5","text":"@shreejit hi","author_id":"9"}],"includes":{"users":[{"id":"9","username":"alice"}]}}');
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
      { env: { ...process.env, XURL_BIN: join(dir, "xurl"), X_AXI_API_BASE: base, X_AXI_STATE_DIR: dir, ...env } },
      (error, stdout) => done({ out: stdout, code: error ? Number(error.code) : 0 }),
    );
  });
}

it("reads through the binary, sends the token, and never prints it", async () => {
  const { out, code } = await run(["mentions"]);
  expect(code).toBe(0);
  expect(out).toContain("alice");
  expect(out).not.toContain("SECRET_TOKEN_VALUE");
  expect(seen.at(-1)?.auth).toBe("Bearer SECRET_TOKEN_VALUE");
  expect(readFileSync(join(dir, "ledger.jsonl"), "utf8")).not.toContain("SECRET_TOKEN_VALUE");
});

it("refuses to send the token to a non-loopback override", async () => {
  const { out, code } = await run(["me"], { X_AXI_API_BASE: "https://evil.example" });
  expect(code).not.toBe(0);
  expect(out).toContain("loopback");
});

it("exits 2 on bad usage and does not call the API", async () => {
  const before = seen.length;
  const { code } = await run(["post", "--bogus"]);
  expect(code).toBe(2);
  expect(seen.length).toBe(before);
});

it("never prints a malformed token", async () => {
  writeFileSync(join(dir, "badxurl"), "#!/bin/sh\nprintf 'SECRET_TOKEN_VALUE\\nsecond line\\n'\n");
  chmodSync(join(dir, "badxurl"), 0o755);
  const { out, code } = await run(["me"], { XURL_BIN: join(dir, "badxurl") });
  expect(code).toBe(1);
  expect(out).toContain("AUTH_REQUIRED");
  expect(out).not.toContain("SECRET_TOKEN_VALUE");
});

it("does not follow redirects, and reports them", async () => {
  const before = seen.length;
  const { out, code } = await run(["api", "/2/redir"]);
  expect(code).not.toBe(0);
  expect(out).toContain("307");
  expect(seen.length).toBe(before + 1);
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
