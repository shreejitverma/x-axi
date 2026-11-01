import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { launchDetached } from "../src/cli.js";

describe("launching the browser opener", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "x-axi-cli-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("reports a program that cannot start", async () => {
    await expect(launchDetached(join(dir, "no-such-opener"), [])).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("returns while a foreground opener is still running, and leaves it running", async () => {
    const release = join(dir, "release");
    const finished = join(dir, "finished");
    const opener = 'i=0; while [ ! -e "$1" ] && [ $i -lt 200 ]; do sleep 0.05; i=$((i+1)); done; [ -e "$1" ] && : > "$2"';
    await launchDetached("/bin/sh", ["-c", opener, "sh", release, finished]);
    expect(existsSync(finished)).toBe(false);
    writeFileSync(release, "");
    await vi.waitFor(() => expect(existsSync(finished)).toBe(true), { timeout: 5000 });
  });
});
