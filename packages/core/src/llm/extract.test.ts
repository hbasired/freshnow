import { describe, expect, it } from "vitest";
import { extractJson } from "./extract.js";

describe("extractJson", () => {
  it("parses plain JSON", () => {
    expect(extractJson('{"status":"done"}')).toEqual({ status: "done" });
  });

  it("strips markdown code fences", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("extracts a JSON object embedded in prose (reasoning models)", () => {
    expect(extractJson('Reasoning… the answer is {"a":1}. Done.')).toEqual({ a: 1 });
  });

  it("throws when there is no JSON object", () => {
    expect(() => extractJson("no json at all")).toThrow();
  });
});
