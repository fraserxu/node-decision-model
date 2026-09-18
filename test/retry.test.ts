import { describe, expect, it } from "vitest";
import {
  ApiError,
  Client,
  ConfigurationError,
  noul,
  RateLimited,
  RetryPolicy,
  TimeoutError,
  TransportError,
  UnprocessableEntity,
} from "../src/index.js";
import {
  connectionError,
  FakeClock,
  FakeSleeper,
  FakeTransport,
  successBody,
  timeoutError,
} from "./helpers.js";

const questions = { urgent: noul("Is this urgent?") };

function buildClient(
  transport: FakeTransport,
  options: {
    sleeper?: FakeSleeper;
    random?: () => number;
    clock?: FakeClock;
    retry?: RetryPolicy | ConstructorParameters<typeof RetryPolicy>[0];
  } = {}
) {
  const sleeper = options.sleeper ?? new FakeSleeper();
  return new Client({
    apiKey: "test-key",
    transport: transport.call,
    sleeper: sleeper.call,
    random: options.random ?? (() => 0),
    ...(options.clock ? { clock: options.clock.call } : {}),
    ...(options.retry ? { retry: options.retry } : {}),
  });
}

describe("RetryPolicy defaults", () => {
  it("matches the official SDKs", () => {
    const policy = new RetryPolicy();
    expect(policy.maxRetries).toBe(2);
    expect(policy.backoffInitial).toBe(500);
    expect(policy.backoffMax).toBe(5_000);
    expect(policy.backoffJitter).toBe(0.25);
    expect(policy.httpStatuses).toContain(408);
    expect(policy.httpStatuses).toContain(429);
    expect(policy.httpStatuses).toContain(500);
    expect(policy.httpStatuses).toContain(529);
    expect(policy.httpStatuses).toContain(599);
    expect(policy.httpStatuses).not.toContain(422);
    expect(policy.respectRetryAfter).toBe(true);
    expect(policy.maxRetryAfter).toBe(60_000);
    expect(policy.retryConnectionErrors).toBe(true);
    expect(policy.retryTimeouts).toBe(true);
    expect(policy.totalTimeout).toBe(30_000);
  });

  it("rejects invalid settings at construction", () => {
    expect(() => new RetryPolicy({ maxRetries: "2" as any })).toThrow(ConfigurationError);
    expect(() => new RetryPolicy({ maxRetries: -1 })).toThrow(ConfigurationError);
    expect(() => new RetryPolicy({ maxRetries: 1.5 })).toThrow(ConfigurationError);
    expect(() => new RetryPolicy({ maxRetryAfter: -1 })).toThrow(ConfigurationError);
    expect(() => new RetryPolicy({ backoffJitter: 2 })).toThrow(ConfigurationError);
    expect(() => new RetryPolicy({ totalTimeout: Number.NaN })).toThrow(ConfigurationError);
    expect(() => new RetryPolicy({ backoffInitial: Number.POSITIVE_INFINITY })).toThrow(
      ConfigurationError
    );
    expect(() => new RetryPolicy({ httpStatuses: 500 as any })).toThrow(ConfigurationError);
    expect(() => buildClient(new FakeTransport([]), { retry: { maxRetries: "2" as any } })).toThrow(
      ConfigurationError
    );
  });

  it("accepts an options object or a policy instance on the client", () => {
    const fromOptions = buildClient(new FakeTransport([]), { retry: { maxRetries: 5 } });
    expect(fromOptions.retryPolicy.maxRetries).toBe(5);

    const policy = new RetryPolicy({ maxRetries: 0 });
    const fromPolicy = buildClient(new FakeTransport([]), { retry: policy });
    expect(fromPolicy.retryPolicy).toBe(policy);

    expect(RetryPolicy.from(undefined).maxRetries).toBe(2);
    expect(RetryPolicy.from(null).maxRetries).toBe(2);
    expect(() => RetryPolicy.from("x" as any)).toThrow(ConfigurationError);
  });
});

