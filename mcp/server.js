#!/usr/bin/env node
/**
 * Writer's Workbench — MCP bridge server.
 *
 * Runs as an MCP server over stdio (so an AI client can call tools) AND as a
 * tiny HTTP server on 127.0.0.1 so the offline HTML app can talk to it.
 *
 *   AI client ──stdio(MCP)──> this process ──HTTP──> writers-workbench-v3.html
 *
 * The HTML app is the source of truth for user-visible state: it polls /commands,
 * applies them with its own functions, then POSTs /state back. This process keeps
 * a mirror so the AI can read live data. Nothing here mutates the app directly.
 */

import http from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const HTTP_PORT = Number(process.env.WW_BRIDGE_PORT || 8765);
const HOST = "127.0.0.1";
const DEBUG = process.env.WW_BRIDGE_DEBUG === "1";

/* ------------------------------------------------------------------ *
 * State store
 * ------------------------------------------------------------------ */

const KIND_TO_LIST = {
  main: "main",
  side: "side",
  scenario: "scenario",
  location: "location",
  item: "item",
  faction: "faction",
  history: "history",
  concept: "concept",
};

/** One-line meaning of each kind, for docs and tool descriptions. */
const KIND_MEANING = {
  main: "full character cards — the people the story is about",
  side: "trimmed NPCs — supporting cast, fewer fields than main",
  scenario: "a setting/rules premise for a session",
  location: "places and nested location groups, with an optional map",
  item: "objects with function, stakes and state",
  faction: "organizations, their goals, methods and members",
  history: "past events, official account vs what really happened",
  concept: "lore abstractions — magic systems, customs, taboos",
};

/** `kind` docs string reused across every tool that takes a kind. */
const KIND_DOC = Object.entries(KIND_MEANING)
  .map(([k, v]) => `${k} = ${v}`)
  .join("; ");

/** Latest snapshot POSTed by the HTML bridge (or null if the app is closed). */
let appState = null;
let appLastSeen = 0;

/** Commands queued by MCP tools, awaiting pickup by the HTML bridge. */
const pendingCommands = [];

/** Requests awaiting a result from the app (command id -> {resolve,reject,timer}). */
const inFlight = new Map();

const COMMAND_TTL_MS = 20_000;

function appConnected() {
  return Date.now() - appLastSeen < 6000;
}

/**
 * Wrap a command for the bridge. The envelope id lives in `cmdId` (NOT `id`)
 * so it can never collide with a tool argument named `id` (an entry id).
 * Tool-specific values live under `args`.
 */
function enqueue(type, args) {
  const cmd = { cmdId: randomUUID(), type, args: args || {} };
  pendingCommands.push(cmd);
  return cmd;
}

/** Queue a command and wait for the app to report the outcome. */
function dispatch(type, args, { awaitResult = true } = {}) {
  const cmd = enqueue(type, args);
  if (!awaitResult) return Promise.resolve({ queued: cmd.cmdId });

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      inFlight.delete(cmd.cmdId);
      resolve({
        ok: false,
        error: appConnected()
          ? "The app did not acknowledge the command in time."
          : "Writer's Workbench is not connected. Open writers-workbench-v3.html and make sure the bridge is enabled.",
      });
    }, COMMAND_TTL_MS);
    inFlight.set(cmd.cmdId, { resolve, timer });
  });
}

function settleResult(id, result) {
  const entry = inFlight.get(id);
  if (!entry) return;
  clearTimeout(entry.timer);
  inFlight.delete(id);
  entry.resolve(result);
}

/* ------------------------------------------------------------------ *
 * HTTP transport (the bridge the HTML app talks to)
 * ------------------------------------------------------------------ */

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "600");
}

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      if (!data) return resolve(null);
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve(null);
      }
    });
  });
}

