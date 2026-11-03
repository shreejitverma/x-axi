import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResponse, Json, Method, XClient } from "../src/api.js";
import { formatApproval, linuxApprovalText, type ApprovalRequest, type ApprovalResult } from "../src/approve.js";
import type { AuthService } from "../src/auth.js";
import { buildCommands } from "../src/commands.js";

type Call = { method: Method; path: string; body?: Json | FormData };
const ok = (body: Json, status = 200): ApiResponse => ({ status, body });
const PARENT = ok({ data: { id: "50", text: "parent text", author_id: "9" }, includes: { users: [{ id: "9", username: "alice" }] } });

function harness(handler: (call: Call) => ApiResponse | Promise<ApiResponse>, approval: ApprovalResult = "approved", scopes = ["tweet.write", "media.write"]) {
  const calls: Call[] = [];
  const events: string[] = [];
  const client: XClient = {
    request: async (method, path, body) => {
      const call: Call = { method, path, ...(body ? { body } : {}) };
      calls.push(call);
      events.push(`${method} ${path}`);
      if (path === "/2/users/me") return ok({ data: { id: "1", username: "shreejit" } });
      return handler(call);
    },
  };
  const requests: ApprovalRequest[] = [];
  const approve = vi.fn(async (request: ApprovalRequest) => {
    requests.push(request);
    events.push("approval");
    return approval;
  });
  const auth: AuthService = {
    accessToken: async () => "fake",
    login: () => Promise.reject(new Error("unused")),
    logout: () => Promise.reject(new Error("unused")),
    status: async () => ({ logged_in: true, storage: "fake", scopes }),
  };
  const sleeps: number[] = [];
  const sleep = async (ms: number) => {
    sleeps.push(ms);
  };
  return {
    commands: buildCommands({ client, approve, auth, sleep }),
    calls,
    events,
    requests,
    approve,
    sleeps,
    writes: () => calls.filter((c) => c.method !== "GET"),
    reads: () => calls.filter((c) => c.method === "GET"),
  };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "x-axi-tools-"));
  process.env["X_AXI_STATE_DIR"] = dir;
  process.env["XDG_CONFIG_HOME"] = join(dir, "config");
});
afterEach(() => {
  delete process.env["X_AXI_STATE_DIR"];
  delete process.env["XDG_CONFIG_HOME"];
  rmSync(dir, { recursive: true, force: true });
});

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ftyp = (brand: string): Buffer => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from(`ftyp${brand}`)]);
const MP4_HEADER = ftyp("mp42");
const EBML_MAGIC = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
const EBML_VERSIONS = [0x4286, 0x42f7, 0x42f2, 0x42f3].flatMap((id) => [id >> 8, id & 0xff, 0x81, id === 0x42f2 ? 4 : id === 0x42f3 ? 8 : 1]);
// EBML layouts from the Matroska spec: the header size as one byte (libwebm) or eight (FFmpeg).
const ebml = (docType: string, longSize = false): Buffer => {
  const body = Buffer.concat([Buffer.from(EBML_VERSIONS), Buffer.from([0x42, 0x82, 0x80 | docType.length]), Buffer.from(docType)]);
  const size = longSize ? Buffer.from([0x01, 0, 0, 0, 0, 0, 0, body.length]) : Buffer.from([0x80 | body.length]);
  return Buffer.concat([EBML_MAGIC, size, body]);
};

function file(name: string, header: Buffer, size: number): string {
  const path = join(dir, name);
  const bytes = Buffer.alloc(size);
  // Position-dependent bytes, so a misordered or overlapping chunk changes the result.
  for (let i = 0; i < size; i += 1) bytes[i] = i % 251;
  header.copy(bytes);
  writeFileSync(path, bytes);
  return path;
}

/** A fake of the documented upload flow, finishing with no processing step unless told otherwise. */
function mediaApi(finalize: Json = { id: "777" }, overrides: (call: Call) => ApiResponse | undefined = () => undefined) {
  return (call: Call): ApiResponse => {
    const special = overrides(call);
    if (special) return special;
    if (call.path === "/2/media/upload/initialize") return ok({ data: { id: "777", expires_after_secs: 86400 } });
    if (call.path === "/2/media/upload/777/append") return ok({ data: { expires_at: 1 } });
    if (call.path === "/2/media/upload/777/finalize") return ok({ data: finalize });
    if (call.path === "/2/tweets") return ok({ data: { id: "60" } }, 201);
    if (call.method === "GET") return PARENT;
    return ok({}, 500);
  };
}

const EVERY_WRITE: [string, string[]][] = [
  ["post", ["post", "hello"]],
  ["post --quote", ["post", "hello", "--quote", "50"]],
  ["reply", ["reply", "50", "hello"]],
  ["thread", ["thread", "one", "two"]],
  ["delete", ["delete", "50"]],
  ["hide", ["hide", "50"]],
  ["unhide", ["unhide", "50"]],
  ["repost", ["repost", "50"]],
  ["unrepost", ["unrepost", "50"]],
  ["follow", ["follow", "alice"]],
  ["unfollow", ["unfollow", "alice"]],
  ["dm send", ["dm", "send", "alice", "hi"]],
];

function lookupOrParent(call: Call): ApiResponse {
  return call.path.startsWith("/2/users/by/username/") ? ok({ data: { id: "9", username: "alice" } }) : PARENT;
}

describe("the new writes need approval", () => {
  for (const result of ["cancelled", "timed_out", "unavailable"] as const) {
    it.each([
      ["thread", () => ["thread", "one", "two"]],
      ["post --quote", () => ["post", "hello", "--quote", "50"]],
      ["post --media", () => ["post", "hello", "--media", file("a.png", PNG_HEADER, 100)]],
      ["reply --media", () => ["reply", "50", "hello", "--media", file("a.png", PNG_HEADER, 100)]],
      ["repost", () => ["repost", "50"]],
      ["unrepost", () => ["unrepost", "50"]],
    ])(`%s sends nothing when approval is ${result}`, async (_name, argv) => {
      const h = harness(lookupOrParent, result);
      const [command, ...args] = argv();
      await expect(h.commands[command!]!(args)).rejects.toMatchObject({ code: result === "unavailable" ? "APPROVAL_UNAVAILABLE" : "NOT_APPROVED" });
      expect(h.approve).toHaveBeenCalledTimes(1);
      expect(h.writes()).toEqual([]);
    });
  }
});

