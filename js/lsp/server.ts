#!/usr/bin/env node

import fs from "fs";
import path from "path";

import {
  createConnection,
  ProposedFeatures,
  TextDocuments,
  CompletionItemKind,
  MarkupKind,
  TextDocumentPositionParams,
  TextDocumentSyncKind,
} from "vscode-languageserver/node.js";

import { TextDocument } from "vscode-languageserver-textdocument";

function usageAndExit() {
  // Keep this super minimal; users usually don't run it directly.
  process.stderr.write(
    "Usage: strudel-lsp --stdio --doc-json-path <path> [--sample-map-path <path>]\n",
  );
  process.exit(1);
}

function parseArgs(argv: string[]) {
  type Args = { stdio: boolean; docJsonPath?: string; sampleMapPath?: string };
  const args: Args = { stdio: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--stdio") {
      args.stdio = true;
    } else if (a === "--doc-json-path") {
      args.docJsonPath = argv[i + 1];
      i++;
    } else if (a === "--sample-map-path") {
      args.sampleMapPath = argv[i + 1];
      i++;
    }
  }
  return args;
}

function stripHtml(html: string) {
  return html.replace(/<[^>]+>/g, "").trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getDocLabel(doc: Record<string, unknown>) {
  if (typeof doc["name"] === "string" && doc["name"] !== null) {
    const name: string = doc["name"];
    return name;
  }
  if (typeof doc["longName"] === "string" && doc["longName"] !== null) {
    const longName: string = doc["longName"];
    return longName;
  }
  throw new Error("doc has no valid name/longName!");
}

function hasExcludedTags(doc: Record<string, unknown>) {
  const tags = doc.tags;
  if (!Array.isArray(tags)) return false;
  return ["superdirtOnly", "noAutocomplete"].some((needle) =>
    tags.some((t) => t?.originalTitle === needle),
  );
}

function isValidDoc(doc: Record<string, unknown>) {
  const label = getDocLabel(doc);
  return (
    typeof label === "string" &&
    label !== "" &&
    !label.startsWith("_") &&
    doc.kind !== "package" &&
    !hasExcludedTags(doc)
  );
}

function stringifyType(type: any) {
  const names: string[] = type.names;
  const out = names.filter((n) => typeof n === "string" && n);
  return out.length ? out.join(" | ") : null;
}

function buildMarkdownDoc(
  doc: Record<string, unknown>,
  displayName: string,
): string {
  const lines = [];

  if (doc.description && typeof doc.description === "string") {
    const desc = stripHtml(doc.description);
    if (desc) lines.push(desc);
  }

  const params = doc.params;
  if (Array.isArray(params) && params.length) {
    lines.push("", "Parameters:");
    for (const p of params) {
      if (!p || typeof p !== "object") continue;
      const pname = typeof p.name === "string" ? p.name : "?";
      const ptype = stringifyType(p.type);
      const pdesc = stripHtml(p.description);
      let line = `- \`${pname}\``;
      if (ptype) line += ` (\`${ptype}\`)`;
      if (pdesc) line += `: ${pdesc}`;
      lines.push(line);
    }
  }

  const synonyms = doc.synonyms;
  if (Array.isArray(synonyms) && synonyms.length) {
    const syn = synonyms.filter((s) => typeof s === "string" && s);
    if (syn.length) {
      lines.push("", `Synonyms: ${syn.map((s) => `\`${s}\``).join(", ")}`);
    }
  }

  const examples = doc.examples;
  if (Array.isArray(examples) && examples.length) {
    lines.push("", "Examples:");
    for (const ex of examples.slice(0, 3)) {
      if (typeof ex !== "string" || !ex) continue;
      lines.push("```strudel", ex, "```");
    }
  }
  if (doc.meta && isRecord(doc.meta)) {
    const src = doc.meta.filename;
    if (typeof src === "string" && src) {
      lines.push("", `Source: \`${src}\``);
    }
  }

  // If being shown as a synonym, make it obvious.
  if (displayName && displayName !== getDocLabel(doc)) {
    lines.unshift(`Alias: \`${displayName}\` → \`${getDocLabel(doc)}\``, "");
  }

  return lines.join("\n");
}

function readJsonFile(p: string) {
  const raw = fs.readFileSync(p, "utf8");
  return JSON.parse(raw);
}

function buildDocIndex(docJson: Record<string, unknown>) {
  const byName = new Map();
  const bySynonym = new Map();

  const docs = docJson.docs;
  if (!Array.isArray(docs)) {
    throw new Error("doc.json missing docs[]");
  }

  for (const d of docs) {
    if (!isValidDoc(d)) continue;
    const name = getDocLabel(d);
    if (!byName.has(name)) {
      byName.set(name, d);
    }

    const syns = Array.isArray(d.synonyms) ? d.synonyms : [];
    for (const s of syns) {
      if (typeof s !== "string" || !s) continue;
      if (!bySynonym.has(s)) {
        bySynonym.set(s, name);
      }
    }
  }

  return { byName, bySynonym };
}

