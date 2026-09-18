import { describe, expect, it } from "vitest";
import { noul, choice, score, QuestionBuilders } from "../src/index.js";

describe("noul", () => {
  it("builds a noul question", () => {
    expect(noul("Is this urgent?")).toEqual({ type: "noul", instructions: "Is this urgent?" });
  });

  it("includes criteria when given", () => {
    expect(noul("Spam?", { true: "unsolicited", false: "expected" })).toEqual({
      type: "noul",
      instructions: "Spam?",
      criteria: { true: "unsolicited", false: "expected" },
    });
  });

  it("accepts object and array instructions", () => {
    expect(noul({ question: "spam?" }).instructions).toEqual({ question: "spam?" });
    expect(noul(["a", "b"]).instructions).toEqual(["a", "b"]);
  });

  it("rejects empty or wrong-typed instructions", () => {
    expect(() => noul("")).toThrow(TypeError);
    expect(() => noul({})).toThrow(TypeError);
    expect(() => noul([])).toThrow(TypeError);
    expect(() => noul(42 as any)).toThrow(TypeError);
    expect(() => noul(null as any)).toThrow(TypeError);
  });
});

describe("choice", () => {
  it("builds a choice question preserving criteria", () => {
    const question = choice("Which team?", { billing: "money", auth: null });
    expect(question).toEqual({
      type: "choice",
      instructions: "Which team?",
      criteria: { billing: "money", auth: null },
    });
  });

  it("rejects non-object criteria and bad sizes", () => {
    expect(() => choice("x", [] as any)).toThrow(TypeError);
    expect(() => choice("x", null as any)).toThrow(TypeError);
    expect(() => choice("x", {})).toThrow(TypeError);
    const big = Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`k${i}`, null]));
    expect(() => choice("x", big)).toThrow(TypeError);
  });

  it("accepts 255 options", () => {
    const max = Object.fromEntries(Array.from({ length: 255 }, (_, i) => [`k${i}`, null]));
    expect(Object.keys(choice("x", max).criteria)).toHaveLength(255);
  });
});

describe("score", () => {
  it("builds a score question", () => {
    expect(score("How severe?", ["cosmetic", "minor", "major"])).toEqual({
      type: "score",
      instructions: "How severe?",
      criteria: ["cosmetic", "minor", "major"],
    });
  });

  it("rejects arrays outside 2..10 and non-arrays", () => {
    expect(() => score("x", ["only one"])).toThrow(TypeError);
    expect(() => score("x", Array.from({ length: 11 }, () => "level"))).toThrow(TypeError);
    expect(() => score("x", {} as any)).toThrow(TypeError);
  });
});

describe("QuestionBuilders", () => {
  it("exposes the same builders namespace-style", () => {
    expect(QuestionBuilders.noul).toBe(noul);
    expect(QuestionBuilders.choice).toBe(choice);
    expect(QuestionBuilders.score).toBe(score);
  });
});
