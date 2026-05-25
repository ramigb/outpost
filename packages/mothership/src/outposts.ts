/**
 * @module @outpost/mothership/outposts
 *
 * Outpost inventory helpers: maps {@link OutpostCommand} types to tool names
 * and builds the serialisable inventory used by the AI agent and dashboard.
 */

import type { OutpostCommand } from "@outpost/protocol";
import type { BeaconSnapshot } from "./beaconClient.js";
import type { MothershipState } from "./state.js";

/**
 * Runtime handles passed to the AI agent so it can inspect and command
 * paired Outposts.
 */
export type AiOutpostRuntime = {
  snapshot: () => BeaconSnapshot & { beacons?: BeaconSnapshot[] };
  sendCommand: (peerId: string, command: OutpostCommand) => unknown;
};

/**
 * Maps an {@link OutpostCommand} type to its canonical tool name in the
 * Mothership catalog.
 *
 * @param command - Typed Outpost command.
 * @returns Dotted tool name.
 */
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

/**
 * Builds a serialisable inventory of paired Outposts and Beacon state.
 *
 * @param state - Current Mothership state.
 * @param beacon - Optional aggregated Beacon snapshot.
 * @returns Inventory object suitable for JSON serialisation.
 */
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