function buildSampleIndex(sampleMap: Record<string, unknown>): {
  soundNames: string[];
  banks: string[];
} {
  // Expected shape:
  // {
  //   "bd": ["/bd/0.wav", ...],
  //   "crate_bd": [...],
  //   "_base": "..."
  // }
  // We treat keys with '_' suffixes as banked sounds: bank_sound.
  if (!sampleMap || typeof sampleMap !== "object") {
    return { soundNames: [], banks: [] };
  }

  const soundNames = [];
  const banks = new Set<string>();

  for (const key of Object.keys(sampleMap)) {
    if (key === "_base") continue;
    if (!key) continue;
    soundNames.push(key);

    const parts = key.split("_");
    if (parts.length >= 2) {
      const bank = parts[0];
      if (bank) banks.add(bank);
    }
  }

  soundNames.sort();

  return { soundNames, banks: Array.from(banks).sort() };
}

function positionToOffset(
  text: string,
  pos: TextDocumentPositionParams["position"],
) {
  const lines = text.split(/\r?\n/);
  let offset = 0;
  for (let i = 0; i < pos.line; i++) {
    offset += (lines[i] || "").length + 1;
  }
  return offset + pos.character;
}

function isWordChar(ch: string) {
  return /[A-Za-z0-9_]/.test(ch);
}

function getWordAt(text: string, offset: number) {
  if (offset < 0 || offset > text.length) return null;
  let start = offset;
  let end = offset;
  while (start > 0 && isWordChar(text[start - 1])) start--;
  while (end < text.length && isWordChar(text[end])) end++;
  if (start === end) return null;
  return { word: text.slice(start, end), start, end };
}

