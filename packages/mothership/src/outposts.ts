import type { OutpostCommand } from "@outpost/protocol";
import type { BeaconSnapshot } from "./beaconClient.js";
import type { MothershipState } from "./state.js";

export type AiOutpostRuntime = {
  snapshot: () => BeaconSnapshot & { beacons?: BeaconSnapshot[] };
  sendCommand: (peerId: string, command: OutpostCommand) => unknown;
};

export function toolNameForOutpostCommand(command: OutpostCommand): string {
  switch (command.type) {
    case "DEPLOY":
      return "outpost.deploy";
    case "ROLLBACK":
      return "outpost.rollback";
    case "SET_ENV":
      return "outpost.set_env";
    case "APPLY_RECIPE":
      return "outpost.apply_recipe";
    case "DOCTOR":
      return "outpost.doctor";
    case "DETECT_APP":
    case "RUN_HEALTH_CHECK":
    case "PING":
    case "GET_STATE":
      return "outpost.inspect";
  }
}

export function buildOutpostInventory(
  state: MothershipState,
  beacon?: BeaconSnapshot & { beacons?: BeaconSnapshot[] }
) {
  const onlinePeers = new Set(beacon?.onlinePeers ?? []);
  return {
    pairedOutposts: state.outposts.map((outpost) => ({
      peerId: outpost.peerId,
      projectName: outpost.projectName ?? outpost.lastStatus?.projectName,
      hostLabel: outpost.hostLabel ?? outpost.lastStatus?.hostLabel,
      beaconUrl: outpost.beaconUrl,
      online: onlinePeers.has(outpost.peerId),
      updatedAt: outpost.updatedAt,
      lastStatus: outpost.lastStatus
    })),
    beacon: beacon
      ? {
          connected: beacon.connected,
          url: beacon.url,
          onlinePeers: beacon.onlinePeers,
          recentCommandResults: beacon.commandResults.slice(0, 10),
          recentBuildLogs: beacon.buildLogs.slice(-20),
          beacons: beacon.beacons?.map((item) => ({
            connected: item.connected,
            url: item.url,
            onlinePeers: item.onlinePeers
          }))
        }
      : undefined
  };
}
