import fs from "fs";
import path from "path";
import vm from "vm";

import { complete } from "./cm_engine.js";

const repoRoot = path.resolve(process.cwd());

type UpstreamCompletion =
  | null
  | {
      from: number;
      options: Array<{ label: string; type?: string; apply?: string }>;
    };

type Fixture = {
  name: string;
  text: string;
  cursor: number;
  explicit: boolean;
};

function assertEqual(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) {
    throw new Error(`${label} mismatch\nactual:   ${a}\nexpected: ${b}`);
  }
}

function matchBefore(text: string, cursorOffset: number, re: RegExp) {
  const before = text.slice(0, cursorOffset);

  // Find rightmost match that ends at cursor.
  const flags = re.flags.includes("g") ? re.flags : re.flags + "g";
  const globalRe = new RegExp(re.source, flags);

  let best: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = globalRe.exec(before))) {
    const idx = m.index ?? 0;
    const matchText = m[0] ?? "";
    const end = idx + matchText.length;
    if (end === before.length) best = m;
    if (matchText.length === 0) globalRe.lastIndex = idx + 1;
  }

  if (!best || best.index === undefined) return null;
  const matchText = best[0];
  const from = best.index;
  const to = from + matchText.length;
  return { from, to, text: matchText };
}

let upstreamAutocomplete:
  | ((ctx: { explicit: boolean; matchBefore: (re: RegExp) => any }) => any)
  | undefined;

function getUpstreamAutocomplete() {
  if (upstreamAutocomplete) return upstreamAutocomplete;

  const upstreamPath = path.resolve(
    repoRoot,
    "../strudel/packages/codemirror/autocomplete.mjs",
  );

  const upstreamSrc = fs.readFileSync(upstreamPath, "utf8");

  // Strip ESM imports/exports and evaluate inside a sandbox.
  // We only need handler logic + `strudelAutocomplete`.
  const stripped = upstreamSrc
    .split(/\r?\n/)
    .filter((line) => !line.startsWith("import "))
    .map((line) => {
      if (line.startsWith("export function ")) return line.replace("export ", "");
      if (line.startsWith("export const strudelAutocomplete")) {
        // Ensure it becomes a global on the vm context.
        return line
          .replace("export const strudelAutocomplete", "var strudelAutocomplete")
          .replace("= (context) =>", "= function (context)");
      }
      if (line.startsWith("export const ")) return line.replace("export ", "");
      return line;
    })
    .join("\n");

  const sandbox: Record<string, any> = {
    console,
    // Stubbed DOM helpers used by tooltip code, not needed for our comparisons.
    document: {
      createElement: () => ({
        innerHTML: "",
        textContent: "",
      }),
    },
    // Stubbed complex chord dictionary.
    complex: {},
    // Stubbed dependencies not needed for handler comparisons.
    autocompletion: () => ({}),
    h: () => [null],
    jsdoc: { docs: [] },
  };

  const context = vm.createContext(sandbox);
  vm.runInContext(stripped, context, { filename: "autocomplete.mjs" });

  const fn = (context as any).strudelAutocomplete;
  if (typeof fn !== "function") {
    const keys = Object.keys(context as any).sort().join(", ");
    throw new Error(
      `Failed to extract upstream strudelAutocomplete; context keys: ${keys}`,
    );
  }

  upstreamAutocomplete = fn;
  return fn;
}

async function runUpstream(fix: Fixture): Promise<UpstreamCompletion> {
  const fn = getUpstreamAutocomplete();

  const context = {
    explicit: fix.explicit,
    matchBefore: (re: RegExp) => matchBefore(fix.text, fix.cursor, re),
  };

  const res = fn(context);
  if (!res) return null;

  return {
    from: res.from,
    options: (res.options ?? []).map((o: any) => ({
      label: o.label,
      type: o.type,
      apply: o.apply,
    })),
  };
}

async function runLocal(fix: Fixture): Promise<UpstreamCompletion> {
  const res = await complete(fix.text, fix.cursor, {
    explicit: fix.explicit,
    docIndex: { byName: new Map(), bySynonym: new Map(), jsdocCompletions: [] },
    sources: {
      soundNames: ["bd", "bd_808", "cp", "gabba"],
      bankNames: ["bd", "drum"],
    },
  });

  if (!res) return null;
  return {
    from: res.from,
    options: res.options.map((o) => ({ label: o.label, type: o.type, apply: o.apply })),
  };
}

async function main() {
  const fixtures: Fixture[] = [
    {
      name: "sound no quotes",
      text: "sound( ",
      cursor: "sound( ".length,
      explicit: true,
    },
    {
      name: "sound quoted fragment",
      text: "sound(\"bd\"",
      cursor: "sound(\"bd\"".length,
      explicit: true,
    },
    {
      name: "bank no quotes",
      text: "bank( ",
      cursor: "bank( ".length,
      explicit: true,
    },
    {
      name: "mode after colon",
      text: "mode(\"duck:C\"",
      cursor: "mode(\"duck:C\"".length,
      explicit: true,
    },
    {
      name: "scale pre colon pitches",
      text: "scale(\"C\"",
      cursor: "scale(\"C\"".length,
      explicit: true,
    },
    {
      name: "fallback empty word explicit",
      text: "",
      cursor: 0,
      explicit: true,
    },
  ];

  for (const fix of fixtures) {
    const upstream = await runUpstream(fix);
    const local = await runLocal(fix);

    // Compare only handler outputs, not doc-based fallback list.
    // (Fallback fixture uses empty docs in local)
    assertEqual(local, upstream, fix.name);
  }

  process.stdout.write("parity_harness: OK\n");
}

main().catch((e: unknown) => {
  const msg = e instanceof Error ? e.stack ?? e.message : String(e);
  process.stderr.write(`${msg}\n`);
  process.exit(1);
});
