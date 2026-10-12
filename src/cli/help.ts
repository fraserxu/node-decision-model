import type { HelpTopic } from "./parse.js";

export const PROGRAM = "decision-model";

const MAIN = `Usage: ${PROGRAM} <command> [options]

Ask a decision model typed questions about a state from the shell.

Commands:
  yesno  "<question>"                 A yes/no question
  choose "<question>" <label>...      Pick one of the labels
  score  "<question>" <level>...      Place the state on 2 to 10 ordered levels
  ask                                 Several questions at once, or a questions file
  providers                           List providers and which one is configured
  help [command | all]                Help for a command; 'help all' prints everything

The state comes from -s <text>, -f <path>, or stdin when it is piped. It is
optional: with none, the model answers from what it already knows.
Cloudflare Clef and Celeris also read a local photo: --image photo.jpg
Clef-omni (--model clef-omni) also listens and watches: --audio clip.wav --video clip.mp4
Celeris (--provider celeris) also says why, one sentence per answer: --explain

Examples:
  ${PROGRAM} choose "The toilet paper roll goes:" over under
  cat issue.json | ${PROGRAM} yesno "Is this urgent?"
  ${PROGRAM} choose "Which team owns this?" billing auth infra -f issue.json
  ${PROGRAM} score "How severe is this?" cosmetic minor major critical -s "500 on checkout"

Options:
  -h, --help       Show this help
  -V, --version    Print the version

The provider is chosen from the environment: TYPESAFE_API_KEY selects
Typesafe, otherwise OPENROUTER_API_KEY selects OpenRouter, otherwise
CLOUDFLARE_AUTH_TOKEN with CLOUDFLARE_ACCOUNT_ID selects Cloudflare Clef,
otherwise CELERIS_API_KEY selects Celeris.
`;

const COMMON = `
State (optional; when none is given, stdin is read if it is piped):
  -s, --state <text>       The state as text
  -f, --file <path>        Read the state from a file, or from stdin with "-".
                           A .json file is parsed as JSON.
      --json-state         Parse the state as JSON wherever it came from
  With no state at all the question is asked about an empty state and the
  model answers from what it already knows.
  A state over about 100 KB must come from -f or stdin; the OS caps one argument.

Images (Cloudflare Clef models and Celeris; repeatable):
  -i, --image <path>       A local image file, placed before the state. Remote
                           URLs are not accepted.
                           Clef: PNG, JPEG, or WebP; up to 4; 4 MiB and 16 megapixels
                           each, 8 MiB total, 13 MiB for the whole request body
                           on clef and clef-flash.
                           Celeris: PNG or JPEG; up to 8; 25 megapixels each, 8 MiB
                           for the whole request body. Each image is named by
                           its file stem (photo.jpg is "photo"; _2, _3 on a repeat).

Audio and video (Cloudflare Clef-omni only, --model clef-omni; repeatable):
      --audio <path>       A local WAV or MP3 file. Up to 4, each 8 MiB and
                           300 seconds.
      --video <path>       A local MP4 or WebM file. Up to 2, each 16 MiB and
                           60 seconds, sampled at 2 frames per second.
  Audio and video together may be 16 MiB. Remote URLs are not accepted.

Celeris (--provider celeris only):
      --explain            Ask for a one-sentence reason, printed under each
                           answer and returned as "explanations" in --json.
                           Up to 64 questions per request with --explain,
                           512 without.
      --max-soft-tokens <n>
                           The resolution each --image is read at: 70, 140,
                           280 (the default), 560, or 1120. An image costs
                           about that many input tokens; lower suits
                           classification, higher OCR and small text. No
                           effect without --image.

Client:
      --provider <name>    open-router, typesafe, cloudflare, or celeris. Default: from the environment
      --model <name>       Model name or alias, e.g. clef-flash or clef-omni. Default: the provider default
      --base-url <url>     Override the provider base URL
      --timeout <ms>       Per-attempt timeout in milliseconds. Default: 5000
      --max-retries <n>    Retries after the first attempt. Default: 2

Output:
  -q, --quiet              Print only the answer
  -v, --verbose            Print every option's probability, with bars in a terminal
      --json               Print the response as JSON; a failure is a JSON error on stderr
      --dry-run            Print the request that would be sent, then exit without sending it
      --no-color           Plain text even in a terminal. NO_COLOR does the same
  -h, --help               Show this help
`;

