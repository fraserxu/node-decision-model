import { describe, expect, it } from "vitest";
import { DecisionResponse } from "../src/index.js";
import type { ChoiceAnswer, NoulAnswer, ScoreAnswer } from "../src/index.js";

const urgent: NoulAnswer = { type: "noul", noul: 0.8, probabilities: {} };
const team: ChoiceAnswer = { type: "choice", choice: "auth", confidence: 0.6, probabilities: {} };
const severity: ScoreAnswer = {
  type: "score",
  score: 1.2,
  confidence: 0.4,
  probabilities: {},
  legend: {},
};

const response = new DecisionResponse({
  answers: { urgent, team, severity },
  usage: { inputTokens: 1, outputTokens: 2, cost: null },
  model: "jev-latest",
  id: "resp_1",
  raw: {},
});

describe("DecisionResponse", () => {
  it("reads answers by id", () => {
    expect(response.get("urgent")).toBe(urgent);
    expect(response.answers.team).toBe(team);
  });

  it("filters answers by type", () => {
    expect(response.nouls()).toEqual({ urgent });
    expect(response.choices()).toEqual({ team });
    expect(response.scores()).toEqual({ severity });
  });

  it("defaults requestId to null", () => {
    expect(response.requestId).toBeNull();
    expect(
      new DecisionResponse({
        answers: {},
        usage: { inputTokens: null, outputTokens: null, cost: null },
        model: null,
        id: null,
        raw: null,
        requestId: "req_1",
      }).requestId
    ).toBe("req_1");
  });
});
