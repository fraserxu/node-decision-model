# node-decision-model

The decision-model interface for Node.js. Decision models answer typed
questions about a state with calibrated probabilities instead of generating
text. This package talks to them through one `Client` with a provider behind
it: OpenRouter by default, Typesafe's native API as a second door,
Cloudflare's Clef models on Workers AI as a third, Celeris's
celeris-1-decision as a fourth, more providers as labs ship them. No runtime
dependencies; Node 20+.

## At a glance

|                     |                                                                                           |
| ------------------- | ----------------------------------------------------------------------------------------- |
| Install             | `npm install node-decision-model`                                                         |
| Auth                | `TYPESAFE_API_KEY`, `OPENROUTER_API_KEY`, `CLOUDFLARE_AUTH_TOKEN` with `CLOUDFLARE_ACCOUNT_ID`, or `CELERIS_API_KEY` in the environment, for the library and the CLI |
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
selects Typesafe, otherwise `OPENROUTER_API_KEY` selects OpenRouter,
otherwise `CLOUDFLARE_AUTH_TOKEN` together with `CLOUDFLARE_ACCOUNT_ID`
selects Cloudflare, otherwise `CELERIS_API_KEY` selects Celeris. With none
set it throws `ConfigurationError` naming them. `getDefaultClient()`
memoizes one such default client; `setDefaultClient(undefined)` resets it.

CommonJS works the same way:

```js
const { Client, noul } = require("node-decision-model");
```

## Command line

The package installs a `decision-model` executable. It is the quickest way
to ask a question from a shell, a script, or an agent tool call.

It needs an API key in the environment: `TYPESAFE_API_KEY` for Typesafe,
`OPENROUTER_API_KEY` for OpenRouter, `CLOUDFLARE_AUTH_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID` for Cloudflare, or `CELERIS_API_KEY` for Celeris.
Typesafe wins when several are set, then OpenRouter, then Cloudflare, then
Celeris, and `--provider` picks one explicitly. `decision-model providers`
shows which keys are set and which provider will be used.

```bash
export TYPESAFE_API_KEY=...
npx decision-model yesno "Is apple healthy?"
```

```
yes  93%
jev-1.13.0 · 270 in / 20 out tokens · 0.9s · req_01a0b6f6
```

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

### Passing an image

Cloudflare Clef, Clef-flash, and Clef-omni can see a local photo, and so can
Celeris. Repeat `-i` / `--image` for each file. Remote URLs are not accepted,
and other providers reject the flag.

```bash
decision-model yesno "Is the total legible?" --image receipt.jpg -s "Receipt from today"
decision-model choose "What is this?" cat dog other -i photo.png -i photo2.jpg --provider cloudflare
decision-model choose "What is this?" cat dog other -i photo.png --provider celeris
```