const EXIT = `
Exit status:
  0  success
  1  the request failed; the error is printed to stderr
  2  usage or configuration error
`;

const EXIT_WITH_CHECK = `
Exit status:
  0  success                        with --check: the answer is yes
  1  the request failed             with --check: the answer is no
  2  usage or configuration error
  3  with --check: the request failed
`;

const YESNO = `Usage: ${PROGRAM} yesno "<question>" [options]

Ask a yes/no question about a state. Prints yes or no with its probability.

  ${PROGRAM} yesno "Is this urgent?" -f issue.json
  yes   96%

Options:
      --threshold <p>      Where yes becomes no. Default: 0.5
      --check              Print nothing; exit 0 for yes and 1 for no
${COMMON}${EXIT_WITH_CHECK}
Examples:
  cat issue.json | ${PROGRAM} yesno "Is this urgent?"
  ${PROGRAM} yesno -q "Is this urgent?" -f issue.json                 # prints yes or no
  ${PROGRAM} yesno --check "Is this spam?" -s "$body" || deliver "$body"
  ${PROGRAM} yesno "Is the fan rattling?" --audio unit.wav --provider cloudflare --model clef-omni
  ${PROGRAM} yesno "Is this urgent?" -f issue.json --explain --provider celeris   # prints the reason too
`;

const CHOOSE = `Usage: ${PROGRAM} choose "<question>" <label>... [options]

Pick one of the labels for a state. Labels are separate arguments, so they
may contain spaces and nothing needs quoting beyond the question.

  ${PROGRAM} choose "Which team owns this?" billing auth infra -f issue.json
  billing   38%   auth 33% · infra 29%
${COMMON}${EXIT}
Examples:
  ${PROGRAM} choose "Which team owns this?" billing auth "platform infra" -s "Deploy is failing"
  ${PROGRAM} choose -q "Which team?" billing auth infra -f issue.json      # prints the label
`;

const SCORE = `Usage: ${PROGRAM} score "<question>" <level>... [options]

Place a state on an ordered scale of 2 to 10 levels, lowest first. Prints
the level the model landed on, its probability, and the numeric score.

  ${PROGRAM} score "How severe is this?" cosmetic minor major critical -f issue.json
  critical   89%   2.89 on a 0–3 scale · major 11%
${COMMON}${EXIT}
Examples:
  ${PROGRAM} score "How severe is this?" cosmetic minor major critical -s "500 on checkout"
  ${PROGRAM} score -q "How urgent?" low medium high -f issue.json           # prints the level
`;

const ASK = `Usage: ${PROGRAM} ask [state] [options]

Ask several questions about one state, or ask from a file. Each question
has an id that names its answer in the output.

Questions (repeatable; at least one is required):
      --noul <id>=<instructions>                 A yes/no question
      --choice <id>=<instructions>|<label>,...   Pick one of up to 255 labels
      --score <id>=<instructions>|<level>,...    Place the state on 2 to 10 levels
      --questions <file|json|->                  A questions map in the wire format,
                                                 merged with the flags
      --input <file|->                           One JSON document { state, questions };
                                                 replaces every other input
  [state]                  The state as text, the same as -s
${COMMON}${EXIT}
Examples:
  ${PROGRAM} ask -s "Server returns 500 on checkout" \\
    --noul urgent="Is this urgent?" \\
    --choice team="Which team owns this?|billing,auth,infra" \\
    --score severity="How severe is this?|cosmetic,minor,major,critical"

  cat issue.json | ${PROGRAM} ask --questions triage.json --json

  ${PROGRAM} ask -s "Review the installation" --provider cloudflare --model clef-omni \\
    --image unit.jpg --audio running.wav --video fan.mp4 \\
    --noul level="Is the unit level?" \\
    --choice noise="What does it sound like?|normal,rattle,grinding" \\
    --score fan="How steady is the fan?|wobbling,uneven,steady"

  ${PROGRAM} ask -f issue.json --provider celeris --explain --image screenshot.png \\
    --noul urgent="Is this urgent?" \\
    --choice team="Which team owns this?|billing,auth,infra"

  ${PROGRAM} ask --input - --json <<'EOF'
  { "state": { "title": "500 on checkout" },
    "questions": { "urgent": { "type": "noul", "instructions": "Is this urgent?" } } }
  EOF
`;

