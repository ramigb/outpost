#!/usr/bin/env node
import { startBeaconServer } from "./server.js";

const portFlag = process.argv.indexOf("--port");
const port = portFlag === -1 ? undefined : Number(process.argv[portFlag + 1]);
startBeaconServer({ port });
