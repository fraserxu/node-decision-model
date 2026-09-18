/** A JSON-compatible value. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** Text, a JSON object, or an array — the shapes accepted for state, instructions, and criteria descriptions. */
export type EntryValue = string | { [key: string]: JsonValue } | JsonValue[];

/** A criterion description; `null` leaves the label undescribed. */
export type Description = EntryValue | null;

/** Optional descriptions of the yes and no outcomes of a noul question. */
export interface NoulCriteria {
  true?: Description;
  false?: Description;
}

/** Labels mapped to rubric descriptions. */
export type ChoiceCriteria = { [label: string]: Description };

/** Ordered rubric level descriptions, indexed by score from zero. */
export type ScoreCriteria = readonly Description[];

/** A yes/no question answered with a calibrated probability. */
export interface NoulQuestion {
  type: "noul";
  instructions: EntryValue;
  criteria?: NoulCriteria;
}

/** A question that selects one of up to 255 named options. */
export interface ChoiceQuestion<C extends ChoiceCriteria = ChoiceCriteria> {
  type: "choice";
  instructions: EntryValue;
  criteria: C;
}

/** A question that places the state on an ordered rubric of 2 to 10 levels. */
export interface ScoreQuestion {
  type: "score";
  instructions: EntryValue;
  criteria: ScoreCriteria;
}

/** Any decision-model question. */
export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;

/** Questions keyed by the ids used to read their answers back. */
export type Questions = { [id: string]: Question };

/** Probability of a yes answer. */
export interface NoulAnswer {
  readonly type: "noul";
  /** Probability of yes, from 0 to 1. */
  readonly noul: number;
  readonly probabilities: Readonly<Record<string, number>>;
}

/** The selected label with its calibrated distribution. */
export interface ChoiceAnswer<C extends ChoiceCriteria = ChoiceCriteria> {
  readonly type: "choice";
  readonly choice: keyof C & string;
  readonly confidence: number;
  /**
   * Probabilities keyed by label. Calibrated, not normalized — they sum to
   * approximately 1.
   */
  readonly probabilities: Readonly<Record<string, number>>;
}

/** An expected score, which may fall between integer rubric levels. */
export interface ScoreAnswer {
  readonly type: "score";
  readonly score: number;
  readonly confidence: number;
  /** Keyed by the wire's string level keys ("0", "1", ...), not by criteria labels. */
  readonly probabilities: Readonly<Record<string, number>>;
  /** Rubric descriptions keyed by the same string level keys. */
  readonly legend: Readonly<Record<string, unknown>>;
}

/** Any decision-model answer. */
export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

/** The answer type for one question, preserving choice criteria keys. */
export type AnswerFor<Q extends Question> = Q extends ChoiceQuestion<infer C>
  ? ChoiceAnswer<C>
  : Q extends ScoreQuestion
    ? ScoreAnswer
    : Q extends NoulQuestion
      ? NoulAnswer
      : never;

/** Answers keyed like the questions map they came from. */
export type AnswersFor<Qs extends Questions> = { readonly [K in keyof Qs]: AnswerFor<Qs[K]> };

/** Token counts and, where the provider reports it, cost for one request. */
export interface Usage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  /** Cost in the provider's currency; null when the provider does not report cost. */
  readonly cost: number | null;
}