const PROVIDERS = `Usage: ${PROGRAM} providers [-v]

List the known providers with their environment variable, default model,
and whether an API key is set. The active row is marked; it is the provider
used when --provider is not given.

Options:
  -v, --verbose    Also show each provider's endpoint URL
  -h, --help       Show this help
`;

const WIRE = `Questions wire format, for --questions and --input:
  {
    "urgent":   { "type": "noul",   "instructions": "Is this urgent?" },
    "team":     { "type": "choice", "instructions": "Which team owns this?",
                  "criteria": { "billing": "invoices and refunds", "auth": null, "infra": null } },
    "severity": { "type": "score",  "instructions": "How severe is this?",
                  "criteria": ["cosmetic", "minor", "major", "critical"] }
  }
  Instructions may be a string, an object, or an array. A null criterion
  leaves a label undescribed.

JSON output, for --json:
  {
    "provider": "typesafe", "model": "jev-1.13.0", "id": null,
    "requestId": "req_...", "elapsedMs": 1004,
    "usage": { "inputTokens": 367, "outputTokens": 68, "cost": null },
    "answers": {
      "urgent":   { "type": "noul", "noul": 0.96, "probabilities": {} },
      "team":     { "type": "choice", "choice": "billing", "confidence": 0.38,
                    "probabilities": { "billing": 0.38, "auth": 0.33, "infra": 0.29 } },
      "severity": { "type": "score", "score": 2.99, "confidence": 0.99,
                    "probabilities": { "0": 0, "1": 0, "2": 0.01, "3": 0.99 },
                    "legend": { "0": "cosmetic", "1": "minor", "2": "major", "3": "critical" } }
    },
    "explanations": {}
  }
  yesno, choose, and score use the id "answer". With --explain on Celeris,
  "explanations" maps each id to its sentence and every answer also carries
  it as "explanation".
  A failure prints one line on stderr:
  { "error": { "type": "Unauthorized", "message": "...", "status": 401, "requestId": "...", "retryable": false } }

Dry run, for --dry-run:
  { "provider": "typesafe", "model": "jev-latest", "url": "https://...",
    "request": { "model": "jev-latest", "state": ..., "questions": { ... } } }
  With --image and the Cloudflare provider, request.images is an array of
  { "content_type": "image/jpeg", "base64": "..." }. With --audio and --video
  on clef-omni, request.audio and request.videos are arrays of data URLs:
  "data:audio/wav;base64,..." and "data:video/mp4;base64,...".
  With the Celeris provider, --explain, --image, and --max-soft-tokens go in
  request.x_celeris: { "explain": true, "images": { "photo": "data:image/jpeg;base64,..." },
  "max_soft_tokens": 560 }. It is absent when none of them is given.
`;

const RULE = "\n————————————————————————————————————————————————————————————————————————\n\n";

const ALL = [MAIN, YESNO, CHOOSE, SCORE, ASK, PROVIDERS, WIRE].join(RULE);

export function helpText(topic: HelpTopic): string {
  switch (topic) {
    case "yesno":
      return YESNO;
    case "choose":
      return CHOOSE;
    case "score":
      return SCORE;
    case "ask":
      return ASK;
    case "providers":
      return PROVIDERS;
    case "all":
      return ALL;
    default:
      return MAIN;
  }
}
