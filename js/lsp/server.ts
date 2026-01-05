#!/usr/bin/env node

import fs from "fs";
import path from "path";

import {
  CodeAction,
  CodeActionKind,
  CompletionItemKind,
  createConnection,
  Diagnostic,
  DiagnosticSeverity,
  MarkupKind,
  ProposedFeatures,
  Range,
  TextDocumentPositionParams,
  TextDocuments,
  TextDocumentSyncKind,
  TextEdit,
  WorkspaceEdit,
} from "vscode-languageserver/node.js";

import { TextDocument } from "vscode-languageserver-textdocument";

import { buildMarkdownDoc, buildDocIndex, complete } from "./cm_engine.js";

import { parse } from "acorn";

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

function rangeToOffsets(text: string, range: Range) {
  const start = positionToOffset(text, range.start);
  const end = positionToOffset(text, range.end);
  return { start: Math.min(start, end), end: Math.max(start, end) };
}

type QuoteChar = "'" | '"' | "`";

function isEscaped(text: string, i: number) {
  let backslashes = 0;
  for (let j = i - 1; j >= 0 && text[j] === "\\"; j--) backslashes++;
  return backslashes % 2 === 1;
}

function findEnclosingStringLiteral(
  text: string,
  selectionStart: number,
  selectionEnd: number,
): { start: number; end: number; quote: QuoteChar; innerStart: number; innerEnd: number } | null {
  // Only support single-line literals for now.
  const before = text.lastIndexOf("\n", selectionStart - 1);
  const lineStart = before === -1 ? 0 : before + 1;
  const after = text.indexOf("\n", selectionEnd);
  const lineEnd = after === -1 ? text.length : after;

  // Scan left for an opening quote.
  let open = -1;
  let quote: QuoteChar | null = null;
  for (let i = selectionStart - 1; i >= lineStart; i--) {
    const ch = text[i];
    if ((ch === "'" || ch === '"' || ch === "`") && !isEscaped(text, i)) {
      open = i;
      quote = ch as QuoteChar;
      break;
    }
  }
  if (open === -1 || !quote) return null;

  // Scan right for the matching closing quote.
  let close = -1;
  for (let i = Math.max(selectionEnd, open + 1); i < lineEnd; i++) {
    const ch = text[i];
    if (ch === quote && !isEscaped(text, i)) {
      close = i;
      break;
    }
  }
  if (close === -1) return null;

  const innerStart = open + 1;
  const innerEnd = close;

  // Selection must be fully inside the literal (or exactly cover it).
  if (selectionStart < open || selectionEnd > close + 1) return null;

  return { start: open, end: close + 1, quote, innerStart, innerEnd };
}

