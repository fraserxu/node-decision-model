import { afterEach, describe, expect, it } from "vitest";
import {
  ApiError,
  choice,
  Client,
  ConfigurationError,
  DecisionResponse,
  getDefaultClient,
  InvalidResponse,
  MissingAnswers,
  noul,
  OpenRouterProvider,
  Overloaded,
  PayloadTooLarge,
  RateLimited,
  RequestError,
  score,
  setDefaultClient,
  TypesafeProvider,
  Unauthorized,
  UnprocessableEntity,
} from "../src/index.js";
import { FakeTransport, successBody, withEnv } from "./helpers.js";

const questions = {
  urgent: noul("Is this urgent?"),
  team: choice("Which team?", { billing: null, auth: null }),
  severity: score("How severe?", ["cosmetic", "minor", "major"]),
};

const fullBody = JSON.stringify({
  id: "resp_42",
  model: "typesafe/jev-1.13",
  answers: {
    urgent: { type: "noul", noul: 0.87, probabilities: { true: 0.87, false: 0.13 } },
    team: {
      type: "choice",
      choice: "billing",
      confidence: 0.9,
      probabilities: { billing: 0.9, auth: 0.1 },
    },
    severity: {
      type: "score",
      score: 1.4,
      confidence: 0.6,
      probabilities: { "0": 0.1, "1": 0.4, "2": 0.5 },
      legend: { "0": "cosmetic", "1": "minor", "2": "major" },
    },
  },
  usage: { input_tokens: 120, output_tokens: 9, cost: 0.0012 },
});

function client(transport: FakeTransport, options: Record<string, unknown> = {}) {
  return new Client({ apiKey: "test-key", transport: transport.call, ...options });
}

describe("Client construction", () => {
  it("apiKey alone selects OpenRouter", () => {
    const c = new Client({ apiKey: "sk-or" });
    expect(c.provider).toBeInstanceOf(OpenRouterProvider);
    expect(c.model).toBe("typesafe/jev-1.13");
    expect(c.baseUrl).toBe("https://openrouter.ai/api/alpha");
    expect(c.timeout).toBe(5_000);
  });

  it("resolves aliases through the provider", () => {
    expect(new Client({ apiKey: "k", model: "jev" }).model).toBe("typesafe/jev-1.13");
    expect(new Client({ apiKey: "k", provider: "typesafe", model: "typesafe/jev-1.13" }).model).toBe(
      "jev-latest"
    );
    expect(new Client({ apiKey: "k", model: "custom/model" }).model).toBe("custom/model");
  });

  it("reads the environment when nothing is passed, preferring Typesafe", async () => {
    await withEnv({ TYPESAFE_API_KEY: "t", OPENROUTER_API_KEY: "o" }, () => {
      expect(new Client().provider).toBeInstanceOf(TypesafeProvider);
    });
    await withEnv({ TYPESAFE_API_KEY: undefined, OPENROUTER_API_KEY: "o" }, () => {
      expect(new Client().provider).toBeInstanceOf(OpenRouterProvider);
    });
  });

  it("applies baseUrl to an environment-selected provider", async () => {
    await withEnv({ TYPESAFE_API_KEY: "t" }, () => {
      expect(new Client({ baseUrl: "https://proxy.example/" }).baseUrl).toBe(
        "https://proxy.example"
      );
    });
  });

  it("raises ConfigurationError naming both env vars when nothing is configured", async () => {
    await withEnv({ TYPESAFE_API_KEY: undefined, OPENROUTER_API_KEY: undefined }, () => {
      expect(() => new Client()).toThrow(ConfigurationError);
      expect(() => new Client()).toThrow(/TYPESAFE_API_KEY, OPENROUTER_API_KEY/);
    });
  });

  it("raises ConfigurationError when a named provider has no key", async () => {
    await withEnv({ TYPESAFE_API_KEY: undefined }, () => {
      expect(() => new Client({ provider: "typesafe" })).toThrow(/set TYPESAFE_API_KEY/);
    });
  });

  it("accepts a provider instance and copies it when overriding", () => {
    const shared = new TypesafeProvider({ apiKey: "a" });
    const asIs = new Client({ provider: shared });
    expect(asIs.provider).toBe(shared);

    const overridden = new Client({ provider: shared, apiKey: "b" });
    expect(overridden.provider).not.toBe(shared);
    expect(overridden.provider.apiKey).toBe("b");
    expect(shared.apiKey).toBe("a");
  });

  it("rejects unknown provider names and types", () => {
    expect(() => new Client({ provider: "mystery" as any, apiKey: "k" })).toThrow(
      ConfigurationError
    );
    expect(() => new Client({ provider: 42 as any, apiKey: "k" })).toThrow(ConfigurationError);
  });
});

