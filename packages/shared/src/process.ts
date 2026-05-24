import { spawn } from "node:child_process";

export type CommandOutput = {
  command: string;
  exitCode: number;
};

export async function runConfiguredCommand(input: {
  command: string;
  cwd: string;
  env?: Record<string, string>;
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
