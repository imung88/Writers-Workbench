/**
 * Headless end-to-end test.
 *
 * Proves the transport, command handlers, and MCP tool round-trip without a
 * browser. ONE server process serves both the MCP stdio client and the HTTP
 * bridge — the real deployment model. A fake app loop stands in for the HTML.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";

const TEST_PORT = Number(process.env.WW_TEST_PORT || 8790);
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const CWD = fileURLToPath(new URL(".", import.meta.url));

// --- a tiny fake Writer's Workbench, mirroring the HTML bridge contract ---
const fakeApp = {
  state: {
    projectName: "Test Project",
    mode: "main",
    rosters: {
      main: { list: [{ id: "main_1", name: "Kuro", fields: { age: "34" }, lists: { tags: ["stoic"] } }], active: 0 },
      side: { list: [], active: 0 },
      scenario: { list: [], active: 0 },
      location: { list: [], active: 0 },
      item: { list: [], active: 0 },
      faction: { list: [], active: 0 },
      history: { list: [], active: 0 },
      concept: { list: [], active: 0 },
    },
    relationships: [],
  },
  lorebookNames: { main: "Test — leads" },
};

const post = (p, o) => fetch(BASE + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(o) }).then((r) => r.json());
const get = (p) => fetch(BASE + p).then((r) => r.json());

function handle(cmd) {
  const args = cmd.args || {};
  const kind = args.kind;
  const R = kind && fakeApp.state.rosters[kind];
  const find = () => {
    if (!R) return -1;
    if (typeof args.index === "number") return args.index;
    if (args.id) return R.list.findIndex((e) => e && e.id === args.id);
    if (args.name) return R.list.findIndex((e) => e && e.name.toLowerCase() === args.name.toLowerCase());
    return -1;
  };
  switch (cmd.type) {
    case "request_state": return { ok: true, state: { ...fakeApp.state, savedAt: Date.now() } };
    case "describe_template":
      return {
        ok: true,
        template: {
          kind,
          name: kind,
          fields: [{ key: "age", section: "Identity", type: "line", label: "Age", hint: "34" }],
          managedFields: ["parentResolved", "clusterCollapsed"],
          lists: [{ key: "tags", multiline: false, example: "Quiet", bullets: "-" }],
        },
      };
    case "add_entry": {
      const e = { id: "gen_" + Math.random().toString(36).slice(2, 8), name: args.entry.name, fields: args.entry.fields || {}, lists: args.entry.lists || {} };
      R.list.push(e);
      return { ok: true, kind, index: R.list.length - 1, name: e.name, id: e.id, applied: [], ignored: [] };
    }
    case "update_entry": {
      const i = find(); if (i < 0) return { ok: false, error: "no match" };
      const e = R.list[i];
      const applied = [], ignored = [], managed = [];
      if (args.newName) { e.name = args.newName; applied.push("name"); }
      const managedKeys = ["parentResolved", "clusterCollapsed", "isGroup", "parentId", "partOf", "mapData"];
      if (args.fields) for (const k of Object.keys(args.fields)) {
        if (k in e.fields) { e.fields[k] = args.fields[k]; applied.push("fields." + k); }
        else if (managedKeys.includes(k)) managed.push("fields." + k);
        else ignored.push("fields." + k);
      }
      if (args.lists) for (const [k, v] of Object.entries(args.lists)) {
        if (k in e.lists) { e.lists[k] = v; applied.push("lists." + k); }
        else ignored.push("lists." + k);
      }
      return { ok: true, kind, index: i, name: e.name, applied, ignored, managed };
    }
    case "delete_entry": {
      const i = find(); if (i < 0) return { ok: false, error: "no match" };
      const [removed] = R.list.splice(i, 1);
      return { ok: true, kind, removed: removed.name };
    }
    case "set_lorebook_name": fakeApp.lorebookNames[args.kind] = args.name; return { ok: true, kind: args.kind, name: args.name };
    case "set_relationship": fakeApp.state.relationships.push({ from: args.from, to: args.to, label: args.label || "" }); return { ok: true, from: args.from, to: args.to };
    case "render_entry_markdown": {
      const i = find(); if (i < 0) return { ok: false, error: "no match" };
      const e = R.list[i];
      return { ok: true, kind, index: i, markdown: `Name: ${e.name}\nAge: ${e.fields.age || ""}` };
    }
    case "build_lorebook": {
      const k = args.kind;
      if (k === "everything") return { ok: true, kind: k, lorebook: { name: "Everything", entries: { "0": { comment: "[Main] Kuro" } } }, entryCount: 1 };
      const rr = fakeApp.state.rosters[k];
      const entries = {};
      rr.list.forEach((e, i) => (entries[String(i)] = { comment: e.name, content: e.name }));
      return { ok: true, kind: k, lorebook: { name: fakeApp.lorebookNames[k] || k, entries }, entryCount: rr.list.length };
    }
    default: return { ok: false, error: "unknown command " + cmd.type };
  }
}

let appLoopRunning = true;
async function appLoop() {
  while (appLoopRunning) {
    try {
      const { commands } = await get("/commands");
      for (const cmd of commands) {
        const result = handle(cmd);
        await post("/result", { id: cmd.cmdId, result });
      }
      await post("/state", { ...fakeApp.state, projectName: "Test Project", savedAt: Date.now() });
    } catch { /* server not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
}

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log("  PASS " + label); }
  else { fail++; console.log("  FAIL " + label + (detail ? "  -> " + detail : "")); }
}

async function main() {
  const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: ["server.js"],
    cwd: CWD,
    env: { ...process.env, WW_BRIDGE_PORT: String(TEST_PORT) },
  }));
  await new Promise((r) => setTimeout(r, 900));

  const loopPromise = appLoop();
  await new Promise((r) => setTimeout(r, 500));

  const tools = (await client.listTools()).tools.map((t) => t.name);
  console.log("\n[1] Tool discovery");
  check("exposes get_status", tools.includes("get_status"));
  check("exposes add_entry", tools.includes("add_entry"));
  check("exposes build_lorebook", tools.includes("build_lorebook"));
  check("exposes describe_template", tools.includes("describe_template"));
  check("tool count == 14", tools.length === 14, "got " + tools.length + ": " + tools.join(", "));

  console.log("\n[2] HTTP bridge loop");
  const h = await get("/health");
  check("health reports appConnected", h.appConnected === true, JSON.stringify(h));
  check("hasState true", h.hasState === true);

  console.log("\n[3] MCP tool round-trip");
  const statusObj = JSON.parse((await client.callTool({ name: "get_status", arguments: {} })).content[0].text);
  check("get_status sees connected app", statusObj.connected === true, JSON.stringify(statusObj));
  check("get_status sees Kuro in main", statusObj.counts && statusObj.counts.main === 1, JSON.stringify(statusObj.counts));

  const listObj = JSON.parse((await client.callTool({ name: "list_entries", arguments: { kind: "main" } })).content[0].text);
  check("list_entries returns Kuro", listObj.entries && listObj.entries[0].name === "Kuro", JSON.stringify(listObj));

  const addObj = JSON.parse((await client.callTool({ name: "add_entry", arguments: { kind: "main", name: "Marla", fields: { role: "owner" }, lists: { tags: ["sharp"] } } })).content[0].text);
  check("add_entry returns ok", addObj.ok === true, JSON.stringify(addObj));

  const getObj = JSON.parse((await client.callTool({ name: "get_entry", arguments: { kind: "main", name: "Marla" } })).content[0].text);
  check("get_entry finds Marla with role", getObj.fields && getObj.fields.role === "owner", JSON.stringify(getObj));
  check("get_entry has tag 'sharp'", getObj.lists.tags && getObj.lists.tags[0] === "sharp", JSON.stringify(getObj.lists));

  const upObj = JSON.parse((await client.callTool({ name: "update_entry", arguments: { kind: "main", name: "Marla", newName: "Marla the Anchor", fields: { role: "bar owner" }, lists: { tags: [] } } })).content[0].text);
  check("update_entry ok", upObj.ok === true, JSON.stringify(upObj));
  check("update_entry reports applied keys", Array.isArray(upObj.applied) && upObj.applied.includes("fields.role"), JSON.stringify(upObj.applied));

  const badObj = JSON.parse((await client.callTool({ name: "update_entry", arguments: { kind: "main", name: "Marla the Anchor", fields: { favColor: "red" } } })).content[0].text);
  check("update_entry flags unknown key as ignored", Array.isArray(badObj.ignored) && badObj.ignored.includes("fields.favColor"), JSON.stringify(badObj));

  const tplObj = JSON.parse((await client.callTool({ name: "describe_template", arguments: { kind: "main" } })).content[0].text);
  check("describe_template lists field keys", Array.isArray(tplObj.fields) && tplObj.fields.some((f) => f.key === "age"), JSON.stringify(tplObj).slice(0, 200));
  check("describe_template lists list keys", Array.isArray(tplObj.lists) && tplObj.lists.some((l) => l.key === "tags"), JSON.stringify(tplObj).slice(0, 200));
  check("describe_template separates managedFields", Array.isArray(tplObj.managedFields) && tplObj.managedFields.includes("parentResolved"), JSON.stringify(tplObj).slice(0, 300));

  const mgdObj = JSON.parse((await client.callTool({ name: "update_entry", arguments: { kind: "main", name: "Marla the Anchor", fields: { parentResolved: "true" } } })).content[0].text);
  check("app-owned key reported as managed, not applied", mgdObj.managed && mgdObj.managed.includes("fields.parentResolved") && !mgdObj.applied.includes("fields.parentResolved"), JSON.stringify(mgdObj));

  const get2Obj = JSON.parse((await client.callTool({ name: "get_entry", arguments: { kind: "main", name: "Marla the Anchor" } })).content[0].text);
  check("rename applied", get2Obj.name === "Marla the Anchor", JSON.stringify(get2Obj));
  check("field updated", get2Obj.fields.role === "bar owner", JSON.stringify(get2Obj.fields));
  check("list cleared", !get2Obj.lists.tags, JSON.stringify(get2Obj.lists));

  const mdObj = JSON.parse((await client.callTool({ name: "render_entry_markdown", arguments: { kind: "main", name: "Kuro" } })).content[0].text);
  check("render_entry_markdown returns markdown", typeof mdObj.markdown === "string" && mdObj.markdown.includes("Kuro"), JSON.stringify(mdObj));

  const lbObj = JSON.parse((await client.callTool({ name: "build_lorebook", arguments: { kind: "main" } })).content[0].text);
  check("build_lorebook returns entries", lbObj.entryCount >= 2, JSON.stringify(lbObj).slice(0, 200));

  const relObj = JSON.parse((await client.callTool({ name: "set_relationship", arguments: { from: "Kuro", to: "Marla the Anchor", label: "sister" } })).content[0].text);
  check("set_relationship ok", relObj.ok === true, JSON.stringify(relObj));

  const delObj = JSON.parse((await client.callTool({ name: "delete_entry", arguments: { kind: "main", name: "Marla the Anchor" } })).content[0].text);
  check("delete_entry ok", delObj.ok === true, JSON.stringify(delObj));

  const list2Obj = JSON.parse((await client.callTool({ name: "list_entries", arguments: { kind: "main" } })).content[0].text);
  check("after delete, back to 1 entry", list2Obj.count === 1, JSON.stringify(list2Obj));

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  appLoopRunning = false;
  await loopPromise;
  await client.close();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error("harness error:", e); process.exit(2); });
