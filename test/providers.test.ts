import { describe, expect, it } from "vitest";
import {
  buildProvider,
  ConfigurationError,
  OpenRouterProvider,
  Provider,
  providerEnvVars,
  providerFromEnv,
  providerNames,
  TypesafeProvider,
  VERSION,
} from "../src/index.js";
import { withEnv } from "./helpers.js";

describe("OpenRouterProvider", () => {
  it("has the documented defaults", () => {
    const provider = new OpenRouterProvider({ apiKey: "k" });
    expect(provider.name).toBe("open-router");
    expect(provider.envVar).toBe("OPENROUTER_API_KEY");
    expect(provider.url).toBe("https://openrouter.ai/api/alpha/decisions");
    expect(provider.defaultModel).toBe("typesafe/jev-1.13");
    expect(provider.reportsCost).toBe(true);
  });

  it("resolves aliases and passes unknown models through", () => {
    const provider = new OpenRouterProvider({ apiKey: "k" });
    expect(provider.resolveModel(null)).toBe("typesafe/jev-1.13");
    expect(provider.resolveModel("")).toBe("typesafe/jev-1.13");
    expect(provider.resolveModel("jev")).toBe("typesafe/jev-1.13");
    expect(provider.resolveModel("jev-latest")).toBe("typesafe/jev-1.13");
    expect(provider.resolveModel("other/model")).toBe("other/model");
  });

  it("reads cost from usage", () => {
    const provider = new OpenRouterProvider({ apiKey: "k" });
    const usage = provider.usage({ usage: { input_tokens: 12, output_tokens: 3, cost: 0.004 } });
    expect(usage).toEqual({ inputTokens: 12, outputTokens: 3, cost: 0.004 });
  });
});

describe("TypesafeProvider", () => {
  it("has the documented defaults", () => {
    const provider = new TypesafeProvider({ apiKey: "k" });
    expect(provider.name).toBe("typesafe");
    expect(provider.envVar).toBe("TYPESAFE_API_KEY");
    expect(provider.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(provider.defaultModel).toBe("jev-latest");
    expect(provider.reportsCost).toBe(false);
  });

  it("maps the OpenRouter model name back to jev-latest", () => {
    const provider = new TypesafeProvider({ apiKey: "k" });
    expect(provider.resolveModel("typesafe/jev-1.13")).toBe("jev-latest");
    expect(provider.resolveModel("jev")).toBe("jev-latest");
    expect(provider.resolveModel(undefined)).toBe("jev-latest");
  });

  it("never reports cost even when the wire carries one", () => {
    const provider = new TypesafeProvider({ apiKey: "k" });
    expect(provider.usage({ usage: { input_tokens: 1, output_tokens: 2, cost: 9 } }).cost).toBeNull();
  });
});

describe("Provider base behaviour", () => {
  it("strips a trailing slash from baseUrl overrides", () => {
    const provider = new TypesafeProvider({ apiKey: "k", baseUrl: "https://example.com/" });
    expect(provider.url).toBe("https://example.com/v1/systemone");
  });

  it("sends auth, content type, and a versioned user agent", () => {
    const headers = new TypesafeProvider({ apiKey: "secret" }).headers();
    expect(headers.Authorization).toBe("Bearer secret");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers.Accept).toBe("application/json");
    expect(headers["User-Agent"]).toBe(`node-decision-model/${VERSION}`);
  });

  it("serializes the request body with model, state, and questions", () => {
    const provider = new TypesafeProvider({ apiKey: "k" });
    const body = provider.requestBody({
      model: "jev-latest",
      state: { a: 1 },
      questions: { q: { type: "noul", instructions: "?" } },
    });
    expect(JSON.parse(body)).toEqual({
      model: "jev-latest",
      state: { a: 1 },
      questions: { q: { type: "noul", instructions: "?" } },
    });
  });

  it("treats blank api keys as missing", () => {
    expect(new TypesafeProvider({ apiKey: "  " }).hasApiKey()).toBe(false);
    expect(new TypesafeProvider({ apiKey: "k" }).hasApiKey()).toBe(true);
  });

  it("redacts the api key in toString", () => {
    const provider = new TypesafeProvider({ apiKey: "super-secret" });
    expect(provider.toString()).not.toContain("super-secret");
    expect(provider.toString()).toContain("[REDACTED]");
  });

  it("configure returns a copy and leaves the original untouched", () => {
    const original = new TypesafeProvider({ apiKey: "a", baseUrl: "https://one.example" });
    const copy = original.configure({ apiKey: "b" });
    expect(copy).toBeInstanceOf(TypesafeProvider);
    expect(copy.apiKey).toBe("b");
    expect(copy.baseUrl).toBe("https://one.example");
    expect(original.apiKey).toBe("a");
  });

  it("handles malformed usage payloads", () => {
    const provider = new OpenRouterProvider({ apiKey: "k" });
    expect(provider.usage({})).toEqual({ inputTokens: null, outputTokens: null, cost: null });
    expect(provider.usage({ usage: "nope" })).toEqual({
      inputTokens: null,
      outputTokens: null,
      cost: null,
    });
    expect(provider.usage({ usage: { input_tokens: "12", cost: "0.5" } })).toEqual({
      inputTokens: 12,
      outputTokens: null,
      cost: 0.5,
    });
  });
});

