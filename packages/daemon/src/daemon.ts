/**
 * @module @outpost/daemon/daemon
 *
 * Core Outpost daemon engine: manages the persistent WebSocket connection
 * to a Beacon relay, handles signed command dispatch, and coordinates
 * deployment, rollback, health checks, and status reporting.
 */

import { readFile } from "node:fs/promises";
import WebSocket from "ws";
import {
  PROTOCOL_VERSION,
  parseOutpostCommand,
  type CommandResult,
  type OutpostStatusReport,
  type PairingHello,
  type SignedEnvelope
} from "@outpost/protocol";
import {
  createSignedEnvelope,
  loadOutpostConfig,
  outpostPaths,
  peerIdFromPublicKey,
  readJsonFile,
  saveOutpostState,
  verifySignedEnvelope,
  listReleases
} from "@outpost/shared";
import {
  deployStaticProject,
  getCurrentCommit,
  readPinnedMothershipKey,
  rollbackRelease
} from "./deploy.js";
import { runDoctor } from "./doctor.js";
import { applyDeploymentRecipe } from "./recipes.js";
import { detectApp, runHealthCheck } from "./strictCommands.js";

/**
 * Connects the Outpost daemon to its configured Beacon relay and begins
 * processing signed commands from Mothership.
 *
 * @param projectRoot - Directory of the managed project. Defaults to `process.cwd()`.
 * @throws Error when the Outpost has not been linked to a Beacon URL.
 */
