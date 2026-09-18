import type { Answer } from "./types.js";

/** Base class for every error this package throws. */
export class DecisionModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** No provider could be resolved, an api key is missing, or an option is invalid. */
export class ConfigurationError extends DecisionModelError {}

/** The request was invalid before it was sent, e.g. an empty questions map. */
export class RequestError extends DecisionModelError {}

/** Network failure after retries were exhausted. */
export class TransportError extends DecisionModelError {
  readonly causeError: unknown;

  constructor(message: string, options: { causeError?: unknown } = {}) {
    super(message);
    this.causeError = options.causeError;
  }
}

/** Open or read timeout after retries were exhausted. */
export class TimeoutError extends TransportError {}

/** Non-2xx response from the API. */
export class ApiError extends DecisionModelError {
  readonly status: number;
  readonly body: string | null;
  readonly headers: Readonly<Record<string, string>>;

  constructor(
    message: string,
    options: { status: number; body: string | null; headers?: Record<string, string> }
  ) {
    super(message);
    this.status = options.status;
    this.body = options.body;
    this.headers = options.headers ?? {};
  }
}

/** 401. */
export class Unauthorized extends ApiError {}

/** 413. */
export class PayloadTooLarge extends ApiError {}

/** 422. Never retried. */
export class UnprocessableEntity extends ApiError {}

/** 429. Retried. */
export class RateLimited extends ApiError {}

/** 529. Retried. */
export class Overloaded extends ApiError {}

/** The body was not JSON, not an object, or an answer was malformed. */
export class InvalidResponse extends DecisionModelError {
  /** Answers that did parse cleanly, keyed by question id. */
  readonly answers: Readonly<Record<string, Answer>>;

  constructor(message: string, options: { answers?: Record<string, Answer> } = {}) {
    super(message);
    this.answers = options.answers ?? {};
  }
}

/** One or more question ids came back missing or wrong-typed. */
export class MissingAnswers extends InvalidResponse {
  readonly missing: readonly string[];

  constructor(
    message: string,
    options: { answers?: Record<string, Answer>; missing?: string[] } = {}
  ) {
    super(message, { answers: options.answers ?? {} });
    this.missing = options.missing ?? [];
  }
}
