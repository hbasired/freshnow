import { describe, expect, it } from "vitest";
import { assetNumber, emirateCode } from "./machine-names.js";

// Synthetic names that copy the SHAPES seen in the real Televend export (2026-10-13) — the
// repository is public, so FreshNow's actual machine list is not committed.
describe("assetNumber", () => {
  it.each([
    ["Mall Alpha-543-DXB", 543],
    ["Mall Alpha-543-Cashless 1-DXB", 543], // the same machine after a rename
    ["Hall-403 -Front Right -Card only- AED15-Cashless 1-SHJ", 403], // AED15 / "Cashless 1" are not assets
    ["Clinic Beta Block 1st floor-Card only-AED15 -856-DXB", 856], // "1st" is not an asset
    ["Station Gamma-1745-AED5-DXB", 1745], // four digits
    ["STORE -1168- DXB", 1168],
    ["Mall Delta Ajman1-390-Cashless 1-AJM", 390], // a digit glued to a word is not an asset
    ["Plaza Epsilon-Ikea- 795 -DXB", 795],
    ["Office Zeta -AED12-Cashless1 only -796-SHJ", 796],
    ["Vendor-ITALY", null],
    ["", null],
  ])("%s → %s", (name, expected) => {
    expect(assetNumber(name)).toBe(expected);
  });
});

describe("emirateCode", () => {
  it.each([
    ["Mall Alpha-543-DXB", "DXB"],
    ["Hall-403 -Front Right -Card only- AED15-Cashless 1-SHJ", "SHJ"],
    ["Mall Delta Ajman1-390-Cashless 1-AJM", "AJM"],
    ["Mall-393-UAQ", "UAQ"],
    ["Vendor-ITALY", null],
  ])("%s → %s", (name, expected) => {
    expect(emirateCode(name)).toBe(expected);
  });
});
