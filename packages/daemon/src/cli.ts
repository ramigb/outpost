/**
 * @module @outpost/daemon/cli
 *
 * Command-line interface for the Outpost daemon.
 *
 * Supports `init`, `link`, `start`, `setup`, `doctor`, and `deploy` subcommands.
 *
 * @example
 * ```bash
 * outpost-daemon init
 * outpost-daemon link --payload <base64>
 * outpost-daemon start
 * outpost-daemon setup --pair <token> --deploy
 * outpost-daemon doctor
 * outpost-daemon deploy --branch main
 * ```
 */

import { linkOutpost } from "./link.js";
import { initOutpost } from "./init.js";
import { startDaemon } from "./daemon.js";
import { deployStaticProject } from "./deploy.js";
import { printDoctor, runDoctor } from "./doctor.js";
import { setupOutpost } from "./setup.js";

const [, , command, ...args] = process.argv;

try {
  if (command === "init") {
    await initOutpost();
    console.log("Outpost initialized in .outpost/");
  } else if (command === "link") {
    const payload = readFlag(args, "--payload");
    if (!payload) {
      throw new Error("Missing required --payload <base64>");
    }
    const result = await linkOutpost(payload);
    console.log(
      `Outpost linked. outpost=${result.outpostPeerId} mothership=${result.mothershipPeerId}`
    );
  } else if (command === "start") {
    await startDaemon();
    console.log("Outpost daemon started");
  } else if (command === "setup") {
    const pair = readFlag(args, "--pair");
    if (!pair) {
      throw new Error("Missing required --pair <pairing-token>");
    }
    await setupOutpost({
      pair,
      installCommand: readFlag(args, "--install"),
      buildCommand: readFlag(args, "--build"),
      outputDir: readFlag(args, "--output"),
      retainReleases: readNumberFlag(args, "--retain"),
      projectName: readFlag(args, "--project-name"),
      deploy: hasFlag(args, "--deploy"),
      startDaemon: !hasFlag(args, "--no-start")
    });
  } else if (command === "doctor") {
    printDoctor(await runDoctor());
  } else if (command === "deploy") {
    const result = await deployStaticProject({
      request: {
        branch: readFlag(args, "--branch"),
        commit: readFlag(args, "--commit")
      }
    });
    console.log(`Outpost deployed release ${result.releaseId} at ${result.commit}`);
  } else {
    console.error("Usage: outpost-daemon <init|link|start|setup|doctor|deploy> [options]");
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

/** Reads the value immediately following a CLI flag, or returns `undefined`. */
function readFlag(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

/** Reads a positive integer flag value. */
function readNumberFlag(args: string[], flag: string): number | undefined {
  const value = readFlag(args, flag);
  if (value === undefined) {
    return undefined;
  }
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return number;
}

/** Returns `true` when the flag is present in the argument list. */
function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}
