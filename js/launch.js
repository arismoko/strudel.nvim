const puppeteer = require("puppeteer");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");
const https = require("https");

const DEFAULT_REPO_URL = "https://codeberg.org/uzu/strudel.git";

const MESSAGES = {
  CONTENT: "STRUDEL_CONTENT:",
  QUIT: "STRUDEL_QUIT",
  TOGGLE: "STRUDEL_TOGGLE",
  UPDATE: "STRUDEL_UPDATE",
  STOP: "STRUDEL_STOP",
  REFRESH: "STRUDEL_REFRESH",
  READY: "STRUDEL_READY",
  CURSOR: "STRUDEL_CURSOR:",
  EVAL_ERROR: "STRUDEL_EVAL_ERROR:",
  SAMPLES: "STRUDEL_SAMPLES:",
  IMPORT_LOCAL_SAMPLES: "STRUDEL_IMPORT_LOCAL_SAMPLES:",
  IMPORT_LOCAL_SAMPLES_OK: "STRUDEL_IMPORT_LOCAL_SAMPLES_OK:",
  IMPORT_LOCAL_SAMPLES_ERROR: "STRUDEL_IMPORT_LOCAL_SAMPLES_ERROR:",
};

const SELECTORS = {
  EDITOR: ".cm-content",
};
const EVENTS = {
  CONTENT_CHANGED: "strudel-content-changed",
};
const STYLES = {
  HIDE_EDITOR_SCROLLBAR: `
        .cm-scroller {
            scrollbar-width: none;
        }
    `,
  HIDE_TOP_BAR: `
        header {
            display: none !important;
        }
    `,
  MAX_MENU_PANEL: `
        nav:not(:has(> button:first-child)) {
            position: absolute;
            z-index: 99;
            height: 100%;
            width: 100vw;
            max-width: 100vw;
            background: linear-gradient(var(--lineHighlight), var(--lineHighlight)), var(--background);
        }
    `,
  HIDE_MENU_PANEL: `
        nav {
            display: none !important;
        }
    `,
  HIDE_CODE_EDITOR: `
        .cm-editor {
            display: none !important;
        }
    `,
  HIDE_ERROR_DISPLAY: `
        header + div + div {
            display: none !important;
        }
    `,
  DISABLE_EVAL_BG_FLASH: `
        .cm-line:not(.cm-activeLine):has(> span) {
            background: var(--lineBackground) !important;
            width: fit-content;
        }
        .cm-line.cm-activeLine {
            background: linear-gradient(var(--lineHighlight), var(--lineHighlight)), var(--lineBackground) !important;
        }
        .cm-line > *, .cm-line span[style*="background-color"] {
            background-color: transparent !important;
            filter: none !important;
        }
    `,
};

const CLI_ARGS = {
  HIDE_TOP_BAR: "--hide-top-bar",
  MAXIMISE_MENU_PANEL: "--maximise-menu-panel",
  HIDE_MENU_PANEL: "--hide-menu-panel",
  HIDE_CODE_EDITOR: "--hide-code-editor",
  HIDE_ERROR_DISPLAY: "--hide-error-display",
  CUSTOM_CSS_B64: "--custom-css-b64=",
  HEADLESS: "--headless",
  USER_DATA_DIR: "--user-data-dir=",
  BROWSER_EXEC_PATH: "--browser-exec-path=",
  DOC_JSON_OUT: "--doc-json-out=",
  LOCAL_SERVER: "--local-server",
  REPO_URL: "--repo-url=",
  REPO_DIR: "--repo-dir=",
  PORT: "--port=",
  REMOTE_DEBUG_PORT: "--remote-debug-port=",
  DOC_ONLY: "--doc-only",
};

const userConfig = {
  hideTopBar: false,
  maximiseMenuPanel: false,
  hideMenuPanel: false,
  hideCodeEditor: false,
  hideErrorDisplay: false,
  customCss: null,
  isHeadless: false,
  userDataDir: null,
  browserExecPath: null,
  docJsonOut: null,
  localServer: false,
  repoUrl: DEFAULT_REPO_URL,
  repoDir: null,
  port: 0,
  remoteDebugPort: 0,
  docOnly: false,
};

