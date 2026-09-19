import { readFile } from "node:fs/promises";
import {
  ApiError,
  buildProvider,
  Client,
  ConfigurationError,
  DecisionModelError,
  InvalidResponse,
  RetryPolicy,
  TransportError,
  providerEnvVars,
  providerFromEnv,
  providerNames,
  VERSION,
} from "../index.js";
import type { ClientOptions, Provider, Question, Questions } from "../index.js";
import { colorEnabled, createStyle } from "./color.js";
import type { Style } from "./color.js";
import {
  formatDryRun,
  formatHuman,
  formatJson,
  formatProviders,
  formatQuiet,
  isYes,
} from "./format.js";
import { helpText, PROGRAM } from "./help.js";
import {
  build,
  DEFAULT_THRESHOLD,
  mergeQuestions,
  parseArgv,
  parseInputJson,
  parseQuestionSpec,
  parseQuestionsJson,
  UsageError,
} from "./parse.js";
import type { AskOptions, CommonOptions, SingleOptions } from "./parse.js";
import { choice, noul, score } from "../index.js";

export interface CliIo {
  stdout: { write(chunk: string): unknown; isTTY?: boolean };
  stderr: { write(chunk: string): unknown };
  stdin: {
    /** True when data is arriving on stdin: a pipe or a redirected file. */
    piped: boolean;
    /** Resolves with everything on stdin once it closes. */
    read(): Promise<string>;
  };
  /** Defaults to process.env; read for NO_COLOR and FORCE_COLOR. */
  env?: NodeJS.ProcessEnv;
  /** Monotonic milliseconds, for the elapsed time in the output. */
  now?: () => number;
  /** Options merged into the Client; tests inject a transport here. */
  clientOptions?: ClientOptions;
}

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;
/** With --check, 1 means "no", so a failed request needs its own code. */
const EXIT_CHECK_FAILED = 3;

/** The id single-question commands use, so --json has the same shape as ask. */
const SINGLE_ID = "answer";

/**
 * Runs the command line with the given arguments (without the node and
 * script paths) and resolves with the exit status. Nothing here touches
 * process directly so the same code runs under test.
 */
export async function run(argv: readonly string[], io: CliIo): Promise<number> {
  // Usage errors happen before the flags are known, so look for --json here.
  const json = argv.includes("--json");
  try {
    const command = parseArgv(argv);
    switch (command.kind) {
      case "help":
        (command.exitCode === EXIT_OK ? io.stdout : io.stderr).write(helpText(command.topic));
        return command.exitCode;
      case "version":
        io.stdout.write(`${VERSION}\n`);
        return EXIT_OK;
      case "providers":
        return runProviders(command.verbose, io);
      case "ask":
        // Awaited here so the catch below sees rejections from the async path.
        return await runAsk(command.options, io);
      case "single":
        return await runSingle(command.options, io);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      report(io, json, { type: error.name, message: error.message, hints: [...error.hints, ...usageHint(argv)] });
      return EXIT_USAGE;
    }
    if (error instanceof ConfigurationError) {
      report(io, json, { type: error.name, message: error.message });
      return EXIT_USAGE;
    }
    throw error;
  }
}

function usageHint(argv: readonly string[]): string[] {
  const command = argv[0];
  const topic = command === "ask" || command === "yesno" || command === "choose" || command === "score" ? ` ${command}` : "";
  return [`Run '${PROGRAM} help${topic}' for usage.`];
}

function runProviders(verbose: boolean, io: CliIo): number {
  const providers = providerNames().map((name) => buildProvider(name));
  const style = styleFor(io, false);
  io.stdout.write(formatProviders(providers, providerFromEnv(), providerEnvVars(), { verbose, style }));
  return EXIT_OK;
}

async function runAsk(options: AskOptions, io: CliIo): Promise<number> {
  const inputs = new InputReader(io);
  let state: unknown;
  let questions: Questions;
  if (options.input !== undefined) {
    ({ state, questions } = parseInputJson(await inputs.pathOrStdin(options.input, "--input")));
  } else {
    state = await resolveState(options, options.positionalState, inputs);
    questions = await resolveAskQuestions(options, inputs);
  }
  return perform({ state, questions }, options, io, { showIds: true, threshold: DEFAULT_THRESHOLD, check: false });
}

async function runSingle(options: SingleOptions, io: CliIo): Promise<number> {
  const inputs = new InputReader(io);
  const state = await resolveState(options, undefined, inputs);
  const questions: Questions = { [SINGLE_ID]: singleQuestion(options) };
  return perform({ state, questions }, options, io, {
    showIds: false,
    threshold: options.threshold,
    check: options.check,
  });
}

function singleQuestion(options: SingleOptions): Question {
  switch (options.verb) {
    case "yesno":
      return build(SINGLE_ID, () => noul(options.question));
    case "choose":
      return build(SINGLE_ID, () =>
        choice(options.question, Object.fromEntries(options.labels.map((label) => [label, null])))
      );
    case "score":
      return build(SINGLE_ID, () => score(options.question, options.labels));
  }
}

