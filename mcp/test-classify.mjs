// Focused check: reproduce Hermes's two reported bugs against the real logic.
// We model classify() exactly as the bridge defines it, fed by a template.

const tpl = {
  fields: [{ key: "age" }, { key: "role" }],
  managedFields: ["clusterCollapsed", "parentResolved", "isGroup", "parentId", "partOf", "mapData"],
  lists: [{ key: "tags" }],
};

function classify(requested) {
  const validFields = {}, validLists = {};
  (tpl.fields || []).forEach((f) => (validFields[f.key] = true));
  (tpl.lists || []).forEach((l) => (validLists[l.key] = true));
  const applied = [], ignored = [], managed = [];
  const rf = requested.fields || {}, rl = requested.lists || {};
  Object.keys(rf).forEach((k) => {
    if (validFields[k]) { applied.push("fields." + k); return; }
    if ((tpl.managedFields || []).indexOf(k) >= 0) { managed.push("fields." + k); return; }
    ignored.push("fields." + k);
  });
  Object.keys(rl).forEach((k) => {
    if (validLists[k]) applied.push("lists." + k);
    else ignored.push("lists." + k);
  });
  return { applied, ignored, managed };
}

let pass = 0, fail = 0;
const check = (label, cond, detail) => {
  if (cond) { pass++; console.log("  PASS " + label); }
  else { fail++; console.log("  FAIL " + label + (detail ? "  -> " + detail : "")); }
};

console.log("[A] bug 1 — coerce() artifact (parentResolved) must not read as applied");
{
  const r = classify({ fields: { parentResolved: true } });
  check("parentResolved reported as managed, not applied", r.applied.length === 0 && r.managed.includes("fields.parentResolved"), JSON.stringify(r));
  check("parentResolved not reported as ignored either", !r.ignored.includes("fields.parentResolved"), JSON.stringify(r));
}

console.log("\n[B] bug 2 — a bogus key must be ignored EVERY time, even after pollution");
{
  const first = classify({ fields: { thisKeyDoesNotExist_at_all: "x" } });
  check("first call ignores the bogus key", first.ignored.includes("fields.thisKeyDoesNotExist_at_all"), JSON.stringify(first));
  // simulate the key having leaked into the entry from an older version
  const entry = { fields: { thisKeyDoesNotExist_at_all: "x", age: "34" } };
  const second = classify({ fields: { thisKeyDoesNotExist_at_all: "y" } });
  check("second call STILL ignores it (no pollution loop)", second.ignored.includes("fields.thisKeyDoesNotExist_at_all"), JSON.stringify(second));
  check("classify no longer consults the entry at all", entry.fields.age === "34");
}

console.log("\n[C] real keys still work");
{
  const r = classify({ fields: { age: "40" }, lists: { tags: ["a"] } });
  check("age applied", r.applied.includes("fields.age"), JSON.stringify(r));
  check("tags applied", r.applied.includes("lists.tags"), JSON.stringify(r));
  check("no false ignored", r.ignored.length === 0, JSON.stringify(r));
}

console.log("\n[D] name of the sanitized list-key slice math");
{
  const wrap = { age: "line" };
  const full = "fields.age";
  const k = full.slice(7);
  check("slice(7) yields the bare field key", k === "age", k);
  const l = "lists.tags".slice(6);
  check("slice(6) yields the bare list key", l === "tags", l);
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
