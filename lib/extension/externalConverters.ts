import type {ExternalDefinitionWithExtend} from "zigbee-herdsman-converters";

import {addExternalDefinition, removeExternalDefinitions} from "zigbee-herdsman-converters";

import {inspectConverterDefinition} from "../converter/contract";
import logger from "../util/logger";
import ExternalJSExtension from "./externalJS";

type TModule = ExternalDefinitionWithExtend | ExternalDefinitionWithExtend[];

export default class ExternalConverters extends ExternalJSExtension<TModule> {
    constructor(
        zigbee: Zigbee,
        bridgeBus: BridgeBus,
        state: State,
        publishEntityState: PublishEntityState,
        eventBus: EventBus,
        enableDisableExtension: (enable: boolean, name: string) => Promise<void>,
        restartCallback: () => Promise<void>,
        addExtension: (extension: Extension) => Promise<void>,
    ) {
        super(
            zigbee,
            bridgeBus,
            state,
            publishEntityState,
            eventBus,
            enableDisableExtension,
            restartCallback,
            addExtension,
            "converter",
            "external_converters",
        );
    }

    protected async removeJS(name: string, _mod: TModule): Promise<void> {
        removeExternalDefinitions(name);

        await this.zigbee.resolveDevicesDefinitions(true);
    }

    protected async loadJS(name: string, mod: TModule, newName?: string): Promise<void> {
        try {
            const definitions = Array.isArray(mod) ? mod : [mod];
            const reports = definitions.map((definition) => inspectConverterDefinition(definition));
            const invalid = reports.flatMap((report) => report.issues);
            if (invalid.length > 0) {
                const codes = invalid.map((issue) => issue.code).join(", ");
                throw new Error(`External converter contract rejected: ${codes}`);
            }

            // Validate every definition before removing the previous registration.
            removeExternalDefinitions(name);

            for (const definition of definitions) {
                definition.externalConverterName = newName ?? name;

                addExternalDefinition(definition);
                logger.info(`Loaded external converter '${newName ?? name}'.`);
            }

            await this.zigbee.resolveDevicesDefinitions(true);
        } catch (error) {
            logger.error(
                /* v8 ignore next */
                `Failed to load external converter '${newName ?? name}'. Check the code for syntax error and make sure it is up to date with the current Zigbee2MQTT version.`,
            );
            logger.warning(
                "External converters are not meant for long term usage, but for local testing after which a pull request should be created to add out-of-the-box support for the device",
            );

            throw error;
        }
    }
}
