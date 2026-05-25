/**
 * @module @outpost/shared/process
 *
 * Child-process helpers for running shell commands and streaming their
 * stdout / stderr line-by-line.
 */

import { spawn } from "node:child_process";

/**
 * Result of a spawned command.
 */
export type CommandOutput = {
  /** The command string that was executed. */
  command: string;
  /** Process exit code. */
  exitCode: number;
};

/**
 * Runs a shell command in a given working directory, streaming each line to an
 * optional callback.
 *
 * @param input - Command configuration.
 * @returns A promise that resolves when the process exits.
 */
export async function runConfiguredCommand(input: {
  /** Shell command to execute. */
  command: string;
  /** Working directory for the child process. */
  cwd: string;
  /** Optional environment variables to merge into `process.env`. */
  env?: Record<string, string>;
  /** Optional callback invoked for every emitted line. */
  onLine?: (stream: "stdout" | "stderr", line: string) => void;
}): Promise<CommandOutput> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.command, {
      cwd: input.cwd,
      shell: true,
      env: { ...process.env, ...input.env },
      stdio: ["ignore", "pipe", "pipe"]
    });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => emitLines("stdout", chunk, input.onLine));
    child.stderr.on("data", (chunk: string) => emitLines("stderr", chunk, input.onLine));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ command: input.command, exitCode: code ?? 1 });
    });
  });
}

function emitLines(
  stream: "stdout" | "stderr",
  chunk: string,
  onLine?: (stream: "stdout" | "stderr", line: string) => void
): void {
  for (const line of chunk.split(/\r?\n/)) {
    if (line.length > 0) {
      onLine?.(stream, line);
    }
  }
}
