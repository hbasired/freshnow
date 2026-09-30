import { describe, expect, it } from "vitest";
import { redactIdentifiers, redactMessages } from "./redact.js";

/**
 * Rule R7 from CLAUDE.md: "never phone numbers" in a prompt. The positives are the shapes
 * FreshNow's staff actually write; the negatives are the numbers the work is full of — lots,
 * batches, vans, quantities, times, order numbers — which must reach the model untouched, or the
 * blocker parser loses the very detail the CEO needs. Test values were checked independently
 * (IBAN mod-97 and card Luhn computed in Python, not with this module).
 */

const r = (s: string) => redactIdentifiers(s).text;

describe("identifiers are removed", () => {
  it("UAE mobile and landline numbers, local and international", () => {
    expect(r("call Ramesh on 050 123 4567 for the key")).toBe("call Ramesh on [phone-1] for the key");
    expect(r("call +971 50 123 4567")).toBe("call [phone-1]");
    expect(r("call 00971501234567 now")).toBe("call [phone-1] now");
    expect(r("0501234567")).toBe("[phone-1]");
    expect(r("office 04 123 4567")).toBe("office [phone-1]");
    expect(r("mistri ka number (+91) 98765 43210 hai")).toBe("mistri ka number ([phone-1] hai");
  });

  it("emails, Emirates IDs, IBANs and card numbers", () => {
    expect(r("send it to priya.nair@freshnow.ae please")).toBe("send it to [email-1] please");
    expect(r("EID 784-1990-1234567-1 expired")).toBe("EID [emirates-id-1] expired");
    expect(r("EID 784199012345671")).toBe("EID [emirates-id-1]");
    expect(r("salary to AE07 0331 2345 6789 0123 456 this month")).toBe("salary to [iban-1] this month");
    expect(r("card 4111 1111 1111 1111 declined")).toBe("card [card-1] declined");
  });

  it("counts what it removed, by kind", () => {
    const out = redactIdentifiers("050 123 4567 or a@b.co or 784-1990-1234567-1");
    expect(out.counts).toMatchObject({ phone: 1, email: 1, emirates_id: 1 });
    expect(out.total).toBe(3);
  });
});

describe("the numbers the work is made of are left alone", () => {
  it.each([
    "batch 42 brix out of spec, hold released stock",
    "filler head 3 jammed, line stopped at 10:30",
    "van 2 ka chiller theek nahi hai, juice kharab ho jayega",
    "20 crates short, only 5 delivered",
    "lot 20240915 passed QC",
    "Order 4501234567 not received", // 10 digits, not starting 0 or +
    "INV-2024-000123 is unpaid",
    "progress 0-100%, now 20–30%",
    "वैन 2 का चिलर काम नहीं कर रहा",
    "വാൻ 2 ലെ ചില്ലർ പ്രവർത്തിക്കുന്നില്ല",
    "card 4111 1111 1111 1112 is a typo", // fails Luhn
    "AE08 0331 2345 6789 0123 456", // fails mod-97
  ])("%s", (text) => {
    expect(redactIdentifiers(text)).toEqual({ text, counts: { email: 0, emirates_id: 0, iban: 0, card: 0, phone: 0 }, total: 0 });
  });

  it("never cuts into the random fence that marks untrusted text", () => {
    const fenced = "<<<UNTRUSTED_0012345678abcdef>>> call 050 123 4567 <<<END_0012345678abcdef>>>";
    expect(r(fenced)).toBe("<<<UNTRUSTED_0012345678abcdef>>> call [phone-1] <<<END_0012345678abcdef>>>");
  });
});

describe("only what the person wrote is touched", () => {
  it("user messages are redacted; the system prompt is ours and left as written", () => {
    const system = { role: "system" as const, content: "Reply as JSON. Example phone field: 050 000 0000." };
    const out = redactMessages([system, { role: "user", content: "call 050 123 4567" }]);
    expect(out.messages[0]).toBe(system);
    expect(out.messages[1]).toEqual({ role: "user", content: "call [phone-1]" });
    expect(out.total).toBe(1);
  });
});

describe("placeholders keep things apart, and the answer gets the real values back", () => {
  it("two numbers get two placeholders; the same number written twice gets the same one", () => {
    const out = redactMessages([
      { role: "user", content: "Rashid: call the supplier on 050 123 4567. Priya: call the landlord on 055 765 4321, then 0501234567 again." },
    ]);
    expect(out.messages[0]!.content).toBe(
      "Rashid: call the supplier on [phone-1]. Priya: call the landlord on [phone-2], then [phone-1] again.",
    );
  });

  it("the numbering is shared across the messages of one call", () => {
    const out = redactMessages([
      { role: "user", content: "mail priya.nair@freshnow.ae" },
      { role: "user", content: "and rashid@freshnow.ae, not PRIYA.NAIR@freshnow.ae" },
    ]);
    expect(out.messages.map((m) => m.content)).toEqual(["mail [email-1]", "and [email-2], not [email-1]"]);
  });

  it("the model's answer is restored on our side — every string, at any depth", () => {
    const { names } = redactMessages([{ role: "user", content: "Rashid: call 050 123 4567. Priya: email ops@freshnow.ae" }]);
    const answer = { tasks: [{ title: "Call the supplier on [phone-1]", detail: null }, { title: "Email [email-1]", n: 2 }] };
    expect(names.restoreDeep(answer)).toEqual({
      tasks: [{ title: "Call the supplier on 050 123 4567", detail: null }, { title: "Email ops@freshnow.ae", n: 2 }],
    });
  });

  it("a placeholder the model invents is left as it is — nothing is made up on the way back", () => {
    const { names } = redactMessages([{ role: "user", content: "call 050 123 4567" }]);
    expect(names.restore("call [phone-1] or [phone-7]")).toBe("call 050 123 4567 or [phone-7]");
  });
});
