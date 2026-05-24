import { execFile } from "node:child_process";
import { readFile, mkdir, access, writeFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { constants } from "node:fs";
import os from "node:os";
import type { BuildLogEvent, ReleaseMetadata } from "@outpost/protocol";
import {
  appendLogLine,
  assertDirectory,
  formatReleaseId,
  listReleases,
  loadOutpostConfig,
  outpostPaths,
  pruneReleases,
  publishRelease,
  rollbackToRelease,
  runConfiguredCommand,
  saveOutpostState,
  readJsonFile,
  pathExists
} from "@outpost/shared";
import { runHealthCheck } from "./strictCommands.js";

export type DeployRequest = {
  branch?: string;
  commit?: string;
};

export type DeployResult = {
  releaseId: string;
  commit: string;
};

export async function deployStaticProject(input: {
  projectRoot?: string;
  request: DeployRequest;
  env?: Record<string, string>;
  onLog?: (event: BuildLogEvent) => void;
}): Promise<DeployResult> {
  const projectRoot = input.projectRoot ?? process.cwd();
  const config = await loadOutpostConfig(projectRoot);
  const paths = outpostPaths(projectRoot);
  const deploymentId = `deploy-${Date.now()}`;
  const startedAt = Date.now();
  await saveOutpostState(projectRoot, { state: "DEPLOYING" });

  const systemLog = (line: string) =>
    emitBuildLog({ paths, deploymentId, stream: "system", line, onLog: input.onLog });
  const commandLog = (stream: "stdout" | "stderr", line: string) =>
    emitBuildLog({ paths, deploymentId, stream, line, onLog: input.onLog });

  try {
    await assertCleanWorkingTree(projectRoot);
    await systemLog("Fetching git remotes");
    await git(projectRoot, ["fetch", "--all", "--prune"]);

    if (input.request.commit) {
      await systemLog(`Checking out commit ${input.request.commit}`);
      await git(projectRoot, ["checkout", input.request.commit]);
    } else if (input.request.branch) {
      await systemLog(`Checking out branch ${input.request.branch}`);
      await git(projectRoot, ["checkout", input.request.branch]);
      await git(projectRoot, ["pull", "--ff-only"]);
    }

    if (config.installCommand) {
      await systemLog(`Running install command: ${config.installCommand}`);
      await runOrFail(config.installCommand, projectRoot, input.env, commandLog);
    }

    if (config.buildCommand) {
      await systemLog(`Running build command: ${config.buildCommand}`);
      await runOrFail(config.buildCommand, projectRoot, input.env, commandLog);
    }

    const commit = (await git(projectRoot, ["rev-parse", "--short", "HEAD"])).trim();
    const outputDir = join(projectRoot, config.outputDir ?? "dist");
    await assertDirectory(outputDir, "Configured build output directory");

    const createdAt = new Date();
    const releaseId = formatReleaseId(createdAt, commit);
    const metadata: ReleaseMetadata = {
      releaseId,
      createdAt: createdAt.toISOString(),
      branch: input.request.branch,
      commit,
      status: "success",
      buildCommand: config.buildCommand ?? "none",
      outputDir: config.outputDir ?? "dist",
      durationMs: Date.now() - startedAt
    };

    await systemLog(`Publishing release ${releaseId}`);
    await publishRelease({ projectRoot, releaseId, outputDir, metadata });
    await pruneReleases(projectRoot, config.retainReleases, releaseId);
    await saveOutpostState(projectRoot, {
      state: "PAIRED_ONLINE",
      currentReleaseId: releaseId,
      currentBranch: input.request.branch,
      currentCommit: commit
    });
    return { releaseId, commit };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await systemLog(`Deployment failed: ${message}`);
    await saveOutpostState(projectRoot, { state: "ERROR", lastError: message });
    throw error;
  }
}

export async function rollbackRelease(input: {
  projectRoot?: string;
  releaseId: string;
}): Promise<void> {
  const projectRoot = input.projectRoot ?? process.cwd();
  await saveOutpostState(projectRoot, { state: "ROLLING_BACK" });
  await rollbackToRelease(projectRoot, input.releaseId);

  const paths = outpostPaths(projectRoot);
  const config = await loadOutpostConfig(projectRoot);

  // Restart systemd service if configured
  if (config.startCommand) {
    const serviceName = config.systemd?.serviceName ?? `outpost-${config.projectName}`;
    const isSystem = await isSystemdSystemWritable();
    try {
      await reloadAndRestartService(serviceName, isSystem);
    } catch (err) {
      console.error(
        `Failed to restart service on rollback: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // Restart Docker containers if configured
  let hasCompose = false;
  let composeFile = "docker-compose.yml";
  for (const name of ["docker-compose.yml", "compose.yml", "docker-compose.yaml", "compose.yaml"]) {
    if (await pathExists(join(paths.live, name))) {
      composeFile = name;
      hasCompose = true;
      break;
    }
  }
  if (hasCompose) {
    const cmd = `docker compose -f ${join(paths.live, composeFile)} up -d --remove-orphans`;
    try {
      await runOrFail(cmd, paths.live, undefined, () => {});
    } catch (err) {
      console.error(
        `Failed to restart Docker containers on rollback: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  const release = (await listReleases(projectRoot)).find(
    (item) => item.releaseId === input.releaseId
  );
  await saveOutpostState(projectRoot, {
    state: "PAIRED_ONLINE",
    currentReleaseId: input.releaseId,
    currentBranch: release?.branch,
    currentCommit: release?.commit
  });
}

export async function getCurrentCommit(projectRoot = process.cwd()): Promise<string | undefined> {
  return git(projectRoot, ["rev-parse", "--short", "HEAD"])
    .then((value) => value.trim())
    .catch(() => undefined);
}

async function runOrFail(
  command: string,
  cwd: string,
  env: Record<string, string> | undefined,
  onLine: (stream: "stdout" | "stderr", line: string) => void
): Promise<void> {
  const result = await runConfiguredCommand({ command, cwd, env, onLine });
  if (result.exitCode !== 0) {
    throw new Error(`Command failed with exit code ${result.exitCode}: ${command}`);
  }
}

async function assertCleanWorkingTree(projectRoot: string): Promise<void> {
  const status = await git(projectRoot, ["status", "--porcelain", "--untracked-files=no"]);
  if (status.trim().length > 0) {
    throw new Error(
      "Git working tree has tracked local changes. Commit, stash, or reset them before deploying."
    );
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message));
        return;
      }
      resolve(stdout);
    });
  });
}

