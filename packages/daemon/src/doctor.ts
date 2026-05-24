import { execFile } from "node:child_process";
import { join } from "node:path";
import { detectBuilder, loadOutpostConfig, outpostPaths, pathExists } from "@outpost/shared";

export type DoctorCheck = {
  name: string;
  ok: boolean;
  message: string;
};

export async function runDoctor(projectRoot = process.cwd()): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];

  checks.push({
    name: "node",
    ok: Number(process.versions.node.split(".")[0]) >= 20,
    message: `Node.js ${process.version}`
  });

  await checkGit(projectRoot, checks);
  await checkConfig(projectRoot, checks);
  await checkOutput(projectRoot, checks);

  return checks;
}

export function printDoctor(checks: DoctorCheck[]): void {
  for (const check of checks) {
    console.log(`${check.ok ? "ok" : "fail"}  ${check.name}  ${check.message}`);
  }
  if (checks.some((check) => !check.ok)) {
    process.exitCode = 1;
  }
}

async function checkGit(projectRoot: string, checks: DoctorCheck[]): Promise<void> {
  try {
    await runGit(projectRoot, ["--version"]);
    checks.push({ name: "git", ok: true, message: "git is available" });
  } catch {
    checks.push({ name: "git", ok: false, message: "git is required but was not found on PATH" });
    return;
  }

  try {
    const inside = (await runGit(projectRoot, ["rev-parse", "--is-inside-work-tree"])).trim();
    checks.push({
      name: "repository",
      ok: inside === "true",
      message:
        inside === "true"
          ? "current directory is a git repository"
          : "run from the app repository root"
    });
  } catch {
    checks.push({ name: "repository", ok: false, message: "run from the app repository root" });
    return;
  }

  const dirty = (
    await runGit(projectRoot, ["status", "--porcelain", "--untracked-files=no"])
  ).trim();
  checks.push({
    name: "working-tree",
    ok: dirty.length === 0,
    message:
      dirty.length === 0
        ? "no tracked local changes"
        : "commit or stash tracked local changes before deploying"
  });

  const remotes = (await runGit(projectRoot, ["remote"])).trim();
  checks.push({
    name: "remote",
    ok: remotes.length > 0,
    message:
      remotes.length > 0
        ? `configured remotes: ${remotes.split(/\s+/).join(", ")}`
        : "add a git remote before deploying"
  });
}

async function checkConfig(projectRoot: string, checks: DoctorCheck[]): Promise<void> {
  const paths = outpostPaths(projectRoot);
  if (!(await pathExists(paths.config))) {
    const detected = await detectBuilder(projectRoot);
    checks.push({
      name: "config",
      ok: false,
      message: detected
        ? "run `outpost-daemon setup --pair <token>` to create .outpost/config.json"
        : "no supported builder detected; create .outpost/config.json manually"
    });
    return;
  }

  const config = await loadOutpostConfig(projectRoot);
  checks.push({ name: "config", ok: true, message: `.outpost/config.json uses ${config.builder}` });
  checks.push({
    name: "beacon",
    ok: Boolean(config.beaconUrl),
    message: config.beaconUrl ? config.beaconUrl : "run setup or link to store a Beacon URL"
  });
  checks.push({
    name: "mothership-key",
    ok: await pathExists(paths.mothershipPublicKey),
    message: (await pathExists(paths.mothershipPublicKey))
      ? "Mothership public key is pinned"
      : "run setup or link to pin Mothership identity"
  });
}

async function checkOutput(projectRoot: string, checks: DoctorCheck[]): Promise<void> {
  const paths = outpostPaths(projectRoot);
  if (!(await pathExists(paths.config))) {
    return;
  }
  const config = await loadOutpostConfig(projectRoot);
  if (config.outputDir) {
    checks.push({
      name: "build-output",
      ok: await pathExists(join(projectRoot, config.outputDir)),
      message: `configured output directory: ${config.outputDir}`
    });
  }
  checks.push({
    name: "live",
    ok: await pathExists(paths.live),
    message: (await pathExists(paths.live)) ? paths.live : "no published release yet; run Deploy"
  });

  if (config.startCommand && process.platform === "linux") {
    try {
      const { execSync } = await import("node:child_process");
      execSync("systemctl --version", { stdio: "ignore" });
      checks.push({
        name: "systemd",
        ok: true,
        message: "systemctl is available"
      });
    } catch {
      checks.push({
        name: "systemd",
        ok: false,
        message: "systemctl command not found (systemd is required for Node services)"
      });
    }
  }
}

function runGit(projectRoot: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd: projectRoot }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message));
        return;
      }
      resolve(stdout);
    });
  });
}
