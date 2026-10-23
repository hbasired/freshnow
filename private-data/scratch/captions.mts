import postgres from "postgres";
import { config } from "dotenv";
config({ path: "C:/Users/acer/Downloads/freshnow/.env", quiet: true });
const sql = postgres(process.env.DATABASE_URL_SERVICE!, { max: 1, onnotice: () => {} });
const rows = await sql`select t.caption, t.region_caption as region, t.asset_no, m.cash_price_fils from tv_machine t
  left join machine_placement p on p.tv_machine_id = t.televend_id left join machine m on m.id = p.machine_id
  where t.enabled order by t.region_caption, t.asset_no`;
for (const r of rows) console.log(`${r.region} | ${r.asset_no} | ${r.caption} | ${r.cash_price_fils ?? ""}`);
const pay = await sql`select payment_type, payment_caption, count(*)::int as n from tv_vend group by 1,2 order by 3 desc`;
console.log(JSON.stringify(pay));
const pl = await sql`select count(*)::int n, count(distinct machine_id)::int machines from machine_placement`;
console.log(JSON.stringify(pl));
await sql.end();
