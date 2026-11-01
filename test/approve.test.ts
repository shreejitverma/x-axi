// Linux dialogs are exercised against fake executables, never a real dialog, so these run on any POSIX machine.
// The platform is always injected as linux here. Nothing in this file reaches osascript.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createApprover,
  formatApproval,
  isExecutableFile,
  linuxApprovalText,
  selectBackend,
  SYSTEM_DIRECTORIES,
  type ApprovalRequest,
} from "../src/approve.js";

const REQUEST: ApprovalRequest = { action: "Post", account: "shreejit", text: "hello", estCostUsd: 0.015 };
const GRAPHICAL = { DISPLAY: ":0" };

const has = (...paths: string[]) => (path: string) => paths.includes(path);

describe("selectBackend", () => {
  it.each([
    ["macOS", "darwin", {}, [], "osascript"],
    ["macOS ignores Linux tools and sessions", "darwin", GRAPHICAL, ["/usr/bin/zenity"], "osascript"],
    ["Linux with both tools prefers zenity", "linux", GRAPHICAL, ["/usr/bin/kdialog", "/usr/bin/zenity"], "zenity"],
    ["zenity outranks kdialog across directories", "linux", GRAPHICAL, ["/usr/bin/kdialog", "/usr/local/bin/zenity"], "zenity"],
    ["only kdialog", "linux", GRAPHICAL, ["/bin/kdialog"], "kdialog"],
    ["Wayland only", "linux", { WAYLAND_DISPLAY: "wayland-0" }, ["/usr/bin/zenity"], "zenity"],
    ["both display variables", "linux", { DISPLAY: ":1", WAYLAND_DISPLAY: "wayland-0" }, ["/usr/bin/kdialog"], "kdialog"],
  ] as const)("%s", (_name, platform, env, tools, kind) => {
    const backend = selectBackend({ platform, env, isExecutable: has(...tools) });
    expect(backend.kind).toBe(kind);
  });

  it.each([
    ["headless with tools installed", "linux", {}, ["/usr/bin/zenity"], "no_graphical_session"],
    ["empty display variables count as none", "linux", { DISPLAY: "", WAYLAND_DISPLAY: "" }, ["/usr/bin/zenity"], "no_graphical_session"],
    ["SSH without X forwarding", "linux", { SSH_CONNECTION: "1.2.3.4 1 5.6.7.8 22" }, ["/usr/bin/zenity"], "no_graphical_session"],
    ["graphical session without a tool", "linux", GRAPHICAL, [], "no_dialog_tool"],
    ["Windows", "win32", GRAPHICAL, ["/usr/bin/zenity"], "unsupported_platform"],
    ["another Unix", "freebsd", GRAPHICAL, ["/usr/bin/zenity"], "unsupported_platform"],
  ] as const)("%s has no backend", (_name, platform, env, tools, reason) => {
    expect(selectBackend({ platform, env, isExecutable: has(...tools) })).toEqual({ kind: "none", reason });
  });

  it("returns the absolute path, preferring the distribution's own directory", () => {
    const backend = selectBackend({ platform: "linux", env: GRAPHICAL, isExecutable: has("/usr/local/bin/zenity", "/usr/bin/zenity") });
    expect(backend).toEqual({ kind: "zenity", path: "/usr/bin/zenity" });
    expect(selectBackend({ platform: "darwin", env: {}, isExecutable: () => false })).toEqual({ kind: "osascript", path: "/usr/bin/osascript" });
  });

  it("probes only the fixed system directories, whatever PATH says", () => {
    const probed: string[] = [];
    const backend = selectBackend({
      platform: "linux",
      env: { ...GRAPHICAL, PATH: "/planted:/usr/bin" },
      isExecutable: (path) => {
        probed.push(path);
        return path.startsWith("/planted/");
      },
    });
    expect(backend).toEqual({ kind: "none", reason: "no_dialog_tool" });
    expect(probed).toEqual(["zenity", "kdialog"].flatMap((tool) => SYSTEM_DIRECTORIES.map((directory) => `${directory}/${tool}`)));
  });
});