On Clef each image may be PNG, JPEG, or WebP, 4 MiB and 16 megapixels; up to
four together may be 8 MiB, and on `clef` and `clef-flash` the whole request
body 13 MiB. On Celeris each image may be PNG or JPEG and 25 megapixels; up to
eight go in one request, and the whole request body may be 8 MiB. Celeris
names each image after its file stem (`receipt.jpg` is `receipt`), with `_2`,
`_3` added when two files share a name; see [Celeris](#celeris) below.

### Asking for a reason

Celeris can say why, in one sentence per answer. `--explain` asks for it and
prints the sentence on its own line under the answer; `--json` adds an
`explanations` map and an `explanation` field on each answer. Other
providers reject the flag.

```bash
decision-model yesno "Is this urgent?" -f issue.json --explain --provider celeris
```

```
yes  96%
     Every checkout has failed since 09:00 and revenue is at zero.
celeris-1-decision · 301 in / 41 out tokens · 1.3s
```

With `--explain` a request may carry 64 questions; without it, 512.
`--max-soft-tokens <n>`, also Celeris only, sets the resolution each `--image`
is read at: 70, 140, 280 (the default), 560, or 1120, costing about that many
input tokens per image. It does nothing without images.

### Passing audio and video

Cloudflare Clef-omni also listens and watches. It needs `--model clef-omni`;
`clef` and `clef-flash` reject the flags with a message that says so, as do
other providers. `--audio` takes a local WAV or MP3 file, `--video` a local MP4
or WebM file, and both repeat. The format is read from the file's bytes, and
a `.wav`, `.mp3`, `.mp4`, or `.webm` extension that disagrees with them is an
error. Remote URLs are not accepted.

```bash
decision-model yesno "Is the fan rattling?" --audio unit.wav --provider cloudflare --model clef-omni
decision-model choose "What is the dog doing?" sleeping playing barking --video dog.mp4 --provider cloudflare --model clef-omni
```

Review an installation from a photo of the unit, a recording of it running,
and a clip of the fan, all in one request:

```bash
decision-model ask -s "Heat pump installed yesterday; the customer reports a noise at startup." \
  --provider cloudflare --model clef-omni \
  --image unit.jpg --audio running.wav --video fan.mp4 \
  --noul level="Is the unit mounted level?" \
  --choice noise="What does the startup sound like?|normal,rattle,grinding" \
  --score fan="How steady is the fan?|wobbling,uneven,steady"
```

```
level  yes       91%
noise  rattle    77%  normal 19% · grinding 4%
fan    uneven    64%  1.52 on a 0–2 scale · steady 28% · wobbling 8%
clef-omni · 2140 in / 54 out tokens · 3.4s · 8f1e2d3c4b5a
```

| Input     | Formats         | Count | Each                 | Together                  |
| --------- | --------------- | ----- | -------------------- | ------------------------- |
| `--image` | PNG, JPEG, WebP | 4     | 4 MiB, 16 megapixels | 8 MiB                     |
| `--audio` | WAV, MP3        | 4     | 8 MiB, 300 seconds   | 16 MiB of audio and video |
| `--video` | MP4, WebM       | 2     | 16 MiB, 60 seconds   | 16 MiB of audio and video |

Sizes and counts are checked before anything is sent. A WAV's duration is
read from its header and an MP4's from its `mvhd` box; MP3 and WebM durations
are left to the server. Videos are sampled at 2 frames per second.

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
  },
  "explanations": {}
}
```

`explanations` is filled, and each answer gains an `explanation` string, when
Celeris was asked with `--explain`.

Under `--json` a failure is one JSON line on stderr, and the exit code is
unchanged:

```json
{ "error": { "type": "Unauthorized", "message": "unauthorized (status 401)", "status": 401, "requestId": "req_…", "retryable": false } }
```

`--dry-run` validates everything, prints the request that would be sent,
and exits without calling the API. It needs no API key, so a program can
check the shape of its questions for free.

### Every flag

| Flag                 | Meaning                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------- |
| `-q, --quiet`        | Print only the answer                                                                       |
| `-v, --verbose`      | Print every option's probability, with bars in a terminal                                   |
| `--json`             | Print the response as JSON; a failure becomes a JSON error on stderr                        |
| `--dry-run`          | Print the request and exit without sending it                                               |
| `--no-color`         | Plain text even in a terminal. `NO_COLOR` does the same; `FORCE_COLOR` forces colour        |
| `--threshold <p>`    | `yesno` only: where yes becomes no. Default 0.5                                             |
| `--check`            | `yesno` only: print nothing; exit 0 for yes and 1 for no                                    |
| `--provider <name>`  | `open-router`, `typesafe`, `cloudflare`, or `celeris`. Default: from the environment        |
| `--model <name>`     | Model name or alias, e.g. `clef-flash` or `clef-omni`. Default: the provider default        |
| `--base-url <url>`   | Override the provider base URL                                                              |
| `--timeout <ms>`     | Per-attempt timeout in milliseconds. Default: 5000                                          |
| `--max-retries <n>`  | Retries after the first attempt. Default: 2                                                 |
| `-i, --image <path>` | Cloudflare Clef and Celeris: a local image file; repeatable, up to 4 (Clef) or 8 (Celeris). No remote URLs |
| `--audio <path>`     | Cloudflare Clef-omni only: a local WAV or MP3 file; repeatable, up to 4. No remote URLs      |
| `--video <path>`     | Cloudflare Clef-omni only: a local MP4 or WebM file; repeatable, up to 2. No remote URLs     |
| `--explain`          | Celeris only: a one-sentence reason under each answer, and in `--json`                      |
| `--max-soft-tokens <n>` | Celeris only: the resolution each image is read at, 70, 140, 280 (default), 560, or 1120 |

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

### Cloudflare Workers AI (Clef)

[Clef, Clef-flash](https://blog.cloudflare.com/clef-decision-models/), and
[Clef-omni](https://developers.cloudflare.com/workers-ai/models/clef-omni/)
are Cloudflare's decision models on Workers AI. They speak the Jev wire
format, so the same questions and answers work unchanged.

```ts
// process.env.CLOUDFLARE_AUTH_TOKEN and process.env.CLOUDFLARE_ACCOUNT_ID
const client = new Client({ provider: "cloudflare" });

