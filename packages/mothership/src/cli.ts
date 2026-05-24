#!/usr/bin/env node
import { startMothershipServer } from "./server.js";

const command = process.argv[2] ?? "start";
const portFlag = process.argv.indexOf("--port");
const port = portFlag === -1 ? undefined : Number(process.argv[portFlag + 1]);

if (command !== "start") {
  console.error("Usage: outpost-mothership start [--port <port>]");
  process.exitCode = 1;
} else {
  await startMothershipServer({ port });
}
