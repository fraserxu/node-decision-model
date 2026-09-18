import type { HelpTopic } from "./parse.js";

export const PROGRAM = "decision-model";

const MAIN = `Usage: ${PROGRAM} <command> [options]

Ask a decision model typed questions about a state from the shell.

Commands:
  ask          Ask questions about a state and print the answers
  providers    List providers, their environment variables, and which one is configured

Options:
  -h, --help       Show this help, or the help of a command: ${PROGRAM} help ask
  -V, --version    Print the version

The provider is chosen from the environment: TYPESAFE_API_KEY selects
Typesafe, otherwise OPENROUTER_API_KEY selects OpenRouter.
`;

const ASK = `Usage: ${PROGRAM} ask [state] [options]

Ask typed questions about a state. Answers are calibrated probabilities.

State (pass one; when none is given, stdin is read if it is not a terminal):
  [state]                  The state as text. @path reads a file, @- reads stdin.
  --state <text>           The same as the positional argument.
  --json-state             Parse the state as JSON instead of sending it as text.

Questions (repeatable; at least one is required):
  --noul <id>=<instructions>                    A yes/no question.
  --choice <id>=<instructions>|<label>,...      Pick one of up to 255 labels.
  --score <id>=<instructions>|<level>,...       Place the state on 2 to 10 rubric levels.
  --questions <json>                            A questions map in the wire format,
                                                also @path or @-. Merged with the flags.

Client:
  --provider <name>        open-router or typesafe. Default: from the environment.
  --model <name>           Model name or alias. Default: the provider default.
  --base-url <url>         Override the provider base URL.
  --timeout <ms>           Per-attempt timeout in milliseconds. Default: 5000.
  --max-retries <n>        Retries after the first attempt. Default: 2.

Output:
  --json                   Print the response as JSON.
  -v, --verbose            Also print the probability of every option.
  -h, --help               Show this help.

Exit status is 0 on success, 1 when the request failed, and 2 for a usage or
configuration error.

Examples:
  ${PROGRAM} ask "Server returns 500 on checkout" \\
    --noul urgent="Is this urgent?" \\
    --choice team="Which team owns this?|billing,auth,infra" \\
    --score severity="How severe is this?|cosmetic,minor,major,critical"

  cat issue.json | ${PROGRAM} ask --json-state --questions @questions.json --json
`;

const PROVIDERS = `Usage: ${PROGRAM} providers

List the known providers with their environment variable, default model,
endpoint, and whether an API key is set, followed by the provider that
${PROGRAM} ask uses when --provider is not given.
`;

export function helpText(topic: HelpTopic): string {
  switch (topic) {
    case "ask":
      return ASK;
    case "providers":
      return PROVIDERS;
    default:
      return MAIN;
  }
}