// the faster model
const flash = new Client({ provider: "cloudflare", model: "clef-flash" });

// the model that also takes audio and video
const omni = new Client({ provider: "cloudflare", model: "clef-omni" });

// or pass the account id and token directly
import { CloudflareProvider } from "node-decision-model";
const client = new Client({
  provider: new CloudflareProvider({ accountId: "...", apiKey: "..." }),
});
```

| Model        | Workers AI id              | Context               | Inputs                      |
| ------------ | -------------------------- | --------------------- | --------------------------- |
| `clef`       | `@cf/cloudflare/clef`      | 64k (65,536 tokens)   | text, images                |
| `clef-flash` | `@cf/cloudflare/clef-flash`| 24k (24,576 tokens)   | text, images                |
| `clef-omni`  | `@cf/cloudflare/clef-omni` | 64k (64,000 tokens)   | text, images, audio, video  |

The hosted Clef-flash context window is now 24k; it was advertised as 64k
when the model launched. Cloudflare lists Clef-omni at $0.15 per million
input tokens.

| Environment variable    | Meaning                                              |
| ----------------------- | ---------------------------------------------------- |
| `CLOUDFLARE_AUTH_TOKEN` | API token with Workers AI permission, sent as Bearer |
| `CLOUDFLARE_ACCOUNT_ID` | The account the request runs under                   |

Each model has its own URL,
`https://api.cloudflare.com/client/v4/accounts/<account id>/ai/run/@cf/cloudflare/<model>`,
and the body's `model` field names the same model. The default model is
`clef`; `clef-flash` trades some accuracy for speed; `clef-omni` adds audio
and video. The Workers AI ids `@cf/cloudflare/clef`,
`@cf/cloudflare/clef-flash`, and `@cf/cloudflare/clef-omni` are accepted as
aliases. The REST API wraps the decision in
`{ "success": true, "result": { ... } }`; the client unwraps it, keeps the
whole body in `response.raw`, and throws `InvalidResponse` with Cloudflare's
error messages when `success` is `false`. A body without the envelope is
read as is. Usage reports `inputTokens` and `outputTokens`; `cost` is
`null`. `response.requestId` is the `cf-ray` header.

