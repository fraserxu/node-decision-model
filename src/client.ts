import {
  ApiError,
  ConfigurationError,
  InvalidResponse,
  MissingAnswers,
  Overloaded,
  PayloadTooLarge,
  RateLimited,
  RequestError,
  TimeoutError,
  TransportError,
  Unauthorized,
  UnprocessableEntity,
  DecisionModelError,
} from "./errors.js";
import { buildProvider, providerEnvVars, providerFromEnv, Provider } from "./providers/index.js";
import type { ProviderName } from "./providers/index.js";
import { RetryPolicy, type RetryPolicyOptions } from "./retry-policy.js";
import { DecisionResponse } from "./response.js";
import type {
  Answer,
  AnswersFor,
  ChoiceAnswer,
  NoulAnswer,
  Question,
  Questions,
  ScoreAnswer,
} from "./types.js";

const REQUEST_ID_HEADER = "x-typesafe-request-id";

/**
 * A transport performs one POST and resolves with `[status, body, headers]`.
 * A two-element `[status, body]` result is still accepted and treated as
 * having no headers, which means no Retry-After support and a null requestId.
 */
export type Transport = (args: {
  url: string;
  headers: Record<string, string>;
  body: string;
}) => Promise<
  readonly [number, string | null] | readonly [number, string | null, Record<string, string>]
>;

export interface ClientOptions {
  /**
   * "open-router", "typesafe", or a Provider instance. When omitted, apiKey
   * alone selects OpenRouter; otherwise the environment decides
   * (TYPESAFE_API_KEY, then OPENROUTER_API_KEY).
   */
  provider?: ProviderName | Provider;
  /** Overrides the provider's environment variable. */
  apiKey?: string;
  /** Undefined means the provider default; aliases resolve per provider. */
  model?: string;
  /** Overrides the provider base URL. */
  baseUrl?: string;
  /** Per-attempt timeout in milliseconds for connecting and reading. */
  timeout?: number;
  /** A RetryPolicy or an options object of overrides. */
  retry?: RetryPolicy | RetryPolicyOptions;
  transport?: Transport;
  /** Injectable for tests: resolves after `ms` milliseconds. */
  sleeper?: (ms: number) => Promise<void>;
  /** Injectable for tests: returns a number in [0, 1), used for backoff jitter. */
  random?: () => number;
  /** Injectable for tests: returns monotonic milliseconds, used for totalTimeout. */
  clock?: () => number;
}

class MalformedAnswer extends Error {}

