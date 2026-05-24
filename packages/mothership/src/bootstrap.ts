import { spawn } from "node:child_process";
import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { pathExists, readJsonFile, writeJsonFile } from "@outpost/shared";
import { createPairingCommand, mothershipPaths } from "./state.js";

export type BootstrapRequest = {
  sshTarget: string;
  repo: string;
  beaconUrl?: string;
  projectPath?: string;
  displayName?: string;
  installCommand?: string;
  buildCommand?: string;
  outputDir?: string;
  retainReleases?: number;
  deploy?: boolean;
};

export type BootstrapOperation = {
  id: string;
  status: "running" | "success" | "failed";
  sshTarget: string;
  repo: string;
  repoKind: "local" | "remote";
  projectPath: string;
  beaconUrl: string;
  startedAt: string;
  finishedAt?: string;
  exitCode?: number;
  error?: string;
  logs: Array<{ stream: "stdout" | "stderr" | "system"; line: string; createdAt: string }>;
};

export async function listBootstrapOperations(): Promise<BootstrapOperation[]> {
  const path = mothershipPaths().bootstrapOperations;
  if (!(await pathExists(path))) {
    return [];
  }
  return readJsonFile<BootstrapOperation[]>(path);
}

export async function startBootstrap(input: BootstrapRequest): Promise<BootstrapOperation> {
  const sshTarget = assertSshTarget(input.sshTarget);
  const repo = input.repo.trim();
  if (!repo) {
    throw new Error("repo is required");
  }
  const repoKind = await detectRepoKind(repo);
  const projectName = input.displayName?.trim() || projectNameFromRepo(repo);
  const projectPath = sanitizeRemotePath(input.projectPath || `outpost-apps/${projectName}`);
  const pairing = await createPairingCommand({
    beaconUrl: input.beaconUrl,
    displayName: projectName,
    buildHints: {
      installCommand: input.installCommand,
      buildCommand: input.buildCommand,
      outputDir: input.outputDir,
      projectName,
      retainReleases: input.retainReleases
    }
  });
  const operation: BootstrapOperation = {
    id: `boot_${Date.now().toString(36)}`,
    status: "running",
    sshTarget,
    repo,
    repoKind,
    projectPath,
    beaconUrl: pairing.payload.beaconUrl,
    startedAt: new Date().toISOString(),
    logs: []
  };
  await saveOperation(operation);
  void runBootstrap(operation, pairing.encoded, input.deploy === true);
  return operation;
}

async function runBootstrap(
  operation: BootstrapOperation,
  pairingToken: string,
  deploy: boolean
): Promise<void> {
  try {
    appendLog(operation, "system", `Connecting to ${operation.sshTarget}`);
    const exitCode =
      operation.repoKind === "local"
        ? await bootstrapLocalRepo(operation, pairingToken, deploy)
        : await bootstrapRemoteRepo(operation, pairingToken, deploy);
    operation.exitCode = exitCode;
    operation.status = exitCode === 0 ? "success" : "failed";
    if (exitCode !== 0) {
      operation.error = `Bootstrap exited with code ${exitCode}`;
    }
  } catch (error) {
    operation.status = "failed";
    operation.error = error instanceof Error ? error.message : String(error);
    appendLog(operation, "stderr", operation.error);
  } finally {
    operation.finishedAt = new Date().toISOString();
    await saveOperation(operation);
  }
}

function buildRuntimeProvisioningScript(): string {
  return [
    "# Self-healing runtime installation",
    "if ! command -v git >/dev/null 2>&1 || ! command -v node >/dev/null 2>&1; then",
    "  echo 'Mothership: Installing git and curl dependencies...'",
    "  sudo apt-get update -y && sudo apt-get install -y git curl || true",
    "  if ! command -v node >/dev/null 2>&1; then",
    "    echo 'Mothership: Installing NodeJS 20...'",
    "    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - || true",
    "    sudo apt-get install -y nodejs || true",
    "  fi",
    "fi",
    "if ! command -v docker >/dev/null 2>&1; then",
    "  echo 'Mothership: Installing Docker runtime...'",
    "  sudo apt-get update -y && sudo apt-get install -y docker.io || true",
    "  sudo systemctl start docker || true",
    "  sudo systemctl enable docker || true",
    "fi",
    ""
  ].join("\n");
}

async function bootstrapRemoteRepo(
  operation: BootstrapOperation,
  pairingToken: string,
  deploy: boolean
): Promise<number> {
  const provision = buildRuntimeProvisioningScript();
  const deploySteps = [
    `mkdir -p ${shellQuote(dirname(operation.projectPath))}`,
    `if [ -d ${shellQuote(`${operation.projectPath}/.git`)} ]; then git -C ${shellQuote(operation.projectPath)} fetch --all --prune; else rm -rf ${shellQuote(operation.projectPath)} && git clone ${shellQuote(operation.repo)} ${shellQuote(operation.projectPath)}; fi`,
    `cd ${shellQuote(operation.projectPath)}`,
    daemonSetupCommand(pairingToken, deploy),
    `nohup npx @outpost/daemon start > .outpost/logs/daemon.log 2>&1 &`
  ].join(" && ");
  const command = `${provision}\n${deploySteps}`;
  return runProcess(operation, "ssh", [operation.sshTarget, command]);
}

