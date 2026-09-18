import type {
  Answer,
  AnswersFor,
  ChoiceAnswer,
  NoulAnswer,
  Questions,
  ScoreAnswer,
  Usage,
} from "./types.js";

export class DecisionResponse<Qs extends Questions = Questions> {
  /** Typed answers keyed like the questions map that produced them. */
  readonly answers: AnswersFor<Qs>;
  readonly usage: Usage;
  /** Whatever model name the provider returned. */
  readonly model: string | null;
  readonly id: string | null;
  /** The parsed response body, untouched. */
  readonly raw: unknown;
  /** Typesafe's `x-typesafe-request-id` header; null on OpenRouter. */
  readonly requestId: string | null;

  constructor(options: {
    answers: AnswersFor<Qs>;
    usage: Usage;
    model: string | null;
    id: string | null;
    raw: unknown;
    requestId?: string | null;
  }) {
    this.answers = options.answers;
    this.usage = options.usage;
    this.model = options.model;
    this.id = options.id;
    this.raw = options.raw;
    this.requestId = options.requestId ?? null;
  }

  /** The answer for one question id. */
  get<K extends keyof Qs>(id: K): AnswersFor<Qs>[K] {
    return this.answers[id];
  }

  /** Answers filtered by type, keyed the same way as `answers`. */
  nouls(): Record<string, NoulAnswer> {
    return this.answersOfType("noul");
  }

  choices(): Record<string, ChoiceAnswer> {
    return this.answersOfType("choice");
  }

  scores(): Record<string, ScoreAnswer> {
    return this.answersOfType("score");
  }

  private answersOfType<T extends Answer>(type: T["type"]): Record<string, T> {
    const filtered: Record<string, T> = {};
    for (const [id, answer] of Object.entries(this.answers as Record<string, Answer>)) {
      if (answer.type === type) filtered[id] = answer as T;
    }
    return filtered;
  }
}