// Process program arguments at launch
for (const arg of process.argv) {
  if (arg === CLI_ARGS.HIDE_TOP_BAR) {
    userConfig.hideTopBar = true;
  } else if (arg === CLI_ARGS.MAXIMISE_MENU_PANEL) {
    userConfig.maximiseMenuPanel = true;
  } else if (arg === CLI_ARGS.HIDE_MENU_PANEL) {
    userConfig.hideMenuPanel = true;
  } else if (arg === CLI_ARGS.HIDE_CODE_EDITOR) {
    userConfig.hideCodeEditor = true;
  } else if (arg === CLI_ARGS.HIDE_ERROR_DISPLAY) {
    userConfig.hideErrorDisplay = true;
  } else if (arg.startsWith(CLI_ARGS.CUSTOM_CSS_B64)) {
    const b64 = arg.slice(CLI_ARGS.CUSTOM_CSS_B64.length);
    try {
      userConfig.customCss = Buffer.from(b64, "base64").toString("utf8");
    } catch (e) {
      console.error("Failed to decode custom CSS:", e);
    }
  } else if (arg === CLI_ARGS.HEADLESS) {
    userConfig.isHeadless = true;
  } else if (arg.startsWith(CLI_ARGS.USER_DATA_DIR)) {
    userConfig.userDataDir = arg.replace(CLI_ARGS.USER_DATA_DIR, "");
  } else if (arg.startsWith(CLI_ARGS.BROWSER_EXEC_PATH)) {
    userConfig.browserExecPath = path.join(
      arg.replace(CLI_ARGS.BROWSER_EXEC_PATH, ""),
    );
  } else if (arg.startsWith(CLI_ARGS.DOC_JSON_OUT)) {
    userConfig.docJsonOut = path.join(arg.replace(CLI_ARGS.DOC_JSON_OUT, ""));
  } else if (arg === CLI_ARGS.LOCAL_SERVER) {
    userConfig.localServer = true;
  } else if (arg.startsWith(CLI_ARGS.REPO_URL)) {
    userConfig.repoUrl = arg.replace(CLI_ARGS.REPO_URL, "");
  } else if (arg.startsWith(CLI_ARGS.REPO_DIR)) {
    userConfig.repoDir = path.join(arg.replace(CLI_ARGS.REPO_DIR, ""));
  } else if (arg.startsWith(CLI_ARGS.PORT)) {
    userConfig.port = Number(arg.replace(CLI_ARGS.PORT, "")) || 0;
  } else if (arg.startsWith(CLI_ARGS.REMOTE_DEBUG_PORT)) {
    userConfig.remoteDebugPort =
      Number(arg.replace(CLI_ARGS.REMOTE_DEBUG_PORT, "")) || 0;
  } else if (arg === CLI_ARGS.DOC_ONLY) {
    userConfig.docOnly = true;
  }
}
if (!userConfig.userDataDir) {
  userConfig.userDataDir = path.join(os.homedir(), ".cache", "strudel-nvim");
}
if (!userConfig.repoDir) {
  userConfig.repoDir = path.join(userConfig.userDataDir, "strudel-src");
}

