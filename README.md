# node-decision-model

The decision-model interface for Node.js. Decision models answer typed
questions about a state with calibrated probabilities instead of generating
text. This package talks to them through one `Client` with a provider behind
it: OpenRouter by default, Typesafe's native API as a second door, more
providers as labs ship them. No runtime dependencies; Node 20+.

A port of [ruby_decision_model](https://github.com/obie/ruby_decision_model),
keeping its design and semantics. The main differences are idiomatic
camelCase options, durations in milliseconds, and answer types inferred from
your questions in TypeScript.

## Install

```bash
npm install node-decision-model
```

## Quick start

```ts
import { Client, noul, choice, score } from "node-decision-model";

const client = new Client();

const response = await client.ask({
  state: { title: "Server returns 500 on checkout", reporter: "support" },
  questions: {
    urgent: noul("Is this urgent?"),
    team: choice("Which team owns this?", { billing: null, auth: null, infra: null }),
    severity: score("How severe is this issue?", ["cosmetic", "minor", "major", "critical"]),
  },
});

response.answers.urgent.noul; // => 0.87
response.answers.team.choice; // => "infra"  (typed as "billing" | "auth" | "infra")
response.answers.severity.score; // => 2.4
response.usage.inputTokens; // => 120
```

`new Client()` with no arguments reads the environment: `TYPESAFE_API_KEY`
selects Typesafe, otherwise `OPENROUTER_API_KEY` selects OpenRouter. With
neither set it throws `ConfigurationError` naming both. `getDefaultClient()`
memoizes one such default client; `setDefaultClient(undefined)` resets it.

Both ESM and CommonJS are supported:

```js
const { Client, noul } = require("node-decision-model");
```

## Providers

### OpenRouter (default)

```ts
// process.env.OPENROUTER_API_KEY
const client = new Client({ provider: "open-router" });

// or pass the key directly; apiKey alone still means OpenRouter
const client = new Client({ apiKey: "sk-or-..." });
```

Requests go to `https://openrouter.ai/api/alpha/decisions`. The default model
is `typesafe/jev-1.13`. Usage reports `inputTokens`, `outputTokens`, and `cost`.

### Typesafe native API

```ts
// process.env.TYPESAFE_API_KEY
const client = new Client({ provider: "typesafe" });
```

Requests go to `https://api.typesafe.ai/v1/systemone`. The default model is
`jev-latest`. Usage reports `inputTokens` and `outputTokens`; `cost` is `null`.
Typesafe returns an `x-typesafe-request-id` header, exposed as
`response.requestId` (`null` on OpenRouter). Quote it when reporting a problem
to Typesafe.

### Options

```ts
new Client({
  provider: "typesafe", // "open-router", "typesafe", or a Provider instance
  apiKey: undefined, // overrides the provider's env var
  model: undefined, // undefined means the provider default; see aliases below
  baseUrl: undefined, // overrides the provider base URL
  timeout: 5_000, // per-attempt connect and read timeout in milliseconds
  retry: { maxRetries: 2 }, // RetryPolicy or an object of overrides
  transport: undefined, // see Transport
});

client.provider; // => TypesafeProvider
client.model; // => "jev-latest" (resolved after aliasing)
```

Both providers send `User-Agent: node-decision-model/<version>`.

### Model aliases

Each provider resolves a few friendly names to its own canonical model name.
Anything not listed passes through untouched. The `model` field on a response
is whatever the provider returned.

| You pass             | OpenRouter sends    | Typesafe sends |
| -------------------- | ------------------- | -------------- |
| `undefined`          | `typesafe/jev-1.13` | `jev-latest`   |
| `"jev"`              | `typesafe/jev-1.13` | `jev-latest`   |
| `"jev-latest"`       | `typesafe/jev-1.13` | `jev-latest`   |
| `"typesafe/jev-1.13"` | `typesafe/jev-1.13` | `jev-latest`   |
| anything else        | as given            | as given       |

### Writing a provider

Extend `Provider` and implement the `name`, `envVar`, `defaultBaseUrl`,
`endpointPath`, and `defaultModel` getters; optionally override `aliases` and
`reportsCost`. Override `headers()`, `requestBody()`, or `usage()` when the
wire format differs. Pass an instance as `provider`.

```ts
import { Provider } from "node-decision-model";

class AcmeProvider extends Provider {
  get name() { return "acme"; }
  get envVar() { return "ACME_API_KEY"; }
  get defaultBaseUrl() { return "https://api.acme.example"; }
  get endpointPath() { return "/v1/decide"; }
  get defaultModel() { return "acme-decide-1"; }
}

const client = new Client({ provider: new AcmeProvider() });
```

## Questions and answers

Three question types, built with `noul`, `choice`, and `score` (also
available together as `QuestionBuilders`):

```ts
noul("Is this spam?"); // yes/no probability
noul("Is this spam?", { true: "unsolicited bulk mail", false: "expected mail" });
choice("Which team?", { billing: "invoices and refunds", auth: "login and SSO" }); // up to 255 options
score("How severe?", ["cosmetic", "minor", "major"]); // 2 to 10 levels
```

Instructions may be a string, an object, or an array; criteria descriptions
may be `null` to leave a label undescribed. Builders throw `TypeError` for
empty instructions or criteria outside the allowed sizes.

Answers come back typed and keyed like the questions:

| Question | Answer fields                                              |
| -------- | ---------------------------------------------------------- |
| `noul`   | `noul`, `probabilities`                                    |
| `choice` | `choice`, `confidence`, `probabilities`                    |
| `score`  | `score`, `confidence`, `probabilities`, `legend`           |

Every answer also carries its `type`. `response.get(id)` reads one answer;
`response.nouls()`, `response.choices()`, and `response.scores()` return the
answers of one type keyed the same way as `response.answers`.

Score `probabilities` and `legend` are keyed by the wire's string level keys
(`"0"`, `"1"`, ...), not by the criteria labels. Choice `probabilities` sum to
approximately 1; treat them as calibrated, not normalized.

In TypeScript the answer types are inferred from the questions map, so
`response.answers.team.choice` is typed as the union of the choice's criteria
keys and unknown ids are compile errors.

## Retries

Retry behaviour follows the official Typesafe SDKs and lives in
`RetryPolicy`. Pass a policy or an object of overrides as `retry`. All
durations are milliseconds.

| Option                  | Default                     | Meaning                                                            |
| ----------------------- | --------------------------- | ------------------------------------------------------------------ |
| `maxRetries`            | `2`                         | Retries after the initial attempt                                  |
| `backoffInitial`        | `500`                       | First backoff, doubling each retry                                 |
| `backoffMax`            | `5000`                      | Backoff ceiling                                                    |
| `backoffJitter`         | `0.25`                      | Fraction of the backoff randomly subtracted                        |
| `httpStatuses`          | `[408, 429, 500..599]`      | Statuses that trigger a retry                                      |
| `respectRetryAfter`     | `true`                      | Honor `Retry-After` and `retry-after-ms`                           |
| `maxRetryAfter`         | `60000`                     | Ceiling for a server-supplied delay                                |
| `retryConnectionErrors` | `true`                      | Retry socket and connection failures                               |
| `retryTimeouts`         | `true`                      | Retry connect and read timeouts                                    |
| `totalTimeout`          | `30000`                     | Budget across attempts and delays; `null` disables                 |

When the next delay would push past `totalTimeout`, the client stops and
throws the last error instead of sleeping. The budget governs whether another
attempt starts; an attempt already in flight still runs to its own `timeout`.

Invalid settings (a negative duration, a non-integer `maxRetries`, a jitter
outside 0..1, a NaN budget) throw `ConfigurationError` when the client is built.

```ts
new Client({ retry: { maxRetries: 4, totalTimeout: 60_000 } });
new Client({ retry: new RetryPolicy({ maxRetries: 0 }) });
```

## Transport

The client uses the global `fetch` by default, with `AbortSignal.timeout` for
the per-attempt timeout. Inject `transport` with any async function that
accepts `{ url, headers, body }` and resolves with
`[status, bodyString, headersObject]`. A two-element `[status, bodyString]`
result is still accepted and treated as having no headers, which means no
`Retry-After` support and a `null` `requestId`.

```ts
const client = new Client({
  apiKey: "test",
  transport: async ({ url, headers, body }) => {
    const res = await myHttp.post(url, { headers, body });
    return [res.status, res.text, res.headers];
  },
});
```

## Errors

Every error extends `DecisionModelError`.

| Error                 | Meaning                                                                                  |
| --------------------- | ---------------------------------------------------------------------------------------- |
| `ConfigurationError`  | No provider could be resolved, missing apiKey, unknown provider, or bad `retry` value    |
| `RequestError`        | Questions map was empty                                                                  |
| `TransportError`      | Network failure after retries, carries `causeError`                                      |
| `TimeoutError`        | Timeout after retries (extends `TransportError`)                                         |
| `ApiError`            | Non-2xx response, carries `status`, `body`, and `headers`                                |
| `Unauthorized`        | 401                                                                                      |
| `PayloadTooLarge`     | 413                                                                                      |
| `UnprocessableEntity` | 422 (never retried)                                                                      |
| `RateLimited`         | 429 (retried)                                                                            |
| `Overloaded`          | 529 (retried)                                                                            |
| `InvalidResponse`     | Body wasn't JSON, wasn't an object, or an answer was malformed; carries partial `answers` |
| `MissingAnswers`      | One or more question ids came back missing or wrong-typed, carries `missing`             |

Status: 0.1.0, API may change.

## Development

```bash
npm install
npm test          # vitest, including type-level tests
npm run lint
npm run typecheck
npm run build     # ESM + CJS + .d.ts into dist/
npm run smoke     # one live request through dist/, reads .env (see .env.example)
```

## Releasing

Publishing runs through npm trusted publishing (GitHub Actions OIDC), so no
npm token is stored anywhere. To ship a version:

1. Bump `version` in `package.json` and `VERSION` in `src/version.ts`.
2. Add the version to `CHANGELOG.md`.
3. Merge to `main`. The Release workflow runs the suite, builds, and publishes
   with provenance. A version already on npm is skipped, so the workflow is
   safe to re-run.

The same workflow can be started by hand from the Actions tab or with
`gh workflow run release.yml`.

## License

MIT

## Relationship to ruby_decision_model

A port of [ruby_decision_model](https://github.com/obie/ruby_decision_model),
keeping its design and semantics. The main differences are idiomatic camelCase
options, durations in milliseconds, and answer types inferred from your
questions in TypeScript.
