import { describe, expect, it } from "vitest";
import { checkNamedPerson, matchPeopleByName } from "./people-match.js";

/**
 * Assigning work to the wrong person is worse than asking again. These are the rules for
 * deciding who a written name means — deterministic, so the same message always routes the
 * same way, whatever the model said.
 */

const people = [
  { id: "1", display_name: "Ahmed Khan" },
  { id: "2", display_name: "Ahmed Ali" },
  { id: "3", display_name: "Khalid Mansour" },
  { id: "4", display_name: "Rashid Al Maktoum" },
  { id: "5", display_name: "DEMO – Priya Nair" },
  { id: "6", display_name: "Natalie Joseph" },
  { id: "7", display_name: "José Fernandes" },
  { id: "8", display_name: "Sara Thomas" },
  { id: "9", display_name: "Sarah Thomas" },
];
const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

describe("which people a written name matches", () => {
  it("a unique first name is one person", () => {
    expect(ids(matchPeopleByName("Rashid", people))).toEqual(["4"]);
    expect(ids(matchPeopleByName("priya", people))).toEqual(["5"]);
  });

  it("a shared first name is everyone who has it", () => {
    expect(ids(matchPeopleByName("Ahmed", people))).toEqual(["1", "2"]);
  });

  it("whole words only — 'Ali' is Ahmed Ali, never Khalid or Natalie", () => {
    expect(ids(matchPeopleByName("Ali", people))).toEqual(["2"]);
  });

  it("the full name settles a shared first name", () => {
    expect(ids(matchPeopleByName("Ahmed Khan", people))).toEqual(["1"]);
    expect(ids(matchPeopleByName("ahmed  ALI", people))).toEqual(["2"]);
  });

  it("a short form of three or more letters is the start of a name; two letters are not enough", () => {
    expect(ids(matchPeopleByName("Rash", people))).toEqual(["4"]);
    expect(matchPeopleByName("Ra", people)).toEqual([]);
  });

  it("ignores case, accents, punctuation and honorifics", () => {
    expect(ids(matchPeopleByName("jose fernandes", people))).toEqual(["7"]);
    // "jose" could also be the start of "Joseph": two candidates, so the CEO is asked.
    expect(ids(matchPeopleByName("jose", people))).toEqual(["6", "7"]);
    expect(ids(matchPeopleByName("Mr. Rashid", people))).toEqual(["4"]);
    expect(ids(matchPeopleByName("Priya ji", people))).toEqual(["5"]);
  });

  it("Sara and Sarah are different people, and 'Sara' is still ambiguous (it starts 'Sarah')", () => {
    expect(ids(matchPeopleByName("Sarah", people))).toEqual(["9"]);
    expect(ids(matchPeopleByName("Sara", people))).toEqual(["8", "9"]);
    expect(ids(matchPeopleByName("Sara Thomas", people))).toEqual(["8"]);
  });

  it("an unknown name or an empty one matches nobody", () => {
    expect(matchPeopleByName("Vikram", people)).toEqual([]);
    expect(matchPeopleByName("  ", people)).toEqual([]);
  });
});

describe("who the work is for — the written name against the model's pick", () => {
  const rashid = people[3]!;
  const priya = people[4]!;

  it("confirmed when the written name matches one person and the model agrees", () => {
    expect(checkNamedPerson({ namedAs: "Rashid", modelPick: rashid, people })).toEqual({ status: "confirmed", person: rashid, overridden: false });
  });

  it("the written name wins when the model picked someone else", () => {
    expect(checkNamedPerson({ namedAs: "Rashid", modelPick: priya, people })).toEqual({ status: "confirmed", person: rashid, overridden: true });
  });

  it("ambiguous when the name fits several people — even if the model picked one of them", () => {
    const r = checkNamedPerson({ namedAs: "Ahmed", modelPick: people[0]!, people });
    expect(r.status).toBe("ambiguous");
    if (r.status === "ambiguous") expect(ids(r.candidates)).toEqual(["1", "2"]);
  });

  it("unverified when the name matches nobody by spelling but the model suggested someone (nickname, other script)", () => {
    expect(checkNamedPerson({ namedAs: "राशिद", modelPick: rashid, people })).toEqual({ status: "unverified", suggested: rashid, namedAs: "राशिद" });
    expect(checkNamedPerson({ namedAs: null, modelPick: rashid, people })).toEqual({ status: "unverified", suggested: rashid, namedAs: null });
  });

  it("none when nobody is named and the model picked nobody", () => {
    expect(checkNamedPerson({ namedAs: "Vikram", modelPick: null, people })).toEqual({ status: "none", namedAs: "Vikram" });
  });

  it("is deterministic: the same inputs give the same answer every time", () => {
    const a = checkNamedPerson({ namedAs: "Ahmed", modelPick: people[1]!, people });
    const b = checkNamedPerson({ namedAs: "Ahmed", modelPick: people[1]!, people });
    expect(a).toEqual(b);
  });
});
