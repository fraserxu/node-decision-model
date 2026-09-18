import type { Transport } from "../src/index.js";

export type TransportResult =
  | readonly [number, string | null]
  | readonly [number, string | null, Record<string, string>];

export interface RecordedRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/**
 * A transport that replays a scripted list of results. An Error entry is
 * thrown instead of returned. Records every request it saw.
 */
export class FakeTransport {
  readonly requests: RecordedRequest[] = [];
  private readonly script: (TransportResult | Error)[];

  constructor(script: (TransportResult | Error)[]) {
    this.script = [...script];
  }

  get call(): Transport {
    return async (request) => {
      this.requests.push(request);
      const next = this.script.shift();
      if (next === undefined) {
        throw new Error("FakeTransport script exhausted");
      }
      if (next instanceof Error) throw next;
      return next;
    };
  }
}

/** Records requested sleep durations without actually sleeping. */
export class FakeSleeper {
  readonly slept: number[] = [];

  get call(): (ms: number) => Promise<void> {
    return async (ms) => {
      this.slept.push(ms);
    };
  }
}

/** A manually advanced clock, for totalTimeout tests. */
export class FakeClock {
  now = 0;

  get call(): () => number {
    return () => this.now;
  }

  advance(ms: number): void {
    this.now += ms;
  }
}

export function successBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: "resp_1",
    model: "typesafe/jev-1.13",
    answers: { urgent: { type: "noul", noul: 0.6, probabilities: {} } },
    usage: {},
    ...overrides,
  });
}

export function timeoutError(): Error {
  const error = new Error("The operation was aborted due to timeout");
  error.name = "TimeoutError";
  return error;
}

export function connectionError(code = "ECONNRESET"): Error {
  const error = new TypeError("fetch failed");
  (error as any).cause = Object.assign(new Error(code), { code });
  return error;
}

/** Runs fn with the given environment variables, restoring them afterwards. */
export async function withEnv(
  vars: Record<string, string | undefined>,
  fn: () => void | Promise<void>
): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) {
    saved[key] = process.env[key];
    if (vars[key] === undefined) delete process.env[key];
    else process.env[key] = vars[key];
  }
  try {
    await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
