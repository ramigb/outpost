/**
 * @module @outpost/daemon/recipes
 *
 * Recipe dispatch layer.  Translates an `APPLY_RECIPE` command into the
 * appropriate concrete deploy function (static, service, or Docker).
 */

import type { BuildLogEvent, OutpostCommand } from "@outpost/protocol";
import { getDeploymentRecipe, loadOutpostConfig } from "@outpost/shared";
import {
  deployStaticProject,
  deployServiceProject,
  deployDockerProject,
  type DeployResult
} from "./deploy.js";

/** Narrowed type for APPLY_RECIPE commands. */
type ApplyRecipeCommand = Extract<OutpostCommand, { type: "APPLY_RECIPE" }>;

/**
 * Result of applying a deployment recipe.
 */
export type ApplyRecipeResult = {
  /** Recipe that was executed. */
  recipeId: string;
  /** Release ID produced by the deployment. */
  releaseId?: string;
  /** Commit SHA that was deployed. */
  commit?: string;
  /** Human-readable outcome message. */
  message: string;
};

/**
 * Applies a deployment recipe by delegating to the correct deploy strategy.
 *
 * @param input - Recipe application parameters.
 * @returns Result describing what was deployed.
 * @throws Error when the recipe is not implemented or parameters are invalid.
 */
export async function applyDeploymentRecipe(input: {
  projectRoot: string;
  command: ApplyRecipeCommand;
  onLog?: (event: BuildLogEvent) => void;
}): Promise<ApplyRecipeResult> {
  const recipe = getDeploymentRecipe(input.command.recipeId);
  if (recipe.maturity !== "implemented") {
    throw new Error(`Recipe ${recipe.id} is not implemented yet`);
  }

  if (recipe.deployStrategy === "static_release") {
    const deploy = await deployStaticProject({
      projectRoot: input.projectRoot,
      request: deployRequestFromParameters(input.command.approvedParameters),
      onLog: input.onLog
    });
    return recipeResult(recipe.id, deploy);
  } else if (recipe.deployStrategy === "service_restart") {
    const config = await loadOutpostConfig(input.projectRoot);
    const params = input.command.approvedParameters;

    const port = Number(params.port ?? config.port ?? 3000);
    const startCommand = String(params.startCommand ?? config.startCommand ?? "npm start");
    const healthUrl = params.healthUrl ? String(params.healthUrl) : config.healthUrl;

    const systemd = {
      serviceName: params.serviceName ? String(params.serviceName) : config.systemd?.serviceName,
      user: params.user ? String(params.user) : config.systemd?.user,
      env:
        params.env && typeof params.env === "object"
          ? (params.env as Record<string, string>)
          : config.systemd?.env
    };

    const deploy = await deployServiceProject({
      projectRoot: input.projectRoot,
      request: deployRequestFromParameters(params),
      port,
      startCommand,
      healthUrl,
      systemd,
      onLog: input.onLog
    });
    return recipeResult(recipe.id, deploy);
  } else if (recipe.deployStrategy === "container_rollout") {
    const config = await loadOutpostConfig(input.projectRoot);
    const params = input.command.approvedParameters;

    const port = Number(params.port ?? config.port ?? 8080);
    const healthUrl = params.healthUrl ? String(params.healthUrl) : config.healthUrl;

    const deploy = await deployDockerProject({
      projectRoot: input.projectRoot,
      request: deployRequestFromParameters(params),
      port,
      healthUrl,
      env:
        params.env && typeof params.env === "object"
          ? (params.env as Record<string, string>)
          : undefined,
      onLog: input.onLog
    });
    return recipeResult(recipe.id, deploy);
  } else {
    throw new Error(
      `Recipe ${recipe.id} uses unsupported deploy strategy ${recipe.deployStrategy}`
    );
  }
}

function deployRequestFromParameters(parameters: Record<string, unknown>): {
  branch?: string;
  commit?: string;
} {
  const branch = optionalString(parameters.branch, "approvedParameters.branch");
  const commit = optionalString(parameters.commit, "approvedParameters.commit");
  const ref = optionalString(parameters.ref, "approvedParameters.ref");
  if (branch && commit) {
    throw new Error("Use either approvedParameters.branch or approvedParameters.commit, not both");
  }
  if (ref && (branch || commit)) {
    throw new Error("Use either approvedParameters.ref or an explicit branch/commit, not both");
  }
  return {
    branch: branch ?? ref,
    commit
  };
}

function recipeResult(recipeId: string, deploy: DeployResult): ApplyRecipeResult {
  return {
    recipeId,
    releaseId: deploy.releaseId,
    commit: deploy.commit,
    message: `Applied recipe ${recipeId} and published release ${deploy.releaseId}`
  };
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} must be a non-empty string when provided`);
  }
  return value;
}
