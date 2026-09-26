import "dotenv/config";
import { closeDb, seedDemo } from "../packages/core/src/index.js";

// Seeds the DEMO database (DATABASE_URL_SERVICE) with clearly-labelled synthetic
// data. Idempotent. The test database is seeded separately by seed.test.ts.
const counts = await seedDemo();
console.log("Seeded demo data (all synthetic, is_synthetic=true):", counts);
await closeDb();
