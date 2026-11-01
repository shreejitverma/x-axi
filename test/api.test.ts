import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { httpClient } from "../src/api.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "x-axi-api-"));
  writeFileSync(join(dir, "xurl"), "#!/bin/sh\necho REAL_TOKEN\n");
  chmodSync(join(dir, "xurl"), 0o755);
  vi.stubEnv("XURL_BIN", join(dir, "xurl"));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

function stubFetch() {
  const fetchStub = vi.fn(async (_url: string, _init: RequestInit) => new Response('{"data":{}}', { status: 200 }));
  vi.stubGlobal("fetch", fetchStub);
  return fetchStub;
}

it("sends the token from xurl to X and to nowhere else by default", async () => {
  vi.stubEnv("X_AXI_API_BASE", "");
  const fetchStub = stubFetch();
  await httpClient.request("GET", "/2/users/me");
  const [url, init] = fetchStub.mock.calls[0]!;
  expect(url).toBe("https://api.x.com/2/users/me");
  expect(init.headers).toMatchObject({ Authorization: "Bearer REAL_TOKEN" });
});

it("sends a fixed test token, never the real one, to a loopback override", async () => {
  vi.stubEnv("X_AXI_API_BASE", "http://127.0.0.1:9999");
  const fetchStub = stubFetch();
  await httpClient.request("GET", "/2/users/me");
  const [url, init] = fetchStub.mock.calls[0]!;
  expect(url).toBe("http://127.0.0.1:9999/2/users/me");
  expect(init.headers).toMatchObject({ Authorization: "Bearer x-axi-test-token" });
});