const httpServer = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    cors(res);
    res.writeHead(204);
    res.end();
    return;
  }
  cors(res);

  const url = new URL(req.url, `http://${HOST}:${HTTP_PORT}`);
  // Opt-in request trace. The bridge polls ~every 1.2s, so this is far too
  // noisy to leave on. Set WW_BRIDGE_DEBUG=1 when diagnosing a connection.
  if (DEBUG) {
    console.error(`[bridge] ${req.method} ${url.pathname} origin=${req.headers.origin || "none"}`);
  }

  // The HTML bridge polls this for work.
  if (url.pathname === "/commands" && req.method === "GET") {
    if (appState === null) {
      // First contact after the app opens — ask it to send a snapshot.
      pendingCommands.unshift({ cmdId: randomUUID(), type: "request_state", args: {} });
    }
    const batch = pendingCommands.splice(0, pendingCommands.length);
    return sendJSON(res, 200, { commands: batch });
  }

  // The HTML bridge pushes its current state here.
  if (url.pathname === "/state" && req.method === "POST") {
    const body = await readBody(req);
    if (body && typeof body === "object") {
      appState = body;
      appLastSeen = Date.now();
    }
    return sendJSON(res, 200, { ok: true, received: !!body });
  }

  // The HTML bridge reports an individual command's outcome.
  if (url.pathname === "/result" && req.method === "POST") {
    const body = await readBody(req);
    appLastSeen = Date.now();
    const result = body && body.result;
    // A request_state command returns the full snapshot inside its result —
    // capture it so the mirror is populated from the very first exchange.
    if (result && result.state && typeof result.state === "object") {
      appState = result.state;
    }
    if (body && body.id) settleResult(body.id, result ?? { ok: true });
    return sendJSON(res, 200, { ok: true });
  }

  // Liveness probe for humans / debugging.
  if (url.pathname === "/health" && req.method === "GET") {
    return sendJSON(res, 200, {
      ok: true,
      appConnected: appConnected(),
      lastSeenMsAgo: appLastSeen ? Date.now() - appLastSeen : null,
      pendingCommands: pendingCommands.length,
      hasState: appState !== null,
    });
  }

  sendJSON(res, 404, { ok: false, error: "not found" });
});

/* ------------------------------------------------------------------ *
 * Helpers for reading the mirrored app state
 * ------------------------------------------------------------------ */

function requireState() {
  if (appState === null) {
    throw new Error(
      "No state received yet. Open writers-workbench-v3.html in a browser with the bridge enabled; it will connect automatically."
    );
  }
  return appState;
}

function rosterOf(state, kind) {
  const key = KIND_TO_LIST[kind];
  if (!key) throw new Error(`Unknown kind "${kind}". Valid: ${Object.keys(KIND_TO_LIST).join(", ")}`);
  const roster = state.rosters && state.rosters[key];
  if (!roster) return { list: [], active: 0 };
  return roster;
}

/** Flatten an entry to a stable, AI-friendly shape (name + fields + lists). */
function summarizeEntry(st, kind, index) {
  const lists = {};
  for (const [k, v] of Object.entries(st.lists || {})) {
    const clean = (v || []).filter((s) => typeof s === "string" && s.trim());
    if (clean.length) lists[k] = clean;
  }
  const fields = {};
  for (const [k, v] of Object.entries(st.fields || {})) {
    if (typeof v === "string" && v.trim()) fields[k] = v;
  }
  return {
    index,
    id: st.id || null,
    name: st.name || "",
    fields,
    lists,
  };
}

function findEntryIndex(roster, { name, id, index }) {
  if (typeof index === "number" && index >= 0 && index < roster.list.length) return index;
  if (id) {
    const i = roster.list.findIndex((e) => e && e.id === id);
    if (i >= 0) return i;
  }
  if (name) {
    const lower = name.toLowerCase();
    const i = roster.list.findIndex((e) => (e.name || "").toLowerCase() === lower);
    if (i >= 0) return i;
  }
  return -1;
}

/* ------------------------------------------------------------------ *
 * MCP server + tools
 * ------------------------------------------------------------------ */

