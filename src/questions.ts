import type {
  ChoiceCriteria,
  ChoiceQuestion,
  Description,
  EntryValue,
  NoulCriteria,
  NoulQuestion,
  ScoreQuestion,
} from "./types.js";

function validateInstructions(instructions: unknown): asserts instructions is EntryValue {
  if (typeof instructions === "string") {
    if (instructions.length === 0) throw new TypeError("instructions must not be empty");
    return;
  }
  if (Array.isArray(instructions)) {
    if (instructions.length === 0) throw new TypeError("instructions must not be empty");
    return;
  }
  if (instructions !== null && typeof instructions === "object") {
    if (Object.keys(instructions).length === 0) {
      throw new TypeError("instructions must not be empty");
    }
    return;
  }
  throw new TypeError("instructions must be a string, object, or array");
}

/** Build a yes/no question. The answer is a calibrated probability of yes. */
export function noul(instructions: EntryValue, criteria?: NoulCriteria): NoulQuestion {
  validateInstructions(instructions);
  const question: NoulQuestion = { type: "noul", instructions };
  if (criteria !== undefined) question.criteria = criteria;
  return question;
}

/**
 * Build a question that selects one of up to 255 named options. Criteria map
 * labels to rubric descriptions (`null` leaves a label undescribed). The
 * criteria keys flow through to the answer's `choice` type.
 */
export function choice<const C extends ChoiceCriteria>(
  instructions: EntryValue,
  criteria: C
): ChoiceQuestion<C> {
  validateInstructions(instructions);
  if (criteria === null || typeof criteria !== "object" || Array.isArray(criteria)) {
    throw new TypeError("criteria must be an object with 1..255 entries");
  }
  const size = Object.keys(criteria).length;
  if (size < 1 || size > 255) {
    throw new TypeError("criteria must be an object with 1..255 entries");
  }
  return { type: "choice", instructions, criteria };
}

/** Build a question that places the state on an ordered rubric of 2 to 10 levels. */
export function score(instructions: EntryValue, criteria: readonly Description[]): ScoreQuestion {
  validateInstructions(instructions);
  if (!Array.isArray(criteria) || criteria.length < 2 || criteria.length > 10) {
    throw new TypeError("criteria must be an array with 2..10 entries");
  }
  return { type: "score", instructions, criteria };
}

/** Namespace-style access mirroring `RubyDecisionModel::Questions`. */
export const Questions = { noul, choice, score } as const;