function rewriteLiteralContent(content: string, from: QuoteChar, to: QuoteChar) {
  let out = content;

  // Normalize common escaped quotes when changing away from that delimiter.
  if (from === "'" && to !== "'") {
    out = out.replace(/\\'/g, "'");
  }
  if (from === '"' && to !== '"') {
    out = out.replace(/\\\"/g, '"');
  }
  if (from === "`" && to !== "`") {
    out = out.replace(/\\`/g, "`");
  }

  if (to === '"') {
    out = out.replace(/\\/g, "\\\\");
    out = out.replace(/\"/g, "\\\"");
    // Disallow multiline -> quoted strings.
    if (out.includes("\n")) return null;
    return out;
  }

  if (to === "`") {
    // Template literals: avoid accidental interpolation.
    out = out.replace(/\\/g, "\\\\");
    out = out.replace(/`/g, "\\`");
    out = out.replace(/\$\{/g, "\\${");
    return out;
  }

  // to === "'"
  out = out.replace(/\\/g, "\\\\");
  out = out.replace(/'/g, "\\'");
  if (out.includes("\n")) return null;
  return out;
}

function makeConvertQuoteAction(
  title: string,
  kind: CodeActionKind,
  uri: string,
  literalRange: Range,
  newText: string,
): CodeAction {
  const edit: WorkspaceEdit = {
    changes: {
      [uri]: [TextEdit.replace(literalRange, newText)],
    },
  };

  return {
    title,
    kind,
    edit,
  };
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

documents.onDidOpen((e) => {
  void validateDocument(e.document);
});

documents.onDidChangeContent((e) => {
  // Track latest version so stale scheduled validations don't publish.
  lastKnownVersionByUri.set(e.document.uri, e.document.version);
  scheduleValidation(e.document.uri, 150);
});

documents.onDidClose((e) => {
  const uri = e.document.uri;

  connection.sendDiagnostics({ uri, diagnostics: [] });

  const t = debounceTimersByUri.get(uri);
  if (t) clearTimeout(t);
  debounceTimersByUri.delete(uri);
  lastKnownVersionByUri.delete(uri);
});

connection.onInitialize(() => {
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: {
        resolveProvider: true,
        triggerCharacters: ["(", "\"", "'", ":"],
      },
      hoverProvider: true,
      codeActionProvider: {
        codeActionKinds: [
          CodeActionKind.RefactorExtract,
          CodeActionKind.RefactorRewrite,
        ],
      },
      executeCommandProvider: {
        commands: ["strudel.extractLet"],
      },
    },
  };
});

function syntaxDiagnosticsFromError(err: unknown): Diagnostic[] | null {
  if (!err || typeof err !== "object") return null;

  const message = (err as any).message;
  const loc = (err as any).loc as { line: number; column: number } | undefined;

  // Only surface acorn-style parse errors (SyntaxError with `loc`).
  if (typeof message !== "string" || !message) return null;
  if (typeof loc?.line !== "number" || typeof loc?.column !== "number") return null;

  const line = Math.max(0, loc.line - 1);
  const character = Math.max(0, loc.column);

  return [
    {
      severity: DiagnosticSeverity.Error,
      message,
      range: {
        start: { line, character },
        // Zero-length range avoids off-by-one highlights near EOF.
        end: { line, character },
      },
      source: "strudel",
    },
  ];
}

const lastKnownVersionByUri = new Map<string, number>();

function scheduleValidation(uri: string, delayMs: number) {
  const existing = debounceTimersByUri.get(uri);
  if (existing) clearTimeout(existing);

  const t = setTimeout(() => {
    debounceTimersByUri.delete(uri);
    const doc = documents.get(uri);
    if (!doc) return;
    void validateDocument(doc);
  }, delayMs);

  debounceTimersByUri.set(uri, t);
}

const debounceTimersByUri = new Map<string, ReturnType<typeof setTimeout>>();

async function validateDocument(doc: TextDocument) {
  const uri = doc.uri;
  const version = doc.version;

  const text = doc.getText();

  try {
    parse(text, {
      ecmaVersion: 2022,
      allowAwaitOutsideFunction: true,
      locations: true,
    } as any);

    // Only publish if this is still the latest version we saw.
    if (lastKnownVersionByUri.get(uri) !== version) return;

    connection.sendDiagnostics({ uri, diagnostics: [] });
  } catch (e: unknown) {
    if (lastKnownVersionByUri.get(uri) !== version) return;

    const diagnostics = syntaxDiagnosticsFromError(e);
    if (diagnostics) {
      connection.sendDiagnostics({ uri, diagnostics });
    } else {
      connection.sendDiagnostics({ uri, diagnostics: [] });
    }
  }
}

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
      return CompletionItemKind.Value;
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

connection.onCodeAction((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];

  const text = doc.getText();
  const { start: selStart, end: selEnd } = rangeToOffsets(text, params.range);
  const uri = params.textDocument.uri;

  const actions: CodeAction[] = [];

  // Extract selection -> let declaration (selection required).
  if (selStart !== selEnd) {
    actions.push({
      title: "Extract to let…",
      kind: CodeActionKind.RefactorExtract,
      command: {
        title: "Extract to let…",
        command: "strudel.extractLet",
        arguments: [
          {
            uri,
            range: params.range,
          },
        ],
      },
    });
  }

  // Many clients (including Neovim) call code actions with an empty range.
  // For quote rewrites, operate on the cursor position by treating it as a
  // 1-character selection.
  const effectiveEnd = selStart === selEnd ? Math.min(selEnd + 1, text.length) : selEnd;

  const lit = findEnclosingStringLiteral(text, selStart, effectiveEnd);
  if (!lit) return actions;

  const content = text.slice(lit.innerStart, lit.innerEnd);
  const k = CodeActionKind.RefactorRewrite;

  // Convert to `...`
  if (lit.quote !== "`") {
    const rewritten = rewriteLiteralContent(content, lit.quote, "`");
    if (rewritten !== null) {
      const newLiteral = "`" + rewritten + "`";
      actions.push(
        makeConvertQuoteAction(
          "Convert to template string",
          k,
          uri,
          {
            start: offsetToPosition(text, lit.start),
            end: offsetToPosition(text, lit.end),
          },
          newLiteral,
        ),
      );
    }
  }

  // Convert to "..."
  if (lit.quote !== '"') {
    const rewritten = rewriteLiteralContent(content, lit.quote, '"');
    if (rewritten !== null) {
      const newLiteral = '"' + rewritten + '"';
      actions.push(
        makeConvertQuoteAction(
          "Convert to double quotes",
          k,
          uri,
          {
            start: offsetToPosition(text, lit.start),
            end: offsetToPosition(text, lit.end),
          },
          newLiteral,
        ),
      );
    }
  }

  return actions;
});


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
      filterText: opt.filterText,
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

  // Hover differs from completion: users may hover a control synonym
  // (`cutoff`) and expect to see docs for the canonical function (`lpf`).
  if (docIndex.bySynonym.has(canonical)) {
    displayName = canonical;
    canonical = docIndex.bySynonym.get(canonical) as string;
  }

  const d = docIndex.byName.get(canonical);
  if (!d) return null;

  const md = buildMarkdownDoc(d, displayName);
  return { contents: { kind: MarkupKind.Markdown, value: md } };
});

connection.listen();