// Returns path with expansion of "~" or "~/" to the user's home directory
function expandTilde(p) {
  if (!p) return p;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

// Apply tilde home expansion
userConfig.userDataDir = expandTilde(userConfig.userDataDir);
userConfig.browserExecPath = expandTilde(userConfig.browserExecPath);
userConfig.repoDir = expandTilde(userConfig.repoDir);

// State
let page = null;
let lastContent = null;
let browser = null;
let serverProc = null;

// Event queue for sequential message processing
const eventQueue = [];
let isProcessingEvent = false;

function fileExists(p) {
  try {
    fs.accessSync(p, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function canReachRemote(repoUrl, { timeoutMs = 2000 } = {}) {
  return new Promise((resolve) => {
    if (!repoUrl || typeof repoUrl !== "string") {
      resolve(true);
      return;
    }

    if (!repoUrl.startsWith("https://")) {
      resolve(true);
      return;
    }

    const url = new URL(repoUrl);
    const req = https.request(
      {
        method: "HEAD",
        protocol: url.protocol,
        host: url.hostname,
        port: url.port ? Number(url.port) : undefined,
        path: url.pathname,
        timeout: timeoutMs,
        headers: {
          "user-agent": "strudel.nvim/launch",
          accept: "*/*",
        },
      },
      (res) => {
        res.resume();
        const status = res.statusCode || 0;

        // If the host is overloaded (503/504/522/etc), skip slow git operations.
        if (status >= 500 && status <= 599) {
          resolve(false);
          return;
        }

        // 2xx/3xx are good. 4xx still indicates the host is reachable.
        resolve(true);
      },
    );

    req.on("timeout", () => {
      req.destroy(new Error("timeout"));
    });

    req.on("error", () => {
      // DNS/TLS/timeout/etc: treat it as unreachable.
      resolve(false);
    });

    req.end();
  });
}

function runCommand(command, args, opts = {}) {
  const { timeoutMs = 0, ...spawnOpts } = opts;

  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      ...spawnOpts,
    });

    let stdout = "";
    let stderr = "";

    const onData = (buf, isErr) => {
      const s = buf.toString();
      if (isErr) {
        stderr += s;
      } else {
        stdout += s;
      }
    };

    proc.stdout.on("data", (d) => onData(d, false));
    proc.stderr.on("data", (d) => onData(d, true));

    let timer = null;
    if (timeoutMs && timeoutMs > 0) {
      timer = setTimeout(() => {
        try {
          proc.kill("SIGTERM");
        } catch {
          // ignore
        }
        const detail = stderr || stdout;
        reject(
          new Error(
            `${command} timed out after ${timeoutMs}ms${detail ? `\n${detail}` : ""}`,
          ),
        );
      }, timeoutMs);
    }

    proc.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });

    proc.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function ensureRepo(repoDir, repoUrl) {
  const gitDir = path.join(repoDir, ".git");
  if (!fileExists(gitDir)) {
    console.error("[strudel.nvim] cloning repo...", repoUrl);
    fs.mkdirSync(path.dirname(repoDir), { recursive: true });

    // IMPORTANT: Clone the *Strudel* repo, not the legacy wrapper.
    // The GitHub repo is a thin redirect containing only docs.
    const cloneUrl = /github\.com\/tidalcycles\/strudel(?:\.git)?$/i.test(repoUrl)
      ? "https://codeberg.org/uzu/strudel"
      : repoUrl;

    const res = await runCommand(
      "git",
      ["clone", "--depth", "1", cloneUrl, repoDir],
      { timeoutMs: 5 * 60 * 1000 },
    );
    if (res.code !== 0) {
      throw new Error(
        `git clone failed (repo: ${cloneUrl}, dir: ${repoDir}): ${res.stderr || res.stdout}`,
      );
    }
    return;
  }

  // Best effort update: failure falls back to cached repo.
  // If the upstream host is down (e.g. 5xx), skip git to avoid long timeouts.
  const remoteOk = await canReachRemote(repoUrl, { timeoutMs: 2000 });
  if (!remoteOk) {
    console.error("[strudel.nvim] repo remote unreachable; using cached repo");
    return;
  }

  console.error("[strudel.nvim] updating cached repo...");

  const fetchRes = await runCommand(
    "git",
    ["-C", repoDir, "fetch", "--all", "--prune"],
    { timeoutMs: 2 * 60 * 1000 },
  );
  if (fetchRes.code !== 0) {
    console.error("git fetch failed; using cached repo:\n", fetchRes.stderr || fetchRes.stdout);
    return;
  }

  const pullRes = await runCommand(
    "git",
    ["-C", repoDir, "pull", "--ff-only"],
    { timeoutMs: 2 * 60 * 1000 },
  );
  if (pullRes.code !== 0) {
    console.error("git pull failed; using cached repo:\n", pullRes.stderr || pullRes.stdout);
  }
}

async function ensurePnpmInstall(repoDir) {
  const nodeModules = path.join(repoDir, "node_modules");
  if (fileExists(nodeModules)) {
    return;
  }

  console.error("[strudel.nvim] installing repo deps (pnpm)...");
  const res = await runCommand("pnpm", ["install"], {
    cwd: repoDir,
    timeoutMs: 10 * 60 * 1000,
  });
  if (res.code !== 0) {
    throw new Error(`pnpm install failed: ${res.stderr || res.stdout}`);
  }
}


async function getRepoHead(repoDir) {
  const res = await runCommand("git", ["-C", repoDir, "rev-parse", "HEAD"], {
    timeoutMs: 30 * 1000,
  });
  if (res.code !== 0) {
    throw new Error(`git rev-parse HEAD failed: ${res.stderr || res.stdout}`);
  }
  return (res.stdout || "").trim();
}

function writeJsonFileAtomic(p, data) {
  const tmp = p + ".tmp";
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(data), "utf8");
  fs.renameSync(tmp, p);
}

