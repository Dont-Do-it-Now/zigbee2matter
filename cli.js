#!/usr/bin/env node
const path = require("node:path");
process.env.ZIGBEE2MATTER_DATA = process.env.ZIGBEE2MATTER_DATA || process.env.ZIGBEE2MQTT_DATA || path.join(process.env.HOME, ".zigbee2matter");
require("./index");
