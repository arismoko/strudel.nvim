# Scratch

## LSP feature audit (from `js/lsp/server.ts`)

This is a quick grouping of Strudel LSP features into **passive** (can run without a live Strudel session/browser) vs **active** (needs a live Strudel session).

### Passive (no Strudel session needed)

These features work as long as the LSP server is running. Some require `doc.json` (generated/cached separately).

- **Parse diagnostics**: publishes `textDocument/publishDiagnostics` from `acorn.parse()` errors.
  - Does **not** need a running Strudel session.
  - Technically does **not** need `doc.json`.
- **Completion** (`completionProvider`): returns completion items based on:
  - `doc.json` (via `buildDocIndex(...)` + `complete(...)`)
  - optional `sampleIndex` (see “Passive, but session-enhanced”)
- **Completion resolve** (`resolveProvider`): enriches completion items.
- **Hover docs** (`hoverProvider`): renders docs from `docIndex` (requires `doc.json`).

### Passive, but session-enhanced (session not required, but improves results)

- **Sample/bank completions**: `sampleIndex` is initialized empty and can be updated via a notification.
  - Without session: completions may be empty/limited.
  - With session: Lua can forward runtime sample data to the LSP via custom notification.

### Active (needs an active Strudel session)

There are no “active” LSP capabilities implemented directly in `js/lsp/server.ts` (it doesn’t execute code or control playback).

However, sample completions become richer when a session is running because the LSP listens for:

- **Custom notification**: `strudel/samples`
  - Payload is provided externally (Lua/Strudel runtime).
  - When received, the server updates `sampleIndex` used by completion.