async function ensureDocJson(repoDir, outPath) {
  if (!outPath) {
    throw new Error("--doc-json-out is required");
  }

  const metaPath = outPath + ".meta.json";
  const head = await getRepoHead(repoDir);

  // If cached doc exists and commit hash matches, skip regeneration.
  if (fileExists(outPath) && fileExists(metaPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      if (meta && meta.head === head) {
        console.error("[strudel.nvim] doc.json cache hit:", head);
        return;
      }
    } catch {
      // ignore parse errors, regenerate
    }
  }

  console.error("[strudel.nvim] generating doc.json (pnpm run jsdoc-json)...");

  const env = {
    ...process.env,
    PATH:
      path.join(repoDir, "node_modules", ".bin") +
      path.delimiter +
      (process.env.PATH || ""),
  };

  const res = await runCommand("pnpm", ["run", "jsdoc-json"], {
    cwd: repoDir,
    env,
    timeoutMs: 10 * 60 * 1000,
  });

  // If jsdoc isn't exposed on PATH (some pnpm layouts), try a direct invoke.
  if (res.code !== 0 && String(res.stderr || res.stdout).includes("jsdoc: command not found")) {
    const pnpmDir = path.join(repoDir, "node_modules", ".pnpm");
    let jsdocScript = null;

    try {
      const entries = fs.readdirSync(pnpmDir);
      const jsdocEntry = entries.find((x) => x.startsWith("jsdoc@"));
      if (jsdocEntry) {
        jsdocScript = path.join(
          pnpmDir,
          jsdocEntry,
          "node_modules",
          "jsdoc",
          "jsdoc.js",
        );
      }
    } catch {
      // ignore
    }

    if (!jsdocScript || !fileExists(jsdocScript)) {
      throw new Error(`pnpm run jsdoc-json failed: ${res.stderr || res.stdout}`);
    }

    const res2 = await runCommand(
      "node",
      [
        jsdocScript,
        "packages/",
        "--template",
        "./node_modules/jsdoc-json",
        "--destination",
        "doc.json",
        "-c",
        "jsdoc/jsdoc.config.json",
      ],
      { cwd: repoDir, env, timeoutMs: 10 * 60 * 1000 },
    );

    if (res2.code === 0) {
      await exportDocJsonFromRepo(outPath, repoDir);
      writeJsonFileAtomic(metaPath, { head, generatedAt: new Date().toISOString() });
      return;
    }

    const msg = res2.stderr || res2.stdout || res.stderr || res.stdout;
    throw new Error(`jsdoc-json failed: ${msg}`);
  }
  if (res.code !== 0) {
    throw new Error(`pnpm run jsdoc-json failed: ${res.stderr || res.stdout}`);
  }

  await exportDocJsonFromRepo(outPath, repoDir);
  writeJsonFileAtomic(metaPath, { head, generatedAt: new Date().toISOString() });
}

async function waitForHttp(url, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { method: "GET" });
      if (res && res.ok) return;
    } catch {
      // ignore
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("Timed out waiting for server: " + url);
}

