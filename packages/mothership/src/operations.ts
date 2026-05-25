/**
 * @module @outpost/mothership/operations
 *
 * Local audit log for every Mothership tool execution.
 *
 * Operations record their lifecycle (created → approval → running →
 * success/failed) together with timestamped events and redacted inputs/outputs.
 */

import { pathExists, randomId, readJsonFile, writeJsonFile } from "@outpost/shared";
import { mothershipPaths } from "./state.js";

/**
 * Single event appended to an operation's timeline.
 */
export type OperationEvent = {
  operationId: string;
  timestamp: string;
  level: "info" | "warning" | "error" | "success";
  phase: string;
  message: string;
  toolName?: string;
  target?: string;
  source?: "ai" | "system" | "user";
};

/**
 * Approval decision for an operation.
 */
export type OperationApproval = {
  required: boolean;
  mode: string;
  reason?: string;
  status: "not_required" | "required" | "approved";
  decidedAt?: string;
};

/**
 * Full operation record persisted to disk.
 */
export type MothershipOperation = {
  id: string;
  status: "waiting_approval" | "running" | "success" | "failed";
  toolName: string;
  title: string;
  target?: string;
  input?: unknown;
  result?: unknown;
  error?: string;
  approval: OperationApproval;
  events: OperationEvent[];
  startedAt: string;
  finishedAt?: string;
  source?: "ai" | "system" | "user";
};

/**
 * Lists all persisted operations, newest first.
 */
export async function listOperations(): Promise<MothershipOperation[]> {
  const path = mothershipPaths().operations;
  if (!(await pathExists(path))) {
    return [];
  }
  return readJsonFile<MothershipOperation[]>(path);
}

/**
 * Creates a new operation record and persists it.
 *
 * @param input - Operation creation parameters.
 * @returns The created operation.
 */
export async function createOperation(input: {
  toolName: string;
  title: string;
  target?: string;
  toolInput?: unknown;
  approval: OperationApproval;
  source?: "ai" | "system" | "user";
}): Promise<MothershipOperation> {
  const operation: MothershipOperation = {
    id: randomId("op"),
    status: input.approval.status === "required" ? "waiting_approval" : "running",
    toolName: input.toolName,
    title: input.title,
    target: input.target,
    input: redactSecrets(input.toolInput),
    approval: input.approval,
    events: [],
    startedAt: new Date().toISOString(),
    source: input.source ?? "system"
  };
  await saveOperation(operation);
  return operation;
}

/**
 * Appends an event to an operation and persists the updated record.
 *
 * @param operation - Operation to update.
 * @param event - Event fields (id and timestamp are added automatically).
 * @returns Updated operation.
 */
export async function appendOperationEvent(
  operation: MothershipOperation,
  event: Omit<OperationEvent, "operationId" | "timestamp">
): Promise<MothershipOperation> {
  operation.events = [
    ...operation.events,
    {
      operationId: operation.id,
      timestamp: new Date().toISOString(),
      ...event
    }
  ];
  await saveOperation(operation);
  return operation;
}

/**
 * Finalises an operation with a success or failure status.
 *
 * @param operation - Operation to finalise.
 * @param input - Final status and optional result/error.
 * @returns Updated operation.
 */
export async function finishOperation(
  operation: MothershipOperation,
  input: {
    status: "success" | "failed";
    result?: unknown;
    error?: string;
  }
): Promise<MothershipOperation> {
  operation.status = input.status;
  operation.result = redactSecrets(input.result);
  operation.error = input.error;
  operation.finishedAt = new Date().toISOString();
  await saveOperation(operation);
  return operation;
}

/**
 * Marks a waiting operation as approved and updates its status to `"running"`.
 *
 * @param operation - Operation awaiting approval.
 * @returns Updated operation.
 */
export async function markOperationApproved(
  operation: MothershipOperation
): Promise<MothershipOperation> {
  operation.status = "running";
  operation.approval = {
    ...operation.approval,
    status: "approved",
    decidedAt: new Date().toISOString()
  };
  await saveOperation(operation);
  return operation;
}

async function saveOperation(operation: MothershipOperation): Promise<void> {
  const operations = (await listOperations()).filter((item) => item.id !== operation.id);
  operations.unshift({ ...operation, events: operation.events.slice(-500) });
  await writeJsonFile(mothershipPaths().operations, operations.slice(0, 100));
}

function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactSecrets);
  }
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      output[key] = isSecretKey(key) ? "[redacted]" : redactSecrets(item);
    }
    return output;
  }
  return value;
}

function isSecretKey(key: string): boolean {
  if (key === "hasApiKey") {
    return false;
  }
  return /apiKey|secret|token|password|encryptedEnv/i.test(key);
}
