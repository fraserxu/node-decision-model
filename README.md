# node-decision-model

The decision-model interface for Node.js. Decision models answer typed
questions about a state with calibrated probabilities instead of generating
text. This package talks to them through one `Client` with a provider behind
it: OpenRouter by default, Typesafe's native API as a second door, more
providers as labs ship them. No runtime dependencies; Node 20+.

## At a glance

|                     |                                                                                           |
| ------------------- | ----------------------------------------------------------------------------------------- |
| Install             | `npm install node-decision-model`                                                         |
| Auth                | `TYPESAFE_API_KEY` or `OPENROUTER_API_KEY` in the environment                             |
| Library entry point | `new Client().ask({ state, questions })`                                                  |
| CLI entry point     | `npx decision-model yesno "Is this urgent?" -f issue.json`                                |
| Question types      | `noul` (yes/no), `choice` (pick one of up to 255 labels), `score` (2 to 10 rubric levels) |
| Answers             | Calibrated probabilities, keyed by the question ids you passed                            |
| Module formats      | ESM and CommonJS, with TypeScript types                                                   |
| Status              | Pre-1.0. The API may change between minor versions.                                       |

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
    team: choice("Which team owns this?", {
      billing: null,
      auth: null,
      infra: null,
    }),
    severity: score("How severe is this issue?", [
      "cosmetic",
      "minor",
      "major",
      "critical",
    ]),
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

CommonJS works the same way:

```js
const { Client, noul } = require("node-decision-model");
```

## Command line

The package installs a `decision-model` executable. It reads the same
environment variables as `new Client()` and is the quickest way to ask a
question from a shell, a script, or an agent tool call.

One question is a verb. The question is the first argument and the labels
follow it, so nothing needs quoting beyond the question text:

```bash
cat issue.json | npx decision-model yesno "Is this urgent?"
npx decision-model choose "Which team owns this?" billing auth infra -f issue.json
npx decision-model score "How severe is this?" cosmetic minor major critical -s "500 on checkout"
```

```
yes  96%
jev-1.13.0 · 300 in / 20 out tokens · 0.8s · req_01a0b6e2

billing  66%  infra 33% · auth 1%
jev-1.13.0 · 329 in / 38 out tokens · 1.0s · req_01a0b6e2

critical  89%  2.89 on a 0–3 scale · major 11%
jev-1.13.0 · 320 in / 33 out tokens · 1.1s · req_01a0b6e2
```

Several questions at once go through `ask`, where each question has an id
that names its answer:

```bash
npx decision-model ask -f issue.json \
  --noul urgent="Is this urgent?" \
  --choice team="Which team owns this?|billing,auth,infra" \
  --score severity="How severe is this?|cosmetic,minor,major,critical"
```

```
urgent    yes       96%
team      billing   74%  infra 25% · auth 1%
severity  critical  99%  2.99 on a 0–3 scale
jev-1.13.0 · 384 in / 68 out tokens · 0.9s · req_01a0b6e2
```

Every answer line reads the same way: the answer, its probability, then
detail. A yes/no answer is `yes` or `no`, split at 0.5 unless `--threshold`
moves the cut. A choice shows the chosen label and the runners-up. A score
shows the level nearest the numeric score, with the score itself in the
detail. `-v` adds every option's probability under each answer, with bars
when stdout is a terminal.

### Passing the state

| Form                 | Meaning                                                  |
| -------------------- | -------------------------------------------------------- |
| `-s, --state <text>` | Sent as text. `ask` also takes it as its first argument  |
| `-f, --file <path>`  | Read from a file. A `.json` file is parsed as JSON       |
| `-f -`               | Read from stdin                                          |
| `--json-state`       | Parse the state as JSON wherever it came from            |
| nothing              | stdin is read when it is piped                           |

The state is optional. With none at all, the question is asked about an
empty state and the model answers from what it already knows, so a
general-knowledge question needs nothing but the question:

```bash
decision-model choose "The toilet paper roll goes:" over under
```

```
over  75%  under 25%
```

Stdin is read only when it is a pipe or a redirected file, so the command
never waits for input at a terminal or in a shell that leaves stdin open
without writing to it. A state larger than about 100 KB must come from a
file or stdin; the operating system caps a single argument.

### Passing questions to `ask`

Flags are repeatable and at least one question is required.

| Flag                                          | Shape                      | Asks                                          |
| --------------------------------------------- | -------------------------- | --------------------------------------------- |
| `--noul id="instructions"`                    | one string                 | A yes/no question                             |
| `--choice id="instructions\|label,label,..."` | last `\|` separates labels | Pick one label                                |
| `--score id="instructions\|level,level,..."`  | last `\|` separates levels | Place the state on an ordered rubric          |
| `--questions <file\|json\|->`                 | wire-format map            | Any question, including criteria descriptions |
| `--input <file\|->`                           | `{ state, questions }`     | A whole request in one document               |

`--questions` takes a path, inline JSON (anything starting with `{`), or `-`
for stdin, and is merged with the flags. Use it when a label needs a
description or the instructions are not a plain string. The wire format is:

```json
{
  "urgent": { "type": "noul", "instructions": "Is this urgent?" },
  "team": {
    "type": "choice",
    "instructions": "Which team owns this?",
    "criteria": {
      "billing": "invoices and refunds",
      "auth": "login and SSO",
      "infra": null
    }
  },
  "severity": {
    "type": "score",
    "instructions": "How severe is this?",
    "criteria": ["cosmetic", "minor", "major", "critical"]
  }
}
```

`--input` carries the state and the questions together and cannot be
combined with any other input. It is the form to use from a program or an
agent: one JSON document in, one out, and nothing to quote.

```bash
decision-model ask --input - --json <<'EOF'
{ "state": { "title": "500 on checkout" },
  "questions": { "urgent": { "type": "noul", "instructions": "Is this urgent?" } } }
EOF
```

### Scripting

`-q` prints only the answer: `yes` or `no`, the label, or the level. With
`ask`, each line is the id, a tab, and the answer.

`yesno --check` prints nothing and answers with the exit status, like
`grep -q`: 0 for yes, 1 for no, 2 for a usage error, and 3 when the request
failed.

```bash
decision-model yesno --check "Is this spam?" -s "$body" || deliver "$body"
team=$(decision-model choose -q "Which team?" billing auth infra -f issue.json)
```

`--json` prints the response for `jq` or a program. The answers keep the
shape the library returns; the single-question commands use the id `answer`.

```json
{
  "provider": "typesafe",
  "model": "jev-1.13.0",
  "id": null,
  "requestId": "req_01a0b6e2ca017972bbd20352d6b866bd",
  "elapsedMs": 827,
  "usage": { "inputTokens": 281, "outputTokens": 20, "cost": null },
  "answers": {
    "urgent": { "type": "noul", "noul": 0.96, "probabilities": {} },
    "team": {
      "type": "choice",
      "choice": "billing",
      "confidence": 0.74,
      "probabilities": { "billing": 0.74, "auth": 0.01, "infra": 0.25 }
    },
    "severity": {
      "type": "score",
      "score": 2.99,
      "confidence": 0.99,
      "probabilities": { "0": 0, "1": 0, "2": 0.01, "3": 0.99 },
      "legend": { "0": "cosmetic", "1": "minor", "2": "major", "3": "critical" }
    }
  }
}
```

Under `--json` a failure is one JSON line on stderr, and the exit code is
unchanged:

```json
{ "error": { "type": "Unauthorized", "message": "unauthorized (status 401)", "status": 401, "requestId": "req_…", "retryable": false } }
```

`--dry-run` validates everything, prints the request that would be sent,
and exits without calling the API. It needs no API key, so a program can
check the shape of its questions for free.

### Every flag

| Flag                | Meaning                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------- |
| `-q, --quiet`       | Print only the answer                                                                       |
| `-v, --verbose`     | Print every option's probability, with bars in a terminal                                   |
| `--json`            | Print the response as JSON; a failure becomes a JSON error on stderr                        |
| `--dry-run`         | Print the request and exit without sending it                                               |
| `--no-color`        | Plain text even in a terminal. `NO_COLOR` does the same; `FORCE_COLOR` forces colour        |
| `--threshold <p>`   | `yesno` only: where yes becomes no. Default 0.5                                             |
| `--check`           | `yesno` only: print nothing; exit 0 for yes and 1 for no                                    |
| `--provider <name>` | `open-router` or `typesafe`. Default: from the environment                                  |
| `--model <name>`    | Model name or alias. Default: the provider default                                          |
| `--base-url <url>`  | Override the provider base URL                                                              |
| `--timeout <ms>`    | Per-attempt timeout in milliseconds. Default: 5000                                          |
| `--max-retries <n>` | Retries after the first attempt. Default: 2                                                 |

Colour and bars appear only when stdout is a terminal, so piped output and
logs stay plain. Nothing ever prompts.

Other commands:

```bash
decision-model providers      # list providers; the active one is marked
decision-model providers -v   # also show each endpoint URL
decision-model help all       # every command, option, and format on one screen
decision-model --version
```

Exit status:

| Code | Meaning                                                                     |
| ---- | --------------------------------------------------------------------------- |
| 0    | Success. With `--check`: the answer is yes                                  |
| 1    | The request failed; the error is on stderr. With `--check`: the answer is no |
| 2    | Usage or configuration error                                                |
| 3    | With `--check` only: the request failed                                     |

## Questions and answers

Three question types, built with `noul`, `choice`, and `score` (also
available together as `QuestionBuilders`):

```ts
noul("Is this spam?"); // yes/no probability
noul("Is this spam?", {
  true: "unsolicited bulk mail",
  false: "expected mail",
});
choice("Which team?", {
  billing: "invoices and refunds",
  auth: "login and SSO",
}); // up to 255 options
score("How severe?", ["cosmetic", "minor", "major"]); // 2 to 10 levels
```

Pick the type by the shape of the answer you need:

- **`noul`** when the answer is yes or no. You get the probability of yes.
- **`choice`** when exactly one of a fixed set of labels applies. You get the
  chosen label and a probability per label.