async function emitBuildLog(input: {
  paths: ReturnType<typeof outpostPaths>;
  deploymentId: string;
  stream: "stdout" | "stderr" | "system";
  line: string;
  onLog?: (event: BuildLogEvent) => void;
}): Promise<void> {
  const event: BuildLogEvent = {
    deploymentId: input.deploymentId,
    stream: input.stream,
    line: input.line,
    createdAt: new Date().toISOString()
  };
  await appendLogLine(
    input.paths.buildsLog,
    `[${event.deploymentId}] [${event.stream}] ${event.line}`
  );
  input.onLog?.(event);
}

export async function readPinnedMothershipKey(projectRoot = process.cwd()): Promise<string> {
  return readFile(outpostPaths(projectRoot).mothershipPublicKey, "utf8");
}

async function isSystemdSystemWritable(): Promise<boolean> {
  if (process.platform !== "linux") return false;
  try {
    await access("/etc/systemd/system", constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function writeSystemdUnit(input: {
  serviceName: string;
  projectName: string;
  user?: string;
  workingDirectory: string;
  startCommand: string;
  port: number;
  env?: Record<string, string>;
}): Promise<{ isSystem: boolean; unitPath: string }> {
  const isSystem = await isSystemdSystemWritable();
  let unitPath: string;
  let userLine = "";
  let wantedBy = "default.target";

  if (isSystem) {
    unitPath = `/etc/systemd/system/${input.serviceName}.service`;
    const targetUser = input.user ?? os.userInfo().username;
    userLine = `User=${targetUser}`;
    wantedBy = "multi-user.target";
  } else {
    const userDir = join(os.homedir(), ".config", "systemd", "user");
    await mkdir(userDir, { recursive: true });
    unitPath = join(userDir, `${input.serviceName}.service`);
  }

  // Generate env lines
  const envLines: string[] = [`Environment="PORT=${input.port}"`];
  // Pass the current process's PATH so user-level node/npm can be found if installed via nvm/fnm
  if (process.env.PATH) {
    envLines.push(`Environment="PATH=${process.env.PATH}"`);
  }
  if (input.env) {
    for (const [key, val] of Object.entries(input.env)) {
      envLines.push(`Environment="${key}=${val}"`);
    }
  }

  const content = `[Unit]
Description=Outpost Node Service - ${input.projectName}
After=network.target

[Service]
Type=simple
${userLine}
WorkingDirectory=${input.workingDirectory}
ExecStart=/bin/sh -c "${input.startCommand}"
Restart=always
${envLines.join("\n")}

[Install]
WantedBy=${wantedBy}
`;

  await writeFile(unitPath, content, "utf8");
  return { isSystem, unitPath };
}

async function reloadAndRestartService(serviceName: string, isSystem: boolean): Promise<void> {
  const systemctl = "systemctl";
  const reloadArgs = isSystem ? ["daemon-reload"] : ["--user", "daemon-reload"];
  const enableArgs = isSystem ? ["enable", serviceName] : ["--user", "enable", serviceName];
  const restartArgs = isSystem ? ["restart", serviceName] : ["--user", "restart", serviceName];

  await runCmd(systemctl, reloadArgs);
  await runCmd(systemctl, enableArgs);
  await runCmd(systemctl, restartArgs);
}

function runCmd(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message));
        return;
      }
      resolve(stdout);
    });
  });
}