const server = new McpServer(
  {
    name: "writers-workbench",
    version: "1.1.0",
  },
  {
    instructions: [
      "Writer's Workbench is an offline, single-file HTML tool for authoring SillyTavern",
      "character cards, lorebook (World Info) entries, and relationship graphs — no server,",
      "no account, no cloud. It organizes writing into eight template `kinds`:",
      "main, side, scenario, location, item, faction, history, concept.",
      "",
      "This MCP server is a bridge to the app running in the user's browser. The BROWSER is the",
      "source of truth: edits you make are applied by the app itself and appear live in its UI.",
      "A mirror of app state is kept here so you can read without disturbing the user.",
      "",
      "Typical flow:",
      "1. get_status — confirm the app is connected (connected:true). If false, the user must",
      "   open writers-workbench-v3.html in a browser; nothing will work until they do.",
      "2. list_entries / get_entry — see what exists before adding or editing.",
      "3. describe_template — REQUIRED before first writing to a kind. It returns the real",
      "   field keys, list keys, labels and hints. Do not guess keys; unrecognized ones are",
      "   dropped and reported back in `ignored`.",
      "4. add_entry / update_entry / delete_entry — write. Check the returned `applied` vs",
      "   `ignored` arrays: anything in `ignored` did NOT stick.",
      "5. render_entry_markdown / build_lorebook — produce the exact output the app exports.",
      "",
      "Notes: fields are plain strings; lists are arrays of strings. Entry contents are prose",
      "the user wrote for a language model to read — preserve their voice, don't paraphrase.",
      "Writes land in the browser's project storage via the app's own autosave; this server",
      "never touches files. Commands time out after 20s if the app isn't open.",
      "",
      "Every roster starts with ONE blank placeholder entry. Fill that with update_entry (use",
      "index: 0 — it has no name to look up by); only use add_entry for a genuinely new slot,",
      "or untitled blanks pile up.",
      "",
      "Not exposed by this server: the location map builder's grid data, project list/switch/",
      "rename, full-text search, and relationship deletion. The relationship graph is add-only,",
      "and readable only via get_state. Do not hunt for tools that don't exist.",
    ].join("\n"),
  }
);

const asText = (obj) => ({
  content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }],
});

const asError = (message) => ({
  isError: true,
  content: [{ type: "text", text: "Error: " + message }],
});

/** Run a tool body, turning thrown errors into MCP error results. */
function tool(fn) {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (e) {
      return asError(e && e.message ? e.message : String(e));
    }
  };
}

/* ---- read-only tools (served from the mirror) ---- */

server.tool(
  "get_status",
  "Check whether the Writer's Workbench app is currently connected, and basic project info.",
  {},
  tool(async () => {
    if (appState === null) {
      return asText({
        connected: false,
        hint: "Open writers-workbench-v3.html in a browser. The bridge connects automatically.",
      });
    }
    return asText({
      connected: appConnected(),
      projectName: appState.projectName || null,
      mode: appState.mode || null,
      savedAt: appState.savedAt || null,
      counts: Object.fromEntries(
        Object.keys(KIND_TO_LIST).map((k) => [k, rosterOf(appState, k).list.length])
      ),
    });
  })
);

server.tool(
  "list_entries",
  `List entries for one template kind. Returns index, id, name and a filled-field count for each. Kinds: ${KIND_DOC}.`,
  { kind: z.enum(Object.keys(KIND_TO_LIST)) },
  tool(async ({ kind }) => {
    const state = requireState();
    const roster = rosterOf(state, kind);
    const entries = roster.list.map((st, i) => {
      const s = summarizeEntry(st, kind, i);
      return {
        index: i,
        id: s.id,
        name: s.name || "(untitled)",
        filledFields: Object.keys(s.fields).length,
        filledLists: Object.keys(s.lists).length,
      };
    });
    return asText({ kind, active: roster.active, count: entries.length, entries });
  })
);