// The dialog budget is 25 rows of 50 cells, with 3 rows always held back for context.
// This counts rows only for text with no soft wraps. Wrapped ASCII is bounded by characters instead: 25 rows hold at most 1250.
const rowsOf = (shown: string) => shown.split("\n").length;

describe("linuxApprovalText", () => {
  it.each([
    ["a 280 character post", "word ".repeat(56), true],
    ["750 ordinary characters", "word ".repeat(150), true],
    ["a 100 character URL", `https://example.com/${"a".repeat(80)}`, true],
    ["a 280 character CJK post, which wraps anywhere", "漢".repeat(280 / 2), true],
    ["15 lines", Array(15).fill("line").join("\n"), true],
    ["26 lines", Array(26).fill("line").join("\n"), false],
    ["text that only overflows once wrapped", "word ".repeat(300), false],
    ["wide characters that overflow sooner", "漢".repeat(700), false],
    ["an unbroken word that needs more rows than there are", "a".repeat(2000), false],
  ])("%s", (_name, text, fits) => {
    expect(linuxApprovalText({ ...REQUEST, text }) !== null).toBe(fits);
  });

  it("leaves short text exactly as macOS shows it", () => {
    const request = { ...REQUEST, text: "a\n\nb", context: "Replying to @alice: hi" };
    expect(linuxApprovalText(request)).toBe(formatApproval(request));
  });

  it("hard-wraps a long run at 49 cells plus the mark, and counts the breaks", () => {
    expect(linuxApprovalText({ ...REQUEST, text: "a".repeat(200) })).toBe(
      [
        "Post as @shreejit (about $0.015)",
        "",
        "Text to send, all of it (200 characters, 1 line):",
        "This dialog splits long words at 4 marks (\u21b5), which are not sent.",
        ...Array(4).fill(`${"a".repeat(49)}\u21b5`),
        "aaaa",
      ].join("\n"),
    );
  });

  it("gives a run of 50 cells its own row without a mark", () => {
    const shown = linuxApprovalText({ ...REQUEST, text: "a".repeat(50) })!;
    expect(shown).not.toContain("\u21b5");
    expect(shown).not.toContain("splits long words");
  });

  it("never splits inside an emoji sequence", () => {
    const programmer = "\u{1f469}\u200d\u{1f4bb}";
    const shown = linuxApprovalText({ ...REQUEST, text: programmer.repeat(30) })!;
    const body = shown.slice(shown.indexOf(programmer));
    expect(body).toContain("\u21b5");
    expect(body.replaceAll("\u21b5\n", "")).toBe(programmer.repeat(30));
    for (const row of body.split("\n")) expect(row.startsWith(programmer)).toBe(true);
  });

  it("cuts context to the rows left, with its full count, without changing the verdict on the text", () => {
    const text = Array(19).fill("line").join("\n");
    expect(rowsOf(linuxApprovalText({ ...REQUEST, text })!)).toBe(22);
    const context = "word ".repeat(1000);
    const shown = linuxApprovalText({ ...REQUEST, text, context })!;
    expect(shown).toContain(`${text}\n\n----- context from X, not sent -----\n[cut to fit: 5000 characters in full]`);
    expect(rowsOf(shown)).toBe(25);
    expect(linuxApprovalText({ ...REQUEST, text: `${text}\nline`, context })).toBeNull();
    expect(linuxApprovalText({ ...REQUEST, text: `${text}\nline` })).toBeNull();
  });

  it("shows as much context as fits before the cut", () => {
    const context = "word ".repeat(1000);
    const shown = linuxApprovalText({ ...REQUEST, text: "hello", context })!;
    expect(shown).toContain("----- context from X, not sent -----\nword word");
    expect(shown.endsWith("\n[cut to fit: 5000 characters in full]")).toBe(true);
    expect(shown.length).toBeLessThanOrEqual(25 * 50);
    expect(shown.length).toBeGreaterThan(20 * 45);
  });

  it("cuts a target it cannot fit, and never refuses it", () => {
    const shown = linuxApprovalText({ action: "Delete post", account: "me", content: "word ".repeat(1000), estCostUsd: 0.01 })!;
    expect(shown.startsWith("Delete post as @me (about $0.010)\n\nword word")).toBe(true);
    expect(shown.endsWith("\n[cut to fit: 5000 characters in full]")).toBe(true);
    expect(shown.length).toBeLessThanOrEqual(22 * 50);
    expect(shown.length).toBeGreaterThan(20 * 45);
  });
});