- **`score`** when the answer sits on an ordered scale. You get an expected
  score that may fall between levels, plus a probability per level.

Instructions may be a string, an object, or an array; criteria descriptions
may be `null` to leave a label undescribed. Builders throw `TypeError` for
empty instructions or criteria outside the allowed sizes.

Answers come back typed and keyed like the questions:

| Question | Answer fields                                    |
| -------- | ------------------------------------------------ |
| `noul`   | `noul`, `probabilities`                          |
| `choice` | `choice`, `confidence`, `probabilities`          |
| `score`  | `score`, `confidence`, `probabilities`, `legend` |

Every answer also carries its `type`. `response.get(id)` reads one answer;
`response.nouls()`, `response.choices()`, and `response.scores()` return the
answers of one type keyed the same way as `response.answers`.

Score `probabilities` and `legend` are keyed by the wire's string level keys
(`"0"`, `"1"`, ...), not by the criteria labels. Choice `probabilities` sum to
approximately 1; treat them as calibrated, not normalized.

In TypeScript the answer types are inferred from the questions map, so
`response.answers.team.choice` is typed as the union of the choice's criteria
keys and unknown ids are compile errors.

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

| You pass              | OpenRouter sends    | Typesafe sends |
| --------------------- | ------------------- | -------------- |
| `undefined`           | `typesafe/jev-1.13` | `jev-latest`   |
| `"jev"`               | `typesafe/jev-1.13` | `jev-latest`   |
| `"jev-latest"`        | `typesafe/jev-1.13` | `jev-latest`   |
| `"typesafe/jev-1.13"` | `typesafe/jev-1.13` | `jev-latest`   |
| anything else         | as given            | as given       |

### Writing a provider

Extend `Provider` and implement the `name`, `envVar`, `defaultBaseUrl`,
`endpointPath`, and `defaultModel` getters; optionally override `aliases` and
`reportsCost`. Override `headers()`, `requestBody()`, or `usage()` when the
wire format differs. Pass an instance as `provider`.

```ts
import { Provider } from "node-decision-model";

class AcmeProvider extends Provider {
  get name() {
    return "acme";
  }
  get envVar() {
    return "ACME_API_KEY";
  }
  get defaultBaseUrl() {
    return "https://api.acme.example";
  }
  get endpointPath() {
    return "/v1/decide";
  }
  get defaultModel() {
    return "acme-decide-1";
  }
}

const client = new Client({ provider: new AcmeProvider() });
```

## Retries

Retry behaviour follows the official Typesafe SDKs and lives in
`RetryPolicy`. Pass a policy or an object of overrides as `retry`. All
durations are milliseconds.

| Option                  | Default                | Meaning                                            |
| ----------------------- | ---------------------- | -------------------------------------------------- |
| `maxRetries`            | `2`                    | Retries after the initial attempt                  |
| `backoffInitial`        | `500`                  | First backoff, doubling each retry                 |
| `backoffMax`            | `5000`                 | Backoff ceiling                                    |
| `backoffJitter`         | `0.25`                 | Fraction of the backoff randomly subtracted        |
| `httpStatuses`          | `[408, 429, 500..599]` | Statuses that trigger a retry                      |
| `respectRetryAfter`     | `true`                 | Honor `Retry-After` and `retry-after-ms`           |
| `maxRetryAfter`         | `60000`                | Ceiling for a server-supplied delay                |
| `retryConnectionErrors` | `true`                 | Retry socket and connection failures               |
| `retryTimeouts`         | `true`                 | Retry connect and read timeouts                    |
| `totalTimeout`          | `30000`                | Budget across attempts and delays; `null` disables |

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

Every error extends `DecisionModelError`, so one `instanceof` check catches
them all. Catch the specific classes when you need to branch.

| Error                 | Meaning                                                                                   |
| --------------------- | ----------------------------------------------------------------------------------------- |
| `ConfigurationError`  | No provider could be resolved, missing apiKey, unknown provider, or bad `retry` value     |
| `RequestError`        | Questions map was empty                                                                   |
| `TransportError`      | Network failure after retries, carries `causeError`                                       |
| `TimeoutError`        | Timeout after retries (extends `TransportError`)                                          |
| `ApiError`            | Non-2xx response, carries `status`, `body`, and `headers`                                 |
| `Unauthorized`        | 401                                                                                       |
| `PayloadTooLarge`     | 413                                                                                       |
| `UnprocessableEntity` | 422 (never retried)                                                                       |
| `RateLimited`         | 429 (retried)                                                                             |
| `Overloaded`          | 529 (retried)                                                                             |
| `InvalidResponse`     | Body wasn't JSON, wasn't an object, or an answer was malformed; carries partial `answers` |
| `MissingAnswers`      | One or more question ids came back missing or wrong-typed, carries `missing`              |

## Development

```bash
npm install
npm test          # vitest, including type-level tests
npm run lint
npm run typecheck
npm run build     # ESM + CJS + .d.ts into dist/, plus the dist/cli.js executable
npm run smoke     # one live request through dist/, reads .env (see .env.example)
node dist/cli.js providers   # try the CLI from a checkout after building
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