async function startLocalServer(repoDir, portHint) {
  const websiteDir = path.join(repoDir, "website");
  if (!fileExists(websiteDir)) {
    throw new Error("Strudel website dir missing: " + websiteDir);
  }

  // Use astro directly instead of `pnpm run dev` because the pnpm script
  // currently injects its own `--host 0.0.0.0`, and multiple hosts lead to
  // confusing bindings (e.g. listening only on ::1).
  const args = ["node", path.join(websiteDir, "node_modules", "astro", "astro.js"), "dev", "--host", "127.0.0.1"];
  if (portHint && portHint > 0) {
    args.push("--port", String(portHint));
  }

  const [cmd, ...cmdArgs] = args;
  serverProc = spawn(cmd, cmdArgs, {
    cwd: websiteDir,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOST: "127.0.0.1",
    },
  });

  let serverUrl = null;
  const onLine = (line) => {
    // Astro prints something like:
    //   "Local    http://localhost:4321/"
    // Vite sometimes prints:
    //   "➜  Local:   http://localhost:5173/"
    // And in some setups it can still report 0.0.0.0.
    const m = line.match(/https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0):\d+\/?/i);
    if (m) {
      serverUrl = m[0]
        .replace("localhost", "127.0.0.1")
        .replace("0.0.0.0", "127.0.0.1");
    }
  };

  serverProc.stdout.on("data", (d) => {
    const s = d.toString();
    // Astro's output uses box-drawing characters; keep the raw text for debugging.
    process.stderr.write(s);
    for (const line of s.split(/\r?\n/)) {
      if (line) onLine(line);
    }
  });
  serverProc.stderr.on("data", (d) => {
    const s = d.toString();
    process.stderr.write(s);
    for (const line of s.split(/\r?\n/)) {
      if (line) onLine(line);
    }
  });

  serverProc.on("exit", (code) => {
    if (code && code !== 0) {
      console.error("Strudel local server exited with code:", code);
    }
  });

  const startedAt = Date.now();
  while (!serverUrl && Date.now() - startedAt < 30000) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!serverUrl) {
    shutdownLocalServer();
    throw new Error(
      "Failed to determine local server URL from pnpm output (timed out after 30s)",
    );
  }

  await waitForHttp(serverUrl);
  return serverUrl;
}

function shutdownLocalServer() {
  if (!serverProc) return;
  try {
    serverProc.kill("SIGTERM");
  } catch {
    // ignore
  }
  serverProc = null;
}

process.on("exit", () => shutdownLocalServer());
process.on("SIGINT", () => {
  shutdownLocalServer();
  process.exit(1);
});
process.on("SIGTERM", () => {
  shutdownLocalServer();
  process.exit(1);
});

async function updateEditorContent(content) {
  if (!page) return;

  try {
    await page.evaluate((newContent) => {
      // Can't simply set the whole content because it breaks inline annimations
      // https://codeberg.org/uzu/strudel/issues/1393
      const view = window.strudelMirror.editor;
      const oldContent = view.state.doc.toString();

      // Find the first position where the content differs
      let start = 0;
      while (
        start < oldContent.length &&
        start < newContent.length &&
        oldContent[start] === newContent[start]
      ) {
        start++;
      }

      // Find the last position where the content differs
      let endOld = oldContent.length - 1;
      let endNew = newContent.length - 1;
      while (
        endOld >= start &&
        endNew >= start &&
        oldContent[endOld] === newContent[endNew]
      ) {
        endOld--;
        endNew--;
      }

      // If there is a change, apply it
      if (start <= endOld || start <= endNew) {
        view.dispatch({
          changes: {
            from: start,
            to: endOld + 1,
            insert: newContent.slice(start, endNew + 1),
          },
        });
      }
    }, content);
  } catch (error) {
    console.error("Error updating editor:", error);
  }
  // Emulate interaction for audio playback
  await page.click("#autoplay-helper");
}

async function moveEditorCursor(position) {
  await page.evaluate((pos) => {
    // Clamp pos to valid range in the editor
    const docLength = window.strudelMirror.editor.state.doc.length;
    if (pos < 0) pos = 0;
    if (pos > docLength) pos = docLength;
    window.strudelMirror.setCursorLocation(pos);
    window.strudelMirror.editor.dispatch({ scrollIntoView: true });
  }, position);
}

