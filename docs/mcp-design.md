# MCP Server — Design Notes

Status: **Not built.** This document records the settled design so it can be
implemented later without re-deriving the decisions. It exists as a reference,
not a commitment to a timeline.

## Goal

Let an AI tool (Claude Desktop, Cline, etc.) read, search, create, and edit the
same markdown notes the aanote app uses — without the app carrying any MCP code
or running anything by default.

## Core decision: separate, AI-client-launched binary

The MCP server is a **standalone binary** (`aanote-mcp`), written in **Rust**,
shipped alongside the app per-platform. It is NOT linked into the Tauri app.

**Why separate:** the app stays exactly as lean as it is today — no MCP SDK in
the dependency tree, no background process, no startup cost. Users who never use
AI never run it.

**Why AI-client-launched:** the server runs on demand. The AI client (Claude
Desktop, etc.) spawns `aanote-mcp` via stdio when the user invokes an AI tool,
and kills it when done. There is no daemon, no "always running" process, no
settings toggle required. The capability is structurally opt-in: a user who
never configures an AI client never triggers it.

```
User does nothing        →  aanote-mcp sits on disk, NEVER runs
User opens aanote        →  app runs; knows nothing about MCP
User asks AI to edit     →  AI client spawns aanote-mcp ON DEMAND
User stops using AI      →  AI client kills the server
```

## Language: Rust (not Node)

Forces the choice: "available on all platforms" with no runtime dependency.

| Option | Cross-platform | Per-platform runtime |
|---|---|---|
| **Rust** (chosen) | Compiles natively for all 3 targets | None — self-contained binary |
| Node | Cross-platform | Users must have Node.js installed (friction) |

The Rust server **reuses the existing logic** in `src-tauri/src/fs_commands.rs` —
extract those functions into a shared crate/library so both the app and the
server call the same code. No logic duplication.

## Tool surface (maps to existing commands)

| MCP tool | Backs onto | Notes |
|---|---|---|
| `list_notes()` | `scan_directory` | |
| `read_note(path)` | `read_note` | |
| `search_notes(query)` | `search_notes_snippet` | |
| `create_note(name, content)` | `create_note` + atomic write | |
| `edit_note(path, content)` | **`save_note_if_unchanged`** | mtime guard — see warning below |

## Critical: edits MUST go through the mtime guard

Any AI write **must** use `save_note_if_unchanged` (expected-mtime comparison),
NOT raw `save_note`. Otherwise an AI edit can clobber a remote Drive change that
downloaded between the app's last sync and the AI's write — exactly the C3
data-loss class. Bake this in from the start; never bypass it for "speed."

## Per-platform distribution

| Platform | App bundle | MCP binary location |
|---|---|---|
| Linux (`.deb`) | `aanote` | `/usr/local/bin/aanote-mcp` |
| macOS (`.dmg`) | `aanote.app` | `aanote.app/Contents/MacOS/aanote-mcp` |
| Windows (future) | installer | `C:\Program Files\aanote\aanote-mcp.exe` |

CI: add `aanote-mcp` as a second build target per platform (one extra line in
the matrix). The MCP binary is built from the same Rust workspace, sharing the
fs/sync library crate.

## The one config wrinkle

The path to `aanote-mcp` differs per OS, so the in-app help text (if any) must
detect the platform and show the right snippet:

```js
// pseudo — in Settings panel
const path = navigator.platform.includes("Mac")
  ? "/Applications/aanote.app/Contents/MacOS/aanote-mcp"
  : navigator.platform.includes("Win")
  ? "C:\\Program Files\\aanote\\aanote-mcp.exe"
  : "aanote-mcp"; // Linux — in PATH
```

The user copies this into their AI client config once. Example (Claude Desktop):
```jsonc
{
  "mcpServers": {
    "aanote": { "command": "aanote-mcp" }
  }
}
```

No app toggle needed — opt-in happens at the AI-client-config layer.

## The known limitation

AI edits made while the aanote app is **closed** bypass Drive sync — they're
plain file writes. If the app is open, the 5s `loadTree` picks them up and they
sync on the next trigger. If the app is closed, edits sit on disk until the next
app open. **Workflow assumption: edit with AI while the app is open.** If this
becomes painful, a future enhancement could have `aanote-mcp` shell out to a
sync-trigger, but that's out of scope for v1.

## Prerequisites (do BEFORE building this)

1. **Harden the sync engine.** The current rewrite is "more defensible" but not
   proven. An AI client calling `save_note_if_unchanged` through `aanote-mcp` is
   an automated vector for corruption if that path has a residual bug — and
   you can't see it in the app UI. Build the mock-Drive property-test harness
   first.
2. **Daily-drive v0.2.0** on both machines. Real usage surfaces what audits
   can't.

## Rough effort

- Extract shared fs/sync logic into a library crate: ~2h
- MCP server binary (`rmcp` crate) wiring tools to the shared lib: ~2h
- CI matrix addition + per-platform packaging: ~1h
- Docs + the in-app config snippet: ~30m

**Total: ~half a day**, assuming the sync engine is verified first.

## What NOT to do

- Don't wire MCP into the Tauri app process (Path B). It couples two protocols
  (Tauri IPC + MCP) to the same state, ties MCP to the app being open, and
  every install carries the MCP SDK forever.
- Don't write the server in Node. It breaks "all platforms, no friction."
- Don't bypass `save_note_if_unchanged` for any reason.
