import {
  createOperation,
  appendOperationEvent,
  finishOperation,
  type MothershipOperation,
  type OperationApproval,
  type OperationEvent
} from "./operations.js";
import { consumeAgentToolCall } from "./memory.js";
import { loadMothershipState, type ApprovalMode } from "./state.js";

export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  authorityLevel: "read" | "local_state" | "external_change" | "risky";
  targetScope: "mothership" | "local_host" | "beacon_strict";
  mutatesLocalState: boolean;
  mutatesRemoteState: boolean;
  destructive: boolean;
};

export type ToolExecutionResult<TResult> = {
  approvalRequired: boolean;
  operation: MothershipOperation;
  result?: TResult;
};

export type ToolRunContext = {
  operation: MothershipOperation;
  emit: (event: Omit<OperationEvent, "operationId" | "timestamp">) => Promise<void>;
};

export const toolCatalog: ToolDefinition[] = [
  {
    name: "provider.validate",
    description: "Validate the configured OpenAI or OpenRouter provider for Mothership.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: { type: "object" },
    authorityLevel: "local_state",
    targetScope: "mothership",
    mutatesLocalState: true,
    mutatesRemoteState: false,
    destructive: false
  },
  {
    name: "host.inspect_local",
    description:
      "Inspect the local host for operating system, architecture, runtimes, service managers, web servers, and listening ports.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: { type: "object" },
    authorityLevel: "read",
    targetScope: "local_host",
    mutatesLocalState: true,
    mutatesRemoteState: false,
    destructive: false
  },
  {
    name: "host.inspect_ssh",
    description: "Inspect a remote host over SSH using read-only provisioning checks.",
    inputSchema: {
      type: "object",
      required: ["sshTarget"],
      properties: { sshTarget: { type: "string" } }
    },
    outputSchema: { type: "object" },
    authorityLevel: "read",
    targetScope: "local_host",
    mutatesLocalState: true,
    mutatesRemoteState: false,
    destructive: false
  },
  {
    name: "host.run_ssh_command",
    description:
      "Run a shell command on a remote host over SSH, such as checking files, cloning a git repo, or starting services.",
    inputSchema: {
      type: "object",
      required: ["sshTarget", "command"],
      properties: {
        sshTarget: { type: "string" },
        command: { type: "string" }
      }
    },
    outputSchema: { type: "object" },
    authorityLevel: "external_change",
    targetScope: "local_host",
    mutatesLocalState: false,
    mutatesRemoteState: true,
    destructive: false
  },
  {
    name: "app.detect_local",
    description: "Detect local app type and package manager signals for a project path.",
    inputSchema: {
      type: "object",
      required: ["projectPath"],
      properties: { projectPath: { type: "string" } }
    },
    outputSchema: { type: "object" },
    authorityLevel: "read",
    targetScope: "local_host",
    mutatesLocalState: true,
    mutatesRemoteState: false,
    destructive: false
  },
  {
    name: "health.http_check",
    description: "Run an HTTP health check against a URL.",
    inputSchema: {
      type: "object",
      required: ["url"],
      properties: { url: { type: "string" }, timeoutMs: { type: "number" } }
    },
    outputSchema: { type: "object" },
    authorityLevel: "read",
    targetScope: "local_host",
    mutatesLocalState: true,
    mutatesRemoteState: false,
    destructive: false
  },
  {
    name: "provisioning.plan_local",
    description:
      "Create a local-host deployment readiness plan from host and app inspection signals.",
    inputSchema: {
      type: "object",
      required: ["projectPath"],
      properties: { projectPath: { type: "string" } }
    },
    outputSchema: { type: "object" },
    authorityLevel: "read",
    targetScope: "local_host",
    mutatesLocalState: true,
    mutatesRemoteState: false,
    destructive: false
  },
  {
    name: "recipes.list",
    description: "List deployment recipes available to Mothership and Outpost.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: { type: "object" },
    authorityLevel: "read",
    targetScope: "mothership",
    mutatesLocalState: true,
    mutatesRemoteState: false,
    destructive: false
  },
  {
    name: "recipes.recommend_local",
    description: "Recommend deployment recipes for a local project after app detection.",
    inputSchema: {
      type: "object",
      required: ["projectPath"],
      properties: { projectPath: { type: "string" } }
    },
    outputSchema: { type: "object" },
    authorityLevel: "read",
    targetScope: "local_host",
    mutatesLocalState: true,
    mutatesRemoteState: false,
    destructive: false
  },
  {
    name: "mothership.bootstrap_vps",
    description:
      "Bootstrap a VPS over SSH, copy or clone an app, pair Outpost, and optionally deploy.",
    inputSchema: {
      type: "object",
      required: ["sshTarget", "repo"],
      properties: {
        sshTarget: { type: "string" },
        repo: { type: "string" },
        projectPath: { type: "string" },
        deploy: { type: "boolean" }
      }
    },
    outputSchema: { type: "object" },
    authorityLevel: "external_change",
    targetScope: "local_host",
    mutatesLocalState: true,
    mutatesRemoteState: true,
    destructive: false
  },
  {
    name: "outpost.list",
    description: "List paired Outposts, live Beacon connectivity, online peers, and recent Outpost activity.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: { type: "object" },
    authorityLevel: "read",
    targetScope: "beacon_strict",
    mutatesLocalState: false,
    mutatesRemoteState: false,
    destructive: false
  },
  {
    name: "outpost.create_pairing",
    description: "Create a pairing setup command for adding or configuring an Outpost.",
    inputSchema: {
      type: "object",
      properties: {
        beaconUrl: { type: "string" },
        displayName: { type: "string" },
        installCommand: { type: "string" },
        buildCommand: { type: "string" },
        outputDir: { type: "string" },
        projectName: { type: "string" },
        retainReleases: { type: "number" }
      }
    },
    outputSchema: { type: "object" },
    authorityLevel: "read",
    targetScope: "mothership",
    mutatesLocalState: false,
    mutatesRemoteState: false,
    destructive: false
  },
  {
    name: "outpost.inspect",
    description:
      "Ask a Beacon strict-mode Outpost for connectivity, state, app detection, or health information.",
    inputSchema: {
      type: "object",
      required: ["peerId"],
      properties: {
        peerId: { type: "string" },
        commandType: { type: "string" },
        projectPath: { type: "string" },
        url: { type: "string" }
      }
    },
    outputSchema: { type: "object" },
    authorityLevel: "read",
    targetScope: "beacon_strict",
    mutatesLocalState: true,
    mutatesRemoteState: false,
    destructive: false
  },
  {
    name: "outpost.doctor",
    description: "Ask a Beacon strict-mode Outpost to run its configured doctor checks.",
    inputSchema: {
      type: "object",
      required: ["peerId"],
      properties: { peerId: { type: "string" } }
    },
    outputSchema: { type: "object" },
    authorityLevel: "read",
    targetScope: "beacon_strict",
    mutatesLocalState: true,
    mutatesRemoteState: false,
    destructive: false
  },
  {
    name: "outpost.deploy",
    description: "Ask a Beacon strict-mode Outpost to deploy through its configured recipe.",
    inputSchema: {
      type: "object",
      required: ["peerId"],
      properties: {
        peerId: { type: "string" },
        branch: { type: "string" },
        commit: { type: "string" }
      }
    },
    outputSchema: { type: "object" },
    authorityLevel: "external_change",
    targetScope: "beacon_strict",
    mutatesLocalState: true,
    mutatesRemoteState: true,
    destructive: false
  },
  {
    name: "outpost.set_env",
    description: "Send encrypted environment configuration to a Beacon strict-mode Outpost.",
    inputSchema: {
      type: "object",
      required: ["peerId", "encryptedEnv"],
      properties: { peerId: { type: "string" }, encryptedEnv: { type: "string" } }
    },
    outputSchema: { type: "object" },
    authorityLevel: "external_change",
    targetScope: "beacon_strict",
    mutatesLocalState: true,
    mutatesRemoteState: true,
    destructive: false
  },
  {
    name: "outpost.apply_recipe",
    description: "Ask a Beacon strict-mode Outpost to apply an approved typed deployment recipe.",
    inputSchema: {
      type: "object",
      required: ["peerId", "recipeId", "approvedParameters"],
      properties: {
        peerId: { type: "string" },
        appId: { type: "string" },
        recipeId: { type: "string" },
        approvedParameters: { type: "object" }
      }
    },
    outputSchema: { type: "object" },
    authorityLevel: "external_change",
    targetScope: "beacon_strict",
    mutatesLocalState: true,
    mutatesRemoteState: true,
    destructive: false
  },
  {
    name: "outpost.rollback",
    description: "Ask a Beacon strict-mode Outpost to switch back to a previous release.",
    inputSchema: {
      type: "object",
      required: ["peerId", "releaseId"],
      properties: { peerId: { type: "string" }, releaseId: { type: "string" } }
    },
    outputSchema: { type: "object" },
    authorityLevel: "risky",
    targetScope: "beacon_strict",
    mutatesLocalState: true,
    mutatesRemoteState: true,
    destructive: false
  }
];

