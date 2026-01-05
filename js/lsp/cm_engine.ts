export type CmCompletionOption = {
  label: string;
  type?: string;
  apply?: string;
  filterText?: string;
  canonicalName?: string;
  isSynonym?: boolean;
};

export type CmCompletionResult = {
  from: number;
  options: CmCompletionOption[];
};

export type CmCompletionMaybe = CmCompletionResult | null;

export type DocJson = {
  docs: unknown[];
};

type Doc = Record<string, unknown>;

type DynamicSources = {
  soundNames?: string[];
  bankNames?: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stripHtml(html: string) {
  return html.replace(/<[^>]+>/g, "").trim();
}

function isInsideString(text: string, cursorOffset: number) {
  const clamped = Math.min(Math.max(cursorOffset, 0), text.length);

  let inQuote: "'" | '"' | "`" | null = null;
  let escaped = false;

  for (let i = 0; i < clamped; i++) {
    const ch = text[i];
    if (!ch) continue;

    if (escaped) {
      escaped = false;
      continue;
    }

    if (ch === "\\") {
      // In JS strings (including template literals), backslash escapes the next char.
      escaped = true;
      continue;
    }

    if (ch === "'" || ch === '"' || ch === "`") {
      if (!inQuote) {
        inQuote = ch;
        continue;
      }

      if (inQuote === ch) {
        inQuote = null;
        continue;
      }
    }

    // Reset at newline for single-quote/double-quote strings.
    if (ch === "\n" && (inQuote === "'" || inQuote === '"')) {
      inQuote = null;
      escaped = false;
    }
  }

  return inQuote !== null;
}

function getDocLabel(doc: Doc) {
  if (typeof doc["name"] === "string") return doc["name"];
  if (typeof doc["longname"] === "string") return doc["longname"];
  if (typeof doc["longName"] === "string") return doc["longName"];
  return null;
}

function hasExcludedTags(doc: Doc) {
  const tags = doc.tags;
  if (!Array.isArray(tags)) return false;
  return ["superdirtOnly", "noAutocomplete"].some((needle) =>
    tags.some((t: any) => t?.originalTitle === needle),
  );
}

function isValidDoc(doc: Doc) {
  const label = getDocLabel(doc);
  return (
    typeof label === "string" &&
    label !== "" &&
    !label.startsWith("_") &&
    doc.kind !== "package" &&
    !hasExcludedTags(doc)
  );
}

export type DocIndex = {
  byName: Map<string, Doc>;
  bySynonym: Map<string, string>;
  jsdocCompletions: CmCompletionOption[];
};

export function buildDocIndex(docJson: DocJson): DocIndex {
  const byName = new Map<string, Doc>();
  const bySynonym = new Map<string, string>();

  if (!docJson || !Array.isArray(docJson.docs)) {
    throw new Error("doc.json missing docs[]");
  }

  // Build indices first.
  for (const d of docJson.docs) {
    if (!isRecord(d)) continue;
    if (!isValidDoc(d)) continue;

    const name = getDocLabel(d);
    if (!name) continue;

    if (!byName.has(name)) byName.set(name, d);

    const syns = Array.isArray(d.synonyms) ? d.synonyms : [];
    for (const s of syns) {
      if (typeof s !== "string" || !s) continue;
      if (!bySynonym.has(s)) bySynonym.set(s, name);
    }
  }

  // Build upstream-style jsdocCompletions list (deduped name + synonyms).
  const seen = new Set<string>();
  const jsdocCompletions: CmCompletionOption[] = [];

  for (const d of docJson.docs) {
    if (!isRecord(d)) continue;
    if (!isValidDoc(d)) continue;

    const canonicalName = getDocLabel(d);
    if (!canonicalName) continue;

    const syns = Array.isArray(d.synonyms) ? d.synonyms : [];
    const labels = [canonicalName, ...syns].filter(
      (x): x is string => typeof x === "string" && x !== "",
    );

    for (const label of labels) {
      if (seen.has(label)) continue;
      seen.add(label);

      const isSynonym = label !== canonicalName;
      jsdocCompletions.push({
        label,
        type: "function",
        canonicalName,
        isSynonym,
      });
    }
  }

  return { byName, bySynonym, jsdocCompletions };
}

export type CompletionContext = {
  explicit: boolean;
  matchBefore: (re: RegExp) => { from: number; to: number; text: string } | null;
};

function makeContext(
  text: string,
  cursorOffset: number,
  explicit: boolean,
  lookbehindLimit = 8192,
): CompletionContext {
  const to = Math.min(Math.max(cursorOffset, 0), text.length);
  const windowFrom = Math.max(0, to - lookbehindLimit);
  const windowText = text.slice(windowFrom, to);

  return {
    explicit,
    // CodeMirror's `matchBefore` finds a match that ends at the cursor.
    matchBefore: (re) => {
      // We only consider matches that reach the end of `windowText`.
      // Prefer the rightmost such match if multiple exist.
      const flags = re.flags.includes("g") ? re.flags : re.flags + "g";
      const globalRe = new RegExp(re.source, flags);

      let best: RegExpExecArray | null = null;
      let m: RegExpExecArray | null;
      while ((m = globalRe.exec(windowText))) {
        const idx = m.index ?? 0;
        const matchText = m[0] ?? "";
        const end = idx + matchText.length;

        if (end === windowText.length) {
          best = m;
        }

        // Avoid infinite loops on empty matches.
        if (matchText.length === 0) {
          globalRe.lastIndex = idx + 1;
        }
      }

      if (!best || best.index === undefined) return null;

      const matchText = best[0];
      const from = windowFrom + best.index;
      const end = from + matchText.length;
      return { from, to: end, text: matchText };
    },
  };
}

// --- Ported/adapted from Strudel's CodeMirror autocomplete ---

const SOUND_NO_QUOTES_REGEX = /(s|sound)\(\s*$/;
const SOUND_WITH_QUOTES_REGEX = /(s|sound)\(\s*['"][^'"]*$/;
const SOUND_FRAGMENT_MATCH_REGEX = /(?:[\s[{(<])([\w]*)$/;

const BANK_NO_QUOTES_REGEX = /bank\(\s*$/;
const BANK_WITH_QUOTES_REGEX = /bank\(\s*['"][^'"]*$/;

const pitchNames = [
  "C",
  "C#",
  "Db",
  "D",
  "D#",
  "Eb",
  "E",
  "E#",
  "Fb",
  "F",
  "F#",
  "Gb",
  "G",
  "G#",
  "Ab",
  "A",
  "A#",
  "Bb",
  "B",
  "B#",
  "Cb",
];

const pitchNamesLongestFirst = [...pitchNames].sort(
  (a, b) => b.length - a.length,
);

// Upstream currently leaves this empty (tonal import is TODO).
const scaleCompletions: Array<{ label: string; type: string }> = [];

const modeCompletions = [
  { label: "below", type: "mode" },
  { label: "above", type: "mode" },
  { label: "duck", type: "mode" },
  { label: "root", type: "mode" },
];

async function getChordSymbolCompletions(): Promise<
  Array<{ label: string; apply?: string; type: string }>
> {
  // Lazy-import to avoid `@strudel/tonal` side effects during LSP startup.
  const { complex } = await import("@strudel/tonal");

  const chordSymbols = ["", ...Object.keys(complex)].sort();
  return chordSymbols.map((symbol) => {
    if (symbol === "") {
      return {
        label: "major",
        apply: "",
        type: "chord-symbol",
      };
    }
    return {
      label: symbol,
      apply: symbol,
      type: "chord-symbol",
    };
  });
}

let chordSymbolCompletionsPromise:
  | Promise<Array<{ label: string; apply?: string; type: string }>>
  | undefined;

function chordSymbolCompletionsCached() {
  if (!chordSymbolCompletionsPromise) {
    chordSymbolCompletionsPromise = getChordSymbolCompletions();
  }
  return chordSymbolCompletionsPromise;
}

const SCALE_NO_QUOTES_REGEX = /scale\(\s*$/;
const SCALE_AFTER_COLON_REGEX = /scale\(\s*['"][^'"]*:[^'"]*$/;
const SCALE_PRE_COLON_REGEX = /scale\(\s*['"][^'"]*$/;
const SCALE_PITCH_MATCH_REGEX = /([A-Ga-g][#b]*)?$/;
const SCALE_SPACES_TO_COLON_REGEX = /\s+/g;

const MODE_NO_QUOTES_REGEX = /mode\(\s*$/;
const MODE_AFTER_COLON_REGEX = /mode\(\s*['"][^'"]*:[^'"]*$/;
const MODE_PRE_COLON_REGEX = /mode\(\s*['"][^'"]*$/;
const MODE_FRAGMENT_MATCH_REGEX = /(?:[\s[{(<])([\w:]*)$/;

const CHORD_NO_QUOTES_REGEX = /chord\(\s*$/;
const CHORD_WITH_QUOTES_REGEX = /chord\(\s*['"][^'"]*$/;
const CHORD_FRAGMENT_MATCH_REGEX = /(?:[\s[{(<])([\w#b+^:-]*)$/;

const FALLBACK_WORD_REGEX = /\w*/;

function extractSoundFragment(inside: string) {
  const m = inside.match(SOUND_FRAGMENT_MATCH_REGEX);
  if (m) return m[1];
  return inside;
}

function soundHandler(context: CompletionContext, sources: DynamicSources): CmCompletionMaybe {
  const soundNoQuotesContext = context.matchBefore(SOUND_NO_QUOTES_REGEX);
  if (soundNoQuotesContext) {
    return { from: soundNoQuotesContext.to, options: [] };
  }

  const soundContext = context.matchBefore(SOUND_WITH_QUOTES_REGEX);
  if (!soundContext) return null;

  const text = soundContext.text;
  const quoteIdx = Math.max(text.lastIndexOf('"'), text.lastIndexOf("'"));
  if (quoteIdx === -1) return null;

  const inside = text.slice(quoteIdx + 1);
  const fragment = extractSoundFragment(inside);

  const soundNames = (sources.soundNames ?? []).slice().sort();
  const filteredSounds = soundNames.filter((name) => name.includes(fragment));

  const from = soundContext.to - fragment.length;

  return {
    from,
    options: filteredSounds.map((label) => ({ label, type: "sound" })),
  };
}

function bankHandler(context: CompletionContext, sources: DynamicSources): CmCompletionMaybe {
  const bankNoQuotesContext = context.matchBefore(BANK_NO_QUOTES_REGEX);
  if (bankNoQuotesContext) {
    return { from: bankNoQuotesContext.to, options: [] };
  }

  const bankMatch = context.matchBefore(BANK_WITH_QUOTES_REGEX);
  if (!bankMatch) return null;

  const text = bankMatch.text;
  const quoteIdx = Math.max(text.lastIndexOf('"'), text.lastIndexOf("'"));
  if (quoteIdx === -1) return null;

  const inside = text.slice(quoteIdx + 1);
  const fragment = inside;

  const bankNames = (sources.bankNames ?? []).slice().sort();
  const filtered = bankNames.filter((b) => b.startsWith(fragment));

  const from = bankMatch.to - fragment.length;
  return {
    from,
    options: filtered.map((label) => ({ label, type: "bank" })),
  };
}

async function chordHandler(context: CompletionContext): Promise<CmCompletionMaybe> {
  const chordNoQuotesContext = context.matchBefore(CHORD_NO_QUOTES_REGEX);
  if (chordNoQuotesContext) {
    return { from: chordNoQuotesContext.to, options: [] };
  }

  const chordContext = context.matchBefore(CHORD_WITH_QUOTES_REGEX);
  if (!chordContext) return null;

  const text = chordContext.text;
  const quoteIdx = Math.max(text.lastIndexOf('"'), text.lastIndexOf("'"));
  if (quoteIdx === -1) return null;
  const inside = text.slice(quoteIdx + 1);

  const fragMatch = inside.match(CHORD_FRAGMENT_MATCH_REGEX);
  const fragment = fragMatch ? fragMatch[1] : inside;

  let rootMatch: string | null = null;
  let symbolFragment = fragment;
  for (const pitch of pitchNamesLongestFirst) {
    if (fragment.toLowerCase().startsWith(pitch.toLowerCase())) {
      rootMatch = pitch;
      symbolFragment = fragment.slice(pitch.length);
      break;
    }
  }

  // Do not offer pitch/root completions for `chord("...")`.
  // This keeps the menu focused on chord symbols/qualities (e.g. ^7, -7, sus).
  const chordSymbolCompletions = await chordSymbolCompletionsCached();

  // If the user typed a root (C, C#, Bb, ...), only complete the symbol part.
  // If not, allow completing from the start (useful if they paste/edit).
  const needle = rootMatch ? symbolFragment : fragment;

  const filteredSymbols = chordSymbolCompletions.filter((s) =>
    s.label.toLowerCase().startsWith(needle.toLowerCase()),
  );

  const from = rootMatch
    ? chordContext.to - fragment.length
    : chordContext.to - needle.length;
  if (!rootMatch) return { from, options: filteredSymbols };

  const rootPrefix = fragment.slice(0, rootMatch.length);
  const options = filteredSymbols.map((s) => {
    const symbol = s.apply !== undefined ? s.apply : s.label;
    const chordText = symbol === "" ? rootPrefix : rootPrefix + symbol;

    return {
      ...s,
      label: rootPrefix + s.label,
      apply: chordText,
      filterText: chordText,
    };
  });

  return { from, options };
}

function scaleHandler(context: CompletionContext): CmCompletionMaybe {
  const scaleNoQuotesContext = context.matchBefore(SCALE_NO_QUOTES_REGEX);
  if (scaleNoQuotesContext) {
    return { from: scaleNoQuotesContext.to, options: [] };
  }

  const scaleAfterColonContext = context.matchBefore(SCALE_AFTER_COLON_REGEX);
  if (scaleAfterColonContext) {
    const text = scaleAfterColonContext.text;
    const colonIdx = text.lastIndexOf(":");
    if (colonIdx !== -1) {
      const fragment = text.slice(colonIdx + 1);
      const filteredScales = scaleCompletions.filter((s) => s.label.startsWith(fragment));
      const options = filteredScales.map((s) => ({
        ...s,
        apply: s.label.replace(SCALE_SPACES_TO_COLON_REGEX, ":"),
      }));
      const from = scaleAfterColonContext.from + colonIdx + 1;
      return { from, options };
    }
  }

  const scalePreColonContext = context.matchBefore(SCALE_PRE_COLON_REGEX);
  if (scalePreColonContext) {
    if (!scalePreColonContext.text.includes(":")) {
      if (context.explicit) {
        const text = scalePreColonContext.text;
        const match = text.match(SCALE_PITCH_MATCH_REGEX);
        const fragment = match ? match[0] : "";
        const filtered = pitchNames.filter((p) =>
          p.toLowerCase().startsWith(fragment.toLowerCase()),
        );
        const from = scalePreColonContext.to - fragment.length;
        const options = filtered.map((p) => ({ label: p, type: "pitch" }));
        return { from, options };
      }
      return { from: scalePreColonContext.to, options: [] };
    }
  }

  return null;
}

function modeHandler(context: CompletionContext): CmCompletionMaybe {
  const modeNoQuotesContext = context.matchBefore(MODE_NO_QUOTES_REGEX);
  if (modeNoQuotesContext) {
    return { from: modeNoQuotesContext.to, options: [] };
  }

  const modeAfterColonContext = context.matchBefore(MODE_AFTER_COLON_REGEX);
  if (modeAfterColonContext) {
    const text = modeAfterColonContext.text;
    const colonIdx = text.lastIndexOf(":");
    if (colonIdx !== -1) {
      const fragment = text.slice(colonIdx + 1);
      const filtered = pitchNames.filter((p) =>
        p.toLowerCase().startsWith(fragment.toLowerCase()),
      );
      const options = filtered.map((p) => ({ label: p, type: "pitch" }));
      const from = modeAfterColonContext.from + colonIdx + 1;
      return { from, options };
    }
  }

  const modeContext = context.matchBefore(MODE_PRE_COLON_REGEX);
  if (!modeContext) return null;

  const text = modeContext.text;
  const quoteIdx = Math.max(text.lastIndexOf('"'), text.lastIndexOf("'"));
  if (quoteIdx === -1) return null;
  const inside = text.slice(quoteIdx + 1);
  const fragMatch = inside.match(MODE_FRAGMENT_MATCH_REGEX);
  const fragment = fragMatch ? fragMatch[1] : inside;
  const filteredModes = modeCompletions.filter((m) => m.label.startsWith(fragment));
  const from = modeContext.to - fragment.length;
  return { from, options: filteredModes };
}

function fallbackHandler(context: CompletionContext, options: CmCompletionOption[]): CmCompletionMaybe {
  const word = context.matchBefore(FALLBACK_WORD_REGEX);
  if (word && word.from === word.to && !context.explicit) return null;
  if (!word) return null;
  return { from: word.from, options };
}

function wordPrefixHandler(text: string, cursorOffset: number, index: DocIndex): CmCompletionResult {
  const before = text.slice(0, cursorOffset);
  const m = before.match(/[A-Za-z0-9_]+$/);
  const prefix = m ? m[0] : "";
  const from = cursorOffset - prefix.length;

  const lowerPrefix = prefix.toLowerCase();
  const options: CmCompletionOption[] = [];

  for (const name of index.byName.keys()) {
    if (lowerPrefix && !name.toLowerCase().startsWith(lowerPrefix)) continue;
    options.push({ label: name, type: "function", canonicalName: name });
  }

  for (const [syn, canonical] of index.bySynonym.entries()) {
    if (lowerPrefix && !syn.toLowerCase().startsWith(lowerPrefix)) continue;
    options.push({
      label: syn,
      type: "function",
      canonicalName: canonical,
      isSynonym: true,
    });
  }

  return { from, options };
}

export async function complete(
  text: string,
  cursorOffset: number,
  params: {
    explicit: boolean;
    docIndex: DocIndex;
    sources?: DynamicSources;
  },
): Promise<CmCompletionMaybe> {
  const sources = params.sources ?? {};
  const ctx = makeContext(text, cursorOffset, params.explicit);

  // If the cursor is inside a string (`...`, '...', "..."), only offer
  // string-context completions (sound/bank/etc). Avoid global function
  // completions from fallbackHandler, which get noisy inside quotes.
  const inString = isInsideString(text, cursorOffset);

  const handlers: Array<() => Promise<CmCompletionMaybe>> = inString
    ? [
        async () => soundHandler(ctx, sources),
        async () => bankHandler(ctx, sources),
        async () => chordHandler(ctx),
        async () => scaleHandler(ctx),
        async () => modeHandler(ctx),
      ]
    : [
        // Mirror upstream handler order.
        async () => soundHandler(ctx, sources),
        async () => bankHandler(ctx, sources),
        async () => chordHandler(ctx),
        async () => scaleHandler(ctx),
        async () => modeHandler(ctx),
        async () => fallbackHandler(ctx, params.docIndex.jsdocCompletions),
      ];

  for (const h of handlers) {
    const res = await h();
    if (res) return res;
  }

  return null;
}

export function buildMarkdownDoc(doc: Doc, displayName?: string | null): string {
  const lines: string[] = [];

  const label = getDocLabel(doc);

  if (displayName && label && displayName !== label) {
    lines.push(`Alias: \`${displayName}\` → \`${label}\``, "");
  }

  if (label && typeof doc.kind === "string") {
    lines.push(`\`${label}\` (${doc.kind})`, "");
  } else if (label) {
    lines.push(`\`${label}\``, "");
  }

  if (typeof doc.description === "string") {
    const desc = stripHtml(doc.description);
    if (desc) lines.push(desc);
  }

  const params = doc.params;
  if (Array.isArray(params) && params.length) {
    lines.push("", "Parameters:");
    for (const p of params) {
      if (!isRecord(p)) continue;
      const pname = typeof p.name === "string" ? p.name : "?";
      const pdesc = typeof p.description === "string" ? stripHtml(p.description) : "";
      const ptype =
        isRecord(p.type) &&
        Array.isArray((p.type as any).names) &&
        typeof (p.type as any).names[0] === "string"
          ? String((p.type as any).names[0])
          : "";

      let line = `- \`${pname}\``;
      if (ptype) line += `: \`${ptype}\``;
      if (pdesc) line += ` — ${pdesc}`;
      lines.push(line);
    }
  }

  const returns = (doc as any).returns;
  if (Array.isArray(returns) && returns.length) {
    const r0 = returns.find((r: unknown) => isRecord(r)) as Record<string, unknown> | undefined;
    const rdesc = r0 && typeof r0.description === "string" ? stripHtml(r0.description) : "";
    const rtype =
      r0 && isRecord(r0.type) && Array.isArray((r0.type as any).names) && typeof (r0.type as any).names[0] === "string"
        ? String((r0.type as any).names[0])
        : "";

    if (rtype || rdesc) {
      lines.push("", "Returns:");
      let line = "-";
      if (rtype) line += ` \`${rtype}\``;
      if (rdesc) line += ` — ${rdesc}`;
      lines.push(line);
    }
  }

  const synonyms = doc.synonyms;
  if (Array.isArray(synonyms) && synonyms.length) {
    const syn = synonyms.filter((s) => typeof s === "string" && s !== "");
    if (syn.length) {
      const merged = label ? [label, ...syn] : syn;
      const unique = Array.from(new Set(merged)).filter((s) => s !== displayName);
      lines.push("", `Synonyms: ${unique.map((s) => `\`${s}\``).join(", ")}`);
    }
  }

  const comment = typeof (doc as any).comment === "string" ? String((doc as any).comment) : "";
  const seeMatches = Array.from(comment.matchAll(/^\s*\*\s*@see\s+(.+)$/gm)).map((m) =>
    (m[1] ?? "").trim(),
  );
  if (seeMatches.length) {
    lines.push("", "See:");
    for (const s of seeMatches.slice(0, 5)) {
      if (!s) continue;
      lines.push(`- ${s}`);
    }
  }

  const examples = doc.examples;
  if (Array.isArray(examples) && examples.length) {
    lines.push("", "Examples:");
    for (const ex of examples.slice(0, 6)) {
      if (typeof ex !== "string" || !ex) continue;
      lines.push("```javascript", ex, "```");
    }
  }

  return lines.join("\n");
}