export async function deployServiceProject(input: {
  projectRoot?: string;
  request: DeployRequest;
  port: number;
  startCommand: string;
  healthUrl?: string;
  systemd?: {
    serviceName?: string;
    user?: string;
    env?: Record<string, string>;
  };
  env?: Record<string, string>;
  onLog?: (event: BuildLogEvent) => void;
}): Promise<DeployResult> {
  const projectRoot = input.projectRoot ?? process.cwd();
  const config = await loadOutpostConfig(projectRoot);
  const paths = outpostPaths(projectRoot);
  const deploymentId = `deploy-${Date.now()}`;
  const startedAt = Date.now();
  await saveOutpostState(projectRoot, { state: "DEPLOYING" });

  const systemLog = (line: string) =>
    emitBuildLog({ paths, deploymentId, stream: "system", line, onLog: input.onLog });
  const commandLog = (stream: "stdout" | "stderr", line: string) =>
    emitBuildLog({ paths, deploymentId, stream, line, onLog: input.onLog });

  // Keep track of the active release before this deployment for rollback
  const releasesBefore = await listReleases(projectRoot);
  const stateFile = await readJsonFile<{ currentReleaseId?: string }>(paths.state).catch(
    () => undefined
  );
  const activeReleaseBefore = stateFile?.currentReleaseId;

  try {
    await assertCleanWorkingTree(projectRoot);
    await systemLog("Fetching git remotes");
    await git(projectRoot, ["fetch", "--all", "--prune"]);

    if (input.request.commit) {
      await systemLog(`Checking out commit ${input.request.commit}`);
      await git(projectRoot, ["checkout", input.request.commit]);
    } else if (input.request.branch) {
      await systemLog(`Checking out branch ${input.request.branch}`);
      await git(projectRoot, ["checkout", input.request.branch]);
      await git(projectRoot, ["pull", "--ff-only"]);
    }

    if (config.installCommand) {
      await systemLog(`Running install command: ${config.installCommand}`);
      await runOrFail(config.installCommand, projectRoot, input.env, commandLog);
    }

    if (config.buildCommand) {
      await systemLog(`Running build command: ${config.buildCommand}`);
      await runOrFail(config.buildCommand, projectRoot, input.env, commandLog);
    }

    const commit = (await git(projectRoot, ["rev-parse", "--short", "HEAD"])).trim();

    const createdAt = new Date();
    const releaseId = formatReleaseId(createdAt, commit);
    const metadata: ReleaseMetadata = {
      releaseId,
      createdAt: createdAt.toISOString(),
      branch: input.request.branch,
      commit,
      status: "success",
      buildCommand: config.buildCommand ?? "none",
      outputDir: config.outputDir ?? ".",
      durationMs: Date.now() - startedAt
    };

    await systemLog(`Publishing release ${releaseId}`);
    // Filter to exclude .git and .outpost directories
    const gitAndOutpostFilter = (src: string) => {
      const base = basename(src);
      return base !== ".git" && base !== ".outpost";
    };

    await publishRelease({
      projectRoot,
      releaseId,
      outputDir: projectRoot, // Copy the entire projectRoot
      metadata,
      filter: gitAndOutpostFilter
    });

    // Write or update systemd service unit
    const serviceName = input.systemd?.serviceName ?? `outpost-${config.projectName}`;
    await systemLog(`Configuring systemd service: ${serviceName}`);
    const { isSystem, unitPath } = await writeSystemdUnit({
      serviceName,
      projectName: config.projectName,
      user: input.systemd?.user,
      workingDirectory: paths.live, // point working dir to the symlink!
      startCommand: input.startCommand,
      port: input.port,
      env: {
        ...input.systemd?.env,
        ...input.env
      }
    });
    await systemLog(
      `Systemd service unit written to ${unitPath} (${isSystem ? "system-level" : "user-level"})`
    );

    await systemLog(`Starting/Restarting service ${serviceName}`);
    await reloadAndRestartService(serviceName, isSystem);

    // Health check retries
    let healthOk = false;
    let healthMsg = "";
    const healthCheckUrl = input.healthUrl ?? `http://localhost:${input.port}/health`;

    await systemLog(`Running health check against ${healthCheckUrl} (up to 5 retries)`);
    for (let attempt = 1; attempt <= 5; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const health = await runHealthCheck(healthCheckUrl);
      if (health.ok) {
        healthOk = true;
        healthMsg = health.message;
        break;
      } else {
        healthMsg = health.message;
        await systemLog(`Health check attempt ${attempt} failed: ${healthMsg}`);
      }
    }

    if (!healthOk) {
      throw new Error(`Service failed health check: ${healthMsg}`);
    }

    await systemLog(`Health check passed: ${healthMsg}`);
    await pruneReleases(projectRoot, config.retainReleases, releaseId);

    // Save successful state
    await saveOutpostState(projectRoot, {
      state: "PAIRED_ONLINE",
      currentReleaseId: releaseId,
      currentBranch: input.request.branch,
      currentCommit: commit
    });

    return { releaseId, commit };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await systemLog(`Deployment failed: ${message}`);
    await saveOutpostState(projectRoot, { state: "ERROR", lastError: message });

    // Rollback Boundary: if we have a previous successful release, automatically roll back!
    if (activeReleaseBefore) {
      await systemLog(`Triggering automatic rollback to previous release: ${activeReleaseBefore}`);
      try {
        await rollbackToRelease(projectRoot, activeReleaseBefore);
        const serviceName = input.systemd?.serviceName ?? `outpost-${config.projectName}`;
        const isSystem = await isSystemdSystemWritable();
        await systemLog(`Restarting service ${serviceName} on previous release`);
        await reloadAndRestartService(serviceName, isSystem);
        await saveOutpostState(projectRoot, {
          state: "PAIRED_ONLINE",
          currentReleaseId: activeReleaseBefore,
          currentBranch: releasesBefore.find((r) => r.releaseId === activeReleaseBefore)?.branch,
          currentCommit: releasesBefore.find((r) => r.releaseId === activeReleaseBefore)?.commit
        });
        await systemLog(`Automatic rollback to ${activeReleaseBefore} succeeded.`);
      } catch (rollbackError) {
        const rollbackMsg =
          rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
        await systemLog(`Automatic rollback failed: ${rollbackMsg}`);
      }
    }

    throw error;
  }
}

