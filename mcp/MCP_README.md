# Writer's Workbench — MCP bridge

An optional local plugin that lets an MCP-capable AI assistant **read and edit your
Writer's Workbench projects** while you keep using the app.

The app stays exactly what it was: one offline HTML file you double-click. This
plugin is additive and entirely optional — **if it isn't running, the app behaves
as if it didn't exist.**

```
AI client ──stdio (MCP)──> server.js ──HTTP (127.0.0.1:8765)──> writers-workbench.html
```

The browser app is the **source of truth**. It polls the plugin for commands,
applies them using its own functions, and pushes a state snapshot back. The plugin
keeps a mirror of that snapshot so the AI can read live data.

---

## Prerequisites

- **Node.js ≥ 18** (the plugin is ESM and uses the built-in `fetch`).
- A Writer's Workbench HTML file, and a browser to open it in.
- An MCP-capable client (Claude Desktop, Hermes, Cursor, Claude Code, …).

> **Use an absolute path to `node` in your client config** if `node` is not on the
> system PATH (e.g. it ships bundled with your client). Clients launch the server
> as a subprocess with their own environment, which may not match your shell.

## Setup

```bash
cd mcp
npm install
```

## Run

```bash
cd mcp
node server.js
```

Leave it running, then open the HTML file as usual.

**Order doesn't matter much, but server-first is fastest to a green light.** Start
the server, then open the app — the app finds it on its first poll. Open the app
first and it also works: the bridge backs off to a slow heartbeat and reconnects
when the server appears.

You'll know it worked when the app shows an **"AI bridge connected"** toast and a
small status pill appears next to the brand in the header.

## Register with your AI client

The plugin is a plain **stdio MCP server**: `command` is your node binary, `args`
is the absolute path to `server.js`.

**Claude Desktop** — `%APPDATA%\Claude\claude_desktop_config.json` (Windows) or
`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

```json
{
  "mcpServers": {
    "writers-workbench": {
      "command": "node",
      "args": ["/absolute/path/to/mcp/server.js"]
    }
  }
}
```

**Hermes** — the top-level `mcp_servers:` key in `~/.hermes/config.yaml`:

```yaml
mcp_servers:
  writers-workbench:
    command: "/absolute/path/to/node"
    args: ["/absolute/path/to/mcp/server.js"]
    enabled: true
