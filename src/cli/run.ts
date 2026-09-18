import { readFile } from "node:fs/promises";
import {
  ApiError,
  buildProvider,
  Client,
  ConfigurationError,
  DecisionModelError,
  TransportError,
  providerEnvVars,
  providerFromEnv,
  providerNames,
  VERSION,
} from "../index.js";
import type { ClientOptions, Question, Questions } from "../index.js";
import { formatHuman, formatJson, formatProviders } from "./format.js";
import { helpText, PROGRAM } from "./help.js";
import {
  mergeQuestions,
  parseArgv,
  parseQuestionSpec,
  parseQuestionsJson,
  UsageError,
} from "./parse.js";
import type { AskOptions } from "./parse.js";

export interface CliIo {
  stdout: { write(chunk: string): unknown };
  stderr: { write(chunk: string): unknown };
  stdin: {
    isTTY: boolean;
    /** Resolves with everything on stdin once it closes. */
    read(): Promise<string>;
  };
  /** Options merged into the Client; tests inject a transport here. */
  clientOptions?: ClientOptions;
}

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;

/**
 * Runs the command line with the given arguments (without the node and
 * script paths) and resolves with the exit status. Nothing here touches
 * process directly so the same code runs under test.
 */
export async function run(argv: readonly string[], io: CliIo): Promise<number> {
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
        return runProviders(io);
      case "ask":
        // Awaited here so the catch below sees rejections from the async path.
        return await runAsk(command.options, io);
    }
  } catch (error) {
    if (error instanceof UsageError || error instanceof ConfigurationError) {
      io.stderr.write(`${PROGRAM}: ${error.message}\n`);
      if (error instanceof UsageError) {
        io.stderr.write(`Run '${PROGRAM} help${argv[0] === "ask" ? " ask" : ""}' for usage.\n`);
      }
      return EXIT_USAGE;
    }
    throw error;
  }
}

function runProviders(io: CliIo): number {
  const providers = providerNames().map((name) => buildProvider(name));
  io.stdout.write(formatProviders(providers, providerFromEnv(), providerEnvVars()));
  return EXIT_OK;
}

async function runAsk(options: AskOptions, io: CliIo): Promise<number> {
  const inputs = new InputReader(io);
  const state = await resolveState(options, inputs);
  const questions = await resolveQuestions(options, inputs);
  const client = new Client(clientOptions(options, io));

  try {
    const response = await client.ask({ state, questions });
    io.stdout.write(
      options.json ? formatJson(response) : formatHuman(response, { verbose: options.verbose })
    );
    return EXIT_OK;
  } catch (error) {
    if (!(error instanceof DecisionModelError)) throw error;
    io.stderr.write(`${PROGRAM}: ${describeError(error)}\n`);
    return EXIT_FAILED;
  }
}

/** Resolves `@path` and `@-` values, letting stdin be consumed only once. */
class InputReader {
  private stdinUsed = false;

  constructor(private readonly io: CliIo) {}

  async resolve(value: string, flag: string): Promise<string> {
    if (!value.startsWith("@")) return value;
    const path = value.slice(1);
    if (path === "-") return this.stdin(flag);
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new UsageError(`${flag}: could not read ${JSON.stringify(path)}: ${message}`);
    }
  }

  async stdin(flag: string): Promise<string> {
    if (this.stdinUsed) throw new UsageError(`${flag}: stdin was already read for another input`);
    this.stdinUsed = true;
    return this.io.stdin.read();
  }

  get stdinIsTerminal(): boolean {
    return this.io.stdin.isTTY;
  }
}

async function resolveState(options: AskOptions, inputs: InputReader): Promise<unknown> {
  let text: string;
  if (options.state !== undefined) {
    text = await inputs.resolve(options.state, "state");
  } else if (!inputs.stdinIsTerminal) {
    text = await inputs.stdin("state");
  } else {
    throw new UsageError("a state is required: pass it as an argument, with --state, or on stdin");
  }

  if (!options.jsonState) return text;
  try {
    return JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new UsageError(`--json-state: the state is not valid JSON: ${message}`);
  }
}

async function resolveQuestions(options: AskOptions, inputs: InputReader): Promise<Questions> {
  const sources: [string, Question][] = [
    ...options.noul.map((spec) => parseQuestionSpec("noul", spec)),
    ...options.choice.map((spec) => parseQuestionSpec("choice", spec)),
    ...options.score.map((spec) => parseQuestionSpec("score", spec)),
  ];
  if (options.questions !== undefined) {
    const json = parseQuestionsJson(await inputs.resolve(options.questions, "--questions"));
    sources.push(...Object.entries(json));
  }
  if (sources.length === 0) {
    throw new UsageError("at least one question is required: --noul, --choice, --score, or --questions");
  }
  return mergeQuestions(sources);
}

function clientOptions(options: AskOptions, io: CliIo): ClientOptions {
  const result: ClientOptions = { ...io.clientOptions };
  if (options.provider !== undefined) result.provider = buildProvider(options.provider);
  if (options.model !== undefined) result.model = options.model;
  if (options.baseUrl !== undefined) result.baseUrl = options.baseUrl;
  if (options.timeout !== undefined) result.timeout = options.timeout;
  if (options.maxRetries !== undefined) result.retry = { maxRetries: options.maxRetries };
  return result;
}

const BODY_PREVIEW_LENGTH = 500;

function describeError(error: DecisionModelError): string {
  if (error instanceof TransportError) {
    // Node's fetch reports every network failure as "fetch failed" and keeps
    // the useful part (ECONNREFUSED, ENOTFOUND, ...) on the cause chain.
    const cause = rootCause(error.causeError);
    return cause === null ? `${error.name}: ${error.message}` : `${error.name}: ${error.message} (${cause})`;
  }
  if (!(error instanceof ApiError)) return `${error.name}: ${error.message}`;

  const body = error.body?.trim() ?? "";
  if (body === "") return `${error.name} (status ${error.status}): ${error.message}`;
  const preview =
    body.length > BODY_PREVIEW_LENGTH ? `${body.slice(0, BODY_PREVIEW_LENGTH)}…` : body;
  return `${error.name} (status ${error.status}): ${error.message}\n${preview}`;
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