export async function deployDockerProject(input: {
  projectRoot?: string;
  request: DeployRequest;
  port: number;
  healthUrl?: string;
  env?: Record<string, string>;
  onLog?: (event: BuildLogEvent) => void;
}): Promise<DeployResult> {
  const projectRoot = input.projectRoot ?? process.cwd();
  const config = await loadOutpostConfig(projectRoot);
  const paths = outpostPaths(projectRoot);
  const deploymentId = `deploy-${Date.now()}`;
  const startedAt = Date.now();
  await saveOutpostState(projectRoot, { state: "DEPLOYING" });

  const systemLog = (line: string) =>
    emitBuildLog({ paths, deploymentId, stream: "system", line, onLog: input.onLog });
  const commandLog = (stream: "stdout" | "stderr", line: string) =>
    emitBuildLog({ paths, deploymentId, stream, line, onLog: input.onLog });

  const releasesBefore = await listReleases(projectRoot);
  const stateFile = await readJsonFile<{ currentReleaseId?: string }>(paths.state).catch(
    () => undefined
  );
  const activeReleaseBefore = stateFile?.currentReleaseId;

  try {
    await assertCleanWorkingTree(projectRoot);
    await systemLog("Fetching git remotes");
    await git(projectRoot, ["fetch", "--all", "--prune"]);

    if (input.request.commit) {
      await systemLog(`Checking out commit ${input.request.commit}`);
      await git(projectRoot, ["checkout", input.request.commit]);
    } else if (input.request.branch) {
      await systemLog(`Checking out branch ${input.request.branch}`);
      await git(projectRoot, ["checkout", input.request.branch]);
      await git(projectRoot, ["pull", "--ff-only"]);
    }

    const commit = (await git(projectRoot, ["rev-parse", "--short", "HEAD"])).trim();
    const createdAt = new Date();
    const releaseId = formatReleaseId(createdAt, commit);
    const metadata: ReleaseMetadata = {
      releaseId,
      createdAt: createdAt.toISOString(),
      branch: input.request.branch,
      commit,
      status: "success",
      buildCommand: "docker compose up -d --build",
      outputDir: ".",
      durationMs: Date.now() - startedAt
    };

    await systemLog(`Publishing release ${releaseId}`);
    const gitAndOutpostFilter = (src: string) => {
      const base = basename(src);
      return base !== ".git" && base !== ".outpost";
    };

    await publishRelease({
      projectRoot,
      releaseId,
      outputDir: projectRoot,
      metadata,
      filter: gitAndOutpostFilter
    });

    // Detect which compose file exists in the live folder
    let composeFile = "docker-compose.yml";
    for (const name of [
      "docker-compose.yml",
      "compose.yml",
      "docker-compose.yaml",
      "compose.yaml"
    ]) {
      if (await pathExists(join(paths.live, name))) {
        composeFile = name;
        break;
      }
    }

    const cmd = `docker compose -f ${join(paths.live, composeFile)} up -d --build --remove-orphans`;
    await systemLog(`Running command: ${cmd}`);
    await runOrFail(cmd, paths.live, input.env, commandLog);

    // Health check retries
    let healthOk = false;
    let healthMsg = "";
    const healthCheckUrl = input.healthUrl ?? `http://localhost:${input.port}/health`;

    await systemLog(`Running health check against ${healthCheckUrl} (up to 5 retries)`);
    for (let attempt = 1; attempt <= 5; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const health = await runHealthCheck(healthCheckUrl);
      if (health.ok) {
        healthOk = true;
        healthMsg = health.message;
        break;
      } else {
        healthMsg = health.message;
        await systemLog(`Health check attempt ${attempt} failed: ${healthMsg}`);
      }
    }

    if (!healthOk) {
      throw new Error(`Docker service failed health check: ${healthMsg}`);
    }

    await systemLog(`Health check passed: ${healthMsg}`);
    await pruneReleases(projectRoot, config.retainReleases, releaseId);

    await saveOutpostState(projectRoot, {
      state: "PAIRED_ONLINE",
      currentReleaseId: releaseId,
      currentBranch: input.request.branch,
      currentCommit: commit
    });

    return { releaseId, commit };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await systemLog(`Docker deployment failed: ${message}`);
    await saveOutpostState(projectRoot, { state: "ERROR", lastError: message });

    // Rollback Boundary: restore previous compose rollout!
    if (activeReleaseBefore) {
      await systemLog(`Triggering automatic rollback to previous release: ${activeReleaseBefore}`);
      try {
        await rollbackToRelease(projectRoot, activeReleaseBefore);
        let composeFile = "docker-compose.yml";
        for (const name of [
          "docker-compose.yml",
          "compose.yml",
          "docker-compose.yaml",
          "compose.yaml"
        ]) {
          if (await pathExists(join(paths.live, name))) {
            composeFile = name;
            break;
          }
        }
        const cmd = `docker compose -f ${join(paths.live, composeFile)} up -d --remove-orphans`;
        await systemLog(`Running rollback command: ${cmd}`);
        await runOrFail(cmd, paths.live, input.env, commandLog);

        await saveOutpostState(projectRoot, {
          state: "PAIRED_ONLINE",
          currentReleaseId: activeReleaseBefore,
          currentBranch: releasesBefore.find((r) => r.releaseId === activeReleaseBefore)?.branch,
          currentCommit: releasesBefore.find((r) => r.releaseId === activeReleaseBefore)?.commit
        });
        await systemLog(`Automatic rollback to ${activeReleaseBefore} succeeded.`);
      } catch (rollbackError) {
        const rollbackMsg =
          rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
        await systemLog(`Automatic rollback failed: ${rollbackMsg}`);
      }
    }

    throw error;
  }
}