async function handleCursorMessage(message) {
  // Expecting format: row:col (1-based row, 0-based col)
  const cursorStr = message.slice(MESSAGES.CURSOR.length);
  const [rowStr, colStr] = cursorStr.split(":");
  const row = parseInt(rowStr);
  const col = parseInt(colStr);

  await page.evaluate(
    ({ row, col }) => {
      const view = window.strudelMirror.editor;
      const lineCount = view.state.doc.lines;
      const clampedRow = Math.max(1, Math.min(row, lineCount));
      const lineInfo = view.state.doc.line(clampedRow);
      const clampedCol = Math.max(0, Math.min(col, lineInfo.length));
      const pos = Math.min(lineInfo.from + clampedCol, lineInfo.to);
      view.dispatch({
        selection: { anchor: pos },
        scrollIntoView: true,
      });
    },
    { row, col },
  );
}

function safeWriteFile(outPath, content) {
  try {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, content, "utf8");
    return true;
  } catch (e) {
    console.error("Failed to write file:", outPath, e);
    return false;
  }
}

async function exportDocJsonFromRepo(outPath, repoDir) {
  if (!outPath) return;
  const p = path.join(repoDir, "doc.json");
  const raw = fs.readFileSync(p, "utf8");
  // Ensure we keep the shape {docs:[...]}
  const parsed = JSON.parse(raw);
  if (!parsed || !Array.isArray(parsed.docs)) {
    throw new Error("Invalid doc.json (missing docs[]) at: " + p);
  }
  safeWriteFile(outPath, JSON.stringify({ docs: parsed.docs }, null, 2));
}
// Handle messages from Neovim
process.stdin.on("data", (data) => {
  const message = data.toString().trim();
  eventQueue.push(message);
  processEventQueue();
});

async function processEventQueue() {
  if (isProcessingEvent) return;
  isProcessingEvent = true;

  while (eventQueue.length > 0) {
    const message = eventQueue.shift();
    try {
      await handleEvent(message);
    } catch (err) {
      console.error("Error processing event:", err);
    }
  }

  isProcessingEvent = false;
}

async function handleEvent(message) {
  if (message === MESSAGES.QUIT) {
    shutdownLocalServer();
    if (browser) {
      await browser.close();
      process.exit(0);
    }
  } else if (message === MESSAGES.TOGGLE) {
    await page.evaluate(() => {
      window.strudelMirror.toggle();
    });
  } else if (message === MESSAGES.UPDATE) {
    await page.evaluate(() => {
      window.strudelMirror.evaluate();
    });
  } else if (message === MESSAGES.REFRESH) {
    await page.evaluate(() => {
      if (window.strudelMirror.repl.state.started) {
        window.strudelMirror.evaluate();
      }
    });
  } else if (message === MESSAGES.STOP) {
    await page.evaluate(() => {
      window.strudelMirror.stop();
    });
  } else if (message.startsWith(MESSAGES.CONTENT)) {
    const base64Content = message.slice(MESSAGES.CONTENT.length);
    if (base64Content === lastContent) return;

    lastContent = base64Content;

    const content = Buffer.from(base64Content, "base64").toString("utf8");
    await updateEditorContent(content);
  } else if (message.startsWith(MESSAGES.CURSOR)) {
    await handleCursorMessage(message);
  } else if (message.startsWith(MESSAGES.IMPORT_LOCAL_SAMPLES)) {
    const b64 = message.slice(MESSAGES.IMPORT_LOCAL_SAMPLES.length);

    try {
      const decoded = Buffer.from(b64, "base64").toString("utf8");
      const payload = JSON.parse(decoded);
      const manifestUrl = payload?.manifestUrl;
      if (typeof manifestUrl !== "string" || !manifestUrl) {
        throw new Error("manifestUrl missing");
      }

      const res = await fetch(manifestUrl);
      if (!res.ok) throw new Error(`Failed to fetch manifest: ${res.status}`);
      const sampleMap = await res.json();

      await page.evaluate(async (sampleMapIn) => {
        if (typeof window.samples !== "function") {
          throw new Error("window.samples not available");
        }
        await window.samples(sampleMapIn);
      }, sampleMap);

      // Refresh samples list for completion.
      await page.evaluate(() => window?.notifySamples?.());

      const sanity = await page.evaluate(() => {
        try {
          const sm = window?.strudelMirror?.repl?.state?.soundMap;
          const d = typeof sm?.get === "function" ? sm.get() : {};
          return Object.keys(d || {}).length;
        } catch {
          return null;
        }
      });

      const okPayload = {
        importedKeys: Object.keys(sampleMap || {}).filter((k) => k !== "_base"),
        soundCountAfter: sanity,
      };

      process.stdout.write(
        MESSAGES.IMPORT_LOCAL_SAMPLES_OK +
          Buffer.from(JSON.stringify(okPayload)).toString("base64") +
          "\n",
      );
    } catch (e) {
      process.stdout.write(
        MESSAGES.IMPORT_LOCAL_SAMPLES_ERROR +
          Buffer.from(String(e?.message || e)).toString("base64") +
          "\n",
      );
    }
  }
}

