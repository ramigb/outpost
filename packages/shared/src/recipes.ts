/**
 * @module @outpost/shared/recipes
 *
 * Deployment recipe definitions and helpers.  A recipe describes how to
 * detect, provision, deploy, health-check, and roll back a category of
 * applications.
 */

/**
 * A deployment recipe describes the full lifecycle for a class of apps.
 */
export type DeploymentRecipe = {
  /** Stable recipe identifier (e.g. `"static-vite"`). */
  id: string;
  /** Human-readable name. */
  name: string;
  /** App type tags this recipe matches against. */
  appTypes: string[];
  /** Tools that must be available on the target host. */
  requiredTools: string[];
  /** Ordered human-readable steps the recipe performs. */
  planSteps: string[];
  /** How the recipe performs the deployment. */
  deployStrategy: "static_release" | "service_restart" | "container_rollout" | "custom";
  /** How the recipe rolls back a failed or unwanted deployment. */
  rollbackStrategy: "symlink" | "previous_service_version" | "previous_image" | "manual";
  /** Optional health-check configuration applied after deploy. */
  healthCheck?: {
    type: "http" | "tcp" | "command";
    target: string;
  };
  /** Whether the recipe is fully implemented or still planned. */
  maturity: "implemented" | "planning";
};

/**
 * Built-in deployment recipes supported by Outpost.
 *
 * @see `listDeploymentRecipes`
 * @see `getDeploymentRecipe`
 * @see `recommendDeploymentRecipes`
 */
export const deploymentRecipes: DeploymentRecipe[] = [
  {
    id: "static-vite",
    name: "Static or Vite release",
    appTypes: ["vite", "vite_static", "static_frontend", "generic_static"],
    requiredTools: ["git", "node", "package_manager", "web_server"],
    planSteps: [
      "Resolve repository and target ref.",
      "Install dependencies if required.",
      "Run the configured build command.",
      "Copy finalized static output into a release directory.",
      "Atomically switch the live release pointer.",
      "Run an HTTP health check when a URL is configured."
    ],
    deployStrategy: "static_release",
    rollbackStrategy: "symlink",
    healthCheck: {
      type: "http",
      target: "configured app URL"
    },
    maturity: "implemented"
  },
  {
    id: "node-service",
    name: "Node.js service",
    appTypes: ["node_service", "node_server", "server_rendered_javascript", "nextjs"],
    requiredTools: ["git", "node", "package_manager", "systemd", "reverse_proxy"],
    planSteps: [
      "Resolve repository and target ref.",
      "Install dependencies and build server assets if required.",
      "Write or update a systemd service unit.",
      "Restart the service.",
      "Run a health check through the reverse proxy.",
      "Preserve previous service metadata for rollback."
    ],
    deployStrategy: "service_restart",
    rollbackStrategy: "previous_service_version",
    healthCheck: {
      type: "http",
      target: "configured service URL"
    },
    maturity: "implemented"
  },
  {
    id: "docker-compose",
    name: "Docker or Docker Compose rollout",
    appTypes: ["docker", "docker_compose", "compose"],
    requiredTools: ["git", "docker"],
    planSteps: [
      "Resolve repository and target ref.",
      "Build or pull the configured image.",
      "Apply Docker Compose or container runtime configuration.",
      "Roll out the updated container.",
      "Run a health check.",
      "Retain previous image or compose metadata for rollback."
    ],
    deployStrategy: "container_rollout",
    rollbackStrategy: "previous_image",
    healthCheck: {
      type: "http",
      target: "configured container URL"
    },
    maturity: "implemented"
  }
];

/**
 * Returns all built-in deployment recipes.
 *
 * @returns Copy of the recipe catalog.
 */
export function listDeploymentRecipes(): DeploymentRecipe[] {
  return deploymentRecipes;
}

/**
 * Retrieves a single recipe by ID.
 *
 * @param recipeId - Recipe identifier.
 * @returns The matching recipe.
 * @throws Error when the recipe does not exist.
 */
export function getDeploymentRecipe(recipeId: string): DeploymentRecipe {
  const recipe = deploymentRecipes.find((item) => item.id === recipeId);
  if (!recipe) {
    throw new Error(`Unknown deployment recipe: ${recipeId}`);
  }
  return recipe;
}

/**
 * Recommends recipes that match the given app type tags.
 *
 * @param appTypes - Detected app type identifiers.
 * @returns Matching recipes in catalog order.
 */
export function recommendDeploymentRecipes(appTypes: string[]): DeploymentRecipe[] {
  const normalized = new Set(appTypes);
  return deploymentRecipes.filter((recipe) =>
    recipe.appTypes.some((appType) => normalized.has(appType))
  );
}
