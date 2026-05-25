/**
 * @module @outpost/beacon/server
 *
 * Blind WebSocket relay that forwards opaque messages between Mothership
 * and Outpost peers without inspecting or decrypting payloads.
 *
 * @remarks
 * Beacon is intentionally dumb: it only validates registration, enforces a
 * simple rate limit, and forwards messages.  It never stores secrets,
 * decrypts envelopes, or interprets commands.
 */

import { createServer, type IncomingMessage } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { parseRelayClientMessage, type RelayServerMessage } from "@outpost/protocol";

/**
 * Internal record for a peer currently connected to this Beacon instance.
 */
type RegisteredConnection = {
  /** Peer ID derived from the public key. */
  peerId: string;
  /** Role in the relay network. */
  role: "mothership" | "outpost";
  /** Underlying WebSocket instance. */
  socket: WebSocket;
  /** Messages sent in the current 10-second window. */
  messageCount: number;
  /** Start of the current rate-limit window. */
  windowStartedAt: number;
};

/**
 * Starts the Beacon HTTP + WebSocket relay server.
 *
 * @param input - Optional port and host overrides.
 * @returns A controller object with a `close()` method.
 *
 * @example
 * ```ts
 * const beacon = startBeaconServer({ port: 8787 });
 * // later
 * beacon.close();
 * ```
 */
export function startBeaconServer(input: { port?: number; host?: string } = {}): {
  close: () => void;
} {
  const port = input.port ?? Number(process.env.PORT ?? 8787);
  const host = input.host ?? process.env.HOST ?? "127.0.0.1";
  const peers = new Map<string, RegisteredConnection>();
  const httpServer = createServer((request, response) => {
    if (request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, peers: peers.size }));
      return;
    }
    response.writeHead(404);
    response.end("not found");
  });
  const wss = new WebSocketServer({ server: httpServer });

  wss.on("connection", (socket, request) => {
    let registered: RegisteredConnection | undefined;
    socket.on("message", (raw) => {
      try {
        if (registered && !allowMessage(registered)) {
          send(socket, { type: "ERROR", message: "Rate limit exceeded" });
          socket.close();
          return;
        }
        const message = parseRelayClientMessage(JSON.parse(raw.toString()));
        if (message.type === "REGISTER") {
          registered = {
            peerId: message.peerId,
            role: message.role,
            socket,
            messageCount: 0,
            windowStartedAt: Date.now()
          };
          peers.set(message.peerId, registered);
          send(socket, { type: "REGISTERED", peerId: message.peerId });
          broadcastPeerState(peers, message.peerId, "PEER_ONLINE");
          return;
        }
        if (!registered || registered.peerId !== message.from) {
          send(socket, {
            type: "ERROR",
            message: "Connection is not registered as the message sender"
          });
          return;
        }
        const target = peers.get(message.to);
        if (!target) {
          send(socket, { type: "ERROR", message: `Peer is offline: ${message.to}` });
          return;
        }
        send(target.socket, { type: "FORWARD", from: message.from, body: message.body });
      } catch (error) {
        send(socket, {
          type: "ERROR",
          message: error instanceof Error ? error.message : String(error)
        });
      }
    });
    socket.on("close", () => {
      if (registered) {
        peers.delete(registered.peerId);
        broadcastPeerState(peers, registered.peerId, "PEER_OFFLINE");
      }
    });
    socket.on("error", () => socket.close());
    request.socket.setNoDelay(true);
    logConnection(request);
  });

  httpServer.listen(port, host, () => {
    console.log(`Beacon listening on ws://${host}:${port}`);
  });

  return {
    close: () => {
      wss.close();
      httpServer.close();
    }
  };
}

function send(socket: WebSocket, message: RelayServerMessage): void {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function broadcastPeerState(
  peers: Map<string, RegisteredConnection>,
  peerId: string,
  type: "PEER_ONLINE" | "PEER_OFFLINE"
): void {
  for (const [targetId, connection] of peers) {
    if (targetId !== peerId) {
      send(connection.socket, { type, peerId });
    }
  }
}

/** Simple per-connection rate limiter: 200 messages per 10-second window. */
function allowMessage(connection: RegisteredConnection): boolean {
  const now = Date.now();
  if (now - connection.windowStartedAt > 10_000) {
    connection.messageCount = 0;
    connection.windowStartedAt = now;
  }
  connection.messageCount += 1;
  return connection.messageCount <= 200;
}

function logConnection(request: IncomingMessage): void {
  const remote = request.socket.remoteAddress ?? "unknown";
  console.log(`Beacon connection from ${remote}`);
}