```

Or via its CLI (`--args` must come last):

```bash
hermes mcp add writers-workbench --command /absolute/path/to/node --args /absolute/path/to/mcp/server.js
```

Then reload MCP in-session (`/reload-mcp`) or restart the client.

**Claude Code / Cursor / most others** — the same `mcpServers` JSON shape, in
`.mcp.json`, `~/.cursor/mcp.json`, or wherever that client keeps it.

Restart the client afterwards. The tools appear namespaced by client — Hermes and
Claude Code use `mcp__<server>__<tool>`, e.g. `mcp__writers_workbench__get_status`
(non-alphanumeric characters in the server name become underscores).

---

## Typical AI flow

This is the order that works. Steps 1 and 3 are the ones people skip and regret.

1. **`get_status`** — confirm you're connected. If `connected` is `false`, stop and
   ask the user to open the HTML file in a browser; nothing else will work.
2. **`list_entries`** / **`get_entry`** — look at what already exists before writing.
3. **`describe_template(kind)`** — **required before the first write to a kind.**
   It returns the real field keys, list keys, labels and hints. Guessing keys
   silently does nothing.
4. **`update_entry`** to fill an existing entry (including the blank placeholder),
   **`add_entry`** only for a genuinely new one.
5. **Check `applied` vs `ignored`** in the reply. Anything in `ignored` did **not**
   stick.
6. **`render_entry_markdown`** / **`build_lorebook`** to produce the export.

### Worked example

Ask for a field list first, trimmed here for length:

```jsonc
// describe_template { "kind": "main" }
{
  "kind": "main",
  "name": "Main characters",
  "fields": [
    { "key": "aliases", "section": "Identity", "type": "line",
      "label": "Aliases", "hint": "Comma-separated. Nicknames, titles, false names." },
    { "key": "occupation", "section": "Identity", "type": "line",
      "label": "Occupation", "hint": null }
  ],
  "managedFields": [],
  "lists": [ { "key": "tags", "multiline": false, "example": "Quiet", "bullets": "-" } ]
}
```

Then write with real keys, and read the reply honestly:

```jsonc
// update_entry
{ "kind": "main", "name": "Kuro", "fields": { "occupation": "smuggler", "favColor": "red" } }
```

```jsonc
// reply
{
  "ok": true, "kind": "main", "index": 0, "name": "Kuro",
  "applied": ["fields.occupation"],
  "ignored": ["fields.favColor"],   // <- does not exist; nothing was written
  "managed": []
}
```

`favColor` isn't a real field, so it landed in `ignored`. Had this been
`ok: true` alone, you'd have assumed it worked.

---

## Tools

**Read (served from the mirror):**

| Tool | Purpose |
|---|---|
| `get_status` | Is the app connected? Project name, per-kind entry counts. |
| `list_entries` | Entries of a kind: index, id, name, filled-field count. |
| `get_entry` | Full fields + lists of one entry (by index, id, or name). |
| `get_state` | Entire mirrored state. Large. Also the only way to read relationships. |
| `estimate_tokens` | Rough token estimate. Approximation — see caveats. |
| `describe_template` | **Call before writing.** Real field/list keys, labels, hints. |

**Write (dispatched to the app; its UI updates live):**

| Tool | Purpose |
|---|---|
| `add_entry` | Create a new entry. |
| `update_entry` | Merge fields/lists into an entry; rename via `newName`. |
| `delete_entry` | Remove an entry. |
| `set_lorebook_name` | Set the lorebook name for a kind. |
| `set_relationship` | Add a relationship edge (add-only). |

All write tools return `applied`, `ignored` and `managed` arrays. **Always check
`ignored`** — that's how you find out a key name was wrong.

**Render / export:**

| Tool | Purpose |
|---|---|
| `render_entry_markdown` | The exact markdown the AI would see for an entry. |
| `build_lorebook` | SillyTavern World Info JSON (`kind:"everything"` for all). |
| `reload_app_state` | Force a fresh snapshot (after the user edits in the UI). |

### Kinds

| Kind | What it models |
|---|---|
| `main` | Full character cards — the people the story is about. |
| `side` | Trimmed NPCs — supporting cast, fewer fields than `main`. |
| `scenario` | A setting/rules premise for a session. |
| `location` | Places and nested location groups, with an optional map. |
| `item` | Objects with function, stakes and state. |
| `faction` | Organizations: goals, methods, members. |
| `history` | Past events — official account vs what really happened. |
| `concept` | Lore abstractions: magic systems, customs, taboos. |

---

## Notes & gotchas

These are real behaviours, not hypotheticals.

- **Every roster starts with one blank placeholder entry.** To fill it, use
  `update_entry` with `index: 0` — the blank has no name, so **looking it up by
  name fails** ("No matching entry"). Use `add_entry` only when you actually want
  another slot, or untitled blanks pile up.
- **Unknown keys are dropped and reported in `ignored`.** A field is judged against
  the template only. If a stale key from an older version of the app is already
  inside an entry, it is *still* reported as ignored rather than falsely applied —
  but it also won't be removed for you. Clear it by hand in the UI.
- **`managedFields` are app-owned.** Keys like `parentResolved`, `parentId`,
  `isGroup`, `mapData` (location grouping/map bookkeeping) exist on entries but are
  written by the app. They're reported separately so they aren't mistaken for
  editable fields, and setting them does nothing useful.
- **`set_relationship` is add-only.** There's no list or delete. Read existing edges
  from `get_state.relationships`.
- **`estimate_tokens` is an approximation.** The app has no tokenizer; it takes the
  larger of ~4 chars/token and ~1.15 tokens/word. Good for comparing sections, not
  for budgeting against a real context window.
- **Writes land in the browser's project storage** via the app's own autosave. This
  plugin never writes files.
- **Not exposed:** the location map grid, project list/switch/rename, full-text
  search, and relationship deletion. Don't go looking for those tools.

## Troubleshooting

**`connected: false`** — the app isn't reachable. Check, in order:

1. Is the HTML file open in a browser? (A closed tab is the usual cause.)
2. Look at the header status pill: **grey** = no server found, **amber** =
   reconnecting, **green** = live. A toast says "AI bridge connected" / "disconnected".
3. Is the server process still running?
4. Is it the *right* project? `get_status.projectName` reports which project the app
   is actually mirroring — easy to be surprised by if the user switched projects or
   has two tabs open.

**Tool calls time out** (20s, with a clear error) — the app didn't acknowledge. The
tab is closed, asleep, or the page is showing a cached older copy. Hard-reload the
page (`Ctrl+F5` / `Cmd+Shift+R`).

**`EADDRINUSE` / "address already in use" on startup** — only **one** process can own
`127.0.0.1:8765`. This happens when a second instance starts while one is already
running (commonly: you ran `node server.js` by hand *and* your AI client spawned its
own). The second instance logs a warning and **keeps serving MCP tools, but the
browser bridge belongs to whichever process claimed the port first**. Stop the
stray process and restart. Some clients report this as
**"Failed to connect: Connection closed"** — that message means the server exited
during startup, and a busy port is the most common reason.

**Edits apply but the form doesn't visibly change** — the page is running a stale
cached copy of the HTML. Hard-reload it.

**Port already used by something else entirely** — set `WW_BRIDGE_PORT` for the
server, and the page's bridge URL must match (it's defined at the top of the bridge
`<script>` in the HTML).

---

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `WW_BRIDGE_PORT` | `8765` | Port the browser bridge listens on. |
| `WW_BRIDGE_DEBUG` | off | Set to `1` to trace every bridge request to stderr. |
| `WW_TEST_PORT` | `8790` | Port used by the end-to-end test harness. |

## Test

```bash
cd mcp
npm test          # or: node test-e2e.mjs
```

Runs a headless simulated app against the real server and exercises every tool.
It binds its own port, so it can run while the real server is live.

`node test-classify.mjs` separately covers the applied/ignored classification
rules (unknown keys, app-owned keys, repeated writes).