describe("formatApproval", () => {
  it("shows a 280 character parent whole and cuts a longer one with its full count", () => {
    const whole = `Replying to @fifteencharname: ${"p".repeat(280)}`;
    expect(formatApproval({ ...REQUEST, context: whole })).toContain(whole);
    const shown = formatApproval({ ...REQUEST, context: "p".repeat(5000) });
    expect(shown.endsWith(`\n${"p".repeat(320)}\n[cut to fit: 5000 characters in full]`)).toBe(true);
  });
});

describe("isExecutableFile", () => {
  it("wants an executable regular file", () => {
    const dir = mkdtempSync(join(tmpdir(), "x-axi-exec-"));
    try {
      writeFileSync(join(dir, "plain"), "");
      writeFileSync(join(dir, "tool"), "");
      chmodSync(join(dir, "tool"), 0o755);
      expect(isExecutableFile(join(dir, "tool"))).toBe(true);
      expect(isExecutableFile(join(dir, "plain"))).toBe(false);
      expect(isExecutableFile(dir)).toBe(false);
      expect(isExecutableFile(join(dir, "missing"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Linux dialog against a fake executable", () => {
  let dir: string;
  let bin: string;
  let argvFile: string;
  let envFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "x-axi-dialog-"));
    bin = join(dir, "system-bin");
    mkdirSync(bin);
    argvFile = join(dir, "argv");
    envFile = join(dir, "env");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Records argv NUL-separated and the environment, then runs `body`. */
  function plant(directory: string, tool: string, body: string): void {
    mkdirSync(directory, { recursive: true });
    const script = `#!/bin/sh\nfor a in "$@"; do printf '%s\\0' "$a"; done > "${argvFile}"\n/usr/bin/env > "${envFile}"\n${body}\n`;
    writeFileSync(join(directory, tool), script);
    chmodSync(join(directory, tool), 0o755);
  }
  const ask = (env: NodeJS.ProcessEnv = {}, request: ApprovalRequest = REQUEST) =>
    createApprover({ platform: "linux", env: { ...GRAPHICAL, ...env }, isExecutable: isExecutableFile, directories: [bin] })(request);
  const recordedArgv = () => readFileSync(argvFile, "utf8").split("\0").slice(0, -1);
  const recordedEnv = () => readFileSync(envFile, "utf8");

  describe.each(["zenity", "kdialog"])("%s", (tool) => {
    it.each([
      ["exit 0", "exit 0", "approved"],
      ["exit 1, the Cancel button", "exit 1", "cancelled"],
      ["exit 1 with an unrelated warning", 'echo "Gtk-WARNING **: theme not found" >&2; exit 1', "cancelled"],
      ["a display message with exit 0, the only approval signal", 'echo "cannot open display" >&2; exit 0', "approved"],
      ["exit 255", "exit 255", "unavailable"],
      ["exit 3", "exit 3", "unavailable"],
      ["a crash by signal", "kill -SEGV $$", "unavailable"],
    ])("treats %s correctly", async (_name, body, result) => {
      plant(bin, tool, body);
      await expect(ask()).resolves.toBe(result);
    });

    it("kills a hang at the timeout and reports it", async () => {
      plant(bin, tool, "exec sleep 30");
      const started = Date.now();
      await expect(ask({ X_AXI_APPROVAL_TIMEOUT: "1" })).resolves.toBe("timed_out");
      expect(Date.now() - started).toBeLessThan(5000);
    }, 10_000);

    it("kills a hang that ignores polite signals", async () => {
      plant(bin, tool, "trap '' TERM INT HUP\nwhile :; do sleep 1; done");
      await expect(ask({ X_AXI_APPROVAL_TIMEOUT: "1" })).resolves.toBe("timed_out");
    }, 10_000);

    it("fails closed when the tool cannot start", async () => {
      plant(bin, tool, "exit 0");
      writeFileSync(join(bin, tool), "#!/nonexistent/interpreter\n");
      await expect(ask()).resolves.toBe("unavailable");
    });

    it("fails closed on text that cannot reach the tool", async () => {
      plant(bin, tool, "exit 0");
      await expect(ask({}, { ...REQUEST, text: "a\0b" })).resolves.toBe("unavailable");
    });

    it("gives the tool no stdin to answer from", async () => {
      plant(bin, tool, 'if read -r line; then exit 0; fi\nexit 1');
      await expect(ask()).resolves.toBe("cancelled");
    });

    it("does not offer approval for outgoing text the dialog cannot show in full", async () => {
      plant(bin, tool, "exit 0");
      await expect(ask({}, { ...REQUEST, text: "a".repeat(2000) })).resolves.toBe("too_long");
      await expect(ask({}, { ...REQUEST, text: Array(30).fill("line").join("\n") })).resolves.toBe("too_long");
      expect(existsSync(argvFile)).toBe(false);
    });

    it("opens the dialog for context and targets of any length", async () => {
      plant(bin, tool, "exit 0");
      await expect(ask({}, { ...REQUEST, context: "word ".repeat(400) })).resolves.toBe("approved");
      await expect(ask({}, { action: "Delete post", account: "me", content: "a".repeat(5000), estCostUsd: null })).resolves.toBe("approved");
    });

    it("ignores an approving tool planted on PATH when the real one cancels", async () => {
      const planted = join(dir, "planted");
      plant(planted, tool, "exit 0");
      plant(bin, tool, "exit 1");
      await expect(ask({ PATH: `${planted}:${process.env["PATH"]}` })).resolves.toBe("cancelled");
    });

    it("refuses when a tool exists only on PATH", async () => {
      const planted = join(dir, "planted");
      plant(planted, tool, "exit 0");
      await expect(ask({ PATH: `${planted}:${process.env["PATH"]}` })).resolves.toBe("no_dialog_tool");
      expect(existsSync(argvFile)).toBe(false);
    });

    it("hands the tool a scrubbed environment", async () => {
      plant(bin, tool, "exit 0");
      await ask({
        WAYLAND_DISPLAY: "wayland-0",
        XAUTHORITY: "/home/me/.Xauthority",
        XDG_RUNTIME_DIR: "/run/user/1000",
        LD_PRELOAD: "/planted/evil.so",
        LD_LIBRARY_PATH: "/planted",
        GTK_MODULES: "evil",
        GTK_PATH: "/planted",
        QT_PLUGIN_PATH: "/planted",
        ZENITY_CANCEL: "0",
        X_API_TOKEN: "secret",
        PATH: "/planted",
      });
      const env = recordedEnv();
      expect(env).toContain("DISPLAY=:0\n");
      expect(env).toContain("WAYLAND_DISPLAY=wayland-0\n");
      expect(env).toContain("XAUTHORITY=/home/me/.Xauthority\n");
      expect(env).toContain("XDG_RUNTIME_DIR=/run/user/1000\n");
      expect(env).toContain(`PATH=${SYSTEM_DIRECTORIES.join(":")}\n`);
      expect(env).not.toContain("/planted");
      expect(env).not.toContain("ZENITY_");
      expect(env).not.toContain("secret");
    });
  });

  it("does not let ZENITY_CANCEL=0 turn Cancel into approval", async () => {
    // This fake reads its exit code from the environment the way real zenity does.
    plant(bin, "zenity", 'exit "${ZENITY_CANCEL:-1}"');
    await expect(ask({ ZENITY_CANCEL: "0" })).resolves.toBe("cancelled");
  });

  it.each([
    ["GTK 3", "(zenity:7): Gtk-WARNING **: cannot open display: :99"],
    ["GTK 4", "Gtk-WARNING **: Failed to open display"],
  ])("reports zenity exiting 1 on a %s display failure as unavailable, not a cancel", async (_name, message) => {
    plant(bin, "zenity", `echo "${message}" >&2; exit 1`);
    await expect(ask()).resolves.toBe("unavailable");
  });

  it("reads exit 1 from kdialog as Cancel whatever it prints", async () => {
    plant(bin, "kdialog", 'echo "cannot open display" >&2; exit 1');
    await expect(ask()).resolves.toBe("cancelled");
  });

  it("reports zenity's own timeout exit as timed out, but not the same code from kdialog", async () => {
    plant(bin, "zenity", "exit 5");
    await expect(ask()).resolves.toBe("timed_out");
    rmSync(join(bin, "zenity"));
    plant(bin, "kdialog", "exit 5");
    await expect(ask()).resolves.toBe("unavailable");
  });

  const HOSTILE = `--timeout=0 $(touch ${"${MARKER}"}) \`touch x\` <b>bold</b> &amp; 'q' "d" a\\nb \\101 \\`;

  it("passes zenity the exact text with markup off and Cancel as the default", async () => {
    plant(bin, "zenity", "exit 1");
    const request = { ...REQUEST, text: `-x\nline two ${HOSTILE}` };
    await ask({ X_AXI_APPROVAL_TIMEOUT: "7", MARKER: join(dir, "marker") }, request);
    expect(recordedArgv()).toEqual([
      "--question",
      "--no-markup",
      "--default-cancel",
      "--title=x-axi: approve this action",
      "--ok-label=Approve",
      "--cancel-label=Cancel",
      "--timeout=7",
      `--text=${formatApproval(request)}`,
    ]);
    expect(existsSync(join(dir, "marker"))).toBe(false);
  });

  it("passes kdialog escaped text that Qt cannot read as markup and kdialog cannot read as escapes", async () => {
    plant(bin, "kdialog", "exit 1");
    await ask({ MARKER: join(dir, "marker") }, { action: "Post", account: "me", content: `<!-- hidden --><b>x</b> & "y"\na\\nb \\`, estCostUsd: null });
    expect(recordedArgv()).toEqual([
      "--title",
      "x-axi: approve this action",
      "--yes-label",
      "Approve",
      "--no-label",
      "Cancel",
      "--warningyesno",
      `<qt><div style="white-space: pre-wrap">Post as @me (unknown)<br><br>&lt;!-- hidden --&gt;&lt;b&gt;x&lt;/b&gt; &amp; &quot;y&quot;<br>a&#92;nb &#92;</div></qt>`,
    ]);
    expect(existsSync(join(dir, "marker"))).toBe(false);
  });

  it.each([
    ["the default when unset", undefined, "120"],
    ["a request", "30", "30"],
    ["a fraction rounded up", "1.5", "2"],
    ["garbage falls back to the default", "soon", "120"],
    ["zero falls back to the default", "0", "120"],
    ["a negative falls back to the default", "-1", "120"],
    ["infinity falls back to the default", "Infinity", "120"],
    ["over an hour", "7200", "7200"],
    ["more than a timer can hold is limited to what it can", "99999999999", "2147483"],
  ])("sets the zenity timeout: %s", async (_name, requested, seconds) => {
    plant(bin, "zenity", "exit 1");
    await ask(requested === undefined ? {} : { X_AXI_APPROVAL_TIMEOUT: requested });
    expect(recordedArgv()).toContain(`--timeout=${seconds}`);
  });
});

describe("a timeout too long for a timer", () => {
  it("still waits for the answer instead of firing at once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "x-axi-dialog-"));
    try {
      writeFileSync(join(dir, "zenity"), "#!/bin/sh\nsleep 0.2\nexit 1\n");
      chmodSync(join(dir, "zenity"), 0o755);
      const approve = createApprover({
        platform: "linux",
        env: { ...GRAPHICAL, X_AXI_APPROVAL_TIMEOUT: "99999999999" },
        isExecutable: isExecutableFile,
        directories: [dir],
      });
      await expect(approve(REQUEST)).resolves.toBe("cancelled");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("no dialog, no write path", () => {
  it.each([
    ["win32", GRAPHICAL, "unsupported_platform"],
    ["linux", {}, "no_graphical_session"],
    ["linux", { ...GRAPHICAL, X_AXI_APPROVE: "1", CI: "true" }, "no_dialog_tool"],
  ] as const)("%s %j resolves to a refusal, never approval", async (platform, env, result) => {
    const approve = createApprover({ platform, env, isExecutable: () => false });
    await expect(approve(REQUEST)).resolves.toBe(result);
  });
});