function defaultSleeper(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class Client {
  readonly provider: Provider;
  readonly model: string;
  readonly timeout: number;
  readonly retryPolicy: RetryPolicy;

  private readonly transport: Transport;
  private readonly sleeper: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly clock: () => number;

  constructor(options: ClientOptions = {}) {
    this.provider = this.resolveProvider(options);
    if (!this.provider.hasApiKey()) {
      throw new ConfigurationError(
        `apiKey is required for ${this.provider.name}: pass apiKey or set ${this.provider.envVar}`
      );
    }

    this.model = this.provider.resolveModel(options.model ?? null);
    this.timeout = options.timeout ?? 5_000;
    this.transport = options.transport ?? this.defaultTransport();
    this.sleeper = options.sleeper ?? defaultSleeper;
    this.retryPolicy = RetryPolicy.from(options.retry);
    this.random = options.random ?? Math.random;
    this.clock = options.clock ?? (() => performance.now());
  }

  get baseUrl(): string {
    return this.provider.baseUrl;
  }

  async ask<const Qs extends Questions>(args: {
    state: unknown;
    questions: Qs;
  }): Promise<DecisionResponse<Qs>> {
    const { state, questions } = args;
    if (questions == null || Object.keys(questions).length === 0) {
      throw new RequestError("questions must not be empty");
    }

    const body = this.provider.requestBody({ model: this.model, state, questions });
    const [status, responseBody, responseHeaders] = await this.performWithRetry({
      url: this.provider.url,
      headers: this.provider.headers(),
      body,
    });
    return this.handleResponse(status, responseBody, responseHeaders, questions);
  }

  private resolveProvider(options: ClientOptions): Provider {
    const { provider, apiKey, baseUrl } = options;

    if (provider instanceof Provider) {
      if (apiKey == null && baseUrl == null) return provider;
      return provider.configure({ apiKey, baseUrl });
    }
    if (typeof provider === "string") {
      return buildProvider(provider, { apiKey, baseUrl });
    }
    if (provider === undefined) {
      if (apiKey == null) {
        const fromEnv = providerFromEnv();
        if (fromEnv === null) {
          throw new ConfigurationError(
            `no provider configured: pass provider or apiKey, or set one of ${providerEnvVars().join(", ")}`
          );
        }
        return baseUrl == null ? fromEnv : fromEnv.configure({ baseUrl });
      }
      return buildProvider("open-router", { apiKey, baseUrl });
    }
    throw new ConfigurationError(
      `provider must be a string or a Provider, got ${typeof provider}`
    );
  }

  private defaultTransport(): Transport {
    return async ({ url, headers, body }) => {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(this.timeout),
      });
      const text = await response.text();
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });
      return [response.status, text, responseHeaders] as const;
    };
  }

  private async performWithRetry(request: {
    url: string;
    headers: Record<string, string>;
    body: string;
  }): Promise<[number, string | null, Record<string, string>]> {
    const policy = this.retryPolicy;
    const startedAt = this.clock();
    let retries = 0;

    for (;;) {
      let result: [number, string | null, Record<string, string>];
      try {
        result = this.normalizeTransportResult(await this.transport(request));
      } catch (error) {
        if (error instanceof DecisionModelError) throw error;

        if (!(policy.retryableError(error) && retries < policy.maxRetries)) {
          throw this.transportError(error);
        }
        const delay = policy.backoff(retries, this.random);
        if (this.budgetExceeded(policy, startedAt, delay)) throw this.transportError(error);

        await this.sleeper(delay);
        if (this.budgetExceeded(policy, startedAt, 0)) throw this.transportError(error);

        retries += 1;
        continue;
      }

      const [status, , responseHeaders] = result;
      if (!(policy.retryableStatus(status) && retries < policy.maxRetries)) return result;

      const delay = policy.delay(retries, { headers: responseHeaders, random: this.random });
      if (this.budgetExceeded(policy, startedAt, delay)) return result;

      await this.sleeper(delay);
      if (this.budgetExceeded(policy, startedAt, 0)) return result;

      retries += 1;
    }
  }

  private budgetExceeded(policy: RetryPolicy, startedAt: number, delay: number): boolean {
    if (policy.totalTimeout === null) return false;
    return this.clock() - startedAt + delay > policy.totalTimeout;
  }

  private normalizeTransportResult(
    result: Awaited<ReturnType<Transport>>
  ): [number, string | null, Record<string, string>] {
    if (!Array.isArray(result)) {
      throw new InvalidResponse("transport must resolve with [status, body, headers?]");
    }
    const [status, body, headers] = result as [unknown, unknown, unknown];
    if (typeof status !== "number") {
      throw new InvalidResponse("transport must resolve with a numeric status");
    }
    return [
      status,
      body == null ? null : String(body),
      headers !== null && typeof headers === "object" ? (headers as Record<string, string>) : {},
    ];
  }

  private transportError(error: unknown): TransportError {
    const message = error instanceof Error ? error.message : String(error);
    if (this.retryPolicy.isTimeoutError(error)) {
      return new TimeoutError(`request timed out: ${message}`, { causeError: error });
    }
    return new TransportError(`transport error: ${message}`, { causeError: error });
  }

  private handleResponse<Qs extends Questions>(
    status: number,
    body: string | null,
    headers: Record<string, string>,
    questions: Qs
  ): DecisionResponse<Qs> {
    if (status >= 200 && status <= 299) {
      return this.parseSuccess(body, headers, questions);
    }
    const options = { status, body, headers };
    switch (status) {
      case 401:
        throw new Unauthorized("unauthorized", options);
      case 413:
        throw new PayloadTooLarge("payload too large", options);
      case 422:
        throw new UnprocessableEntity("unprocessable entity", options);
      case 429:
        throw new RateLimited("rate limited", options);
      case 529:
        throw new Overloaded("overloaded", options);
      default:
        throw new ApiError(`api error (status ${status})`, options);
    }
  }

  private parseSuccess<Qs extends Questions>(
    body: string | null,
    headers: Record<string, string>,
    questions: Qs
  ): DecisionResponse<Qs> {
    if (body === null || body.trim() === "") {
      throw new InvalidResponse("response body was empty");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new InvalidResponse(`response body was not valid JSON: ${message}`);
    }

    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new InvalidResponse("response body was not a JSON object");
    }

    const parsedObject = parsed as Record<string, unknown>;
    const rawAnswers =
      parsedObject.answers !== null &&
      typeof parsedObject.answers === "object" &&
      !Array.isArray(parsedObject.answers)
        ? (parsedObject.answers as Record<string, unknown>)
        : {};

    const normalized: Record<string, Answer> = {};
    const malformed: string[] = [];
    const missing: string[] = [];

    for (const [id, question] of Object.entries(questions)) {
      const answerValue = rawAnswers[id];
      const expectedType = this.questionType(question);

      if (
        answerValue !== null &&
        typeof answerValue === "object" &&
        !Array.isArray(answerValue) &&
        (answerValue as Record<string, unknown>).type === expectedType
      ) {
        try {
          normalized[id] = this.normalizeAnswer(
            expectedType,
            answerValue as Record<string, unknown>
          );
        } catch (error) {
          if (!(error instanceof MalformedAnswer)) throw error;
          malformed.push(id);
        }
      } else {
        missing.push(id);
      }
    }

    if (malformed.length > 0) {
      throw new InvalidResponse(`malformed answer fields for: ${malformed.join(", ")}`, {
        answers: normalized,
      });
    }
    if (missing.length > 0) {
      throw new MissingAnswers(`missing or wrong-type answers for: ${missing.join(", ")}`, {
        answers: normalized,
        missing,
      });
    }

    return new DecisionResponse<Qs>({
      answers: normalized as AnswersFor<Qs>,
      usage: this.provider.usage(parsed),
      model: typeof parsedObject.model === "string" ? parsedObject.model : null,
      id: typeof parsedObject.id === "string" ? parsedObject.id : null,
      raw: parsed,
      requestId: this.requestIdFrom(headers),
    });
  }

  private requestIdFrom(headers: Record<string, string>): string | null {
    if (headers === null || typeof headers !== "object") return null;
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() !== REQUEST_ID_HEADER) continue;
      const single = Array.isArray(value) ? value[0] : value;
      return single == null ? null : String(single);
    }
    return null;
  }

  private questionType(question: Question): string | null {
    if (question === null || typeof question !== "object") return null;
    return typeof question.type === "string" ? question.type : null;
  }

  private normalizeAnswer(type: string | null, raw: Record<string, unknown>): Answer {
    switch (type) {
      case "noul": {
        const value = raw.noul;
        if (typeof value !== "number" || Number.isNaN(value)) throw new MalformedAnswer();
        const answer: NoulAnswer = {
          type: "noul",
          noul: value,
          probabilities: this.recordOrEmpty(raw.probabilities),
        };
        return answer;
      }
      case "choice": {
        const selected = raw.choice;
        const confidence = raw.confidence;
        if (typeof selected !== "string" || typeof confidence !== "number") {
          throw new MalformedAnswer();
        }
        const answer: ChoiceAnswer = {
          type: "choice",
          choice: selected,
          confidence,
          probabilities: this.recordOrEmpty(raw.probabilities),
        };
        return answer;
      }
      case "score": {
        const value = raw.score;
        const confidence = raw.confidence;
        if (typeof value !== "number" || typeof confidence !== "number") {
          throw new MalformedAnswer();
        }
        const answer: ScoreAnswer = {
          type: "score",
          score: value,
          confidence,
          probabilities: this.recordOrEmpty(raw.probabilities),
          legend: this.recordOrEmpty(raw.legend),
        };
        return answer;
      }
      default:
        throw new MalformedAnswer();
    }
  }

  private recordOrEmpty(value: unknown): Record<string, number> {
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, number>)
      : {};
  }
}

let memoizedClient: Client | undefined;

/**
 * A memoized default client built from the environment. Reset with
 * `setDefaultClient(undefined)`.
 */
export function getDefaultClient(): Client {
  return (memoizedClient ??= new Client());
}

export function setDefaultClient(client: Client | undefined): void {
  memoizedClient = client;
}
