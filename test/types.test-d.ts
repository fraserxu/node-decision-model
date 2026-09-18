import { describe, expectTypeOf, it } from "vitest";
import { Client, choice, noul, score } from "../src/index.js";
import type { ChoiceAnswer, NoulAnswer, ScoreAnswer } from "../src/index.js";

describe("answer type inference", () => {
  it("infers answer types from the questions map", async () => {
    const client = new Client({ apiKey: "k" });
    const response = await client.ask({
      state: {},
      questions: {
        urgent: noul("Is this urgent?"),
        team: choice("Which team?", { billing: null, auth: "authentication" }),
        severity: score("How severe?", ["cosmetic", "minor"]),
      },
    });

    expectTypeOf(response.answers.urgent).toEqualTypeOf<NoulAnswer>();
    expectTypeOf(response.answers.severity).toEqualTypeOf<ScoreAnswer>();
    expectTypeOf(response.answers.team.choice).toEqualTypeOf<"billing" | "auth">();
    expectTypeOf(response.get("team")).toEqualTypeOf<
      ChoiceAnswer<{ readonly billing: null; readonly auth: "authentication" }>
    >();

    expectTypeOf(response.answers).not.toHaveProperty("nope");
    // @ts-expect-error unknown question ids are rejected
    response.get("nope");
  });

  it("choice preserves criteria keys", () => {
    const question = choice("Which?", { a: null, b: null });
    expectTypeOf(question.criteria).toEqualTypeOf<{ readonly a: null; readonly b: null }>();
  });
});