export function listTools(): ToolDefinition[] {
  return toolCatalog;
}

export function getTool(name: string): ToolDefinition {
  const tool = toolCatalog.find((item) => item.name === name);
  if (!tool) {
    throw new Error(`Unknown Mothership tool: ${name}`);
  }
  return tool;
}

export function approvalForTool(
  tool: ToolDefinition,
  mode: ApprovalMode,
  approved: boolean
): OperationApproval {
  const reason = approvalReason(tool, mode);
  if (!reason) {
    return { required: false, mode, status: "not_required" };
  }
  return {
    required: true,
    mode,
    reason,
    status: approved ? "approved" : "required",
    decidedAt: approved ? new Date().toISOString() : undefined
  };
}

export async function executeTool<TResult>(input: {
  toolName: string;
  title: string;
  target?: string;
  toolInput?: unknown;
  approved?: boolean;
  source?: "ai" | "system" | "user";
  run: (context: ToolRunContext) => Promise<TResult>;
}): Promise<ToolExecutionResult<TResult>> {
  const state = await loadMothershipState();
  const tool = getTool(input.toolName);
  if (input.source === "ai") {
    await consumeAgentToolCall();
  }
  const approval = approvalForTool(
    tool,
    state.config.approvals?.mode ?? "automatic",
    input.approved === true
  );
  const operation = await createOperation({
    toolName: tool.name,
    title: input.title,
    target: input.target,
    toolInput: input.toolInput,
    approval,
    source: input.source ?? "system"
  });

  if (approval.status === "required") {
    await appendOperationEvent(operation, {
      level: "warning",
      phase: "approval",
      message: approval.reason ?? "Approval required before running this tool",
      toolName: tool.name,
      target: input.target
    });
    return { approvalRequired: true, operation };
  }

  await appendOperationEvent(operation, {
    level: "info",
    phase: "tool",
    message: `Running ${tool.name}`,
    toolName: tool.name,
    target: input.target
  });

  try {
    const context: ToolRunContext = {
      operation,
      emit: async (event) => {
        await appendOperationEvent(operation, event);
      }
    };
    const result = await input.run(context);
    await appendOperationEvent(operation, {
      level: "success",
      phase: "tool",
      message: `${tool.name} completed`,
      toolName: tool.name,
      target: input.target
    });
    await finishOperation(operation, { status: "success", result });
    return { approvalRequired: false, operation, result };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await appendOperationEvent(operation, {
      level: "error",
      phase: "tool",
      message,
      toolName: tool.name,
      target: input.target
    });
    await finishOperation(operation, { status: "failed", error: message });
    throw error;
  }
}

function approvalReason(tool: ToolDefinition, mode: ApprovalMode): string | undefined {
  if (mode === "automatic") {
    return undefined;
  }
  if (mode === "manual") {
    return "Manual approval mode requires approval before each Mothership tool runs.";
  }
  if (mode === "confirm_risky" && (tool.destructive || tool.authorityLevel === "risky")) {
    return "This tool is classified as risky and requires approval in confirm_risky mode.";
  }
  if (mode === "confirm_external_changes" && tool.mutatesRemoteState) {
    return "This tool can change target infrastructure or app state and requires approval in confirm_external_changes mode.";
  }
  return undefined;
}