async function bootstrapLocalRepo(
  operation: BootstrapOperation,
  pairingToken: string,
  deploy: boolean
): Promise<number> {
  const localPath = expandLocalPath(operation.repo);
  const stat = await lstat(localPath);
  if (!stat.isDirectory()) {
    throw new Error(`Local repo must be a directory: ${localPath}`);
  }
  const remotePrepare = `rm -rf ${shellQuote(operation.projectPath)} && mkdir -p ${shellQuote(operation.projectPath)}`;
  const prepareCode = await runProcess(operation, "ssh", [operation.sshTarget, remotePrepare]);
  if (prepareCode !== 0) {
    return prepareCode;
  }

  const tar = spawn("tar", ["-czf", "-", "-C", dirname(localPath), basename(localPath)], {
    stdio: ["ignore", "pipe", "pipe"]
  });
  const ssh = spawn(
    "ssh",
    [
      operation.sshTarget,
      `tar -xzf - -C ${shellQuote(operation.projectPath)} --strip-components=1`
    ],
    { stdio: ["pipe", "pipe", "pipe"] }
  );
  tar.stdout.pipe(ssh.stdin);
  pipeLogs(operation, "stderr", tar.stderr);
  pipeLogs(operation, "stdout", ssh.stdout);
  pipeLogs(operation, "stderr", ssh.stderr);
  const copyCode = await waitForPipedProcesses(tar, ssh);
  if (copyCode !== 0) {
    return copyCode;
  }

  const provision = buildRuntimeProvisioningScript();
  const deploySteps = [
    `cd ${shellQuote(operation.projectPath)}`,
    daemonSetupCommand(pairingToken, deploy),
    `nohup npx @outpost/daemon start > .outpost/logs/daemon.log 2>&1 &`
  ].join(" && ");
  const command = `${provision}\n${deploySteps}`;
  return runProcess(operation, "ssh", [operation.sshTarget, command]);
}

function daemonSetupCommand(pairingToken: string, deploy: boolean): string {
  return [
    "npx @outpost/daemon setup",
    "--pair",
    shellQuote(pairingToken),
    "--no-start",
    deploy ? "--deploy" : ""
  ]
    .filter(Boolean)
    .join(" ");
}

function runProcess(
  operation: BootstrapOperation,
  command: string,
  args: string[]
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    pipeLogs(operation, "stdout", child.stdout);
    pipeLogs(operation, "stderr", child.stderr);
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}

function pipeLogs(
  operation: BootstrapOperation,
  stream: "stdout" | "stderr",
  readable: NodeJS.ReadableStream
): void {
  readable.setEncoding("utf8");
  readable.on("data", (chunk: string) => {
    for (const line of chunk.split(/\r?\n/)) {
      if (line) {
        appendLog(operation, stream, line);
      }
    }
  });
}

function waitForPipedProcesses(
  tar: ReturnType<typeof spawn>,
  ssh: ReturnType<typeof spawn>
): Promise<number> {
  return new Promise((resolve) => {
    let tarCode: number | null = null;
    let sshCode: number | null = null;
    const maybeDone = () => {
      if (tarCode !== null && sshCode !== null) {
        resolve(tarCode === 0 ? sshCode : tarCode);
      }
    };
    tar.on("close", (code) => {
      tarCode = code ?? 1;
      ssh.stdin?.end();
      maybeDone();
    });
    ssh.on("close", (code) => {
      sshCode = code ?? 1;
      maybeDone();
    });
  });
}

async function saveOperation(operation: BootstrapOperation): Promise<void> {
  const operations = (await listBootstrapOperations()).filter((item) => item.id !== operation.id);
  operations.unshift({ ...operation, logs: operation.logs.slice(-300) });
  await writeJsonFile(mothershipPaths().bootstrapOperations, operations.slice(0, 50));
}

function appendLog(
  operation: BootstrapOperation,
  stream: "stdout" | "stderr" | "system",
  line: string
): void {
  operation.logs = [...operation.logs, { stream, line, createdAt: new Date().toISOString() }].slice(
    -300
  );
  void saveOperation(operation);
}

async function detectRepoKind(repo: string): Promise<"local" | "remote"> {
  if (repo.startsWith(".") || repo.startsWith("/") || repo.startsWith("~")) {
    return "local";
  }
  if (await pathExists(resolve(repo))) {
    return "local";
  }
  return "remote";
}

function expandLocalPath(path: string): string {
  if (path === "~") {
    return homedir();
  }
  if (path.startsWith("~/")) {
    return resolve(homedir(), path.slice(2));
  }
  return resolve(path);
}

function projectNameFromRepo(repo: string): string {
  const trimmed = repo.replace(/\/$/, "");
  const name = basename(trimmed).replace(/\.git$/, "") || "app";
  return name.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 80);
}

function assertSshTarget(value: string): string {
  const target = value.trim();
  if (!/^[a-zA-Z0-9._@:-]+$/.test(target)) {
    throw new Error("sshTarget must look like user@host or host and cannot contain spaces");
  }
  return target;
}

function sanitizeRemotePath(value: string): string {
  const path = value.trim().replace(/^~\//, "");
  if (!path || path.includes("\0") || path.startsWith("-")) {
    throw new Error("projectPath is invalid");
  }
  return path;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