interface Presentation {
  showIds: boolean;
  threshold: number;
  check: boolean;
}

async function perform(
  request: { state: unknown; questions: Questions },
  options: CommonOptions,
  io: CliIo,
  presentation: Presentation
): Promise<number> {
  if (options.dryRun) {
    const provider = providerForDryRun(options);
    io.stdout.write(
      formatDryRun({ provider, model: provider.resolveModel(options.model), ...request })
    );
    return EXIT_OK;
  }

  const client = new Client(clientOptions(options, io));
  const now = io.now ?? (() => performance.now());
  const started = now();
  try {
    const response = await client.ask(request);
    const elapsedMs = Math.round(now() - started);
    const provider = client.provider.name;

    if (options.json) {
      io.stdout.write(formatJson(response, { provider, elapsedMs }));
    } else if (presentation.check) {
      // Nothing: the exit status is the answer.
    } else if (options.quiet) {
      io.stdout.write(formatQuiet(response, presentation));
    } else {
      io.stdout.write(
        formatHuman(response, {
          style: styleFor(io, options.noColor),
          verbose: options.verbose,
          showIds: presentation.showIds,
          threshold: presentation.threshold,
          provider,
          elapsedMs,
        })
      );
    }

    if (!presentation.check) return EXIT_OK;
    const answer = response.answers[SINGLE_ID];
    return answer !== undefined && answer.type === "noul" && isYes(answer, presentation.threshold)
      ? EXIT_OK
      : EXIT_FAILED;
  } catch (error) {
    if (!(error instanceof DecisionModelError)) throw error;
    report(io, options.json, describeFailure(error, client.retryPolicy));
    return presentation.check ? EXIT_CHECK_FAILED : EXIT_FAILED;
  }
}

function styleFor(io: CliIo, noColor: boolean): Style {
  return createStyle(
    colorEnabled({ isTTY: io.stdout.isTTY === true, env: io.env ?? process.env, disabled: noColor })
  );
}

/** Resolves paths and `-`, letting stdin be consumed only once. */
class InputReader {
  private stdinUsed = false;

  constructor(private readonly io: CliIo) {}

  /** `-` reads stdin; anything else is a path. A leading `@` is stripped for compatibility. */
  async pathOrStdin(value: string, flag: string): Promise<string> {
    const target = value.startsWith("@") ? value.slice(1) : value;
    if (target === "-") return this.stdin(flag);
    try {
      return await readFile(target, "utf8");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new UsageError(`${flag}: could not read ${JSON.stringify(target)}: ${message}`);
    }
  }

  async stdin(flag: string): Promise<string> {
    if (this.stdinUsed) throw new UsageError(`${flag}: stdin was already read for another input`);
    this.stdinUsed = true;
    return this.io.stdin.read();
  }

  get stdinIsPiped(): boolean {
    return this.io.stdin.piped;
  }
}

/**
 * The state comes from `-s`, the positional (ask only), `-f`, or piped
 * stdin, in that order. With none of those the state is empty, which the
 * API accepts: the model answers from its priors. A positional
 * `@path` or `@-` means `-f` for compatibility with 0.2.
 */
async function resolveState(
  options: CommonOptions,
  positional: string | undefined,
  inputs: InputReader
): Promise<unknown> {
  let text: string;
  let parseJson = options.jsonState;
  const file = options.file ?? (positional?.startsWith("@") ? positional.slice(1) : undefined);
  const inline = options.state ?? (positional?.startsWith("@") ? undefined : positional);

  if (inline !== undefined) {
    text = inline;
  } else if (file !== undefined) {
    text = await inputs.pathOrStdin(file, "--file");
    parseJson ||= file !== "-" && file.toLowerCase().endsWith(".json");
  } else if (inputs.stdinIsPiped) {
    text = await inputs.stdin("state");
  } else {
    text = "";
  }

  if (!parseJson) return text;
  try {
    return JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const source = options.jsonState ? "--json-state" : `--file ${file}`;
    throw new UsageError(`${source}: the state is not valid JSON: ${message}`);
  }
}

async function resolveAskQuestions(options: AskOptions, inputs: InputReader): Promise<Questions> {
  const sources: [string, Question][] = [
    ...options.noul.map((spec) => parseQuestionSpec("noul", spec)),
    ...options.choice.map((spec) => parseQuestionSpec("choice", spec)),
    ...options.score.map((spec) => parseQuestionSpec("score", spec)),
  ];
  if (options.questions !== undefined) {
    const value = options.questions;
    const text = value.trimStart().startsWith("{")
      ? value
      : await inputs.pathOrStdin(value, "--questions");
    sources.push(...Object.entries(parseQuestionsJson(text)));
  }
  if (sources.length === 0) {
    throw new UsageError("at least one question is required", [
      "Add --noul, --choice, --score, --questions, or --input.",
      'For one question without flags: decision-model yesno "Is this urgent?" -f issue.json',
    ]);
  }
  return mergeQuestions(sources);
}