server.tool(
  "get_entry",
  "Read the full contents (fields + list values) of one entry, located by index, id, or name. " +
    "Name lookup ignores case but requires an exact match; the blank placeholder entry has no name, " +
    "so target it with index: 0.",
  {
    kind: z.enum(Object.keys(KIND_TO_LIST)),
    index: z.number().int().optional(),
    id: z.string().optional(),
    name: z.string().optional(),
  },
  tool(async ({ kind, index, id, name }) => {
    const state = requireState();
    const roster = rosterOf(state, kind);
    const i = findEntryIndex(roster, { name, id, index });
    if (i < 0) return asError(`No entry found in "${kind}" matching that index/id/name.`);
    return asText(summarizeEntry(roster.list[i], kind, i));
  })
);

server.tool(
  "get_state",
  "Return the full mirrored project state (all rosters, lorebook names, relationships, settings). " +
    "Large — prefer list_entries/get_entry for targeted reads. This is also the ONLY way to read the " +
    "relationship graph: there is no list_relationships tool, so read `relationships` from here.",
  {},
  tool(async () => asText(requireState()))
);

server.tool(
  "estimate_tokens",
  "Estimate the token count of a piece of text. Approximation only — the app has no tokenizer " +
    "(it takes the larger of ~4 chars/token and ~1.15 tokens/word). Fine for comparing sections, " +
    "not for budgeting against a real model's context window.",
  { text: z.string() },
  tool(async ({ text }) => {
    const chars = Math.ceil(text.length / 4);
    const words = Math.max(1, (text.match(/\S+/g) || []).length);
    const byWords = Math.ceil(words * 1.15);
    return asText({ text: text.slice(0, 80) + (text.length > 80 ? "…" : ""), approxTokens: Math.max(chars, byWords) });
  })
);

/* ---- write tools (dispatched to the app, await its acknowledgement) ---- */

server.tool(
  "add_entry",
  "Create a NEW entry of the given kind. Values in `fields` are field strings; values in `lists` " +
    "are arrays of list-item strings. Returns `applied` (keys written), `ignored` (keys the template " +
    "doesn't define — dropped) and `managed` (app-owned keys). " +
    "NOTE: every roster starts with one blank placeholder entry. To fill that blank, use " +
    "update_entry on it rather than add_entry — otherwise untitled blanks accumulate. " +
    "Call describe_template first to learn the valid keys.",
  {
    kind: z.enum(Object.keys(KIND_TO_LIST)),
    name: z.string(),
    fields: z.record(z.string()).optional(),
    lists: z.record(z.array(z.string())).optional(),
    makeActive: z.boolean().optional(),
  },
  tool(async ({ kind, name, fields, lists, makeActive }) => {
    const result = await dispatch("add_entry", {
      kind,
      entry: { name, fields: fields || {}, lists: lists || {} },
      makeActive: makeActive !== false,
    });
    return result.ok ? asText(result) : asError(result.error);
  })
);

server.tool(
  "update_entry",
  "Update an existing entry (found by index, id, or name). `fields` and `lists` are merged into the " +
    "entry — provided keys overwrite, omitted keys are untouched. Pass a list value of [] to clear that " +
    "list. Returns `applied` (keys that stuck), `ignored` (keys the template doesn't define — wrote " +
    "nothing) and `managed` (app-owned keys such as map/parent bookkeeping). ALWAYS check `ignored`: " +
    "a field name that isn't in describe_template silently does nothing. " +
    "Locating by NAME fails on the blank placeholder entry (it has no name) — use index: 0 for that.",
  {
    kind: z.enum(Object.keys(KIND_TO_LIST)),
    index: z.number().int().optional(),
    id: z.string().optional(),
    name: z.string().optional(),
    newName: z.string().optional(),
    fields: z.record(z.string()).optional(),
    lists: z.record(z.array(z.string())).optional(),
  },
  tool(async (args) => {
    const result = await dispatch("update_entry", args);
    return result.ok ? asText(result) : asError(result.error);
  })
);

server.tool(
  "delete_entry",
  "Delete an entry (found by index, id, or name) from a kind.",
  {
    kind: z.enum(Object.keys(KIND_TO_LIST)),
    index: z.number().int().optional(),
    id: z.string().optional(),
    name: z.string().optional(),
  },
  tool(async (args) => {
    const result = await dispatch("delete_entry", args);
    return result.ok ? asText(result) : asError(result.error);
  })
);

