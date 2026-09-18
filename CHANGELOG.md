# Changelog

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