/** Builds the Client options, turning missing keys into errors that name the fix. */
function clientOptions(options: CommonOptions, io: CliIo): ClientOptions {
  const result: ClientOptions = { ...io.clientOptions };
  if (options.provider !== undefined) {
    const provider = namedProvider(options.provider);
    if (!provider.hasApiKey() && result.apiKey === undefined) {
      throw new UsageError(`no API key for ${provider.name}`, [
        `Set ${provider.envVar} in the environment.`,
        `Run '${PROGRAM} providers' to see what is set.`,
      ]);
    }
    result.provider = provider;
  } else if (result.apiKey === undefined && providerFromEnv() === null) {
    throw new UsageError("no API key found", [
      `Set ${providerEnvVars().join(" or ")}, or pass --provider with its key in the environment.`,
      `Run '${PROGRAM} providers' to see what is set.`,
    ]);
  }
  if (options.model !== undefined) result.model = options.model;
  if (options.baseUrl !== undefined) result.baseUrl = options.baseUrl;
  if (options.timeout !== undefined) result.timeout = options.timeout;
  if (options.maxRetries !== undefined) result.retry = { maxRetries: options.maxRetries };
  return result;
}

function namedProvider(name: string): Provider {
  try {
    return buildProvider(name);
  } catch (error) {
    if (!(error instanceof ConfigurationError)) throw error;
    throw new UsageError(error.message, [`Run '${PROGRAM} providers' to list them.`]);
  }
}

/** A dry run needs no key, so it never goes through the Client constructor. */
function providerForDryRun(options: CommonOptions): Provider {
  const provider =
    options.provider !== undefined
      ? namedProvider(options.provider)
      : (providerFromEnv() ?? buildProvider("open-router"));
  return options.baseUrl === undefined ? provider : provider.configure({ baseUrl: options.baseUrl });
}

interface Failure {
  type: string;
  message: string;
  hints?: string[];
  status?: number;
  requestId?: string | null;
  retryable?: boolean;
  /** Extra lines for the human form only, e.g. a response body preview. */
  body?: string | undefined;
}

const BODY_PREVIEW_LENGTH = 500;
const REQUEST_ID_HEADER = "x-typesafe-request-id";

function describeFailure(error: DecisionModelError, policy: RetryPolicy): Failure {
  if (error instanceof ApiError) {
    const body = error.body?.trim() ?? "";
    const requestId = Object.entries(error.headers).find(
      ([key]) => key.toLowerCase() === REQUEST_ID_HEADER
    )?.[1];
    // The generic ApiError message already carries its status.
    const message = error.message.includes("(status")
      ? error.message
      : `${error.message} (status ${error.status})`;
    return {
      type: error.name,
      message,
      status: error.status,
      requestId: requestId ?? null,
      retryable: policy.retryableStatus(error.status),
      body: body === "" ? undefined : body.length > BODY_PREVIEW_LENGTH ? `${body.slice(0, BODY_PREVIEW_LENGTH)}…` : body,
    };
  }
  if (error instanceof TransportError) {
    // Node's fetch reports every network failure as "fetch failed" and keeps
    // the useful part (ECONNREFUSED, ENOTFOUND, ...) on the cause chain.
    const cause = rootCause(error.causeError);
    return {
      type: error.name,
      message: cause === null ? error.message : `${error.message} (${cause})`,
      retryable: true,
    };
  }
  return { type: error.name, message: error.message, retryable: error instanceof InvalidResponse };
}

/** Prints a failure as `program: message` plus hints, or as one JSON line. */
function report(io: CliIo, json: boolean, failure: Failure): void {
  if (json) {
    const { type, message, status, requestId, retryable } = failure;
    io.stderr.write(
      `${JSON.stringify({ error: compact({ type, message, status, requestId, retryable: retryable ?? false }) })}\n`
    );
    return;
  }
  const lines = [`${PROGRAM}: ${failure.message}`];
  if (failure.body !== undefined) lines.push(failure.body);
  for (const hint of failure.hints ?? []) lines.push(`  ${hint}`);
  io.stderr.write(`${lines.join("\n")}\n`);
}

function compact<T extends Record<string, unknown>>(record: T): Partial<T> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as Partial<T>;
}

/** The code or message of the innermost error on the cause chain, if it adds anything. */
function rootCause(error: unknown): string | null {
  let current = error;
  let deepest: unknown = null;
  while (current instanceof Error) {
    deepest = current;
    current = current.cause;
  }
  if (!(deepest instanceof Error) || deepest === error) return null;
  const code = (deepest as { code?: unknown }).code;
  return typeof code === "string" ? code : deepest.message;
}