describe("Client#ask", () => {
  it("rejects an empty questions map", async () => {
    await expect(client(new FakeTransport([])).ask({ state: {}, questions: {} })).rejects.toBeInstanceOf(
      RequestError
    );
  });

  it("posts the provider body and headers", async () => {
    const transport = new FakeTransport([[200, fullBody]]);
    await client(transport, { provider: "typesafe" }).ask({ state: { a: 1 }, questions });
    const request = transport.requests[0]!;
    expect(request.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(request.headers.Authorization).toBe("Bearer test-key");
    expect(JSON.parse(request.body)).toEqual({ model: "jev-latest", state: { a: 1 }, questions });
  });

  it("parses every answer type", async () => {
    const response = await client(new FakeTransport([[200, fullBody]])).ask({
      state: {},
      questions,
    });
    expect(response).toBeInstanceOf(DecisionResponse);
    expect(response.answers.urgent).toEqual({
      type: "noul",
      noul: 0.87,
      probabilities: { true: 0.87, false: 0.13 },
    });
    expect(response.answers.team.choice).toBe("billing");
    expect(response.answers.team.confidence).toBe(0.9);
    expect(response.answers.severity.score).toBe(1.4);
    expect(response.answers.severity.legend).toEqual({ "0": "cosmetic", "1": "minor", "2": "major" });
    expect(response.get("severity").probabilities["1"]).toBe(0.4);
    expect(response.usage).toEqual({ inputTokens: 120, outputTokens: 9, cost: 0.0012 });
    expect(response.model).toBe("typesafe/jev-1.13");
    expect(response.id).toBe("resp_42");
    expect(response.raw).toEqual(JSON.parse(fullBody));
  });

  it("exposes the Typesafe request id from headers, case-insensitively", async () => {
    const withId = new FakeTransport([[200, fullBody, { "X-Typesafe-Request-Id": "req_9" }]]);
    expect((await client(withId).ask({ state: {}, questions })).requestId).toBe("req_9");

    const arrayHeader = new FakeTransport([
      [200, fullBody, { "x-typesafe-request-id": ["req_a", "req_b"] as any }],
    ]);
    expect((await client(arrayHeader).ask({ state: {}, questions })).requestId).toBe("req_a");

    const none = new FakeTransport([[200, fullBody, {}]]);
    expect((await client(none).ask({ state: {}, questions })).requestId).toBeNull();
  });

  it("raises MissingAnswers with the ids and partial answers", async () => {
    const body = JSON.stringify({
      answers: {
        urgent: { type: "noul", noul: 0.5 },
        team: { type: "score", score: 1, confidence: 1 },
      },
    });
    const error = await client(new FakeTransport([[200, body]]))
      .ask({ state: {}, questions })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MissingAnswers);
    expect((error as MissingAnswers).missing).toEqual(["team", "severity"]);
    expect(Object.keys((error as MissingAnswers).answers)).toEqual(["urgent"]);
  });

  it("raises InvalidResponse for malformed answer fields", async () => {
    const body = JSON.stringify({
      answers: {
        urgent: { type: "noul", noul: "high" },
        team: { type: "choice", choice: "billing", confidence: 0.5 },
        severity: { type: "score", score: 1, confidence: 1 },
      },
    });
    const error = await client(new FakeTransport([[200, body]]))
      .ask({ state: {}, questions })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InvalidResponse);
    expect(error).not.toBeInstanceOf(MissingAnswers);
    expect((error as InvalidResponse).message).toMatch(/malformed answer fields for: urgent/);
    expect(Object.keys((error as InvalidResponse).answers).sort()).toEqual(["severity", "team"]);
  });

  it("raises InvalidResponse for empty, non-JSON, and non-object bodies", async () => {
    const q = { urgent: noul("?") };
    for (const body of ["", "   ", null, "not json", "[1,2]", "42"]) {
      await expect(
        client(new FakeTransport([[200, body]])).ask({ state: {}, questions: q })
      ).rejects.toBeInstanceOf(InvalidResponse);
    }
  });

  it("tolerates missing probabilities and legend", async () => {
    const body = JSON.stringify({
      answers: {
        urgent: { type: "noul", noul: 0.1 },
        team: { type: "choice", choice: "auth", confidence: 0.7, probabilities: "bad" },
        severity: { type: "score", score: 2, confidence: 0.2 },
      },
    });
    const response = await client(new FakeTransport([[200, body]])).ask({ state: {}, questions });
    expect(response.answers.urgent.probabilities).toEqual({});
    expect(response.answers.team.probabilities).toEqual({});
    expect(response.answers.severity.legend).toEqual({});
    expect(response.usage).toEqual({ inputTokens: null, outputTokens: null, cost: null });
  });

  it("maps error statuses to error classes with status, body, and headers", async () => {
    const cases: [number, unknown][] = [
      [401, Unauthorized],
      [413, PayloadTooLarge],
      [422, UnprocessableEntity],
      [429, RateLimited],
      [529, Overloaded],
      [418, ApiError],
    ];
    for (const [status, ErrorClass] of cases) {
      const error = await client(new FakeTransport([[status, "body", { "x-a": "b" }]]), {
        retry: { maxRetries: 0 },
      })
        .ask({ state: {}, questions })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ErrorClass as any);
      expect((error as ApiError).status).toBe(status);
      expect((error as ApiError).body).toBe("body");
      expect((error as ApiError).headers).toEqual({ "x-a": "b" });
    }
  });

  it("rejects transports that resolve with something other than a tuple", async () => {
    const bad = { call: async () => "nope" as any } as unknown as FakeTransport;
    await expect(client(bad).ask({ state: {}, questions })).rejects.toBeInstanceOf(InvalidResponse);
  });
});

describe("default client", () => {
  afterEach(() => setDefaultClient(undefined));

  it("memoizes one client built from the environment", async () => {
    await withEnv({ TYPESAFE_API_KEY: "t" }, () => {
      const first = getDefaultClient();
      expect(first).toBe(getDefaultClient());
      expect(first.provider).toBeInstanceOf(TypesafeProvider);
    });
  });

  it("can be replaced or reset", () => {
    const custom = new Client({ apiKey: "k", transport: new FakeTransport([]).call });
    setDefaultClient(custom);
    expect(getDefaultClient()).toBe(custom);
    setDefaultClient(undefined);
    expect(() => getDefaultClient()).not.toBe(custom);
  });
});

describe("successBody helper sanity", () => {
  it("round-trips through the client", async () => {
    const response = await client(new FakeTransport([[200, successBody()]])).ask({
      state: "s",
      questions: { urgent: noul("?") },
    });
    expect(response.answers.urgent.noul).toBe(0.6);
  });
});
