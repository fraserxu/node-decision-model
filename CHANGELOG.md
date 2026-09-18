# Changelog

## 0.3.0

A friendlier command line. The library is unchanged.

- Add `yesno`, `choose`, and `score` commands for one question. The question is the first argument and the labels follow it, so nothing needs quoting beyond the question text and labels may contain spaces.
- Answers read as answers: `yes 96%`, `billing 66%  infra 33% · auth 1%`, `critical 99%  2.99 on a 0–3 scale`. Percentages replace three-decimal probabilities, a score shows the level it landed on, and the type column is gone. `-v` prints every option's probability with bars in a terminal.
- State comes from `-s <text>`, `-f <path>` (a `.json` file is parsed), `-f -`, or piped stdin. The `ask` positional and `@path`/`@-` still work but are no longer documented.
- Scripting: `-q` prints only the answer; `yesno --check` exits 0 for yes and 1 for no with `--threshold` to move the cut; `--json` gains `provider` and `elapsedMs`.
- Agent callers: `ask --input <file|->` takes one `{ state, questions }` document; under `--json` a failure is one JSON line on stderr with `type`, `message`, `status`, `requestId`, and `retryable`; `--dry-run` prints the request without sending it and needs no key; `help all` prints every command, option, and format on one screen.
- `--questions` accepts a path, inline JSON, or `-` without the `@` prefix.
- Errors say what to type: a missing key names the environment variables and `decision-model providers`; a malformed `--choice` shows an example and the verb form; an unknown command suggests the closest one.
- Colour when stdout is a terminal, honouring `NO_COLOR`, `FORCE_COLOR`, and `--no-color`. `providers` marks the active row and shows endpoints with `-v`.
- Breaking: the human output columns changed. Programs should read `--json`, whose answer shape is unchanged. Under `--json`, errors are now JSON rather than prose.

## 0.2.0

- Add a `decision-model` command line: `ask` sends a state and `--noul`, `--choice`, `--score`, or `--questions` to a decision model and prints a table or `--json`; `providers` lists providers and which one the environment selects. Built on Node's `parseArgs`, so the package still has no runtime dependencies.
- README: add an at-a-glance table, document the CLI state and question forms, the `--questions` wire format, the `--json` output shape, and exit codes; drop the `ruby_decision_model` sections.
- Write the `bin` path as `dist/cli.js`, the form npm normalizes to, so `npm publish` no longer warns that it auto-corrected `package.json`.

## 0.1.1

- README: document the relationship to `ruby_decision_model` and what differs in the port.

## 0.1.0

Initial release. A Node.js port of [ruby_decision_model](https://github.com/obie/ruby_decision_model).

- `Client` with pluggable providers: OpenRouter (default) and Typesafe's native API.
- `noul`, `choice`, and `score` question builders with answer types inferred from the questions map.
- Retry policy matching the official Typesafe SDKs: exponential backoff with jitter, `Retry-After` support, and a total time budget.
- Typed error hierarchy: `ConfigurationError`, `RequestError`, `TransportError`, `TimeoutError`, `ApiError` and its status subclasses, `InvalidResponse`, `MissingAnswers`.
- Zero runtime dependencies; ESM and CommonJS builds with TypeScript declarations.