server.tool(
  "set_lorebook_name",
  "Set the lorebook name for a kind (used as the exported filename/value).",
  {
    kind: z.enum(Object.keys(KIND_TO_LIST)),
    name: z.string(),
  },
  tool(async (args) => {
    const result = await dispatch("set_lorebook_name", args);
    return result.ok ? asText(result) : asError(result.error);
  })
);

server.tool(
  "set_relationship",
  "Add a relationship edge between two characters in the relationship graph. " +
    "ADD-ONLY: there is no update or delete counterpart, and duplicates are the app's problem to " +
    "reject. Read existing edges from get_state (`.relationships`) — this tool cannot read them back.",
  {
    from: z.string().describe("Character name (the entry's name)"),
    to: z.string().describe("Character name"),
    label: z.string().optional(),
    reciprocal: z.boolean().optional(),
  },
  tool(async (args) => {
    const result = await dispatch("set_relationship", args);
    return result.ok ? asText(result) : asError(result.error);
  })
);

/* ---- schema introspection ---- */

server.tool(
  "describe_template",
  "Get the exact field keys, list keys, labels, hints and app-managed keys for one template kind. " +
    "Call this BEFORE writing to a kind you haven't written to yet: it returns the real keys the app " +
    "stores, so you fill a real form instead of guessing keys that silently do nothing. " +
    "`fields` and `lists` are settable. `managedFields` exist on entries but are owned by the app " +
    "(map/parent bookkeeping) — reading them is fine, setting them is pointless.",
  { kind: z.enum(Object.keys(KIND_TO_LIST)) },
  tool(async ({ kind }) => {
    const result = await dispatch("describe_template", { kind });
    if (!result.ok) return asError(result.error);
    const t = result.template || {};
    if (t.error) return asError(t.error);
    return asText(t);
  })
);

/* ---- export tools (ask the app to render, capture the markdown/JSON) ---- */

server.tool(
  "render_entry_markdown",
  "Render the markdown the AI would see for one entry — exactly what the app produces.",
  {
    kind: z.enum(Object.keys(KIND_TO_LIST)),
    index: z.number().int().optional(),
    id: z.string().optional(),
    name: z.string().optional(),
    hideEmpty: z.boolean().optional(),
  },
  tool(async (args) => {
    const result = await dispatch("render_entry_markdown", args);
    return result.ok ? asText(result) : asError(result.error);
  })
);

server.tool(
  "build_lorebook",
  "Build a SillyTavern World Info lorebook JSON for one kind (or all kinds with kind=\"everything\"). Returns the JSON object.",
  {
    kind: z.enum([...Object.keys(KIND_TO_LIST), "everything"]),
    hideEmpty: z.boolean().optional(),
  },
  tool(async (args) => {
    const result = await dispatch("build_lorebook", args);
    return result.ok ? asText(result) : asError(result.error);
  })
);

server.tool(
  "reload_app_state",
  "Force the app to send a fresh state snapshot (use after you know the user edited in the UI).",
  {},
  tool(async () => {
    const result = await dispatch("request_state", {});
    return result.ok ? asText({ ok: true, refreshed: true }) : asError(result.error);
  })
);

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

httpServer.on("error", (err) => {
  // A busy port must never take down the MCP stdio session — the two channels
  // are independent. Another instance (or a stale one) owning the port just
  // means no browser can attach to *this* process; the tools still respond.
  if (err && err.code === "EADDRINUSE") {
    console.error(
      `[writers-workbench-mcp] port ${HTTP_PORT} is already in use — the MCP tools still work, ` +
        `but the browser bridge is served by the other process. Close it and restart to reclaim the port.`
    );
    return;
  }
  console.error(`[writers-workbench-mcp] http server error: ${err && err.message}`);
});

httpServer.listen(HTTP_PORT, HOST, () => {
  // stderr only — stdout is reserved for the MCP stdio protocol.
  console.error(`[writers-workbench-mcp] bridge listening on http://${HOST}:${HTTP_PORT}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[writers-workbench-mcp] MCP server ready on stdio");