describe("RetryPolicy backoff", () => {
  it("doubles from the initial value, caps at max, and subtracts jitter", () => {
    const policy = new RetryPolicy();
    expect(policy.backoff(0, () => 0)).toBe(500);
    expect(policy.backoff(1, () => 0)).toBe(1_000);
    expect(policy.backoff(2, () => 0)).toBe(2_000);
    expect(policy.backoff(10, () => 0)).toBe(5_000);
    expect(policy.backoff(0, () => 1)).toBeCloseTo(375);
    expect(policy.backoff(0, () => 0.5)).toBeCloseTo(437.5);
  });

  it("never returns a negative delay", () => {
    const policy = new RetryPolicy({ backoffJitter: 1 });
    expect(policy.backoff(0, () => 1)).toBe(0);
  });
});

describe("RetryPolicy retry-after parsing", () => {
  const policy = new RetryPolicy();

  it("prefers retry-after-ms", () => {
    expect(policy.retryAfterMs({ "retry-after-ms": "1500", "retry-after": "10" })).toBe(1_500);
  });

  it("reads Retry-After seconds case-insensitively", () => {
    expect(policy.retryAfterMs({ "Retry-After": "2" })).toBe(2_000);
    expect(policy.retryAfterMs({ "RETRY-AFTER": "0.5" })).toBe(500);
  });

  it("reads Retry-After HTTP dates", () => {
    const future = new Date(Date.now() + 10_000).toUTCString();
    const ms = policy.retryAfterMs({ "retry-after": future });
    expect(ms).toBeGreaterThan(8_000);
    expect(ms).toBeLessThanOrEqual(10_000);
  });

  it("clamps past dates to zero and ignores garbage", () => {
    const past = new Date(Date.now() - 10_000).toUTCString();
    expect(policy.retryAfterMs({ "retry-after": past })).toBe(0);
    expect(policy.retryAfterMs({ "retry-after": "soon" })).toBeNull();
    expect(policy.retryAfterMs({ "retry-after": "-5" })).toBeNull();
    expect(policy.retryAfterMs({ "retry-after-ms": "-5" })).toBeNull();
    expect(policy.retryAfterMs({})).toBeNull();
  });

  it("delay clamps hints to maxRetryAfter and falls back to backoff", () => {
    expect(policy.delay(0, { headers: { "retry-after": "120" } })).toBe(60_000);
    expect(policy.delay(0, { headers: {}, random: () => 0 })).toBe(500);
    const ignoring = new RetryPolicy({ respectRetryAfter: false });
    expect(ignoring.delay(0, { headers: { "retry-after": "120" }, random: () => 0 })).toBe(500);
  });
});

