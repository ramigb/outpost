/**
 * @module @outpost/daemon/setup
 *
 * High-level setup orchestration: validates prerequisites, links the Outpost,
 * optionally deploys, and optionally starts the daemon.
 */

import { execFile } from "node:child_process";
import { basename } from "node:path";
import { deployStaticProject } from "./deploy.js";
import { startDaemon } from "./daemon.js";
import { linkOutpost } from "./link.js";
import {
  loadOutpostConfig,
  outpostPaths,
  pathExists,
  saveOutpostConfig,
  type OutpostConfig
} from "@outpost/shared";

/**
 * Options accepted by the `setup` CLI command.
 */
export type SetupOptions = {
  /** Base64-encoded pairing token from Mothership. */
  pair: string;
  installCommand?: string;
  buildCommand?: string;
  outputDir?: string;
  retainReleases?: number;
  projectName?: string;
  /** Whether to trigger an immediate deploy after setup. */
  deploy?: boolean;
  /** Whether to start the daemon after setup. Defaults to `true`. */
  startDaemon?: boolean;
};

/**
 * Runs the full Outpost setup workflow.
 *
 * @param options - Setup parameters.
 * @param projectRoot - Directory of the managed project.
 * @throws Error when prerequisites are missing or setup fails.
 */
export async function setupOutpost(
  options: SetupOptions,
  projectRoot = process.cwd()
): Promise<void> {
  await assertNodeVersion();
  await assertGitAvailable();
  await assertGitRepository(projectRoot);

  const linkResult = await linkOutpost(options.pair, projectRoot);
  const config = await applySetupOverrides(projectRoot, options);

  if (options.deploy) {
    await deployStaticProject({ projectRoot, request: {} });
  }

  printSetupSummary(config, projectRoot, linkResult.mothershipPeerId);
  if (options.startDaemon ?? true) {
    await startDaemon(projectRoot);
  }
}

async function applySetupOverrides(
  projectRoot: string,
  options: SetupOptions
): Promise<OutpostConfig> {
  const config = await loadOutpostConfig(projectRoot);
  const next: OutpostConfig = {
    ...config,
    projectName: options.projectName ?? config.projectName,
    installCommand: options.installCommand ?? config.installCommand,
    buildCommand: options.buildCommand ?? config.buildCommand,
    outputDir: options.outputDir ?? config.outputDir,
    retainReleases: options.retainReleases ?? config.retainReleases
  };
  await saveOutpostConfig(projectRoot, next);
  return next;
}

function printSetupSummary(
  config: OutpostConfig,
  projectRoot: string,
  mothershipPeerId: string
): void {
  const paths = outpostPaths(projectRoot);
  console.log("");
  console.log("Outpost setup complete");
  console.log("");
  console.log(`Project   ${config.projectName || basename(projectRoot)}`);
  console.log(`Builder   ${config.builder}`);
  if (config.installCommand) {
    console.log(`Install   ${config.installCommand}`);
  }
  console.log(`Build     ${config.buildCommand}`);
  console.log(`Output    ${config.outputDir}`);
  console.log(`Serve     ${paths.live}`);
  console.log(`Beacon    ${config.beaconUrl ?? "not configured"}`);
  console.log(`Control   ${mothershipPeerId}`);
  console.log("");
  console.log("Mothership has detected this Outpost once the Beacon connection opens.");
  console.log("Next: click Deploy.");
  console.log("");
}

async function assertNodeVersion(): Promise<void> {
  const major = Number(process.versions.node.split(".")[0]);
  if (!Number.isFinite(major) || major < 20) {
    throw new Error(`Node.js 20 or newer is required. Current version: ${process.version}`);
  }
}

async function assertGitAvailable(): Promise<void> {
  await run("git", ["--version"], process.cwd()).catch(() => {
    throw new Error("git is required but was not found on PATH.");
  });
}

async function assertGitRepository(projectRoot: string): Promise<void> {
  const result = await run("git", ["rev-parse", "--is-inside-work-tree"], projectRoot).catch(
    () => ""
  );
  if (result.trim() !== "true") {
    throw new Error(
      "Current directory is not a git repository. Run setup from the app repository root."
    );
  }
}

/** Runs a git command in the given directory. */
export async function runGit(projectRoot: string, args: string[]): Promise<string> {
  return run("git", args, projectRoot);
}

/** Checks whether the live symlink already exists. */
export async function outpostLiveExists(projectRoot: string): Promise<boolean> {
  return pathExists(outpostPaths(projectRoot).live);
}

function run(command: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message));
        return;
      }
      resolve(stdout);
    });
  });
}
