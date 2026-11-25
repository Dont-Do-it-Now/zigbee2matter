import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const converterPackage = require("zigbee-herdsman-converters/package.json");
const definitions = require("zigbee-herdsman-converters/devices/index").default;

function getFeatureNames(exposes = []) {
    const names = new Set();
    const visit = (items) => {
        for (const item of items) {
            if (item?.name) names.add(item.name);
            if (Array.isArray(item?.features)) visit(item.features);
        }
    };
    if (Array.isArray(exposes)) visit(exposes);
    return [...names].sort((a, b) => a.localeCompare(b));
}

const devices = definitions
    .filter((definition) => definition?.model && definition?.vendor)
    .map((definition) => ({
        model: definition.model,
        vendor: definition.vendor,
        description: definition.description ?? "",
        zigbeeModel: Array.isArray(definition.zigbeeModel) ? definition.zigbeeModel : [],
        whiteLabel: Array.isArray(definition.whiteLabel)
            ? definition.whiteLabel
                  .filter((label) => label && typeof label === "object")
                  .map(({ vendor, model }) => ({ vendor: vendor ?? "", model: model ?? "" }))
            : [],
        exposes: getFeatureNames(definition.exposes),
    }))
    .sort((a, b) => a.vendor.localeCompare(b.vendor) || a.model.localeCompare(b.model));

const outputDirectory = resolve("site/assets");
await mkdir(outputDirectory, { recursive: true });
await writeFile(
    resolve(outputDirectory, "devices.json"),
    `{
  "source": "zigbee-herdsman-converters",
  "version": ${JSON.stringify(converterPackage.version)},
  "license": ${JSON.stringify(converterPackage.license)},
  "devices": [
${devices.map((device) => `    ${JSON.stringify(device)}`).join(",\n")}
  ]
}\n`,
);
process.stdout.write(`Wrote ${devices.length} device definitions from zigbee-herdsman-converters ${converterPackage.version}.\n`);