// Initialize browser and set up event handlers
(async () => {
  try {
    if (!userConfig.localServer && !userConfig.docOnly) {
      throw new Error(
        "Local server mode is required. Pass --local-server to launch.js.",
      );
    }

    console.error("[strudel.nvim] ensureRepo...", userConfig.repoDir);
    await ensureRepo(userConfig.repoDir, userConfig.repoUrl);

    console.error("[strudel.nvim] ensurePnpmInstall...");
    await ensurePnpmInstall(userConfig.repoDir);

    console.error("[strudel.nvim] ensureDocJson...");
    await ensureDocJson(userConfig.repoDir, userConfig.docJsonOut);

    if (userConfig.docOnly) {
      console.error("[strudel.nvim] doc-only mode: exiting");
      return;
    }

    const strudelUrl = await startLocalServer(userConfig.repoDir, userConfig.port);


    browser = await puppeteer.launch({
      headless: userConfig.isHeadless,
      defaultViewport: null,
      userDataDir: userConfig.userDataDir,
      ignoreDefaultArgs: ["--mute-audio", "--enable-automation"],
      args: [
        `--app=${strudelUrl}`,
        "--autoplay-policy=no-user-gesture-required",
        ...(userConfig.remoteDebugPort
          ? [`--remote-debugging-port=${userConfig.remoteDebugPort}`]
          : []),
      ],
      ...(userConfig.browserExecPath && {
        executablePath: userConfig.browserExecPath,
      }),
    });

    // Wait for the page to be ready (found the editor)
    const pages = await browser.pages();
    page = pages[0];
    await page.waitForSelector(SELECTORS.EDITOR, { timeout: 30000 });

    // Listen for browser disconnect or page close
    browser.on("disconnected", () => {
      process.exit(0);
    });
    page.on("close", () => {
      process.exit(0);
    });

    // Register additional styles
    await page.addStyleTag({ content: STYLES.HIDE_EDITOR_SCROLLBAR });
    await page.addStyleTag({ content: STYLES.DISABLE_EVAL_BG_FLASH });

    if (userConfig.maximiseMenuPanel) {
      await page.addStyleTag({ content: STYLES.MAX_MENU_PANEL });
    }
    if (userConfig.hideTopBar) {
      await page.addStyleTag({ content: STYLES.HIDE_TOP_BAR });
    }
    if (userConfig.hideMenuPanel) {
      await page.addStyleTag({ content: STYLES.HIDE_MENU_PANEL });
    }
    if (userConfig.hideCodeEditor) {
      await page.addStyleTag({ content: STYLES.HIDE_CODE_EDITOR });
    }
    if (userConfig.hideErrorDisplay) {
      await page.addStyleTag({ content: STYLES.HIDE_ERROR_DISPLAY });
    }
    if (userConfig.customCss) {
      await page.addStyleTag({ content: userConfig.customCss });
    }

    // Create an invisible unfocusable autoplay helper element in the page
    await page.evaluate(() => {
      const el = document.createElement("div");
      el.id = "autoplay-helper";
      Object.assign(el.style, {
        position: "fixed",
        left: "0px",
        top: "0px",
        width: "4px",
        height: "4px",
        opacity: "0",
        pointerEvents: "auto",
        zIndex: "2147483647",
      });

      // Prevent focus on mousedown so caret in editor isn't shifted
      el.addEventListener(
        "mousedown",
        (e) => {
          e.preventDefault();
        },
        { passive: false },
      );

      document.body.appendChild(el);
    });

    // Handle content sync
    await page.exposeFunction("sendEditorContent", async () => {
      const content = await page.evaluate(() => {
        return window.strudelMirror.code;
      });

      const base64Content = Buffer.from(content).toString("base64");

      if (base64Content !== lastContent && !isProcessingEvent) {
        lastContent = base64Content;

        process.stdout.write(MESSAGES.CONTENT + base64Content + "\n");
      }
    });
    if (!userConfig.isHeadless) {
      await page.evaluate(
        (editorSelector, eventName) => {
          const editor = document.querySelector(editorSelector);

          // Listen for content changes
          const observer = new MutationObserver(() => {
            editor.dispatchEvent(new CustomEvent(eventName));
          });
          observer.observe(editor, {
            childList: true,
            characterData: true,
            subtree: true,
          });

          editor.addEventListener(eventName, window.sendEditorContent);
        },
        SELECTORS.EDITOR,
        EVENTS.CONTENT_CHANGED,
      );
    }

    // Handle samples reporting (for LSP completion)
    await page.exposeFunction("notifySamples", async () => {
      try {
        const samples = await page.evaluate(() => {
          // Best-effort: this object shape may vary across Strudel versions.
          const sm = window?.soundMap;
          const raw = typeof sm?.get === "function" ? sm.get() : sm;
          const soundNames = Object.keys(raw || {}).sort();

          const banksSet = new Set();
          for (const key of soundNames) {
            const [bank, suffix] = key.split("_");
            if (suffix && bank) banksSet.add(bank);
          }

          return { soundNames, banks: Array.from(banksSet).sort() };
        });

        const b64 = Buffer.from(JSON.stringify(samples)).toString("base64");
        process.stdout.write(MESSAGES.SAMPLES + b64 + "\n");
      } catch {
        // ignore
      }
    });

    // Try to emit samples periodically (pages may load soundMap later).
    await page.evaluate(() => {
      let sentOnce = false;
      setInterval(() => {
        try {
          if (!sentOnce) {
            const sm = window?.strudelMirror?.repl?.state?.soundMap;
            if (sm && typeof sm.get === "function") {
              sentOnce = true;
            }
          }
          window?.notifySamples?.();
        } catch {
          // ignore
        }
      }, 1000);
    });

    // Handle eval errors reporting
    await page.exposeFunction("notifyEvalError", (evalErrorMessage) => {
      if (evalErrorMessage) {
        const b64 = Buffer.from(evalErrorMessage).toString("base64");
        process.stdout.write(MESSAGES.EVAL_ERROR + b64 + "\n");
      }
    });
    await page.evaluate(() => {
      let lastError = null;
      setInterval(() => {
        try {
          const currentError =
            window.strudelMirror.repl.state.evalError.message;
          if (currentError !== lastError) {
            lastError = currentError;
            window.notifyEvalError(currentError);
          }
        } catch (e) {
          // Ignore errors (e.g., page not ready)
        }
      }, 300);
    });

    // Handle cursor position
    await page.exposeFunction("sendEditorCursor", async () => {
      const cursor = await page.evaluate(() => {
        const view = window.strudelMirror.editor;
        const pos = view.state.selection.main.head;
        const lineInfo = view.state.doc.lineAt(pos);
        const row = lineInfo.number; // 1-based
        const col = pos - lineInfo.from; // 0-based
        return `${row}:${col}`;
      });
      process.stdout.write(MESSAGES.CURSOR + cursor + "\n");
    });
    if (!userConfig.isHeadless) {
      await page.evaluate((editorSelector) => {
        const editor = document.querySelector(editorSelector);
        // Listen for cursor changes
        editor.addEventListener("keyup", window.sendEditorCursor);
        editor.addEventListener("keydown", window.sendEditorCursor);
        editor.addEventListener("mouseup", window.sendEditorCursor);
        editor.addEventListener("mousedown", window.sendEditorCursor);
      }, SELECTORS.EDITOR);
    }


    // Signal that browser is ready
    process.stdout.write(MESSAGES.READY + "\n");
  } catch (error) {
    console.error("Error:", error);
    process.exit(1);
  }
})();
