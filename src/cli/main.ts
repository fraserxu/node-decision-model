#!/usr/bin/env node
// The `decision-model` executable. All logic lives in run.ts so it can be
// tested without spawning a process; this file only wires up process streams.
import { run } from "./run.js";

// A consumer such as `| head` closing the pipe early is not an error.
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});

async function readStdin(): Promise<string> {
  process.stdin.setEncoding("utf8");
  const chunks: string[] = [];
  for await (const chunk of process.stdin) chunks.push(String(chunk));
  return chunks.join("");
}

process.exitCode = await run(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
  stdin: { isTTY: process.stdin.isTTY === true, read: readStdin },
});
