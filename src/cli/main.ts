#!/usr/bin/env node
// The `decision-model` executable. All logic lives in run.ts so it can be
// tested without spawning a process; this file only wires up process streams.
import { fstatSync } from "node:fs";
import { run } from "./run.js";

// A consumer such as `| head` closing the pipe early is not an error.
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});

/**
 * Stdin is read implicitly only when something is actually arriving on it:
 * a pipe (`cat x | decision-model`) or a redirected file (`< x`). A terminal,
 * /dev/null, or a device an agent's shell leaves open but never writes to
 * counts as no input, so the command never blocks waiting for it.
 */
function stdinIsPiped(): boolean {
  try {
    const stat = fstatSync(0);
    return stat.isFIFO() || stat.isFile();
  } catch {
    return false;
  }
}

async function readStdin(): Promise<string> {
  process.stdin.setEncoding("utf8");
  const chunks: string[] = [];
  for await (const chunk of process.stdin) chunks.push(String(chunk));
  return chunks.join("");
}

process.exitCode = await run(process.argv.slice(2), {
  stdout: { write: (chunk) => process.stdout.write(chunk), isTTY: process.stdout.isTTY === true },
  stderr: process.stderr,
  stdin: { piped: stdinIsPiped(), read: readStdin },
  env: process.env,
  now: () => performance.now(),
});
