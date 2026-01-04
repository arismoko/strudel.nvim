#!/usr/bin/env node

import fs from "fs";
import path from "path";

import {
  CompletionItemKind,
  createConnection,
  MarkupKind,
  ProposedFeatures,
  TextDocumentPositionParams,
  TextDocuments,
  TextDocumentSyncKind,
  TextEdit,
} from "vscode-languageserver/node.js";

import { TextDocument } from "vscode-languageserver-textdocument";

import { buildMarkdownDoc, buildDocIndex, complete } from "./cm_engine.js";

function usageAndExit() {
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

function readJsonFile(p: string) {
  const raw = fs.readFileSync(p, "utf8");
  return JSON.parse(raw);
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

function stripHtml(html: string) {
  return html.replace(/<[^>]+>/g, "").trim();
}

type SampleIndex = { soundNames: string[]; banks: string[] };

function deriveBanksFromSounds(soundNames: string[]) {
  const banks = new Set<string>();
  for (const key of soundNames) {
    const [bank, suffix] = key.split("_");
    if (suffix && bank) banks.add(bank);
  }
  return Array.from(banks).sort();
}

function buildSampleIndex(sampleMap: Record<string, unknown>): SampleIndex {
  if (!sampleMap || typeof sampleMap !== "object") {
    return { soundNames: [], banks: [] };
  }

  const soundNames: string[] = [];

  for (const key of Object.keys(sampleMap)) {
    if (key === "_base") continue;
    if (!key) continue;
    soundNames.push(key);
  }

  soundNames.sort();

  return { soundNames, banks: deriveBanksFromSounds(soundNames) };
}

const args = parseArgs(process.argv.slice(2));
if (!args.stdio) {
  usageAndExit();
}

let docJsonPath = args.docJsonPath;
if (!docJsonPath) {
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
        triggerCharacters: ["(", "\"", "'", ":"],
      },
      hoverProvider: true,
    },
  };
});

connection.onNotification("strudel/samples", (payload) => {
  if (!payload || typeof payload !== "object") return;

  const soundNames = Array.isArray((payload as any).soundNames)
    ? (payload as any).soundNames.filter(
        (s: unknown) => typeof s === "string" && s,
      )
    : [];

  // Keep parity with upstream bank derivation from sound keys.
  const sortedSoundNames = soundNames.slice().sort();

  sampleIndex = {
    soundNames: sortedSoundNames,
    banks: deriveBanksFromSounds(sortedSoundNames),
  };
});

function cmTypeToLspKind(type?: string): CompletionItemKind {
  switch (type) {
    case "function":
      return CompletionItemKind.Function;
    case "sound":
    case "bank":
      return CompletionItemKind.Value;
    case "pitch":
    case "mode":
    case "scale":
    case "chord-symbol":
      return CompletionItemKind.Value;
    default:
      return CompletionItemKind.Text;
  }
}

function offsetToPosition(text: string, offset: number) {
  const clamped = Math.min(Math.max(offset, 0), text.length);
  const before = text.slice(0, clamped);
  const parts = before.split(/\r?\n/);
  const line = parts.length - 1;
  const character = parts[parts.length - 1].length;
  return { line, character };
}

connection.onCompletion(async (params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];

  const text = doc.getText();
  const offset = positionToOffset(text, params.position);

  // Intentional divergence from upstream CodeMirror `context.explicit`:
  // we always behave as explicit so users don't need manual invocation.
  const explicit = true;

  const cm = await complete(text, offset, {
    explicit,
    docIndex,
    sources: {
      soundNames: sampleIndex.soundNames,
      bankNames: sampleIndex.banks,
    },
  });

  if (!cm) return [];

  return cm.options.map((opt) => {
    const newText = opt.apply !== undefined ? opt.apply : opt.label;
    const range = {
      start: offsetToPosition(text, cm.from),
      end: offsetToPosition(text, offset),
    };

    return {
      label: opt.label,
      kind: cmTypeToLspKind(opt.type),
      // Upstream CodeMirror does not force ordering between synonyms and canonicals.
      sortText: undefined,
      textEdit: TextEdit.replace(range, newText),
      data:
        opt.type === "function" && opt.canonicalName
          ? {
              type: opt.isSynonym ? "syn" : "doc",
              name: opt.canonicalName,
              synonym: opt.isSynonym ? opt.label : undefined,
            }
          : undefined,
    };
  });
});

connection.onCompletionResolve((item) => {
  const data = item.data as any;
  if (!data || (data.type !== "doc" && data.type !== "syn")) return item;

  const canonical = data.name as string;
  const doc = docIndex.byName.get(canonical);
  if (!doc) return item;

  const displayName = data.type === "syn" ? (data.synonym as string) : null;
  const md = buildMarkdownDoc(doc, displayName);

  item.detail = typeof (doc as any).description === "string" ? stripHtml((doc as any).description) : undefined;
  item.documentation = { kind: MarkupKind.Markdown, value: md };
  return item;
});

connection.onHover((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;

  const text = doc.getText();
  const offset = positionToOffset(text, params.position);

  // Match a word under cursor
  const before = text.slice(0, offset);
  const after = text.slice(offset);
  const left = before.match(/[A-Za-z0-9_]+$/)?.[0] ?? "";
  const right = after.match(/^[A-Za-z0-9_]+/)?.[0] ?? "";
  const word = left + right;
  if (!word) return null;

  let canonical = word;
  let displayName: string | null = null;

  if (!docIndex.byName.has(canonical) && docIndex.bySynonym.has(canonical)) {
    displayName = canonical;
    canonical = docIndex.bySynonym.get(canonical) as string;
  }

  const d = docIndex.byName.get(canonical);
  if (!d) return null;

  const md = buildMarkdownDoc(d, displayName);
  return { contents: { kind: MarkupKind.Markdown, value: md } };
});

connection.listen();
