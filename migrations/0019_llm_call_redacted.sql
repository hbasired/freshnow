-- migrations/0019_llm_call_redacted.sql — how many identifiers each AI call had removed.
--
-- Rule R7 (packages/core/src/llm/redact.ts) takes phone numbers, emails, Emirates IDs, IBANs
-- and card numbers out of every prompt before it leaves. The count goes on the call's own row,
-- so "identifiers removed before sending" is evidence in the database (the compliance page and
-- the daily snapshot read it), not a claim in a document. The count only — never what was removed.

alter table llm_call add column if not exists redacted int not null default 0 check (redacted >= 0);