describe("--dry-run", () => {
  it.each(EVERY_WRITE)("%s writes nothing, asks nothing, and says reads are billed", async (_name, [command, ...args]) => {
    const h = harness(lookupOrParent);
    const out = (await h.commands[command!]!([...args, "--dry-run"])) as { dry_run: { would_send: unknown[]; write_est_cost: string }; est_cost: string; help: string[] };
    expect(h.writes()).toEqual([]);
    expect(h.approve).not.toHaveBeenCalled();
    expect(out.dry_run.would_send.length).toBeGreaterThan(0);
    expect(out.dry_run.write_est_cost).toBeDefined();
    // Every path here validates with at least the account read, which is billed.
    expect(Number(out.est_cost.slice(1))).toBeGreaterThan(0);
    expect(out.help.join(" ")).toContain("bills");
  });

  it("shows the exact request a post would send, and its cost", async () => {
    const h = harness(() => ok({}));
    const out = (await h.commands["post"]!(["see https://example.com", "--dry-run"])) as { dry_run: { would_send: unknown[]; write_est_cost: string } };
    expect(out.dry_run.would_send).toEqual([{ method: "POST", path: "/2/tweets", body: { text: "see https://example.com" } }]);
    expect(out.dry_run.write_est_cost).toBe("$0.200");
  });

  it("still validates: bad text fails before any read", async () => {
    const h = harness(() => ok({}));
    await expect(h.commands["post"]!(["safe‮text", "--dry-run"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(h.calls).toEqual([]);
  });

  it("follow-file names the batch and sends nothing", async () => {
    const queue = join(dir, "q.json");
    writeFileSync(queue, JSON.stringify([{ id: "9", username: "alice" }, { id: "10", username: "bob" }]));
    const h = harness(() => ok({}));
    const out = (await h.commands["follow-file"]!([queue, "--max", "1", "--dry-run"])) as { dry_run: { batch: unknown[]; remaining_after: number; write_est_cost: string } };
    expect(out.dry_run.batch).toEqual([{ id: "9", username: "alice" }]);
    expect(out.dry_run.remaining_after).toBe(1);
    expect(out.dry_run.write_est_cost).toBe("$0.015");
    expect(h.writes()).toEqual([]);
    expect(h.approve).not.toHaveBeenCalled();
  });

  it("media is inspected and reported, and not one byte is uploaded", async () => {
    const path = file("clip.mp4", MP4_HEADER, 5_000_001);
    const h = harness(() => ok({}));
    const out = (await h.commands["post"]!(["hi", "--media", path, "--dry-run"])) as { dry_run: { media: string; would_send: Json[] } };
    expect(out.dry_run.media).toContain("clip.mp4 (video/mp4, 5.0 MB)");
    expect(out.dry_run.would_send[0]).toMatchObject({ path: "/2/media/upload/initialize", body: { media_type: "video/mp4", total_bytes: 5_000_001, media_category: "tweet_video" } });
    expect(out.dry_run.would_send[1]).toMatchObject({ chunks: 2 });
    expect(h.writes()).toEqual([]);
  });

  it("a post that is already gone stays a no-op", async () => {
    const h = harness(() => ok({ errors: [{ title: "Not Found Error" }] }));
    await expect(h.commands["delete"]!(["50", "--dry-run"])).resolves.toMatchObject({ post: { status: "already gone (no-op)" } });
  });
});

describe("thread", () => {
  let next: number;
  beforeEach(() => {
    next = 100;
  });
  const posting = (fail?: (index: number) => ApiResponse | Error | undefined) => {
    let index = 0;
    return (): ApiResponse => {
      const failure = fail?.(index);
      index += 1;
      if (failure instanceof Error) throw failure;
      if (failure) return failure;
      next += 1;
      return ok({ data: { id: String(next) } }, 201);
    };
  };

  it("asks once, shows every part and the total, and chains each reply to the part before", async () => {
    const h = harness(posting());
    const out = await h.commands["thread"]!(["first", "second", "third"]);
    expect(h.approve).toHaveBeenCalledTimes(1);
    const shown = formatApproval(h.requests[0]!);
    for (const part of ["first", "second", "third"]) expect(shown).toContain(part);
    expect(h.requests[0]!.estCostUsd).toBeCloseTo(0.045);
    expect(h.writes().map((c) => c.body)).toEqual([
      { text: "first" },
      { text: "second", reply: { in_reply_to_tweet_id: "101" } },
      { text: "third", reply: { in_reply_to_tweet_id: "102" } },
    ]);
    expect(out).toMatchObject({ thread: { status: "published", total: 3 }, est_cost: "$0.045" });
  });

  it("prices each part through the URL rule", async () => {
    const h = harness(posting());
    await h.commands["thread"]!(["plain", "see https://example.com"]);
    expect(h.requests[0]!.estCostUsd).toBeCloseTo(0.215);
  });

  it("stops at a refused part, reports what posted and that this one did not, and never retries", async () => {
    const h = harness(posting((i) => (i === 1 ? ok({ detail: "You are not allowed" }, 403) : undefined)));
    const out = (await h.commands["thread"]!(["first", "second", "third"])) as Record<string, Json>;
    expect(h.writes()).toHaveLength(2);
    expect(out["thread"]).toMatchObject({ status: "stopped early", posted: [{ part: 1, id: "101" }], total: 3 });
    expect(out["stopped"]).toMatchObject({ part: 2, outcome: "not posted", code: "FORBIDDEN", not_attempted: 1 });
    expect(out["est_cost"]).toBe("$0.015");
  });

  it.each([
    ["a dropped connection", () => new Error("socket hang up")],
    ["a 5xx", () => ok({ title: "Service Unavailable" }, 503)],
    ["a 2xx without an ID", () => ok({}, 201)],
  ])("reports the outcome of the part as unknown after %s, and bills it", async (_name, failure) => {
    const h = harness(posting((i) => (i === 1 ? failure() : undefined)));
    const out = (await h.commands["thread"]!(["first", "second", "third"])) as Record<string, Json>;
    expect(h.writes()).toHaveLength(2);
    expect(out["stopped"]).toMatchObject({ part: 2, code: "OUTCOME_UNKNOWN" });
    expect(String((out["stopped"] as Json)["outcome"])).toContain("unknown");
    expect(out["est_cost"]).toBe("$0.030");
  });

  it("fails as an ordinary error when the first part fails, since nothing is public", async () => {
    const h = harness(posting(() => ok({ detail: "You are not allowed" }, 403)));
    await expect(h.commands["thread"]!(["first", "second"])).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(h.writes()).toHaveLength(1);
  });

  it("refuses one part, an invalid part, and a thread too long to review, before any call", async () => {
    const h = harness(posting());
    await expect(h.commands["thread"]!(["only"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(h.commands["thread"]!(["ok", "bad‮part"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(h.commands["thread"]!(Array.from({ length: 21 }, (_, i) => `part ${i}`))).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(h.calls).toEqual([]);
  });
});

describe("post --quote", () => {
  it("shows the quoted post and sends quote_tweet_id", async () => {
    const h = harness((c) => (c.method === "GET" ? PARENT : ok({ data: { id: "60" } }, 201)));
    await h.commands["post"]!(["my take", "--quote", "https://x.com/alice/status/50"]);
    expect(formatApproval(h.requests[0]!)).toContain("Quoting @alice: parent text");
    expect(h.requests[0]!.estCostUsd).toBe(0.015);
    expect(h.writes()[0]!.body).toEqual({ text: "my take", quote_tweet_id: "50" });
  });

  it("names the Enterprise requirement when X refuses", async () => {
    const h = harness((c) => (c.method === "GET" ? PARENT : ok({ detail: "not permitted" }, 403)));
    const error = await h.commands["post"]!(["my take", "--quote", "50"]).catch((e: { code: string; suggestions: string[] }) => e) as { code: string; suggestions: string[] };
    expect(error.code).toBe("FORBIDDEN");
    expect(error.suggestions.join(" ")).toContain("Enterprise");
  });

  it("names the Enterprise requirement when X refuses with the client-forbidden shape, and only for a quote", async () => {
    const refused = (c: Call): ApiResponse => (c.method === "GET" ? PARENT : ok({ detail: "client-forbidden" }, 403));
    const quoted = await harness(refused).commands["post"]!(["my take", "--quote", "50"]).catch((e: { code: string; suggestions: string[] }) => e) as { code: string; suggestions: string[] };
    expect(quoted.code).toBe("APP_NOT_ENROLLED");
    expect(quoted.suggestions.join(" ")).toContain("Enterprise");
    const plain = await harness(refused).commands["post"]!(["my take"]).catch((e: { code: string; suggestions: string[] }) => e) as { code: string; suggestions: string[] };
    expect(plain.code).toBe("APP_NOT_ENROLLED");
    expect(plain.suggestions.join(" ")).not.toContain("Enterprise");
  });

  it("refuses a missing post before the dialog", async () => {
    const h = harness(() => ok({ errors: [{ title: "Not Found Error" }] }));
    await expect(h.commands["post"]!(["my take", "--quote", "50"])).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(h.approve).not.toHaveBeenCalled();
  });
});

describe("post --media", () => {
  const appends = (calls: Call[]) => calls.filter((c) => c.path.endsWith("/append"));

  it.each([
    ["one byte under a chunk", 4_999_999, [4_999_999]],
    ["exactly one chunk", 5_000_000, [5_000_000]],
    ["one byte over one chunk", 5_000_001, [5_000_000, 1]],
    ["exactly two chunks", 10_000_000, [5_000_000, 5_000_000]],
    ["exactly three chunks", 15_000_000, [5_000_000, 5_000_000, 5_000_000]],
  ])("splits %s", async (_name, size, expected) => {
    const path = file("clip.mp4", MP4_HEADER, size);
    const h = harness(mediaApi());
    await h.commands["post"]!(["hi", "--media", path]);
    const forms = appends(h.calls).map((c) => c.body as FormData);
    expect(forms.map((f) => (f.get("media") as File).size)).toEqual(expected);
    expect(forms.map((f) => f.get("segment_index"))).toEqual(expected.map((_, i) => String(i)));
    const rebuilt = Buffer.concat(await Promise.all(forms.map(async (f) => Buffer.from(await (f.get("media") as File).arrayBuffer()))));
    expect(rebuilt.equals(readFileSync(path))).toBe(true);
  });

  it("runs the documented sequence, after approval and in order, and attaches the ID", async () => {
    const path = file("photo.png", PNG_HEADER, 1000);
    const h = harness(mediaApi());
    const out = await h.commands["post"]!(["hi", "--media", path]);
    expect(h.events).toEqual([
      "GET /2/users/me",
      "approval",
      "POST /2/media/upload/initialize",
      "POST /2/media/upload/777/append",
      "POST /2/media/upload/777/finalize",
      "POST /2/tweets",
    ]);
    expect(h.calls.find((c) => c.path.endsWith("initialize"))!.body).toEqual({ media_type: "image/png", total_bytes: 1000, media_category: "tweet_image" });
    expect(h.writes().at(-1)!.body).toEqual({ text: "hi", media: { media_ids: ["777"] } });
    expect(out).toMatchObject({ post: { id: "60", status: "published" } });
  });

  it("tells apart files with the same name in different directories, in the dialog and the dry run", async () => {
    mkdirSync(join(dir, "public"));
    mkdirSync(join(dir, "private"));
    const shown = await Promise.all(["public", "private"].map(async (folder) => {
      const path = file(join(folder, "photo.png"), PNG_HEADER, 100);
      const h = harness(mediaApi());
      await h.commands["post"]!(["hi", "--media", path]);
      const dry = await h.commands["post"]!(["hi", "--media", path, "--dry-run"]);
      expect(String((dry["dry_run"] as Json)["media"])).toContain(path);
      expect(h.calls.find((c) => c.path.endsWith("/append"))!.body).toBeInstanceOf(FormData);
      expect(((h.calls.find((c) => c.path.endsWith("/append"))!.body as FormData).get("media") as File).name).toBe("photo.png");
      return formatApproval(h.requests[0]!);
    }));
    expect(shown[0]).toContain(join(dir, "public", "photo.png"));
    expect(shown[1]).toContain(join(dir, "private", "photo.png"));
  });

  it("shows where a relative path points, and keeps both ends of a very long one", async () => {
    const path = file("photo.png", PNG_HEADER, 100);
    const h = harness(mediaApi());
    await h.commands["post"]!(["hi", "--media", relative(process.cwd(), path)]);
    expect(formatApproval(h.requests[0]!)).toContain(path);

    const deep = join(dir, "a".repeat(200));
    mkdirSync(deep);
    const long = harness(mediaApi());
    await long.commands["post"]!(["hi", "--media", file(join("a".repeat(200), "b".repeat(100) + "-end.png"), PNG_HEADER, 100)]);
    const shown = formatApproval(long.requests[0]!);
    expect(shown).toContain("-end.png (image/png");
    expect(shown).toContain(dir.slice(0, 20));
    expect(shown).toContain("characters in full");
  });

  it("shows the file name, type, and size in the dialog", async () => {
    const path = file("photo.png", PNG_HEADER, 2_400_000);
    const h = harness(mediaApi());
    await h.commands["post"]!(["hi", "--media", path]);
    const shown = formatApproval(h.requests[0]!);
    expect(shown).toContain("photo.png");
    expect(shown).toContain("image/png");
    expect(shown).toContain("2.4 MB");
  });

  it("uses the GIF category for a GIF, and may post media with no text", async () => {
    const path = file("loop.gif", Buffer.from("GIF89a"), 6_000_000);
    const h = harness(mediaApi());
    await h.commands["post"]!(["--media", path]);
    expect(h.calls.find((c) => c.path.endsWith("initialize"))!.body).toMatchObject({ media_type: "image/gif", media_category: "tweet_gif" });
    expect(h.writes().at(-1)!.body).toEqual({ media: { media_ids: ["777"] } });
  });

  it("works on a reply", async () => {
    const path = file("photo.png", PNG_HEADER, 100);
    const h = harness(mediaApi());
    await h.commands["reply"]!(["50", "hi", "--media", path]);
    expect(h.writes().at(-1)!.body).toEqual({ text: "hi", reply: { in_reply_to_tweet_id: "50" }, media: { media_ids: ["777"] } });
  });

  it.each([
    ["an image over 5 MiB", () => file("big.png", PNG_HEADER, 5 * 1024 * 1024 + 1)],
    ["a GIF over 15 MiB", () => file("big.gif", Buffer.from("GIF89a"), 15 * 1024 * 1024 + 1)],
    ["an unknown type", () => file("notes.png", Buffer.from("hello world"), 100)],
    ["a renamed file", () => file("clip.png", MP4_HEADER, 100)],
    ["a HEIC photo", () => file("photo.heic", ftyp("heic"), 100)],
    ["a HEIC photo renamed to .mp4", () => file("photo.mp4", ftyp("heic"), 100)],
    ["an AVIF image renamed to .mp4", () => file("photo.mp4", ftyp("avif"), 100)],
    ["an M4A audio file renamed to .mp4", () => file("song.mp4", ftyp("M4A "), 100)],
    ["a 3GP video renamed to .mp4", () => file("clip.mp4", ftyp("3gp4"), 100)],
    ["a Matroska video", () => file("clip.mkv", ebml("matroska"), 100)],
    ["a Matroska video renamed to .webm", () => file("clip.webm", ebml("matroska"), 100)],
    ["an EBML file with no DocType", () => file("clip.webm", EBML_MAGIC, 100)],
    ["an empty file", () => file("none.png", Buffer.alloc(0), 0)],
    ["a missing file", () => join(dir, "missing.png")],
    ["a directory", () => dir],
  ])("refuses %s before any spend or dialog", async (_name, path) => {
    const h = harness(mediaApi());
    await expect(h.commands["post"]!(["hi", "--media", path()])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(h.calls).toEqual([]);
    expect(h.approve).not.toHaveBeenCalled();
  });

  it.each([
    ["isom", "clip.mp4", ftyp("isom"), "video/mp4"],
    ["iso5", "clip.mp4", ftyp("iso5"), "video/mp4"],
    ["mp41", "clip.mp4", ftyp("mp41"), "video/mp4"],
    ["avc1", "clip.mp4", ftyp("avc1"), "video/mp4"],
    ["M4V", "clip.m4v", ftyp("M4V "), "video/mp4"],
    ["qt", "clip.mov", ftyp("qt  "), "video/quicktime"],
    ["WebM with a one-byte header size", "clip.webm", ebml("webm"), "video/webm"],
    ["WebM with an eight-byte header size", "clip.webm", ebml("webm", true), "video/webm"],
  ])("detects %s", async (_name, name, header, mediaType) => {
    const h = harness(mediaApi());
    await h.commands["post"]!(["hi", "--media", file(name, header, 100)]);
    expect(h.calls.find((c) => c.path.endsWith("initialize"))!.body).toMatchObject({ media_type: mediaType, media_category: "tweet_video" });
  });

  it.each([
    ["HEIC", "photo.heic", ftyp("heic")],
    ["Matroska", "clip.mkv", ebml("matroska")],
  ])("does not advise renaming %s to a type it is not", async (_name, name, header) => {
    const h = harness(mediaApi());
    const error = await h.commands["post"]!(["hi", "--media", file(name, header, 100)]).catch((e: Error) => e);
    expect((error as Error).message).toContain("not a supported file");
    expect((error as Error).message).not.toContain("rename");
  });

  it("accepts an image at exactly the limit", async () => {
    const path = file("edge.png", PNG_HEADER, 5 * 1024 * 1024);
    const h = harness(mediaApi());
    await expect(h.commands["post"]!(["hi", "--media", path])).resolves.toMatchObject({ post: { id: "60" } });
  });

  it("refuses a login without media.write before any spend or dialog, and says how to fix it", async () => {
    const path = file("photo.png", PNG_HEADER, 100);
    const h = harness(mediaApi(), "approved", ["tweet.write"]);
    const error = await h.commands["post"]!(["hi", "--media", path]).catch((e: { code: string; suggestions: string[] }) => e) as { code: string; suggestions: string[] };
    expect(error.code).toBe("MISSING_SCOPE");
    expect(error.suggestions.join(" ")).toContain("x-axi login");
    expect(h.calls).toEqual([]);
  });

  it("refuses two --media flags rather than dropping one", async () => {
    const h = harness(mediaApi());
    await expect(h.commands["post"]!(["hi", "--media", "a.png", "--media", "b.png"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(h.calls).toEqual([]);
  });

  it("polls status while processing, waiting as long as X asks, then posts", async () => {
    const path = file("clip.mp4", MP4_HEADER, 100);
    const states = [{ state: "in_progress", check_after_secs: 7 }, { state: "succeeded" }];
    const h = harness(mediaApi({ id: "777", processing_info: { state: "pending", check_after_secs: 3 } }, (c) =>
      c.method === "GET" && c.path.startsWith("/2/media/upload") ? ok({ data: { id: "777", processing_info: states.shift() } }) : undefined,
    ));
    await h.commands["post"]!(["hi", "--media", path]);
    expect(h.sleeps).toEqual([3000, 7000]);
    expect(h.reads().map((c) => c.path).filter((p) => p.startsWith("/2/media"))).toEqual(Array(2).fill("/2/media/upload?command=STATUS&media_id=777"));
    expect(h.writes().at(-1)!.path).toBe("/2/tweets");
  });

  it("posts nothing when processing fails", async () => {
    const path = file("clip.mp4", MP4_HEADER, 100);
    const h = harness(mediaApi({ id: "777", processing_info: { state: "failed" } }));
    await expect(h.commands["post"]!(["hi", "--media", path])).rejects.toMatchObject({ code: "MEDIA_FAILED", message: expect.stringContaining("nothing was posted") });
    expect(h.writes().map((c) => c.path)).not.toContain("/2/tweets");
  });

  it("gives up on endless processing, and posts nothing", async () => {
    const path = file("clip.mp4", MP4_HEADER, 100);
    const pending = { state: "in_progress", check_after_secs: 60 };
    const h = harness(mediaApi({ id: "777", processing_info: pending }, (c) => (c.method === "GET" && c.path.startsWith("/2/media/upload") ? ok({ data: { id: "777", processing_info: pending } }) : undefined)));
    await expect(h.commands["post"]!(["hi", "--media", path])).rejects.toMatchObject({ code: "MEDIA_TIMEOUT" });
    expect(h.sleeps).toHaveLength(10);
    expect(h.writes().map((c) => c.path)).not.toContain("/2/tweets");
  });

  it("stops at a failed chunk, never retries it, and says nothing was posted", async () => {
    const path = file("clip.mp4", MP4_HEADER, 10_000_000);
    let chunks = 0;
    const h = harness(mediaApi({ id: "777" }, (c) => {
      if (!c.path.endsWith("/append")) return undefined;
      chunks += 1;
      if (chunks === 2) throw new Error("socket hang up");
      return undefined;
    }));
    await expect(h.commands["post"]!(["hi", "--media", path])).rejects.toMatchObject({ code: "MEDIA_UPLOAD_FAILED", message: expect.stringContaining("nothing was posted") });
    expect(chunks).toBe(2);
    expect(h.writes().map((c) => c.path)).not.toContain("/2/tweets");
  });

  it("refuses a file that changed after the dialog", async () => {
    const path = file("photo.png", PNG_HEADER, 100);
    const h = harness(mediaApi());
    h.approve.mockImplementationOnce(async () => {
      writeFileSync(path, Buffer.concat([PNG_HEADER, Buffer.alloc(500)]));
      return "approved";
    });
    await expect(h.commands["post"]!(["hi", "--media", path])).rejects.toMatchObject({ message: expect.stringContaining("changed after") });
    expect(h.writes().map((c) => c.path)).not.toContain("/2/tweets");
  });

  it("explains a post refused after the upload", async () => {
    const path = file("clip.mp4", MP4_HEADER, 100);
    const h = harness(mediaApi({ id: "777" }, (c) => (c.path === "/2/tweets" ? ok({ detail: "video too long" }, 403) : undefined)));
    const error = await h.commands["post"]!(["hi", "--media", path]).catch((e: { code: string; suggestions: string[] }) => e) as { code: string; suggestions: string[] };
    expect(error.code).toBe("FORBIDDEN");
    expect(error.suggestions.join(" ")).toContain("Media 777");
  });

  it("records upload calls as unpriced in the ledger", async () => {
    const path = file("photo.png", PNG_HEADER, 100);
    const h = harness(mediaApi());
    await h.commands["post"]!(["hi", "--media", path]);
    const ledger = readFileSync(join(dir, "ledger.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as { op: string; usd: number | null });
    expect(ledger.filter((e) => e.op === "media_upload").map((e) => e.usd)).toEqual([null, null, null]);
    expect(ledger.find((e) => e.op === "post")!.usd).toBe(0.015);
  });
});

describe("--dry-run and the Linux dialog", () => {
  const long = "word ".repeat(200).trim();
  const short = "hello";
  const parts = (count: number): string[] => Array.from({ length: count }, (_, i) => `part ${i + 1}`);
  const posts = (c: Call): ApiResponse => (c.method === "GET" ? PARENT : c.path.includes("/dm_conversations") ? ok({ data: { dm_event_id: "9" } }) : ok({ data: { id: "60" } }, 201));

  it.each([
    ["a post that fits", ["post", short], false],
    ["a post that does not", ["post", long], true],
    ["a reply that does not", ["reply", "50", long], true],
    ["a quote that does not", ["post", long, "--quote", "50"], true],
    ["a DM that does not", ["dm", "send", "bob", long], true],
    ["a thread of 8 short parts", ["thread", ...parts(8)], false],
    ["a thread of 9 short parts", ["thread", ...parts(9)], true],
  ])("agrees with the dialog the real run would open: %s", async (_name, argv, tooLong) => {
    const [name, ...args] = argv as [string, ...string[]];
    const real = harness(name === "dm" ? (c) => (c.path.includes("/by/username/") ? ok({ data: { id: "2", username: "bob" } }) : posts(c)) : posts);
    await real.commands[name]!(args);
    // The request the gate really sends decides, read by the code that picks the Linux refusal.
    expect(linuxApprovalText(real.requests[0]!) === null).toBe(tooLong);

    const dry = harness(name === "dm" ? (c) => (c.path.includes("/by/username/") ? ok({ data: { id: "2", username: "bob" } }) : posts(c)) : posts);
    const out = await dry.commands[name]!([...args, "--dry-run"]);
    expect(dry.approve).not.toHaveBeenCalled();
    expect(dry.writes()).toEqual([]);
    expect("linux_dialog" in (out["dry_run"] as Json)).toBe(tooLong);
    expect((out["help"] as string[]).join(" ").includes("shorten the text")).toBe(tooLong);
  });

  it("names the refusal the real run gives", async () => {
    const out = await harness(posts).commands["post"]!([long, "--dry-run"]);
    expect((out["dry_run"] as Json)["linux_dialog"]).toContain("APPROVAL_TEXT_TOO_LONG");
  });

  it("does not report media with no text, because that dialog cannot refuse", async () => {
    const h = harness(mediaApi());
    const out = await h.commands["post"]!(["--media", file("photo.png", PNG_HEADER, 100), "--dry-run"]);
    expect("linux_dialog" in (out["dry_run"] as Json)).toBe(false);
  });
});

describe("repost and unrepost", () => {
  it("reposts with the documented request, showing the post", async () => {
    const h = harness((c) => (c.method === "GET" ? PARENT : ok({ data: { rest_id: "50", retweeted: true } })));
    await expect(h.commands["repost"]!(["50"])).resolves.toMatchObject({ post: { id: "50", status: "reposted" } });
    expect(formatApproval(h.requests[0]!)).toContain("@alice: parent text");
    expect(h.requests[0]!.estCostUsd).toBeNull();
    expect(h.writes()[0]).toEqual({ method: "POST", path: "/2/users/1/retweets", body: { tweet_id: "50" } });
  });

  it("unreposts with the documented request", async () => {
    const h = harness((c) => (c.method === "GET" ? PARENT : ok({ data: { retweeted: false } })));
    await expect(h.commands["unrepost"]!(["50"])).resolves.toMatchObject({ post: { status: "not reposted" } });
    expect(h.writes()[0]).toEqual({ method: "DELETE", path: "/2/users/1/retweets/50" });
  });

  it("reports an unknown outcome when X does not confirm", async () => {
    const h = harness((c) => (c.method === "GET" ? PARENT : ok({ data: { retweeted: false } })));
    await expect(h.commands["repost"]!(["50"])).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
  });

  it.each([
    ["repost", "no confirmation", { data: { retweeted: false } }, 200],
    ["repost", "a server failure", { detail: "boom" }, 503],
    ["unrepost", "no confirmation", { data: { retweeted: true } }, 200],
    ["unrepost", "a server failure", { detail: "boom" }, 503],
  ] as const)("after %s and %s, names a check that shows this account's reposts", async (command, _case, body, status) => {
    const h = harness((c) => (c.method === "GET" ? PARENT : ok(body, status)));
    const error = await h.commands[command]!(["50"]).catch((e: { code: string; suggestions: string[] }) => e) as { code: string; suggestions: string[] };
    expect(error.code).toBe("OUTCOME_UNKNOWN");
    expect(error.suggestions[0]).toContain("https://x.com/shreejit");
    expect(error.suggestions[0]).not.toContain("x-axi view 50");
  });
});

describe("following and followers", () => {
  const user = (id: number, extra: Json = {}): Json => ({ id: String(id), username: `user${id}`, name: `User ${id}`, ...extra });

  /** A fake list that honours max_results and pagination_token, as a real one would. */
  const lists = (accounts: Record<string, { counts?: Json; following?: Json[]; followers?: Json[] }>) => {
    const pages = (rows: Json[], query: URLSearchParams): ApiResponse => {
      const size = Number(query.get("max_results"));
      const start = Number(query.get("pagination_token")?.replace("token", "") ?? 0);
      const data = rows.slice(start, start + size);
      const next = start + size < rows.length ? `token${start + size}` : undefined;
      return ok({ ...(data.length ? { data } : {}), meta: { result_count: data.length, ...(next ? { next_token: next } : {}) } });
    };
    return (call: Call): ApiResponse => {
      const url = new URL(call.path, "http://x");
      const me = url.pathname === "/2/users/me";
      const byName = url.pathname.match(/^\/2\/users\/by\/username\/(\w+)$/)?.[1];
      if (me || byName) {
        const key = me ? "1" : Object.keys(accounts).find((id) => accounts[id]!.counts?.["username"] === byName);
        const account = key ? accounts[key] : undefined;
        if (!account) return ok({ errors: [{ title: "Not Found Error" }] });
        const { username, ...metrics } = account.counts ?? {};
        return ok({ data: { id: key, username: username ?? "shreejit", public_metrics: metrics } });
      }
      const list = url.pathname.match(/^\/2\/users\/(\d+)\/(following|followers)$/);
      if (list) return pages(accounts[list[1]!]![list[2] as "following" | "followers"] ?? [], url.searchParams);
      throw new Error(`unexpected ${call.path}`);
    };
  };
  const bob = (rows: Json[], extra: Json = {}) => ({ counts: { username: "bob", following_count: rows.length, followers_count: rows.length, ...extra }, following: rows, followers: rows });
  const manyUsers = (count: number, from = 1000) => Array.from({ length: count }, (_, i) => user(from + i));

  it("shows the total and a page, at the list rate plus the lookup", async () => {
    const h = harness(lists({ "2": bob(manyUsers(30)) }));
    const out = await h.commands["following"]!(["bob", "--limit", "5"]);
    expect(out).toMatchObject({ target: "@bob", total: 30, count: 5, next_token: "token5", est_cost: "$0.060" });
    expect((out["users"] as Json[])[0]).toEqual({ id: "1000", username: "user1000", name: "User 1000", protected: false });
    expect(h.reads().at(-1)!.path).toContain("max_results=5");
    expect(h.reads().at(-1)!.path).toContain("user.fields=protected");
    expect(h.approve).not.toHaveBeenCalled();
  });

  it("uses the follower count and endpoint for followers, and continues from --next", async () => {
    const h = harness(lists({ "2": bob(manyUsers(30)) }));
    await h.commands["followers"]!(["bob", "--limit", "5", "--next", "token5"]);
    expect(h.reads().at(-1)!.path).toContain("/2/users/2/followers");
    expect(h.reads().at(-1)!.path).toContain("pagination_token=token5");
  });

  it("reads your own list at the owned rate without a handle", async () => {
    const h = harness(lists({ "1": { counts: { following_count: 3 }, following: manyUsers(3) } }));
    await expect(h.commands["following"]!([])).resolves.toMatchObject({ target: "@shreejit", total: 3, count: 3, est_cost: "$0.013" });
  });

  it("states an empty list definitively", async () => {
    const h = harness(lists({ "2": bob([]) }));
    await expect(h.commands["following"]!(["bob"])).resolves.toMatchObject({ total: 0, users: "0 accounts found" });
  });

  it("refuses a large page before reading it, showing the total and cost", async () => {
    const h = harness(lists({ "2": bob(manyUsers(5000)) }));
    const error = await h.commands["following"]!(["bob", "--limit", "500"]).catch((e: { code: string; message: string; suggestions: string[] }) => e) as { code: string; message: string; suggestions: string[] };
    expect(error.code).toBe("SPEND_CAP");
    expect(error.message).toContain("500 of the 5000");
    expect(error.message).toContain("$5.010");
    expect(error.suggestions.join(" ")).toContain("--max-spend 5.01");
    expect(h.reads().filter((c) => c.path.includes("/following"))).toEqual([]);
  });

  it("allows that page with a cap that covers it", async () => {
    const h = harness(lists({ "2": bob(manyUsers(5000)) }));
    await expect(h.commands["following"]!(["bob", "--limit", "500", "--max-spend", "5.01"])).resolves.toMatchObject({ count: 500 });
  });

  // Worked from the published rates: a $0.01 lookup plus $0.01 per row.
  it.each([
    [108, "1.09"],
    [137, "1.38"],
    [140, "1.41"],
    [163, "1.64"],
  ])("advises a cap for %i rows that the rerun accepts", async (rows, usd) => {
    const accounts = { "2": bob(manyUsers(200)) };
    const refused = harness(lists(accounts));
    const error = await refused.commands["following"]!(["bob", "--limit", String(rows)]).catch((e: { code: string; suggestions: string[] }) => e) as { code: string; suggestions: string[] };
    expect(error.code).toBe("SPEND_CAP");
    expect(error.suggestions[0]).toContain(`--max-spend ${usd} `);
    const rerun = harness(lists(accounts));
    await expect(rerun.commands["following"]!(["bob", "--limit", String(rows), "--max-spend", usd])).resolves.toMatchObject({ count: rows, est_cost: `$${usd}0` });
  });

  it("creates an export readable only by its owner", async () => {
    const out = join(dir, "export.json");
    const h = harness(lists({ "2": bob(manyUsers(2)) }));
    await h.commands["followers"]!(["bob", "--all", "--out", out]);
    expect(statSync(out).mode & 0o777).toBe(0o600);
  });

  const runPrinted = (command: string, accounts: Parameters<typeof lists>[0]) => {
    const [name, ...args] = command.replace(/^x-axi /, "").split(" ");
    return harness(lists(accounts)).commands[name!]!(args);
  };
  const printedCommands = (result: Json): string[] => [...(result["help"] as string[]).join(" ").matchAll(/`([^`]+)`/g)].map((m) => m[1]!);

  it("prints continuations that read the next rows, keeping the cap the read needed", async () => {
    const accounts = { "2": bob(manyUsers(5000)) };
    const first = await harness(lists(accounts)).commands["following"]!(["bob", "--limit", "500", "--max-spend", "5.01"]);
    const [more] = printedCommands(first);
    const next = await runPrinted(more!, accounts);
    expect(next).toMatchObject({ count: 500, next_token: "token1000" });
    expect((next["users"] as Json[])[0]).toMatchObject({ id: "1500" });
  });

  it("prints an --all continuation that exports only the rest", async () => {
    const accounts = { "2": bob(manyUsers(30)) };
    const first = await harness(lists(accounts)).commands["following"]!(["bob", "--limit", "5"]);
    const [, rest] = printedCommands(first);
    const out = join(dir, "rest.json");
    await expect(runPrinted(rest!.replace("FILE", out), accounts)).resolves.toMatchObject({ export: { written: 25, complete: true } });
    expect((JSON.parse(readFileSync(out, "utf8")) as Json[])[0]).toMatchObject({ id: "1005" });
  });

  // $1 default cap less the $0.01 lookup leaves $0.99, which buys 99 rows at the published $0.01.
  it("exports the rest of a list too large for the cap in stages, each stopping at the cap with a working continuation", async () => {
    const accounts = { "2": bob(manyUsers(5000)) };
    const first = await harness(lists(accounts)).commands["following"]!(["bob"]);
    const [, rest] = printedCommands(first);
    expect((first["help"] as string[]).join(" ")).toContain("stops at the $1.000 cap");
    const out = join(dir, "rest.json");
    const stage = await runPrinted(rest!.replace("FILE", out), accounts);
    expect(stage).toMatchObject({ export: { written: 99, complete: false }, stopped: { code: "SPEND_CAP" }, next_token: "token119", est_cost: "$1.000" });
    expect((stage["help"] as string[]).join(" ")).toContain("cannot be priced in advance");
    expect((JSON.parse(readFileSync(out, "utf8")) as Json[])[0]).toMatchObject({ id: "1020" });
    const continuation = printedCommands(stage).find((c) => c.includes("--next"));
    const nextOut = join(dir, "more.json");
    await expect(runPrinted(continuation!.replace("NEW_FILE", nextOut), accounts)).resolves.toMatchObject({ export: { written: 99 }, next_token: "token218" });
    expect((JSON.parse(readFileSync(nextOut, "utf8")) as Json[])[0]).toMatchObject({ id: "1119" });
  });

  it("--all --next near the end of a large list costs only what remains", async () => {
    const out = join(dir, "tail.json");
    const h = harness(lists({ "2": bob(manyUsers(130)) }));
    // 10 rows left at $0.01 plus the $0.01 lookup; the whole list would be priced at $1.31.
    const result = await h.commands["following"]!(["bob", "--all", "--out", out, "--next", "token120"]);
    expect(result).toMatchObject({ export: { written: 10, complete: true }, est_cost: "$0.110" });
  });

  it("--all without --next still refuses a list over the cap up front", async () => {
    const out = join(dir, "whole.json");
    const h = harness(lists({ "2": bob(manyUsers(130)) }));
    await expect(h.commands["following"]!(["bob", "--all", "--out", out])).rejects.toMatchObject({ code: "SPEND_CAP" });
    expect(h.reads().filter((c) => c.path.includes("/following"))).toEqual([]);
    expect(existsSync(out)).toBe(false);
  });

  it("omits --max-spend from a continuation when the read did not need one", async () => {
    const first = await harness(lists({ "2": bob(manyUsers(30)) })).commands["following"]!(["bob", "--limit", "5"]);
    expect(printedCommands(first)[0]).toBe("x-axi following bob --limit 5 --next token5");
  });

  it("--all prints a continuation that finishes a stopped export under the same cap", async () => {
    const accounts = { "2": bob(manyUsers(1500)) };
    const list = lists(accounts);
    const first = harness((c) => (c.path.includes("pagination_token") ? ok({ reset_at: "later" }, 429) : list(c)));
    const result = await first.commands["following"]!(["bob", "--all", "--out", join(dir, "first.json"), "--max-spend", "20"]);
    const continuation = printedCommands(result).find((c) => c.includes("--next"));
    const out = join(dir, "second.json");
    await expect(runPrinted(continuation!.replace("NEW_FILE", out), accounts)).resolves.toMatchObject({ export: { written: 500, complete: true } });
    expect((JSON.parse(readFileSync(out, "utf8")) as Json[])[0]).toMatchObject({ id: "2000" });
  });

  it("cuts a page short at the cap when X's count is too low", async () => {
    const h = harness(lists({ "2": { counts: { username: "bob", following_count: 10 }, following: manyUsers(5000) } }));
    // $0.01 lookup leaves $0.99, which buys 99 rows at the $0.01 list rate.
    const out = await h.commands["following"]!(["bob", "--limit", "1000", "--max-spend", "1"]);
    expect(out).toMatchObject({ count: 99, next_token: "token99", est_cost: "$1.000" });
    expect(h.reads().at(-1)!.path).toContain("max_results=99");
  });

  it("refuses a page the cap cannot buy one row of, reading nothing, even when X's count is 0", async () => {
    const h = harness(lists({ "2": { counts: { username: "bob", following_count: 0 }, following: manyUsers(5) } }));
    const error = await h.commands["following"]!(["bob", "--max-spend", "0.01"]).catch((e: { code: string; suggestions: string[] }) => e) as { code: string; suggestions: string[] };
    expect(error.code).toBe("SPEND_CAP");
    expect(error.suggestions.join(" ")).toContain("--max-spend 0.02");
    expect(h.reads().filter((c) => c.path.includes("/following"))).toEqual([]);
  });

  it.each([["--max-spend", "0"], ["--max-spend", "-1"], ["--max-spend", "lots"], ["--limit", "1001"], ["--limit", "0"]])("refuses %s %s before any call", async (flag, value) => {
    const h = harness(lists({}));
    await expect(h.commands["following"]!(["bob", flag, value])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(h.calls).toEqual([]);
  });

  it("--all exports every page, and says the export is not a follow queue", async () => {
    const out = join(dir, "export.json");
    const h = harness(lists({ "2": bob(manyUsers(2500)) }));
    const result = await h.commands["following"]!(["bob", "--all", "--out", out, "--max-spend", "26"]);
    expect(result).toMatchObject({ export: { written: 2500, complete: true, total: 2500 }, est_cost: "$25.010" });
    expect(h.reads().filter((c) => c.path.includes("/following"))).toHaveLength(3);
    const rows = JSON.parse(readFileSync(out, "utf8")) as Json[];
    expect(rows).toHaveLength(2500);
    expect((result["help"] as string[]).join(" ")).toContain("x-axi follow-plan");
  });

  it("--all reads the list even when X's count wrongly says it is empty", async () => {
    const out = join(dir, "export.json");
    const h = harness(lists({ "2": { counts: { username: "bob", following_count: 0 }, following: manyUsers(3) } }));
    const result = await h.commands["following"]!(["bob", "--all", "--out", out]);
    expect(result).toMatchObject({ export: { written: 3, complete: true } });
    expect(JSON.parse(readFileSync(out, "utf8"))).toHaveLength(3);
  });

  it("--all refuses up front when the total exceeds the cap, reading no page and writing no file", async () => {
    const out = join(dir, "export.json");
    const h = harness(lists({ "2": bob(manyUsers(2000)) }));
    await expect(h.commands["following"]!(["bob", "--all", "--out", out])).rejects.toMatchObject({ code: "SPEND_CAP" });
    await expect(h.commands["following"]!(["bob", "--all", "--out", out, "--max-spend", "2"])).rejects.toMatchObject({ code: "SPEND_CAP" });
    expect(h.reads().filter((c) => c.path.includes("/following"))).toEqual([]);
    expect(existsSync(out)).toBe(false);
  });

  it("--all cannot run past the cap even when X's count is far too low", async () => {
    const out = join(dir, "export.json");
    const h = harness(lists({ "2": { counts: { username: "bob", following_count: 10 }, following: manyUsers(5000) } }));
    const result = await h.commands["following"]!(["bob", "--all", "--out", out, "--max-spend", "1.01"]);
    expect(result).toMatchObject({ export: { written: 100, complete: false }, stopped: { code: "SPEND_CAP" }, next_token: "token100", est_cost: "$1.010" });
    expect(JSON.parse(readFileSync(out, "utf8"))).toHaveLength(100);
  });

  it("--all keeps what it paid for when a later page fails, and says where to continue", async () => {
    const out = join(dir, "export.json");
    const list = lists({ "2": bob(manyUsers(1500)) });
    const h = harness((c) => (c.path.includes("pagination_token") ? ok({ reset_at: "later" }, 429) : list(c)));
    const result = await h.commands["following"]!(["bob", "--all", "--out", out, "--max-spend", "20"]);
    expect(result).toMatchObject({ export: { written: 1000, complete: false }, stopped: { code: "RATE_LIMITED" }, next_token: "token1000" });
    expect(JSON.parse(readFileSync(out, "utf8"))).toHaveLength(1000);
    expect((result["help"] as string[])[0]).toContain("do not retry in a loop");
  });

  it("--all is not complete when X reports partial errors", async () => {
    const out = join(dir, "export.json");
    const list = lists({ "2": bob(manyUsers(2)) });
    const h = harness((c) => (c.path.includes("/following") ? ok({ data: [user(1000)], errors: [{ detail: "hidden" }], meta: { result_count: 1 } }) : list(c)));
    const result = await h.commands["following"]!(["bob", "--all", "--out", out]);
    expect(result).toMatchObject({ export: { written: 1, complete: false }, partial_errors: 1 });
  });

  it.each([
    ["an app outside the package", { detail: "client-forbidden" }, 403, "APP_NOT_ENROLLED", "Pay-per-use"],
    ["a revoked login", { detail: "nope" }, 401, "AUTH_REQUIRED", "x-axi auth status"],
  ])("--all keeps X's remedy when the first page fails on %s", async (_name, body, status, code, remedy) => {
    const out = join(dir, "export.json");
    const list = lists({ "2": bob(manyUsers(5)) });
    const h = harness((c) => (c.path.includes("/following") ? ok(body, status) : list(c)));
    const error = await h.commands["following"]!(["bob", "--all", "--out", out]).catch((e: { code: string; suggestions: string[] }) => e) as { code: string; suggestions: string[] };
    expect(error.code).toBe(code);
    expect(error.suggestions.join(" ")).toContain(remedy);
    expect(existsSync(out)).toBe(false);
  });

  it("--all fails as an error with no file when the first page fails", async () => {
    const out = join(dir, "export.json");
    const list = lists({ "2": bob(manyUsers(5)) });
    const h = harness((c) => (c.path.includes("/following") ? ok({ detail: "not allowed" }, 403) : list(c)));
    await expect(h.commands["following"]!(["bob", "--all", "--out", out])).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(existsSync(out)).toBe(false);
  });

  it("--all and --out go together, and an existing file is never overwritten", async () => {
    const out = join(dir, "export.json");
    writeFileSync(out, "precious");
    const h = harness(lists({ "2": bob(manyUsers(5)) }));
    await expect(h.commands["following"]!(["bob", "--all"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(h.commands["following"]!(["bob", "--out", join(dir, "new.json")])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(h.commands["following"]!(["bob", "--all", "--out", out])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(readFileSync(out, "utf8")).toBe("precious");
    expect(h.calls).toEqual([]);
  });

  describe("follow-plan", () => {
    const plan = (mine: Json[], theirs: Json[]) => ({
      "1": { counts: { following_count: mine.length }, following: mine },
      "2": bob(theirs),
    });

    it("removes accounts you already follow and yourself, in the file format follow-file reads", async () => {
      const out = join(dir, "queue.json");
      const h = harness(lists(plan([user(10), user(11)], [user(10), user(1, { username: "shreejit" }), user(12), user(11), user(13)])));
      const result = await h.commands["follow-plan"]!(["bob", "--out", out]);
      expect(JSON.parse(readFileSync(out, "utf8"))).toEqual([{ id: "12", username: "user12" }, { id: "13", username: "user13" }]);
      expect(result).toMatchObject({
        follow_plan: { target: "@bob", target_following: 5, your_following: 2, already_followed: 2, self_excluded: 1, queued: 2, protected_held: 0 },
        following_them_would_cost: "$0.030",
      });
      // Two lookups, 2 of your own at the owned rate, 5 of theirs at the list rate.
      expect(result["est_cost"]).toBe("$0.072");
      expect(h.approve).not.toHaveBeenCalled();
      expect(h.writes()).toEqual([]);
      await expect(h.commands["follow-file"]!([out, "--dry-run"])).resolves.toMatchObject({ dry_run: { batch: [{ id: "12" }, { id: "13" }] } });
    });

    it("reads each list once", async () => {
      const h = harness(lists(plan([user(10)], [user(12)])));
      await h.commands["follow-plan"]!(["bob", "--out", join(dir, "queue.json")]);
      expect(h.reads().filter((c) => c.path.includes("/following")).map((c) => new URL(c.path, "http://x").pathname)).toEqual(["/2/users/1/following", "/2/users/2/following"]);
    });

    it("holds protected accounts in a separate list by default", async () => {
      const out = join(dir, "queue.json");
      const h = harness(lists(plan([], [user(12), user(13, { protected: true })])));
      await expect(h.commands["follow-plan"]!(["bob", "--out", out])).resolves.toMatchObject({ follow_plan: { queued: 1, protected_held: 1, protected_file: join(dir, "queue.protected.json") } });
      expect(JSON.parse(readFileSync(out, "utf8"))).toEqual([{ id: "12", username: "user12" }]);
      expect(JSON.parse(readFileSync(join(dir, "queue.protected.json"), "utf8"))).toEqual([{ id: "13", username: "user13" }]);
    });

    it("queues protected accounts with --include-protected", async () => {
      const out = join(dir, "queue.json");
      const h = harness(lists(plan([], [user(13, { protected: true })])));
      await expect(h.commands["follow-plan"]!(["bob", "--out", out, "--include-protected"])).resolves.toMatchObject({ follow_plan: { queued: 1, protected_held: 0 } });
      expect(existsSync(join(dir, "queue.protected.json"))).toBe(false);
    });

    it("refuses above the threshold without --max-spend, showing the cost, reading no list and writing no file", async () => {
      const out = join(dir, "queue.json");
      const h = harness(lists(plan(manyUsers(100, 5000), manyUsers(200))));
      const error = await h.commands["follow-plan"]!(["bob", "--out", out]).catch((e: { code: string; message: string; suggestions: string[] }) => e) as { code: string; message: string; suggestions: string[] };
      expect(error.code).toBe("SPEND_CAP");
      // $0.02 of lookups, 100 at $0.001, 200 at $0.01.
      expect(error.message).toContain("$2.120");
      expect(error.suggestions.join(" ")).toContain("--max-spend 2.12");
      expect(h.reads().filter((c) => c.path.includes("/following"))).toEqual([]);
      expect(existsSync(out)).toBe(false);
    });

    it("proceeds with a --max-spend that covers it", async () => {
      const out = join(dir, "queue.json");
      const h = harness(lists(plan(manyUsers(100, 5000), manyUsers(200))));
      await expect(h.commands["follow-plan"]!(["bob", "--out", out, "--max-spend", "2.12"])).resolves.toMatchObject({ follow_plan: { queued: 200 } });
    });

    it("writes no queue if your own list cannot be read whole, because it could hold accounts you follow", async () => {
      const out = join(dir, "queue.json");
      const list = lists(plan(manyUsers(1500, 5000), [user(12)]));
      const h = harness((c) => (c.path.includes("/2/users/1/following") && c.path.includes("pagination_token") ? ok({ detail: "boom" }, 503) : list(c)));
      await expect(h.commands["follow-plan"]!(["bob", "--out", out, "--max-spend", "5"])).rejects.toMatchObject({ message: expect.stringContaining("no queue was written") });
      expect(existsSync(out)).toBe(false);
    });

    it("puts X's remedy first when a rate limit stops the read", async () => {
      const out = join(dir, "queue.json");
      const list = lists(plan([user(10)], [user(12)]));
      const h = harness((c) => (c.path.includes("/2/users/1/following") ? ok({ reset_at: "later" }, 429) : list(c)));
      const error = await h.commands["follow-plan"]!(["bob", "--out", out]).catch((e: { code: string; suggestions: string[] }) => e) as { code: string; suggestions: string[] };
      expect(error.code).toBe("RATE_LIMITED");
      expect(error.suggestions[0]).toContain("do not retry in a loop");
      expect(existsSync(out)).toBe(false);
    });

    it("says how to raise the cap when the cap stops the read", async () => {
      const out = join(dir, "queue.json");
      const accounts = plan([], manyUsers(500));
      accounts["2"]!.counts = { username: "bob", following_count: 5 };
      const h = harness(lists(accounts));
      const error = await h.commands["follow-plan"]!(["bob", "--out", out, "--max-spend", "1"]).catch((e: { suggestions: string[] }) => e) as { suggestions: string[] };
      expect(error.suggestions[0]).toContain("--max-spend");
    });

    it("writes no queue when X reports partial errors on your own list", async () => {
      const out = join(dir, "queue.json");
      const list = lists(plan([user(10)], [user(12)]));
      const h = harness((c) => (c.path.includes("/2/users/1/following") ? ok({ data: [user(10)], errors: [{ detail: "hidden" }], meta: { result_count: 1 } }) : list(c)));
      await expect(h.commands["follow-plan"]!(["bob", "--out", out])).rejects.toMatchObject({ code: "INCOMPLETE_READ" });
      expect(existsSync(out)).toBe(false);
    });

    it("writes no queue if the cap stops the read, however wrong X's counts were", async () => {
      const out = join(dir, "queue.json");
      const accounts = plan([], manyUsers(500));
      accounts["2"]!.counts = { username: "bob", following_count: 5 };
      const h = harness(lists(accounts));
      await expect(h.commands["follow-plan"]!(["bob", "--out", out, "--max-spend", "1"])).rejects.toMatchObject({ code: "SPEND_CAP" });
      expect(existsSync(out)).toBe(false);
    });

    it("still removes accounts you follow when X's count of your follows wrongly reads 0", async () => {
      const out = join(dir, "queue.json");
      const accounts = plan([user(10)], [user(10), user(12)]);
      accounts["1"]!.counts = { following_count: 0 };
      const h = harness(lists(accounts));
      const result = await h.commands["follow-plan"]!(["bob", "--out", out]);
      expect(JSON.parse(readFileSync(out, "utf8"))).toEqual([{ id: "12", username: "user12" }]);
      expect(result).toMatchObject({ follow_plan: { your_following: 1, already_followed: 1, queued: 1 } });
    });

    it("still reads the target's list when X's count of it wrongly reads 0", async () => {
      const out = join(dir, "queue.json");
      const accounts = plan([], [user(12)]);
      accounts["2"]!.counts = { username: "bob", following_count: 0 };
      const h = harness(lists(accounts));
      await expect(h.commands["follow-plan"]!(["bob", "--out", out])).resolves.toMatchObject({ follow_plan: { queued: 1 } });
    });

    it("warns when X lists fewer of your follows than its count", async () => {
      const out = join(dir, "queue.json");
      const accounts = plan([user(10)], [user(12)]);
      accounts["1"]!.counts = { following_count: 2 };
      const h = harness(lists(accounts));
      const result = await h.commands["follow-plan"]!(["bob", "--out", out]);
      expect(String(result["warning"])).toContain("1 of the 2");
    });

    it("advises a cap for both lists that the rerun accepts", async () => {
      const out = join(dir, "queue.json");
      // $0.02 of lookups, 10 of your own at $0.001, 135 of theirs at $0.01.
      const accounts = plan(manyUsers(10, 5000), manyUsers(135));
      const refused = harness(lists(accounts));
      const error = await refused.commands["follow-plan"]!(["bob", "--out", out]).catch((e: { code: string; suggestions: string[] }) => e) as { code: string; suggestions: string[] };
      expect(error.code).toBe("SPEND_CAP");
      expect(error.suggestions[0]).toContain("--max-spend 1.38 ");
      const rerun = harness(lists(accounts));
      await expect(rerun.commands["follow-plan"]!(["bob", "--out", out, "--max-spend", "1.38"])).resolves.toMatchObject({ follow_plan: { queued: 135 }, est_cost: "$1.380" });
    });

    it("creates the queue and the protected list readable only by their owner", async () => {
      const out = join(dir, "queue.json");
      const h = harness(lists(plan([], [user(12), user(13, { protected: true })])));
      await h.commands["follow-plan"]!(["bob", "--out", out]);
      expect(statSync(out).mode & 0o777).toBe(0o600);
      expect(statSync(join(dir, "queue.protected.json")).mode & 0o777).toBe(0o600);
    });

    it("refuses your own account, reading neither list and writing no file", async () => {
      const out = join(dir, "queue.json");
      const h = harness(lists({ "1": { counts: { username: "shreejit", following_count: 1 }, following: [user(10)] } }));
      await expect(h.commands["follow-plan"]!(["shreejit", "--out", out])).rejects.toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringContaining("your own account") });
      expect(h.reads().filter((c) => c.path.includes("/following"))).toEqual([]);
      expect(existsSync(out)).toBe(false);
    });

    it("refuses an existing queue and a missing --out", async () => {
      const out = join(dir, "queue.json");
      const h = harness(lists(plan([], [])));
      await expect(h.commands["follow-plan"]!(["bob"])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      writeFileSync(out, "precious");
      await expect(h.commands["follow-plan"]!(["bob", "--out", out])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      expect(readFileSync(out, "utf8")).toBe("precious");
      expect(h.calls).toEqual([]);
    });

    it("states an empty plan definitively, and still writes the file", async () => {
      const out = join(dir, "queue.json");
      const h = harness(lists(plan([user(10)], [user(10)])));
      const result = await h.commands["follow-plan"]!(["bob", "--out", out]);
      expect(result).toMatchObject({ follow_plan: { queued: 0, already_followed: 1 } });
      expect((result["help"] as string[])[0]).toContain("0 accounts to follow");
      expect(JSON.parse(readFileSync(out, "utf8"))).toEqual([]);
    });
  });
});
