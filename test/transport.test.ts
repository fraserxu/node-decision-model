import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, noul, TimeoutError, TransportError, Unauthorized } from "../src/index.js";

// Exercises the default fetch transport end to end against a local server.

interface Seen {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

let server: Server;
let baseUrl: string;
let seen: Seen[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", path: req.url ?? "", headers: req.headers, body });

      if (req.url === "/v1/systemone") {
        res.writeHead(200, {
          "Content-Type": "application/json",
          "X-Typesafe-Request-Id": "req_local",
        });
        res.end(
          JSON.stringify({
            id: "resp_local",
            model: "jev-latest",
            answers: { urgent: { type: "noul", noul: 0.42, probabilities: {} } },
            usage: { input_tokens: 7, output_tokens: 1 },
          })
        );
        return;
      }
      if (req.url === "/unauthorized/v1/systemone") {
        res.writeHead(401, { "Content-Type": "text/plain" });
        res.end("nope");
        return;
      }
      if (req.url === "/slow/v1/systemone") {
        // Never respond; the client's timeout has to fire.
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("default fetch transport", () => {
  it("posts JSON with auth headers and reads the body and headers back", async () => {
    seen = [];
    const client = new Client({ provider: "typesafe", apiKey: "local-key", baseUrl });
    const response = await client.ask({ state: "hi", questions: { urgent: noul("Urgent?") } });

    expect(response.answers.urgent.noul).toBe(0.42);
    expect(response.requestId).toBe("req_local");
    expect(response.usage).toEqual({ inputTokens: 7, outputTokens: 1, cost: null });

    const request = seen[0]!;
    expect(request.method).toBe("POST");
    expect(request.path).toBe("/v1/systemone");
    expect(request.headers.authorization).toBe("Bearer local-key");
    expect(request.headers["content-type"]).toBe("application/json");
    expect(request.headers["user-agent"]).toMatch(/^node-decision-model\//);
    expect(JSON.parse(request.body)).toEqual({
      model: "jev-latest",
      state: "hi",
      questions: { urgent: { type: "noul", instructions: "Urgent?" } },
    });
  });

  it("surfaces API errors with the body", async () => {
    const client = new Client({
      provider: "typesafe",
      apiKey: "k",
      baseUrl: `${baseUrl}/unauthorized`,
    });
    const error = await client
      .ask({ state: {}, questions: { urgent: noul("?") } })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Unauthorized);
    expect((error as Unauthorized).body).toBe("nope");
  });

  it("times out a hanging request", async () => {
    const client = new Client({
      provider: "typesafe",
      apiKey: "k",
      baseUrl: `${baseUrl}/slow`,
      timeout: 50,
      retry: { maxRetries: 0 },
    });
    const error = await client
      .ask({ state: {}, questions: { urgent: noul("?") } })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TimeoutError);
  });

  it("reports a refused connection as a TransportError", async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));

    const client = new Client({
      provider: "typesafe",
      apiKey: "k",
      baseUrl: `http://127.0.0.1:${port}`,
      retry: { maxRetries: 0 },
    });
    const error = await client
      .ask({ state: {}, questions: { urgent: noul("?") } })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TransportError);
    expect(error).not.toBeInstanceOf(TimeoutError);
  });
});
