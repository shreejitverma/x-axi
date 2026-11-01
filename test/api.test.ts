import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { createHttpClient } from "../src/api.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function stubFetch() {
  const fetchStub = vi.fn(async (_url: string, _init: RequestInit) => new Response('{"data":{}}', { status: 200 }));
  vi.stubGlobal("fetch", fetchStub);
  return fetchStub;
}

it("sends the stored access token to X and to nowhere else by default", async () => {
  vi.stubEnv("X_AXI_API_BASE", "");
  const fetchStub = stubFetch();
  const accessToken = vi.fn(async () => "REAL_TOKEN");
  await createHttpClient(accessToken).request("GET", "/2/users/me");
  const [url, init] = fetchStub.mock.calls[0]!;
  expect(url).toBe("https://api.x.com/2/users/me");
  expect(init.headers).toMatchObject({ Authorization: "Bearer REAL_TOKEN" });
  expect(accessToken).toHaveBeenCalledTimes(1);
});

it("sends a fixed test token, never the real one, to a loopback override, without asking for a token", async () => {
  vi.stubEnv("X_AXI_API_BASE", "http://127.0.0.1:9999");
  const fetchStub = stubFetch();
  const accessToken = vi.fn(async () => "REAL_TOKEN");
  await createHttpClient(accessToken).request("GET", "/2/users/me");
  const [url, init] = fetchStub.mock.calls[0]!;
  expect(url).toBe("http://127.0.0.1:9999/2/users/me");
  expect(init.headers).toMatchObject({ Authorization: "Bearer x-axi-test-token" });
  expect(accessToken).not.toHaveBeenCalled();
});

it("never puts a malformed token in a header, and never echoes it", async () => {
  vi.stubEnv("X_AXI_API_BASE", "");
  const fetchStub = stubFetch();
  const error = await createHttpClient(async () => "SECRET_TOKEN_VALUE\nsecond line").request("GET", "/2/users/me").then(
    () => { throw new Error("expected rejection"); },
    (e: { code: string; message: string; suggestions: string[] }) => e,
  );
  expect(error.code).toBe("AUTH_REQUIRED");
  expect(JSON.stringify(error)).not.toContain("SECRET_TOKEN_VALUE");
  expect(error.message).not.toContain("SECRET_TOKEN_VALUE");
  expect(fetchStub).not.toHaveBeenCalled();
});

it("sends a FormData body as real multipart over loopback, with the bytes intact and no JSON content type", async () => {
  let contentType: string | undefined;
  let received = Buffer.alloc(0);
  const server = createServer((req, res) => {
    contentType = req.headers["content-type"];
    const parts: Buffer[] = [];
    req.on("data", (part: Buffer) => parts.push(part));
    req.on("end", () => {
      received = Buffer.concat(parts);
      res.end('{"data":{"expires_at":1}}');
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  try {
    vi.stubEnv("X_AXI_API_BASE", `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    const form = new FormData();
    form.append("segment_index", "3");
    form.append("media", new Blob([Buffer.from([0, 255, 13, 10, 7])]), "clip.mp4");
    const response = await createHttpClient(async () => "unused").request("POST", "/2/media/upload/777/append", form);
    expect(response).toEqual({ status: 200, body: { data: { expires_at: 1 } } });
    expect(contentType).toMatch(/^multipart\/form-data; boundary=/);
    expect(received.toString("latin1")).toContain('name="segment_index"\r\n\r\n3\r\n');
    expect(received.toString("latin1")).toContain('name="media"; filename="clip.mp4"');
    expect(received.includes(Buffer.from([0, 255, 13, 10, 7]))).toBe(true);
  } finally {
    server.close();
  }
});

it("reports a network failure by name, without the request", async () => {
  vi.stubEnv("X_AXI_API_BASE", "");
  vi.stubGlobal("fetch", vi.fn(async () => { throw Object.assign(new TypeError("fetch failed: Authorization: Bearer REAL_TOKEN"), { cause: { code: "ENOTFOUND" } }); }));
  await expect(createHttpClient(async () => "REAL_TOKEN").request("GET", "/2/users/me")).rejects.toThrow("network failure: ENOTFOUND");
});
