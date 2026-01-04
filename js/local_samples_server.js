#!/usr/bin/env node

const http = require("http");
const fs = require("fs");
const path = require("path");

const MESSAGES = {
  READY: "STRUDEL_LOCAL_SAMPLES_READY:",
  ERROR: "STRUDEL_LOCAL_SAMPLES_ERROR:",
};

const AUDIO_EXTS = new Set([".wav", ".mp3", ".m4a", ".flac", ".aac", ".ogg"]);

function parseArgValue(prefix) {
  const arg = process.argv.find((a) => a.startsWith(prefix));
  if (!arg) return null;
  return arg.slice(prefix.length);
}

function safeRealpath(p) {
  return fs.realpathSync(p);
}

function isChildPath(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function listDirectories(root) {
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => name && !name.startsWith("."))
    .sort((a, b) => a.localeCompare(b));
}

function walkFiles(root) {
  const out = [];

  function walk(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(abs);
      } else if (e.isFile()) {
        out.push(abs);
      }
    }
  }

  walk(root);
  return out;
}

function toPosix(p) {
  return p.split(path.sep).join("/");
}

function buildSampleMap(root) {
  // Option A: immediate child directories are sound names.
  const soundDirs = listDirectories(root);
  const sampleMap = { _base: "" };

  let fileCount = 0;
  for (const soundName of soundDirs) {
    const soundRoot = path.join(root, soundName);
    const files = walkFiles(soundRoot)
      .filter((abs) => AUDIO_EXTS.has(path.extname(abs).toLowerCase()))
      .sort((a, b) => a.localeCompare(b));

    if (!files.length) continue;

    const rels = files.map((abs) => {
      const rel = path.relative(root, abs);
      return toPosix(rel);
    });

    sampleMap[soundName] = rels;
    fileCount += rels.length;
  }

  return { sampleMap, soundCount: Object.keys(sampleMap).length - 1, fileCount };
}

function sendTaggedJson(tag, obj) {
  const b64 = Buffer.from(JSON.stringify(obj)).toString("base64");
  process.stdout.write(tag + b64 + "\n");
}

async function main() {
  const rootArg = parseArgValue("--root=");
  const portArg = parseArgValue("--port=");
  const manifestPath = parseArgValue("--manifest-path=") || "/strudel-samples.json";

  if (!rootArg) {
    sendTaggedJson(MESSAGES.ERROR, { error: "missing --root" });
    process.exit(2);
  }

  const port = portArg ? Number(portArg) || 0 : 0;

  let root;
  try {
    root = safeRealpath(rootArg);
  } catch (e) {
    sendTaggedJson(MESSAGES.ERROR, { error: `invalid root: ${rootArg}`, detail: String(e) });
    process.exit(2);
  }

  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    sendTaggedJson(MESSAGES.ERROR, { error: `root is not a directory: ${root}` });
    process.exit(2);
  }

  let cached = buildSampleMap(root);

  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      const pathname = url.pathname;

      // Allow Strudel (and the embedded Chromium) to fetch from a different port.
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      if (pathname === manifestPath) {
        const body = JSON.stringify(cached.sampleMap);
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        res.end(body);
        return;
      }

      // Serve static files rooted at `root`.
      const decoded = decodeURIComponent(pathname);
      const rel = decoded.replace(/^\//, "");

      // Reject traversal or absolute paths.
      if (!rel || rel.includes("..") || path.isAbsolute(rel)) {
        res.writeHead(404);
        res.end("not found");
        return;
      }

      const abs = path.join(root, rel);
      if (!isChildPath(root, abs)) {
        res.writeHead(404);
        res.end("not found");
        return;
      }

      let st;
      try {
        st = fs.statSync(abs);
      } catch {
        res.writeHead(404);
        res.end("not found");
        return;
      }

      if (!st.isFile()) {
        res.writeHead(404);
        res.end("not found");
        return;
      }

      const ext = path.extname(abs).toLowerCase();
      if (!AUDIO_EXTS.has(ext)) {
        res.writeHead(403);
        res.end("forbidden");
        return;
      }

      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Cache-Control": "no-store",
      });

      fs.createReadStream(abs).pipe(res);
    } catch (e) {
      res.writeHead(500);
      res.end("error");
      sendTaggedJson(MESSAGES.ERROR, { error: "request failed", detail: String(e) });
    }
  });

  server.listen({ host: "127.0.0.1", port }, () => {
    const addr = server.address();
    const actualPort = typeof addr === "object" && addr ? addr.port : port;
    const baseUrl = `http://127.0.0.1:${actualPort}`;

    cached.sampleMap._base = `${baseUrl}/`;

    sendTaggedJson(MESSAGES.READY, {
      root,
      port: actualPort,
      baseUrl: `${baseUrl}/`,
      manifestPath,
      manifestUrl: `${baseUrl}${manifestPath}`,
      soundCount: cached.soundCount,
      fileCount: cached.fileCount,
    });
  });

  const shutdown = () => {
    try {
      server.close(() => {
        process.exit(0);
      });
    } catch {
      process.exit(0);
    }
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  sendTaggedJson(MESSAGES.ERROR, { error: "startup failed", detail: String(e?.stack || e) });
  process.exit(1);
});
