export const PROJECT_NAME = "FreshNow Operations Platform";

// This build is the local demo: synthetic data, deviations documented in
// DEVIATIONS.md. Surfaced so the UI/bot can badge synthetic content honestly.
//
// Read from the environment, defaulting to demo: a production build sets IS_DEMO=false and
// the DEMO badge, which is driven by this through /app-config, goes away. Hardcoded `true`
// would have kept badging real company data as demo forever (audit 2026-09-18).
export const IS_DEMO = (process.env.IS_DEMO ?? "true").toLowerCase() !== "false";

// The seeded demo CEO (see migrations/0001). The real CEO Telegram id is linked
// at onboarding; until then routing/escalation resolve to this employee.
export const DEMO_CEO_ID = "00000000-0000-0000-0000-0000000000ce";