function getWordBefore(text: string, offset: number) {
  let i = offset;
  while (i > 0 && !isWordChar(text[i - 1])) i--;
  return getWordAt(text, i);
}
function detectFunctionCallContext(text: string, offset: number) {
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  const lineEndIdx = text.indexOf("\n", offset);
  const lineEnd = lineEndIdx === -1 ? text.length : lineEndIdx;
  const line = text.slice(lineStart, lineEnd);
  const rel = offset - lineStart;

  const before = line.slice(0, rel);

  const lastDq = before.lastIndexOf(".");
  const quotePos = Math.max(lastDq);
  if (quotePos === -1) return { kind: null };
}
function detectStringCallContext(text: string, offset: number) {
  // Minimal same-line heuristic.
  // If cursor is inside the first argument string, detect s(".."), sound(".."), bank("..").

  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  const lineEndIdx = text.indexOf("\n", offset);
  const lineEnd = lineEndIdx === -1 ? text.length : lineEndIdx;
  const line = text.slice(lineStart, lineEnd);
  const rel = offset - lineStart;

  const before = line.slice(0, rel);

  const lastDq = before.lastIndexOf('"');
  const lastSq = before.lastIndexOf("'");
  const quotePos = Math.max(lastDq, lastSq);
  if (quotePos === -1) return { kind: null };

  const quoteChar = before[quotePos];
  const quoteCount = before.split(quoteChar).length - 1;
  if (quoteCount % 2 === 0) return { kind: null };

  const beforeQuote = before.slice(0, quotePos);
  if (/\bbank\(\s*$/.test(beforeQuote))
    return {
      kind: "bank",
      quoteChar,
      beforeQuote,
      inside: before.slice(quotePos + 1),
    };
  if (/\bsound\(\s*$/.test(beforeQuote))
    return {
      kind: "sound",
      quoteChar,
      beforeQuote,
      inside: before.slice(quotePos + 1),
    };
  if (/\bs\(\s*$/.test(beforeQuote))
    return {
      kind: "sound",
      quoteChar,
      beforeQuote,
      inside: before.slice(quotePos + 1),
    };

  return { kind: null };
}

function extractSoundFragment(inside: string) {
  const m = inside.match(/(?:[\s[{(<])([\w]*)$/);
  if (m) return m[1];
  return inside;
}

function buildCompletionItemsForDocs(
  prefix: string,
  index: Record<string, Map<any, any>>,
) {
  const items = [];
  const lowerPrefix = prefix ? prefix.toLowerCase() : "";

  for (const name of index.byName.keys()) {
    if (lowerPrefix && !name.toLowerCase().startsWith(lowerPrefix)) continue;
    items.push({
      label: name,
      kind: CompletionItemKind.Function,
      data: { type: "doc", name },
      sortText: "0_" + name,
    });
  }

  for (const [syn, canonical] of index.bySynonym.entries()) {
    if (lowerPrefix && !syn.toLowerCase().startsWith(lowerPrefix)) continue;
    items.push({
      label: syn,
      kind: CompletionItemKind.Function,
      data: { type: "syn", synonym: syn, name: canonical },
      sortText: "1_" + syn,
    });
  }

  return items;
}

function buildCompletionItemsForSounds(
  fragment: string,
  sampleIndex: { soundNames: string[]; banks: string[] },
) {
  const lowerFragment = fragment ? fragment.toLowerCase() : "";
  const items = [];
  for (const s of sampleIndex.soundNames) {
    if (lowerFragment && !s.toLowerCase().includes(lowerFragment)) continue;
    items.push({
      label: s,
      kind: CompletionItemKind.Value,
      sortText: "0_" + s,
    });
  }
  return items;
}

function buildCompletionItemsForBanks(
  fragment: string,
  sampleIndex: SampleIndex,
) {
  const lowerFragment = fragment ? fragment.toLowerCase() : "";
  const items = [];
  for (const b of sampleIndex.banks) {
    if (lowerFragment && !b.toLowerCase().startsWith(lowerFragment)) continue;
    items.push({
      label: b,
      kind: CompletionItemKind.Value,
      sortText: "0_" + b,
    });
  }
  return items;
}

const args = parseArgs(process.argv.slice(2));
if (!args.stdio) {
  usageAndExit();
}

let docJsonPath = args.docJsonPath;
if (!docJsonPath) {
  // Try to find it relative to this plugin, for manual runs.
  docJsonPath = path.resolve(__dirname, "../../lua/strudel/doc.json");
}

let docIndex;
try {
  docIndex = buildDocIndex(readJsonFile(docJsonPath));
} catch (e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  process.stderr.write(`Failed to load doc.json: ${msg}\n`);
  process.exit(1);
}
type SampleIndex = { soundNames: string[]; banks: string[] };
let sampleIndex: SampleIndex = {
  soundNames: [],
  banks: [],
};
if (args.sampleMapPath) {
  try {
    sampleIndex = buildSampleIndex(readJsonFile(args.sampleMapPath));
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`Failed to load sample map: ${msg}\n`);
  }
}

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

documents.listen(connection);

connection.onInitialize(() => {
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: {
        resolveProvider: true,
      },
      hoverProvider: true,
    },
  };
});

connection.onNotification("strudel/samples", (payload) => {
  if (!payload || typeof payload !== "object") return;
  const soundNames = Array.isArray(payload.soundNames)
    ? payload.soundNames.filter((s: unknown) => typeof s === "string" && s)
    : [];
  const banks = Array.isArray(payload.banks)
    ? payload.banks.filter((b: unknown) => typeof b === "string" && b)
    : [];
  sampleIndex = {
    soundNames: soundNames.slice().sort(),
    banks: banks.slice().sort(),
  };
});

connection.onCompletion((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];

  const text = doc.getText();
  const offset = positionToOffset(text, params.position);

  const ctx = detectStringCallContext(text, offset);
  if (ctx.kind === "sound") {
    const fragment = extractSoundFragment(ctx.inside || "");
    return buildCompletionItemsForSounds(fragment, sampleIndex);
  }
  if (ctx.kind === "bank") {
    const fragment = ctx.inside || "";
    return buildCompletionItemsForBanks(fragment, sampleIndex);
  }

  const w = getWordBefore(text, offset);
  const prefix = w ? w.word : "";
  return buildCompletionItemsForDocs(prefix, docIndex);
});

connection.onCompletionResolve((item) => {
  const data = item.data;
  if (!data || (data.type !== "doc" && data.type !== "syn")) return item;

  const canonical = data.name;
  const doc = docIndex.byName.get(canonical);
  if (!doc) return item;

  const displayName = data.type === "syn" ? data.synonym : null;
  const md = buildMarkdownDoc(doc, displayName);

  item.detail = stripHtml(doc.description);
  item.documentation = { kind: MarkupKind.Markdown, value: md };
  return item;
});

connection.onHover((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;

  const text = doc.getText();
  const offset = positionToOffset(text, params.position);

  const w = getWordAt(text, offset);
  if (!w) return null;

  let canonical = w.word;
  let displayName = null;

  if (!docIndex.byName.has(canonical) && docIndex.bySynonym.has(canonical)) {
    displayName = canonical;
    canonical = docIndex.bySynonym.get(canonical);
  }

  const d = docIndex.byName.get(canonical);
  if (!d) return null;

  if (displayName) {
    const md = buildMarkdownDoc(d, displayName);
    return {
      contents: { kind: MarkupKind.Markdown, value: md },
    };
  }
});

connection.listen();
