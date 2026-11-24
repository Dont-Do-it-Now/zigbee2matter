#!/usr/bin/env node
const path = require("node:path");
if (process.env.ZIGBEE2MQTT_DATA && !process.env.ZIGBEE2MATTER_DATA) {
    console.warn("ZIGBEE2MQTT_DATA is ignored; set ZIGBEE2MATTER_DATA instead.");
}
process.env.ZIGBEE2MATTER_DATA = process.env.ZIGBEE2MATTER_DATA || path.join(process.env.HOME || process.env.USERPROFILE || ".", ".zigbee2matter");
require("./index");