All three models accept images. Pass `images` to `ask`: a local path, a
`Uint8Array` of PNG, JPEG, or WebP bytes, or a `data:image/png;base64,...`
URL (JPEG and WebP data URLs too). Remote URLs are not accepted. The request
embeds each image as `{ "content_type", "base64" }`, and Clef places those
images before the state. The limits match the
[Clef schema](https://developers.cloudflare.com/workers-ai/models/clef/):
4 images, 4 MiB and 16 megapixels each, 8 MiB of image bytes in total, and
on `clef` and `clef-flash` a 13 MiB request body. The "total decoded" cap is
the sum of those file bytes, not the expanded pixel buffer, so a normal photo
under 16 megapixels gets through. Other providers throw `RequestError` if
`images` is set. The CLI flag is `--image` / `-i`.

```ts
import { readFileSync } from "node:fs";

const response = await client.ask({
  state: "Receipt from today",
  images: [readFileSync("receipt.jpg")], // or the path "receipt.jpg"
  questions: { legible: noul("Is the total legible?") },
});
```

```bash
decision-model yesno "Is the total legible?" --image receipt.jpg -s "Receipt from today"
```

#### Audio and video with Clef-omni

`clef-omni` also takes `audio` and `videos`. Each entry is a local path, a
`Uint8Array`, or a data URL, like an image: WAV or MP3 for audio
(`data:audio/wav;base64,...`, `data:audio/mpeg;base64,...`), MP4 or WebM for
video (`data:video/mp4;base64,...`, `data:video/webm;base64,...`). The
format is read from the bytes; a path whose `.wav`, `.mp3`, `.mp4`, or
`.webm` extension disagrees with them is a `RequestError`, as is any other
format and any remote URL. The request carries them as data URL strings in
`audio` and `videos`, with the `images` objects unchanged. The types are
exported as `AudioSource` and `VideoSource`; `MediaInputs` names all three
arrays together.

```ts
const omni = new Client({ provider: "cloudflare", model: "clef-omni" });

const response = await omni.ask({
  state: "Heat pump installed yesterday; the customer reports a noise at startup.",
  images: ["unit.jpg"],
  audio: ["running.wav"], // or readFileSync("running.wav")
  videos: ["fan.mp4"],
  questions: {
    level: noul("Is the unit mounted level?"),
    noise: choice("What does the startup sound like?", {
      normal: null,
      rattle: null,
      grinding: null,
    }),
    fan: score("How steady is the fan?", ["wobbling", "uneven", "steady"]),
  },
});

response.answers.noise.choice; // => "rattle"
response.answers.fan.score; // => 1.52
```

The limits follow the
[Clef-omni schema](https://developers.cloudflare.com/workers-ai/models/clef-omni/):

| Input    | Count | Each                 | Together                         |
| -------- | ----- | -------------------- | -------------------------------- |
| `images` | 4     | 4 MiB, 16 megapixels | 8 MiB                            |
| `audio`  | 4     | 8 MiB, 300 seconds   | 16 MiB of audio and video bytes  |
| `videos` | 2     | 16 MiB, 60 seconds   | 16 MiB of audio and video bytes  |

Counts and sizes are checked locally. A WAV's duration is read from its
`fmt ` and `data` chunks and an MP4's from its `mvhd` box, so a clip that is
too long fails before anything is sent; MP3 and WebM durations are left to
the server. The model samples video at 2 frames per second. The 13 MiB
request body cap applies to `clef` and `clef-flash` only: Clef-omni's docs
set no body cap, and its media limits add up to more than 13 MiB, so the
client holds it to the decoded limits above instead. Setting `audio` or
`videos` with `clef` or `clef-flash` throws `RequestError` naming the model
and `--model clef-omni`; other providers throw `RequestError` as they do for
images. A request without media is sent exactly as before, with no empty
arrays.

The environment selects Cloudflare only when both variables are set; with
the token alone, `decision-model providers` shows the key as `incomplete`.
A `baseUrl` override (for example an AI Gateway URL ending in `/ai/run`)
replaces the account URL, so it needs no account id.

### Celeris

Celeris's decision model, `celeris-1-decision`, speaks the System One wire
format Typesafe uses, so the same questions and answers work unchanged. What
System One has no field for goes in an `x_celeris` object: a one-sentence
reason per answer, images, and the resolution images are read at.

```ts
// process.env.CELERIS_API_KEY
const client = new Client({ provider: "celeris" });

// or pass the key directly
import { CelerisProvider } from "node-decision-model";
const client = new Client({ provider: new CelerisProvider({ apiKey: "ck_..." }) });
```

```bash
export CELERIS_API_KEY=ck_...
decision-model yesno "Is this urgent?" -f issue.json --provider celeris --explain
```

| Environment variable | Meaning                                              |
| -------------------- | ---------------------------------------------------- |
| `CELERIS_API_KEY`    | API key, starts with `ck_`, sent as a Bearer token   |

Requests go to
`https://inference.celeris.ai/celeris-1-decision/v1/systemone`. The model is
a segment of the path as well as the body's `model`, and the client keeps the
two together: `urlFor(model)` is `<base URL>/<model>/v1/systemone`, with the
base URL `https://inference.celeris.ai` by default. A `baseUrl` override or
`--base-url` replaces that host part only, so a proxy at
`https://proxy.example` is called at
`https://proxy.example/celeris-1-decision/v1/systemone`. There is no
environment variable for the base URL, as for the other providers. The
default and only model is `celeris-1-decision`; there are no aliases. The
environment selects Celeris last, only when `CELERIS_API_KEY` is the only
credential set; `--provider celeris` and `provider: "celeris"` always work.
Usage reports `inputTokens` and `outputTokens`; `cost` is `null`.

Celeris does not document a server-generated request id header.
`response.requestId` (and the `requestId` in the CLI's `--json` failure line)
is read from an `x-request-id` header as a best effort, and is `null` when
there is none. What Celeris does document is an optional caller-supplied
`X-Client-Trace-Id` request header that it echoes back on the response, and
a `ref` field in error bodies. The client does not send the trace header
itself (a subclass overriding `headers()` or a custom `transport` can add
it), but it does include `ref` in the error message, see below.

#### Explanations

`explain: true` asks for a reason per answer. The request carries
`x_celeris.explain`, and the response's `x_celeris.explanations` comes back
as `response.explanations`, keyed by question id, and as `explanation` on
each answer. Celeris answers at most 64 questions per request with `explain`
(512 without), and the client checks that before sending. Any other provider
throws `RequestError` when `explain` is set; the CLI flag is `--explain`.

```ts
const response = await client.ask({
  state: { title: "Server returns 500 on checkout" },
  questions: { urgent: noul("Is this urgent?") },
  explain: true,
});

response.answers.urgent.noul; // => 0.96
response.answers.urgent.explanation; // => "Every checkout has failed since 09:00."
response.explanations.urgent; // the same sentence
```

#### Images

Pass `images` to `ask` as for Clef: a local path, a `Uint8Array` of PNG or
JPEG bytes, or a `data:image/png;base64,...` or `data:image/jpeg;base64,...`
URL. WebP, any other format, and remote URLs are rejected. The request sends
them as `x_celeris.images`, a map of names to data URLs. A file is named by
its stem with every character outside letters, digits, and underscores
replaced by one underscore (`My Photo (2).jpg` is `My_Photo_2`); bytes and
data URLs are named by position, `image1`, `image2`, ...; a name already
taken gets `_2`, `_3`, and so on. Up to 8 images, each at most 25 megapixels,
and a request body of at most 8 MiB including the base64. The CLI flag is
`--image` / `-i`.

```ts
const response = await client.ask({
  state: "Receipt from today",
  images: ["receipt.jpg"], // sent as x_celeris.images.receipt
  questions: { legible: noul("Is the total legible?") },
});
```

Audio and video are not accepted: `ask({ audio })` or `ask({ videos })` with
Celeris throws `RequestError`, as `--audio` and `--video` do in the CLI.

#### Image resolution

`maxSoftTokens` sets `x_celeris.max_soft_tokens`, the resolution every image
in the request is read at. It is not a reasoning budget: each image costs
roughly that many input tokens, so a lower value is cheaper and suits
classification, and a higher one keeps small text legible for OCR. The
allowed values are 70, 140, 280 (what the model uses when it is not set),
560, and 1120; anything else throws `RequestError` before the request is
sent. It only matters when images are sent; on a text-only request it is
passed through and has no effect. Other providers throw `RequestError` when
it is set. The CLI flag is `--max-soft-tokens <n>`. The exported
`CELERIS_MAX_SOFT_TOKENS` lists the values and
`CELERIS_DEFAULT_MAX_SOFT_TOKENS` is 280.

`x_celeris` is sent only when at least one of `explain`, `images`, or
`maxSoftTokens` is set; a plain request is byte for byte the System One body.

#### Limits and errors

| Limit                        | Value                                      | Exported as                       |
| ---------------------------- | ------------------------------------------ | --------------------------------- |
| Questions per request        | 512, or 64 with `explain`                  | `CELERIS_MAX_QUESTIONS`, `CELERIS_MAX_EXPLAINED_QUESTIONS` |
| Images per request           | 8                                          | `CELERIS_MAX_IMAGES`              |
| Pixels per image             | 25,000,000                                 | `CELERIS_MAX_PIXELS`              |
| Request body                 | 8 MiB, images included                     | `CELERIS_MAX_BODY_BYTES`          |
| `maxSoftTokens`              | 70, 140, 280, 560, 1120                    | `CELERIS_MAX_SOFT_TOKENS`         |

Every limit is checked before anything is sent, and a violation is a
`RequestError` (exit code 2 in the CLI, with a hint).

Celeris returns errors in an OpenAI-style envelope,
`{ "error": { "message", "type", "code", "ref" } }`, where `ref` is an
optional short reference such as `q-d3` to quote to Celeris support. The
usual classes are thrown by status, and the envelope's message, code, and
`ref` (when present) are appended to the error message, for example
`unauthorized: Invalid API key provided. (code invalid_api_key, ref q-a1)`;
the whole body stays in `error.body`. 401 is `Unauthorized`, 402
(`insufficient_quota`) an `ApiError`, 404 an `ApiError`, 413
`PayloadTooLarge`, 422 `UnprocessableEntity` with the validation detail and
no retry, 429 (`rate_limit_exceeded`, `service_busy`) `RateLimited` and
retried after `Retry-After`, and 5xx retried like every provider.

#### Verified vs. unconfirmed

Confirmed against docs.celeris.ai (the Authentication, Decisions, and Errors
pages): the `Authorization: Bearer ck_...` header; the `CELERIS_API_KEY`
variable name, which Celeris's own examples use; the `/<model>/v1/systemone`
endpoint and the `x_celeris` fields (`explain`, `images`, `max_soft_tokens`,
`explanations`); the limits (512 questions, 64 with `explain`, 8 images at 25
megapixels each, an 8 MiB body, and `max_soft_tokens` of 70, 140, 280, 560,
or 1120); and the `{ "error": { "message", "type", "code", "ref" } }`
envelope.

Not yet confirmed against a live successful call: this release was tested
with mocked HTTP only. A request with an invalid key did get Celeris's
documented 401 `invalid_api_key` envelope from the live endpoint, which
confirms the URL, the auth header, and the error envelope, but not the
success body. The `x-request-id` header is undocumented and may never be
sent, and the exact shape of a 422 body has not been observed.

### Options

```ts
new Client({
  provider: "typesafe", // "open-router", "typesafe", "cloudflare", "celeris", or a Provider instance
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

Every provider sends `User-Agent: node-decision-model/<version>`.

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

| You pass                      | Cloudflare sends | To                              |
| ----------------------------- | ---------------- | ------------------------------- |
| `undefined`                   | `clef`           | `.../@cf/cloudflare/clef`       |
| `"@cf/cloudflare/clef"`       | `clef`           | `.../@cf/cloudflare/clef`       |
| `"clef-flash"`                | `clef-flash`     | `.../@cf/cloudflare/clef-flash` |
| `"@cf/cloudflare/clef-flash"` | `clef-flash`     | `.../@cf/cloudflare/clef-flash` |
| `"clef-omni"`                 | `clef-omni`      | `.../@cf/cloudflare/clef-omni`  |
| `"@cf/cloudflare/clef-omni"`  | `clef-omni`      | `.../@cf/cloudflare/clef-omni`  |
| anything else                 | as given         | `.../@cf/cloudflare/<model>`    |

Celeris has no aliases: `undefined` sends `celeris-1-decision` to
`https://inference.celeris.ai/celeris-1-decision/v1/systemone`, and anything
else is sent as given to `.../<model>/v1/systemone`.

### Writing a provider

Extend `Provider` and implement the `name`, `envVar`, `defaultBaseUrl`,
`endpointPath`, and `defaultModel` getters; optionally override `aliases`,
`reportsCost`, and `requestIdHeader`. Override `headers()`, `requestBody()`
(its argument type is exported as `RequestBodyArgs`; the base implementation
rejects `images`, `audio`, `videos`, `explain`, and `maxSoftTokens`),
`unwrap()`, or `usage()` when the wire format differs, `urlFor(model)` when
each model has its own URL, `missingConfiguration()` when the provider needs
more than a key, `errorDetail(status, body)` when a non-2xx body carries a
message worth appending to the error, and `explanations(parsed)` when the
response carries a reason per answer. Pass an instance as `provider`.

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
| `RequestError`        | Questions map was empty, an image, audio, or video input was invalid or not allowed, a Celeris limit or option was wrong, or `explain` / `maxSoftTokens` went to another provider |
| `TransportError`      | Network failure after retries, carries `causeError`                                       |
| `TimeoutError`        | Timeout after retries (extends `TransportError`)                                          |
| `ApiError`            | Non-2xx response, carries `status`, `body`, and `headers`; Celeris adds the envelope's message, code, and `ref` to the message |
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

1. Bump `version` in `package.json` and the two `version` fields for this
   package in `package-lock.json`. `--version` and the User-Agent read that
   version from `package.json`; do not add a second copy.
2. Add the version to `CHANGELOG.md`.
3. Merge to `main`. The Release workflow runs the suite, builds, and publishes
   with provenance. A version already on npm is skipped, so the workflow is
   safe to re-run.

The same workflow can be started by hand from the Actions tab or with
`gh workflow run release.yml`.

## License

MIT