export async function startDaemon(projectRoot = process.cwd()): Promise<void> {
  const paths = outpostPaths(projectRoot);
  const config = await loadOutpostConfig(projectRoot);
  if (!config.beaconUrl) {
    throw new Error(
      "Outpost is not linked to a Beacon URL. Run `outpost-daemon link --payload <base64>` first."
    );
  }
  const privateKeyPem = await readFile(paths.outpostPrivateKey, "utf8");
  const publicKeyPem = await readFile(paths.outpostPublicKey, "utf8");
  const mothershipPublicKey = await readPinnedMothershipKey(projectRoot);
  const outpostPeerId = peerIdFromPublicKey(publicKeyPem);
  const mothershipPeerId = peerIdFromPublicKey(mothershipPublicKey);
  let busy = false;

  const connect = () => {
    const socket = new WebSocket(config.beaconUrl!);
    socket.on("open", async () => {
      await saveOutpostState(projectRoot, { state: "PAIRED_ONLINE" });
      socket.send(JSON.stringify({ type: "REGISTER", role: "outpost", peerId: outpostPeerId }));
      if (config.pairingNonce) {
        const hello: PairingHello = {
          type: "PAIRING_HELLO",
          protocolVersion: PROTOCOL_VERSION,
          pairingNonce: config.pairingNonce,
          outpostPublicKey: publicKeyPem,
          projectName: config.projectName,
          hostLabel: config.hostLabel
        };
        socket.send(
          JSON.stringify({
            type: "FORWARD",
            from: outpostPeerId,
            to: mothershipPeerId,
            body: hello
          })
        );
      }
      await sendStatus(socket, projectRoot, outpostPeerId, mothershipPeerId, privateKeyPem);
    });
    socket.on("close", async () => {
      await saveOutpostState(projectRoot, { state: "PAIRED_OFFLINE" });
      setTimeout(connect, 2_000);
    });
    socket.on("message", async (raw) => {
      try {
        const message = JSON.parse(raw.toString()) as {
          type?: string;
          from?: string;
          body?: unknown;
        };
        if (message.type !== "FORWARD" || message.from !== mothershipPeerId) {
          return;
        }
        const envelope = message.body as SignedEnvelope;
        verifySignedEnvelope({
          envelope,
          publicKeyPem: mothershipPublicKey,
          expectedSenderId: mothershipPeerId,
          expectedRecipientId: outpostPeerId
        });
        const command = parseOutpostCommand(envelope.payload);
        if (
          busy &&
          command.type !== "GET_STATE" &&
          command.type !== "PING" &&
          command.type !== "DOCTOR" &&
          command.type !== "DETECT_APP" &&
          command.type !== "RUN_HEALTH_CHECK"
        ) {
          await sendResult(
            socket,
            {
              commandType: command.type,
              ok: false,
              message: "A deployment or rollback is already running"
            },
            outpostPeerId,
            mothershipPeerId,
            privateKeyPem
          );
          return;
        }
        if (command.type === "PING" || command.type === "GET_STATE") {
          await sendStatus(socket, projectRoot, outpostPeerId, mothershipPeerId, privateKeyPem);
          return;
        }
        busy = true;
        try {
          if (command.type === "DEPLOY") {
            const result = await deployStaticProject({
              projectRoot,
              request: command,
              onLog: (event) => {
                const envelope = createSignedEnvelope({
                  senderId: outpostPeerId,
                  recipientId: mothershipPeerId,
                  privateKeyPem,
                  payload: { type: "BUILD_LOG", event }
                });
                socket.send(
                  JSON.stringify({
                    type: "FORWARD",
                    from: outpostPeerId,
                    to: mothershipPeerId,
                    body: envelope
                  })
                );
              }
            });
            await sendResult(
              socket,
              { commandType: "DEPLOY", ok: true, releaseId: result.releaseId },
              outpostPeerId,
              mothershipPeerId,
              privateKeyPem
            );
          } else if (command.type === "ROLLBACK") {
            await rollbackRelease({ projectRoot, releaseId: command.releaseId });
            await sendResult(
              socket,
              { commandType: "ROLLBACK", ok: true, releaseId: command.releaseId },
              outpostPeerId,
              mothershipPeerId,
              privateKeyPem
            );
          } else if (command.type === "SET_ENV") {
            await sendResult(
              socket,
              {
                commandType: "SET_ENV",
                ok: false,
                message: "Encrypted build-time env storage is not implemented yet"
              },
              outpostPeerId,
              mothershipPeerId,
              privateKeyPem
            );
          } else if (command.type === "DETECT_APP") {
            const detection = await detectApp(projectRoot, command.projectPath);
            await sendResult(
              socket,
              {
                commandType: "DETECT_APP",
                ok: detection.appTypes.length > 0,
                message:
                  detection.appTypes.length > 0
                    ? `Detected ${detection.appTypes.join(", ")}`
                    : "No supported app type detected",
                data: detection
              },
              outpostPeerId,
              mothershipPeerId,
              privateKeyPem
            );
          } else if (command.type === "RUN_HEALTH_CHECK") {
            const health = await runHealthCheck(command.url);
            await sendResult(
              socket,
              {
                commandType: "RUN_HEALTH_CHECK",
                ok: health.ok,
                message: health.message,
                data: health
              },
              outpostPeerId,
              mothershipPeerId,
              privateKeyPem
            );
          } else if (command.type === "APPLY_RECIPE") {
            const result = await applyDeploymentRecipe({
              projectRoot,
              command,
              onLog: (event) => {
                const envelope = createSignedEnvelope({
                  senderId: outpostPeerId,
                  recipientId: mothershipPeerId,
                  privateKeyPem,
                  payload: { type: "BUILD_LOG", event }
                });
                socket.send(
                  JSON.stringify({
                    type: "FORWARD",
                    from: outpostPeerId,
                    to: mothershipPeerId,
                    body: envelope
                  })
                );
              }
            });
            await sendResult(
              socket,
              {
                commandType: "APPLY_RECIPE",
                ok: true,
                releaseId: result.releaseId,
                message: result.message,
                data: result
              },
              outpostPeerId,
              mothershipPeerId,
              privateKeyPem
            );
          } else if (command.type === "DOCTOR") {
            const checks = await runDoctor(projectRoot);
            await sendResult(
              socket,
              {
                commandType: "DOCTOR",
                ok: checks.every((check) => check.ok),
                message: checks
                  .map((check) => `${check.ok ? "ok" : "fail"} ${check.name}: ${check.message}`)
                  .join("\n"),
                data: checks
              },
              outpostPeerId,
              mothershipPeerId,
              privateKeyPem
            );
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await sendResult(
            socket,
            { commandType: command.type, ok: false, message },
            outpostPeerId,
            mothershipPeerId,
            privateKeyPem
          );
        } finally {
          busy = false;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await saveOutpostState(projectRoot, { state: "ERROR", lastError: message });
      }
    });
    socket.on("error", () => {
      socket.close();
    });
  };

  connect();
}

async function sendStatus(
  socket: WebSocket,
  projectRoot: string,
  senderId: string,
  recipientId: string,
  privateKeyPem: string
): Promise<void> {
  const config = await loadOutpostConfig(projectRoot);
  const paths = outpostPaths(projectRoot);
  const state = await readJsonFile<{
    state: OutpostStatusReport["state"];
    currentReleaseId?: string;
    currentBranch?: string;
    currentCommit?: string;
    lastError?: string;
  }>(paths.state);
  const report: OutpostStatusReport = {
    state: state.state,
    projectName: config.projectName,
    hostLabel: config.hostLabel,
    currentReleaseId: state.currentReleaseId,
    currentBranch: state.currentBranch,
    currentCommit: state.currentCommit ?? (await getCurrentCommit(projectRoot)),
    releases: await listReleases(projectRoot),
    lastError: state.lastError
  };
  const envelope = createSignedEnvelope({
    senderId,
    recipientId,
    privateKeyPem,
    payload: { type: "STATE", report }
  });
  socket.send(JSON.stringify({ type: "FORWARD", from: senderId, to: recipientId, body: envelope }));
}

async function sendResult(
  socket: WebSocket,
  result: CommandResult,
  senderId: string,
  recipientId: string,
  privateKeyPem: string
): Promise<void> {
  const envelope = createSignedEnvelope({
    senderId,
    recipientId,
    privateKeyPem,
    payload: { type: "COMMAND_RESULT", result }
  });
  socket.send(JSON.stringify({ type: "FORWARD", from: senderId, to: recipientId, body: envelope }));
}
