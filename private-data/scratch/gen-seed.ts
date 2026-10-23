import { ACCESS_ROLES, ROLE_CAPABILITIES } from "../../packages/core/src/permissions.js";
const rows: string[] = [];
for (const r of ACCESS_ROLES) for (const c of ROLE_CAPABILITIES[r]) rows.push(`  ('${r}', '${c}')`);
console.log(rows.join(",\n"));
console.error(`${rows.length} rows`);
