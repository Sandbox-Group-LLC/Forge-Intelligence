// Capability preflight. Checks the shell-verifiable items in capabilities.json
// (cli.required + env.required block the gate; env.watched are surfaced but
// never block), prints a ✅/‼️/○ report, and opens or closes the edit/commit
// gate by writing/removing .claude/.state/preflight-ok. The MCP list is verified
// by the MODEL (a shell can't see MCP connections).
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";

const ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const STATE = join(ROOT, ".claude", ".state");
mkdirSync(STATE, { recursive: true });
const session = existsSync(join(STATE, "session-id")) ? readFileSync(join(STATE, "session-id"), "utf8").trim() : "manual";

const cap = JSON.parse(readFileSync(join(ROOT, "capabilities.json"), "utf8"));
const has = (cmd) => { try { execSync(`command -v ${cmd}`, { stdio: "ignore", shell: "/bin/bash" }); return true; } catch { return false; } };
const tick = (ok) => (ok ? "✅" : "‼️");

let requiredOk = true;
const out = ["── PREFLIGHT · capability check ──"];

for (const c of cap.cli?.required ?? []) { const ok = has(c); if (!ok) requiredOk = false; out.push(`${tick(ok)} cli  ${c}${ok ? "" : "   (REQUIRED — missing)"}`); }
for (const o of cap.cli?.optional ?? []) { const ok = has(o.name); out.push(`${ok ? "✅" : "○ "} cli  ${o.name}${ok ? "" : "   — " + o.why}`); }
for (const e of cap.env?.required ?? []) { const ok = !!process.env[e.name]; if (!ok) requiredOk = false; out.push(`${tick(ok)} env  ${e.name}${ok ? "" : "   (REQUIRED — add to env secrets + restart)"}`); }

// Watched secrets never block the gate, but a missing one is loud — these are
// the keys that get wiped on container resets (ElevenLabs/OpenAI/relay/Remotion).
let missingWatched = 0;
for (const w of cap.env?.watched ?? []) { const ok = !!process.env[w.name]; if (!ok) missingWatched++; out.push(`${ok ? "✅" : "○ "} env  ${w.name}${ok ? "" : "   — MISSING (watched): " + w.why}`); }

const required = cap.mcp?.required ?? [];
const direct = (cap.mcp?.directMcps ?? []).map((m) => m.name);
out.push(`◐  mcp  VERIFY against your tools — required: ${required.join(", ") || "(none)"}  ·  direct: ${direct.join(", ") || "(none)"}`);

const okFile = join(STATE, "preflight-ok");
if (requiredOk) { writeFileSync(okFile, session); out.push(`→ required capabilities present · edit/commit gate OPEN${missingWatched ? ` · ‼️ ${missingWatched} watched secret(s) missing — surface to the user` : ""}`); }
else { if (existsSync(okFile)) rmSync(okFile); out.push("→ a REQUIRED capability is missing · edit/commit gate CLOSED until fixed"); }

console.log(out.join("\n"));
process.exit(requiredOk ? 0 : 1);
