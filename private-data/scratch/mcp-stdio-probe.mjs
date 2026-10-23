import { spawn } from "node:child_process";
const child = spawn(process.execPath, ["--import", "tsx", "packages/mcp-televend/src/index.ts"], { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] });
let buf = "";
const pending = new Map();
child.stdout.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { console.log("NON-JSON ON STDOUT (protocol violation):", line.slice(0, 200)); continue; }
    if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  }
});
child.stderr.on("data", (d) => process.stderr.write("  [server stderr] " + d.toString()));
let id = 0;
const send = (method, params) => new Promise((res) => { const myId = ++id; pending.set(myId, res); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method, params }) + "\n"); });
const notify = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, ...(params && { params }) }) + "\n");
const init = await send("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "freshnow-probe", version: "0" } });
console.log("initialize ->", init.result?.protocolVersion, init.result?.serverInfo, init.error ?? "");
notify("notifications/initialized");
const tools = await send("tools/list", {});
console.log("tools ->", tools.result?.tools?.map((t) => `${t.name}${t.annotations?.readOnlyHint ? " [read-only]" : ""}`));
const show = (label, r) => { const t = r.result?.content?.[0]?.text ?? JSON.stringify(r.error); console.log(`\n${label} (isError=${r.result?.isError ?? false}) ->\n` + t.slice(0, 1400)); };
show("machines search=791", await send("tools/call", { name: "televend_machines", arguments: { search: "791", limit: 5 } }));
show("alarms 2026-10-12", await send("tools/call", { name: "televend_events_day", arguments: { day: "2026-10-12", limit: 3 } }));
show("cash collections 2026-10-14", await send("tools/call", { name: "televend_cash_collections_day", arguments: { day: "2026-10-14" } }));
show("status", await send("tools/call", { name: "televend_status", arguments: {} }));
child.kill();
