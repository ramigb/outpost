#!/usr/bin/env node
/**
 * @module @outpost/beacon/cli
 *
 * Command-line entry point for the Beacon relay server.
 *
 * @example
 * ```bash
 * node packages/beacon/dist/cli.js --port 8787
 * ```
 */

import { startBeaconServer } from "./server.js";

const portFlag = process.argv.indexOf("--port");
const port = portFlag === -1 ? undefined : Number(process.argv[portFlag + 1]);
startBeaconServer({ port });