describe("Client retry behaviour", () => {
  it("retries retryable statuses then succeeds", async () => {
    const transport = new FakeTransport([
      [500, "boom"],
      [503, "still"],
      [200, successBody()],
    ]);
    const sleeper = new FakeSleeper();
    const response = await buildClient(transport, { sleeper }).ask({ state: {}, questions });
    expect(response.answers.urgent.noul).toBe(0.6);
    expect(transport.requests).toHaveLength(3);
    expect(sleeper.slept).toEqual([500, 1_000]);
  });

  it("gives up after maxRetries and throws the last status", async () => {
    const transport = new FakeTransport([
      [429, "slow down"],
      [429, "slow down"],
      [429, "slow down"],
    ]);
    await expect(buildClient(transport).ask({ state: {}, questions })).rejects.toBeInstanceOf(
      RateLimited
    );
    expect(transport.requests).toHaveLength(3);
  });

  it("does not retry 422", async () => {
    const transport = new FakeTransport([[422, "bad"]]);
    await expect(buildClient(transport).ask({ state: {}, questions })).rejects.toBeInstanceOf(
      UnprocessableEntity
    );
    expect(transport.requests).toHaveLength(1);
  });

  it("honors Retry-After headers over backoff", async () => {
    const transport = new FakeTransport([
      [429, "", { "retry-after": "2" }],
      [429, "", { "Retry-After-Ms": "250" }],
      [200, successBody()],
    ]);
    const sleeper = new FakeSleeper();
    await buildClient(transport, { sleeper }).ask({ state: {}, questions });
    expect(sleeper.slept).toEqual([2_000, 250]);
  });

  it("treats a two-element transport result as having no headers", async () => {
    const transport = new FakeTransport([
      [429, ""],
      [200, successBody()],
    ]);
    const sleeper = new FakeSleeper();
    const response = await buildClient(transport, { sleeper }).ask({ state: {}, questions });
    expect(sleeper.slept).toEqual([500]);
    expect(response.requestId).toBeNull();
  });

  it("retries connection errors and timeouts", async () => {
    const transport = new FakeTransport([connectionError(), timeoutError(), [200, successBody()]]);
    const response = await buildClient(transport).ask({ state: {}, questions });
    expect(response.answers.urgent.noul).toBe(0.6);
    expect(transport.requests).toHaveLength(3);
  });

  it("wraps an exhausted timeout as TimeoutError with the cause", async () => {
    const transport = new FakeTransport([timeoutError(), timeoutError(), timeoutError()]);
    const error = await buildClient(transport)
      .ask({ state: {}, questions })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TimeoutError);
    expect((error as TimeoutError).causeError).toBeInstanceOf(Error);
    expect((error as TimeoutError).message).toMatch(/request timed out/);
  });

  it("wraps an exhausted connection failure as TransportError", async () => {
    const transport = new FakeTransport([
      connectionError("ECONNREFUSED"),
      connectionError("ECONNREFUSED"),
      connectionError("ECONNREFUSED"),
    ]);
    const error = await buildClient(transport)
      .ask({ state: {}, questions })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TransportError);
    expect(error).not.toBeInstanceOf(TimeoutError);
  });

  it("does not retry errors that are not network related", async () => {
    const transport = new FakeTransport([new RangeError("bug in transport")]);
    await expect(buildClient(transport).ask({ state: {}, questions })).rejects.toBeInstanceOf(
      TransportError
    );
    expect(transport.requests).toHaveLength(1);
  });

  it("respects retryTimeouts and retryConnectionErrors switches", async () => {
    const noTimeouts = new FakeTransport([timeoutError(), [200, successBody()]]);
    await expect(
      buildClient(noTimeouts, { retry: { retryTimeouts: false } }).ask({ state: {}, questions })
    ).rejects.toBeInstanceOf(TimeoutError);

    const noConnection = new FakeTransport([connectionError(), [200, successBody()]]);
    await expect(
      buildClient(noConnection, { retry: { retryConnectionErrors: false } }).ask({
        state: {},
        questions,
      })
    ).rejects.toBeInstanceOf(TransportError);
  });

  it("stops before a delay that would exceed the total budget", async () => {
    const transport = new FakeTransport([
      [500, "one"],
      [500, "two"],
      [200, successBody()],
    ]);
    const clock = new FakeClock();
    const slept: number[] = [];
    const sleeper = {
      slept,
      call: async (ms: number) => {
        slept.push(ms);
        clock.advance(ms);
      },
    } as FakeSleeper;
    const client = buildClient(transport, {
      clock,
      sleeper,
      retry: { totalTimeout: 700, maxRetries: 5 },
    });
    // First retry: 0 elapsed + 500 backoff fits the 700 budget. Second retry:
    // 500 elapsed + 1000 backoff does not, so the second 500 is returned as-is.
    const error = await client.ask({ state: {}, questions }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).body).toBe("two");
    expect(transport.requests).toHaveLength(2);
    expect(slept).toEqual([500]);
  });

  it("re-checks the budget after sleeping", async () => {
    const transport = new FakeTransport([
      [500, "one"],
      [200, successBody()],
    ]);
    const clock = new FakeClock();
    const sleeper = { call: async (ms: number) => clock.advance(ms + 1_000) } as FakeSleeper;
    const client = buildClient(transport, {
      clock,
      sleeper,
      retry: { totalTimeout: 1_000 },
    });
    await expect(client.ask({ state: {}, questions })).rejects.toBeInstanceOf(ApiError);
    expect(transport.requests).toHaveLength(1);
  });

  it("a null totalTimeout disables the budget", async () => {
    const transport = new FakeTransport([
      [500, "one"],
      [200, successBody()],
    ]);
    const clock = new FakeClock();
    clock.advance(1_000_000);
    const response = await buildClient(transport, { clock, retry: { totalTimeout: null } }).ask({
      state: {},
      questions,
    });
    expect(response.answers.urgent.noul).toBe(0.6);
  });

  it("maxRetries 0 means a single attempt", async () => {
    const transport = new FakeTransport([[500, "one"]]);
    await expect(
      buildClient(transport, { retry: { maxRetries: 0 } }).ask({ state: {}, questions })
    ).rejects.toBeInstanceOf(ApiError);
    expect(transport.requests).toHaveLength(1);
  });
});
