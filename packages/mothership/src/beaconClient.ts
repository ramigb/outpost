import WebSocket from "ws";
import type {
  BuildLogEvent,
  CommandResult,
  OutpostCommand,
  OutpostStatusReport,
  PairingHello,
  SignedEnvelope
} from "@outpost/protocol";
import { createSignedEnvelope } from "@outpost/shared";
import type { MothershipState } from "./state.js";
import { normalizeMothershipConfig, upsertOutpost } from "./state.js";

export class MothershipBeaconClient {
  private socket?: WebSocket;
  private reconnectTimer?: NodeJS.Timeout;
  private closed = false;
  private onlinePeers = new Set<string>();
  private commandResults: Array<{ peerId: string; result: CommandResult; receivedAt: string }> = [];
  private buildLogs: Array<{ peerId: string; event: BuildLogEvent }> = [];

  constructor(
    private state: MothershipState,
    private beaconUrl = state.config.beaconUrl
  ) {}

  connect(): void {
    this.closed = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    const socket = new WebSocket(this.beaconUrl);
    this.socket = socket;
    socket.on("open", () => {
      socket.send(
        JSON.stringify({ type: "REGISTER", role: "mothership", peerId: this.state.peerId })
      );
    });
    socket.on("message", async (raw) => {
      const message = JSON.parse(raw.toString()) as {
        type?: string;
        peerId?: string;
        from?: string;
        body?: unknown;
      };
      if (message.type === "PEER_ONLINE" && message.peerId) {
        this.onlinePeers.add(message.peerId);
      } else if (message.type === "PEER_OFFLINE" && message.peerId) {
        this.onlinePeers.delete(message.peerId);
      } else if (message.type === "FORWARD" && message.from) {
        await this.observeForward(message.from, message.body);
      }
    });
    socket.on("close", () => {
      this.onlinePeers.clear();
      if (!this.closed) {
        this.reconnectTimer = setTimeout(() => this.connect(), 2_000);
      }
    });
    socket.on("error", () => socket.close());
  }

  reconnect(state: MothershipState): void {
    this.state = state;
    this.socket?.removeAllListeners();
    this.socket?.close();
    this.onlinePeers.clear();
    this.connect();
  }

  updateState(state: MothershipState): void {
    this.state = state;
  }

  sendCommand(outpostPeerId: string, command: OutpostCommand): SignedEnvelope<OutpostCommand> {
    const envelope = createSignedEnvelope({
      senderId: this.state.peerId,
      recipientId: outpostPeerId,
      privateKeyPem: this.state.privateKeyPem,
      payload: command
    });
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(
        JSON.stringify({
          type: "FORWARD",
          from: this.state.peerId,
          to: outpostPeerId,
          body: envelope
        })
      );
    }
    return envelope;
  }

  isConnected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.socket?.removeAllListeners();
    this.socket?.close();
    this.socket = undefined;
    this.onlinePeers.clear();
  }

  snapshot(): BeaconSnapshot {
    return {
      url: this.beaconUrl,
      connected: this.isConnected(),
      onlinePeers: [...this.onlinePeers],
      commandResults: this.commandResults,
      buildLogs: this.buildLogs
    };
  }

  private async observeForward(peerId: string, body: unknown): Promise<void> {
    const hello = body as PairingHello;
    if (hello?.type === "PAIRING_HELLO") {
      await upsertOutpost({
        peerId,
        publicKeyPem: hello.outpostPublicKey,
        projectName: hello.projectName,
        hostLabel: hello.hostLabel,
        beaconUrl: this.beaconUrl
      });
      return;
    }

    const envelope = body as SignedEnvelope<{
      type?: string;
      report?: OutpostStatusReport;
      result?: CommandResult;
      event?: BuildLogEvent;
    }>;
    if (envelope?.payload?.type === "STATE" && envelope.payload.report) {
      await upsertOutpost({
        peerId,
        projectName: envelope.payload.report.projectName,
        hostLabel: envelope.payload.report.hostLabel,
        beaconUrl: this.beaconUrl,
        lastStatus: envelope.payload.report
      });
    } else if (envelope?.payload?.type === "COMMAND_RESULT") {
      this.commandResults = [
        {
          peerId,
          result: envelope.payload.result as CommandResult,
          receivedAt: new Date().toISOString()
        },
        ...this.commandResults
      ].slice(0, 50);
    } else if (envelope?.payload?.type === "BUILD_LOG") {
      this.buildLogs = [
        ...this.buildLogs,
        { peerId, event: envelope.payload.event as BuildLogEvent }
      ].slice(-500);
    }
  }
}

export type BeaconSnapshot = {
  connected: boolean;
  url: string;
  onlinePeers: string[];
  commandResults: Array<{ peerId: string; result: CommandResult; receivedAt: string }>;
  buildLogs: Array<{ peerId: string; event: BuildLogEvent }>;
};

export class MothershipBeaconHub {
  private clients = new Map<string, MothershipBeaconClient>();

  constructor(private state: MothershipState) {}

  connect(): void {
    for (const beacon of normalizeMothershipConfig(this.state.config).beacons ?? []) {
      this.ensureClient(beacon.url);
    }
  }

  reconnect(state: MothershipState): void {
    this.state = state;
    const wanted = new Set(
      (normalizeMothershipConfig(state.config).beacons ?? []).map((beacon) => beacon.url)
    );
    for (const [url, client] of this.clients) {
      if (!wanted.has(url)) {
        client.close();
        this.clients.delete(url);
      } else {
        client.updateState(state);
      }
    }
    this.connect();
  }

  updateState(state: MothershipState): void {
    this.state = state;
    for (const client of this.clients.values()) {
      client.updateState(state);
    }
  }

  sendCommand(outpostPeerId: string, command: OutpostCommand): SignedEnvelope<OutpostCommand> {
    const outpost = this.state.outposts.find((item) => item.peerId === outpostPeerId);
    const preferred = outpost?.beaconUrl ? this.clients.get(outpost.beaconUrl) : undefined;
    if (preferred) {
      return preferred.sendCommand(outpostPeerId, command);
    }
    const connected = [...this.clients.values()].find((client) => client.isConnected());
    if (connected) {
      return connected.sendCommand(outpostPeerId, command);
    }
    const first = [...this.clients.values()][0] ?? this.ensureClient(this.state.config.beaconUrl);
    return first.sendCommand(outpostPeerId, command);
  }

  snapshot(): BeaconSnapshot & { beacons: BeaconSnapshot[] } {
    const beacons = [...this.clients.values()].map((client) => client.snapshot());
    return {
      connected: beacons.some((beacon) => beacon.connected),
      url: beacons[0]?.url ?? this.state.config.beaconUrl,
      onlinePeers: [...new Set(beacons.flatMap((beacon) => beacon.onlinePeers))],
      commandResults: beacons
        .flatMap((beacon) => beacon.commandResults)
        .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
        .slice(0, 50),
      buildLogs: beacons.flatMap((beacon) => beacon.buildLogs).slice(-500),
      beacons
    };
  }

  close(): void {
    for (const client of this.clients.values()) {
      client.close();
    }
    this.clients.clear();
  }

  private ensureClient(url: string): MothershipBeaconClient {
    const existing = this.clients.get(url);
    if (existing) {
      return existing;
    }
    const client = new MothershipBeaconClient(this.state, url);
    this.clients.set(url, client);
    client.connect();
    return client;
  }
}