describe("registry", () => {
  it("builds providers by name, tolerating separators", () => {
    expect(buildProvider("typesafe", { apiKey: "k" })).toBeInstanceOf(TypesafeProvider);
    expect(buildProvider("open-router", { apiKey: "k" })).toBeInstanceOf(OpenRouterProvider);
    expect(buildProvider("open_router", { apiKey: "k" })).toBeInstanceOf(OpenRouterProvider);
    expect(buildProvider("openrouter", { apiKey: "k" })).toBeInstanceOf(OpenRouterProvider);
  });

  it("raises ConfigurationError for unknown names", () => {
    expect(() => buildProvider("mystery")).toThrow(ConfigurationError);
    expect(() => buildProvider("mystery")).toThrow(/known providers: open-router, typesafe/);
  });

  it("lists names and env vars in priority order", () => {
    expect(providerNames()).toEqual(["open-router", "typesafe"]);
    expect(providerEnvVars()).toEqual(["TYPESAFE_API_KEY", "OPENROUTER_API_KEY"]);
  });
});

describe("providerFromEnv", () => {
  it("prefers Typesafe when both keys are set", async () => {
    await withEnv({ TYPESAFE_API_KEY: "t", OPENROUTER_API_KEY: "o" }, () => {
      expect(providerFromEnv()).toBeInstanceOf(TypesafeProvider);
    });
  });

  it("falls back to OpenRouter", async () => {
    await withEnv({ TYPESAFE_API_KEY: undefined, OPENROUTER_API_KEY: "o" }, () => {
      expect(providerFromEnv()).toBeInstanceOf(OpenRouterProvider);
    });
  });

  it("returns null with no keys", async () => {
    await withEnv({ TYPESAFE_API_KEY: undefined, OPENROUTER_API_KEY: undefined }, () => {
      expect(providerFromEnv()).toBeNull();
    });
  });
});

describe("custom providers", () => {
  class CustomProvider extends Provider {
    override get name() {
      return "custom";
    }
    override get envVar() {
      return "CUSTOM_API_KEY";
    }
    override get defaultBaseUrl() {
      return "https://custom.example";
    }
    override get endpointPath() {
      return "/v1/decide";
    }
    override get defaultModel() {
      return "custom-1";
    }
  }

  it("subclasses inherit defaults", () => {
    const provider = new CustomProvider({ apiKey: "k" });
    expect(provider.url).toBe("https://custom.example/v1/decide");
    expect(provider.resolveModel("anything")).toBe("anything");
    expect(provider.reportsCost).toBe(false);
    expect(provider.usage({ usage: { input_tokens: 5, cost: 1 } })).toEqual({
      inputTokens: 5,
      outputTokens: null,
      cost: null,
    });
  });
});
