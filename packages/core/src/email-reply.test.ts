import { describe, expect, it } from "vitest";
import {
  authPasses,
  emailAddressOf,
  extractReply,
  formatTaskKey,
  normaliseMessageId,
  parseEmailStatus,
  parseReferences,
  readAuthResults,
  taskNumberFromSubject,
} from "./email-reply.js";

/**
 * How an emailed reply is read. Formats are the ones the real clients produce (Gmail web and
 * phone, Outlook); addresses are placeholders.
 */

describe("the task key (FN-42)", () => {
  it("is written and found the same way", () => {
    expect(formatTaskKey(42)).toBe("FN-42");
    expect(taskNumberFromSubject("Re: [FN-42] New task: Fix the van 2 chiller")).toBe(42);
    expect(taskNumberFromSubject("RE: RE: fn-7 status")).toBe(7);
  });

  it("is not found inside other words or numbers", () => {
    expect(taskNumberFromSubject("XFN-42 order")).toBeNull();
    expect(taskNumberFromSubject("FN-")).toBeNull();
    expect(taskNumberFromSubject(null)).toBeNull();
  });
});

describe("threading headers", () => {
  it("Message-IDs lose their brackets; References keep their order", () => {
    expect(normaliseMessageId(" <fn.abc@gmail.com> ")).toBe("fn.abc@gmail.com");
    expect(normaliseMessageId("<>")).toBeNull();
    expect(parseReferences("<a1@x.com> <b2@y.com>\n <c3@z.com>")).toEqual(["a1@x.com", "b2@y.com", "c3@z.com"]);
  });
});

describe("what the person wrote, without the quote", () => {
  it("Gmail web, with the 'On … wrote:' line wrapped over two lines", () => {
    const text = [
      "Done, chiller fixed. Took 2 hours.",
      "",
      "On Mon, Oct 5, 2026 at 10:02 AM FreshNow Ops <",
      "ops@example.com> wrote:",
      "",
      "> [FN-42] New task from the CEO",
      "> Fix the van 2 chiller",
    ].join("\n");
    expect(extractReply(text)).toBe("Done, chiller fixed. Took 2 hours.");
  });

  it("Gmail on a phone, with its footer", () => {
    const text = "40% done, waiting for the compressor\n\nSent from my iPhone\n\n> On 5 Oct 2026, at 10:02, FreshNow wrote:\n> Fix it";
    expect(extractReply(text)).toBe("40% done, waiting for the compressor");
  });

  it("Outlook's rule-and-headers style", () => {
    const text = "Blocked - no gas for the chiller\r\n\r\n________________________________\r\nFrom: FreshNow Ops <ops@example.com>\r\nSent: Monday\r\nSubject: [FN-42]";
    expect(extractReply(text)).toBe("Blocked - no gas for the chiller");
  });

  it("a signature after the standard delimiter is dropped", () => {
    expect(extractReply("On it now.\n-- \nHemanth\nWarehouse")).toBe("On it now.");
  });

  it("a reply that is only the quote leaves nothing to file", () => {
    expect(extractReply("> quoted only\n> more")).toBe("");
  });
});

describe("status words on the first line", () => {
  it.each([
    ["Done, chiller fixed", "done", 100],
    ["Completed the delivery", "done", 100],
    ["100% finished", "done", 100],
    ["40% done, waiting for parts", "blocker", 40],
    ["40% done, still on it", "in_progress", 40],
    ["about 70 percent there", "in_progress", 70],
    ["Started this morning", "in_progress", null],
    ["Blocked - no gas", "blocker", null],
    ["not done yet, tomorrow", "in_progress", null],
    ["ok noted", "pending", null],
  ] as const)("%s → %s", (text, status, percent) => {
    expect(parseEmailStatus(text)).toEqual({ status, percent });
  });

  it("only the first line counts — a quoted 'done' further down does not close the task", () => {
    expect(parseEmailStatus("Will start tomorrow\nthe last one was done")).toEqual({ status: "pending", percent: null });
  });
});

describe("did the receiving server vouch for the sender?", () => {
  const google = [
    "mx.google.com;\r\n       dkim=pass header.i=@gmail.com header.s=20230601 header.b=AbCd;\r\n       spf=pass (google.com: domain of worker@example.com designates 209.85.220.41 as permitted sender) smtp.mailfrom=worker@example.com;\r\n       dmarc=pass (p=NONE sp=QUARANTINE dis=NONE) header.from=gmail.com",
  ];

  it("reads Google's verdicts", () => {
    const v = readAuthResults(google, "mx.google.com");
    expect(v).toEqual({ spf: "pass", dkim: "pass", dmarc: "pass", by: "mx.google.com" });
    expect(authPasses(v)).toBe(true);
  });

  it("ignores a header any other server wrote — a forger can add their own lower down", () => {
    const forged = ["evil.example; dkim=pass; spf=pass; dmarc=pass"];
    expect(authPasses(readAuthResults(forged, "mx.google.com"))).toBe(false);
  });

  it("only the FIRST trusted header counts (the one Google added on arrival)", () => {
    const v = readAuthResults(["mx.google.com; dkim=fail; spf=pass; dmarc=fail", ...google], "mx.google.com");
    expect(v.dkim).toBe("fail");
    expect(authPasses(v)).toBe(false);
  });

  it("a missing verdict is a failure, not a pass", () => {
    expect(authPasses(readAuthResults([], "mx.google.com"))).toBe(false);
    expect(authPasses(readAuthResults(["mx.google.com; dkim=pass; dmarc=pass"], "mx.google.com"))).toBe(false);
  });
});

describe("addresses", () => {
  it("are lower-cased out of a display form", () => {
    expect(emailAddressOf("Hemanth K <Worker@Example.COM>")).toBe("worker@example.com");
    expect(emailAddressOf(" ops@example.com ")).toBe("ops@example.com");
  });
});
