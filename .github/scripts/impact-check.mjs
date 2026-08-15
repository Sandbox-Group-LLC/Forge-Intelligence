#!/usr/bin/env node
// Cross-service impact check.
// Compares the base branch's route snapshot against the PR's, and joins removed
// or changed routes against test/consumer-map.json to name the external services
// a change would break. Exits 1 (fails the PR) when a consumer is impacted.
//
// Usage: impact-check.mjs <base-snapshot.json> <head-snapshot.json> <consumer-map.json>
//
// Route params are normalized (:id and {id} -> {}) so a param RENAME is not a
// false removal, while a real path/method removal is.

import { readFileSync, writeFileSync } from "node:fs";

const [, , baseFile, headFile, mapFile] = process.argv;

const norm = (route) =>
  route
    .replace(/:[A-Za-z0-9_]+\??/g, "{}")
    .replace(/\{[^}]+\}/g, "{}")
    .replace(/\/+$/, "");

const load = (f) => new Map(JSON.parse(readFileSync(f, "utf8")).map((r) => [norm(r), r]));

const base = load(baseFile);
const head = load(headFile);
const map = JSON.parse(readFileSync(mapFile, "utf8"));

const removed = [...base.entries()].filter(([n]) => !head.has(n));
const added = [...head.entries()].filter(([n]) => !base.has(n));

const matches = (routePath, pattern) => {
  const p = norm("X " + pattern).slice(2); // normalize pattern path the same way
  if (pattern.endsWith("*")) return routePath.startsWith(p.slice(0, -1));
  return routePath === p;
};

const impacts = [];
for (const [n, original] of removed) {
  const path = n.split(" ").slice(1).join(" ");
  for (const c of map.consumers) {
    if (c.paths.some((pat) => matches(path, pat))) {
      impacts.push({ route: original, service: c.service, repo: c.repo, contact: c.contact, sources: c.sources });
    }
  }
}

let report = "## Cross-service impact report\n\n";
if (!removed.length && !added.length) {
  report += "No route-surface changes.\n";
} else {
  if (removed.length) {
    report += `**Removed/renamed routes (${removed.length}):**\n` +
      removed.map(([, r]) => `- \`${r}\``).join("\n") + "\n\n";
  }
  if (added.length) {
    report += `**Added routes (${added.length}):**\n` +
      added.map(([, r]) => `- \`${r}\``).join("\n") + "\n\n";
  }
  if (impacts.length) {
    report += "### 🚨 BREAKS EXTERNAL CONSUMERS\n\n";
    for (const i of impacts) {
      report += `- \`${i.route}\` → **${i.service}** (\`${i.repo}\`)\n` +
        `  - call sites: ${i.sources.map((s) => `\`${s}\``).join(", ")}\n` +
        `  - blast radius: ${i.contact}\n`;
    }
    report += "\nCoordinate with the consumer (deprecate + migrate) before merging, " +
      "or keep the old route as an alias. If the consumer has already migrated, " +
      "update `test/consumer-map.json` in this PR.\n";
  } else {
    report += "✅ No external consumers impacted (per `test/consumer-map.json`).\n";
  }
}

writeFileSync("impact-report.md", report);
console.log(report);
process.exit(impacts.length ? 1 : 0);
