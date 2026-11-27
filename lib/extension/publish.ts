import bind from "bind-decorator";
import type * as zhc from "zigbee-herdsman-converters";
import {BASE_TOPIC} from "../bridgeBus/constants"; // z2m-fork: T006
import Device from "../model/device";
import Group from "../model/group";
import logger from "../util/logger";
import * as settings from "../util/settings";
import {stringify} from "../util/stringify";
import utils from "../util/utils";
import Extension from "./extension";

// TODO: get rid of this, use class member
let topicGetSetRegex: RegExp;
// Used by `publish.test.ts` to reload regex when changing `mqtt.base_topic`.
export const loadTopicGetSetRegex = (): void => {
    topicGetSetRegex = new RegExp(`^${BASE_TOPIC}/(?!bridge)(.+?)/(get|set)(?:/(.+))?$`);
};

const STATE_VALUES: ReadonlyArray<string> = ["on", "off", "toggle", "open", "close", "stop", "lock", "unlock"];
const SCENE_CONVERTER_KEYS: ReadonlyArray<string> = ["scene_store", "scene_add", "scene_remove", "scene_remove_all", "scene_rename"];

interface ParsedTopic {
    ID: string;
    endpoint: string | undefined;
    attribute: string;
    type: "get" | "set";
}

export default class Publish extends Extension {
    private readonly commandQueues = new Map<string, Promise<void>>();
    /** Queued (not yet started) `set` commands per queue key; a newer command touching the same keys supersedes them. */
    private readonly queuedSets = new Map<string, {keys: string[]; superseded: boolean}[]>();
    /** The running `set` per queue key, released early once the device reports the requested values. */
    private readonly inFlight = new Map<string, {ID: string | number; release: () => void; matches: (update: KeyValue) => boolean}>();

    // biome-ignore lint/suspicious/useAwait: API
    override async start(): Promise<void> {
        loadTopicGetSetRegex();
        this.eventBus.onBridgeBusMessage(this, this.onBridgeBusMessage);
        this.eventBus.onStateChange(this, this.onStateChange);
    }

    @bind private onStateChange(data: eventdata.StateChange): void {
        // Optimistic/cached values are not device reports.
        if (data.reason === "commandOptimistic" || data.reason === "groupOptimistic" || data.reason === "publishCached") return;
        for (const flight of this.inFlight.values()) if (flight.ID === data.entity.ID && flight.matches(data.update)) flight.release();
    }

    parseTopic(topic: string): ParsedTopic | undefined {
        // The function supports the following topic formats (below are for 'set'. 'get' will look the same):
        // - <base_topic>/device_name/set (auto-matches endpoint and attribute is defined in the payload)
        // - <base_topic>/device_name/set/attribute (default endpoint used)
        // - <base_topic>/device_name/endpoint/set (attribute is defined in the payload)
        // - <base_topic>/device_name/endpoint/set/attribute (payload is the value)

        // Make the rough split on get/set keyword.
        // Before the get/set is the device name and optional endpoint name.
        // After it there will be an optional attribute name.
        const match = topic.match(topicGetSetRegex);

        if (!match) {
            return undefined;
        }

        const deviceNameAndEndpoint = match[1];
        const attribute = match[3];

        // Now parse the device/group name, and endpoint name
        const entity = this.zigbee.resolveEntityAndEndpoint(deviceNameAndEndpoint);
        return {ID: entity.ID, endpoint: entity.endpointID, type: match[2] as "get" | "set", attribute: attribute};
    }

    parseMessage(parsedTopic: ParsedTopic, data: eventdata.BridgeBusMessage): KeyValue | undefined {
        if (parsedTopic.attribute) {
            try {
                return {[parsedTopic.attribute]: JSON.parse(data.message)};
            } catch {
                return {[parsedTopic.attribute]: data.message};
            }
        } else {
            try {
                return JSON.parse(data.message);
            } catch {
                return STATE_VALUES.includes(data.message.toLowerCase()) ? {state: data.message} : undefined;
            }
        }
    }

    updateMessageHomeAssistant(message: KeyValue, entityState: KeyValue): void {
        /**
         * Home Assistant always publishes 'state', even when e.g. only setting
         * the color temperature. This would lead to 2 zigbee publishes, where the first one
         * (state) is probably unnecessary.
         */
        if (settings.get().homeassistant.enabled) {
            const hasColorTemp = message.color_temp !== undefined;
            const hasColor = message.color !== undefined;
            const hasBrightness = message.brightness !== undefined;
            if (entityState.state === "ON" && (hasColorTemp || hasColor) && !hasBrightness) {
                delete message.state;
                logger.debug("Skipping state because of Home Assistant");
            }
        }
    }

    @bind async onBridgeBusMessage(data: eventdata.BridgeBusMessage): Promise<void> {
        const parsedTopic = this.parseTopic(data.topic);

        if (!parsedTopic) {
            return;
        }

        const queueKey = `${parsedTopic.ID}/${parsedTopic.endpoint ?? "default"}`;
        const previous = this.commandQueues.get(queueKey) ?? Promise.resolve();
        // Latest command wins: a queued, not yet started `set` whose keys are all re-set by this command is dropped.
        const message = this.parseMessage(parsedTopic, data) ?? {};
        const queued = {keys: Object.keys(message), superseded: false};
        const track = parsedTopic.type === "set" && queued.keys.length > 0;
        if (track) {
            const waiting = this.queuedSets.get(queueKey) ?? [];
            for (const older of waiting) if (older.keys.every((key) => queued.keys.includes(key))) older.superseded = true;
            this.queuedSets.set(queueKey, [...waiting.filter((item) => !item.superseded), queued]);
        }
        const current = previous
            .catch(() => undefined)
            .then(() => {
                if (track)
                    this.queuedSets.set(
                        queueKey,
                        (this.queuedSets.get(queueKey) ?? []).filter((item) => item !== queued),
                    );
                if (queued.superseded) {
                    logger.info(
                        `Zigbee command superseded by a newer command: ${parsedTopic.ID}/${parsedTopic.endpoint ?? "default"} keys=${queued.keys.join(",")}`,
                    );
                    return undefined;
                }

                // `parsedTopic.ID` is the topic token (friendly name), state changes carry the entity's own ID (ieeeAddr / group id).
                const entityID = track ? this.zigbee.resolveEntity(parsedTopic.ID)?.ID : undefined;
                if (entityID === undefined) return this.processBridgeBusMessage(data, parsedTopic);

                // The ZCL call may wait for a Default Response (e.g. 10s timeout on a sleepy end device) although the device already
                // reported the requested state: release the queue slot as soon as that report arrives. The call itself continues.
                let released = false;
                let release = (): void => {};
                const observed = new Promise<void>((resolve) => {
                    release = () => {
                        released = true;
                        resolve();
                    };
                });
                const names = (key: string): string[] => (parsedTopic.endpoint ? [key, `${key}_${parsedTopic.endpoint}`] : [key]);
                const flight = {
                    ID: entityID,
                    release,
                    matches: (update: KeyValue): boolean =>
                        Object.entries(message).every(([key, value]) =>
                            names(key).some(
                                (name) =>
                                    name in update && typeof value !== "object" && String(update[name]).toLowerCase() === String(value).toLowerCase(),
                            ),
                        ),
                };
                this.inFlight.set(queueKey, flight);

                return Promise.race([this.processBridgeBusMessage(data, parsedTopic, () => released), observed]).finally(() => {
                    if (this.inFlight.get(queueKey) === flight) this.inFlight.delete(queueKey);
                });
            });
        this.commandQueues.set(queueKey, current);
        try {
            await current;
        } finally {
            if (this.commandQueues.get(queueKey) === current) this.commandQueues.delete(queueKey);
        }
    }

    private async processBridgeBusMessage(
        data: eventdata.BridgeBusMessage,
        parsedTopic: ParsedTopic,
        isReleased: () => boolean = () => false,
    ): Promise<void> {
        const re = this.zigbee.resolveEntity(parsedTopic.ID);

        if (!re) {
            logger.error(`Entity '${parsedTopic.ID}' is unknown`);
            return;
        }

        // Get entity details
        let definition: zhc.Definition | zhc.Definition[];
        if (re instanceof Device) {
            if (!re.definition) {
                logger.error(`Cannot publish to unsupported device '${re.name}'`);
                return;
            }
            definition = re.definition;
        } else {
            definition = re.membersDefinitions();
        }
        const target = re instanceof Group ? re.zh : re.endpoint(parsedTopic.endpoint);

        if (!target) {
            logger.error(`Device '${re.name}' has no endpoint '${parsedTopic.endpoint}'`);
            return;
        }

        // Convert the MQTT message to a Zigbee message.
        const message = this.parseMessage(parsedTopic, data);

        if (!message) {
            logger.error(`Invalid message '${message}', skipping...`);
            return;
        }

        const device = re instanceof Device ? re.zh : undefined;
        const entitySettings = re.options;
        const entityState = this.state.get(re);
        const membersState =
            re instanceof Group
                ? // biome-ignore lint/style/noNonNullAssertion: TODO: biome migration: might be a bit much assumed here?
                  Object.fromEntries(re.zh.members.map((e) => [e.deviceIeeeAddress, this.state.get(this.zigbee.resolveEntity(e.deviceIeeeAddress)!)]))
                : undefined;
        const converters = this.getDefinitionConverters(definition);

        this.updateMessageHomeAssistant(message, entityState);

        /**
         * Order state & brightness based on current bulb state
         *
         * Not all bulbs support setting the color/color_temp while it is off
         * this results in inconsistent behavior between different vendors.
         *
         * bulb on => move state & brightness to the back
         * bulb off => move state & brightness to the front
         */
        const entries = Object.entries(message);
        const sorter = typeof message.state === "string" && message.state.toLowerCase() === "off" ? 1 : -1;
        entries.sort((a) => (["state", "brightness", "brightness_percent"].includes(a[0]) ? sorter : sorter * -1));

        // For each attribute call the corresponding converter
        const usedConverters: {[s: number]: zhc.Tz.Converter[]} = {};
        const toPublish: {[s: number | string]: KeyValue} = {};
        const toPublishEntity: {[s: number | string]: Device | Group} = {};
        const addToToPublish = (entity: Device | Group, payload: KeyValue): void => {
            const ID = entity.ID;

            if (!(ID in toPublish)) {
                toPublish[ID] = {};
                toPublishEntity[ID] = entity;
            }

            toPublish[ID] = {...toPublish[ID], ...payload};
        };

        const endpointNames = re instanceof Device ? re.getEndpointNames() : [];
        const propertyEndpointRegex = new RegExp(`^(.*?)_(${endpointNames.join("|")})$`);
        let scenesChanged = false;

        for (const entry of entries) {
            let key = entry[0];
            const value = entry[1];
            let endpointName = parsedTopic.endpoint;
            let localTarget = target;
            let endpointOrGroupID = utils.isZHEndpoint(target) ? target.ID : target.groupID;

            // When the key has a endpointName included (e.g. state_right), this will override the target.
            const propertyEndpointMatch = key.match(propertyEndpointRegex);

            if (re instanceof Device && propertyEndpointMatch) {
                endpointName = propertyEndpointMatch[2];
                key = propertyEndpointMatch[1];
                // biome-ignore lint/style/noNonNullAssertion: endpointName is always matched to an existing endpoint of the device since `propertyEndpointRegex` only contains valid endpoints for this device
                localTarget = re.endpoint(endpointName)!;
                endpointOrGroupID = localTarget.ID;
            }

            if (usedConverters[endpointOrGroupID] === undefined) usedConverters[endpointOrGroupID] = [];
            // Match any key if the toZigbee converter defines no key.
            const converter = converters.find(
                (c) =>
                    (!c.key || c.key.includes(key)) && (re instanceof Group || !c.endpoints || (endpointName && c.endpoints.includes(endpointName))),
            );

            if (parsedTopic.type === "set" && converter && usedConverters[endpointOrGroupID].includes(converter)) {
                // Use a converter for set only once
                // (e.g. light_onoff_brightness converters can convert state and brightness)
                continue;
            }

            if (!converter) {
                logger.error(`No converter available for '${key}' on '${re.name}': (${stringify(message[key])})`);
                continue;
            }

            // If the endpoint_name name is a number, try to map it to a friendlyName
            if (!Number.isNaN(Number(endpointName)) && re.isDevice() && utils.isZHEndpoint(localTarget) && re.endpointName(localTarget)) {
                endpointName = re.endpointName(localTarget);
            }

            // Converter didn't return a result, skip
            const entitySettingsKeyValue: KeyValue = entitySettings;
            const meta: zhc.Tz.Meta = {
                endpoint_name: endpointName,
                options: entitySettingsKeyValue,
                message: {...message},
                device,
                state: entityState,
                membersState,
                mapped: definition,
                /* v8 ignore start */
                deviceExposesChanged: (): void => {
                    if (re instanceof Device) this.eventBus.emitExposesAndDevicesChanged(re);
                },
                /* v8 ignore stop */
                /* v8 ignore next */
                publish: (payload: KeyValue) => this.publishEntityState(re, payload),
            };

            // Strip endpoint name from meta.message properties.
            if (endpointName) {
                for (const [key, value] of Object.entries(meta.message)) {
                    if (key.endsWith(endpointName)) {
                        delete meta.message[key];
                        const keyWithoutEndpoint = key.substring(0, key.length - endpointName.length - 1);
                        meta.message[keyWithoutEndpoint] = value;
                    }
                }

                if (parsedTopic.type === "set") {
                    logger.info(
                        `Zigbee command received: device=${re.name} endpoint=${endpointName ?? "default"} key=${key} value=${stringify(value)}`,
                    );
                }
            }

            try {
                if (parsedTopic.type === "set" && converter.convertSet) {
                    logger.debug(`Publishing '${parsedTopic.type}' '${key}' to '${re.name}'`);
                    const result = await converter.convertSet(localTarget, key, value, meta);
                    logger.info(
                        `Zigbee converter completed: device=${re.name} endpoint=${endpointName ?? "default"} key=${key} state=${
                            result?.state === undefined ? "none" : stringify(result.state)
                        }`,
                    );
                    const optimistic = entitySettings.optimistic === undefined || entitySettings.optimistic;

                    if (result?.state && optimistic) {
                        const msg = result.state;

                        if (endpointName) {
                            for (const key of Object.keys(msg)) {
                                msg[`${key}_${endpointName}`] = msg[key];
                                delete msg[key];
                            }
                        }

                        // filter out attribute listed in filtered_optimistic
                        utils.filterProperties(entitySettings.filtered_optimistic, msg);

                        addToToPublish(re, msg);
                    }

                    if (result?.membersState && optimistic) {
                        for (const [ieeeAddr, state] of Object.entries(result.membersState)) {
                            // biome-ignore lint/style/noNonNullAssertion: might be a bit much assumed here?
                            addToToPublish(this.zigbee.resolveEntity(ieeeAddr)!, state);
                        }
                    }
                } else if (parsedTopic.type === "get" && converter.convertGet) {
                    logger.debug(`Publishing get '${parsedTopic.type}' '${key}' to '${re.name}'`);
                    await converter.convertGet(localTarget, key, meta);
                } else {
                    logger.error(`No converter available for '${parsedTopic.type}' '${key}' (${message[key]})`);
                    continue;
                }
            } catch (error) {
                const message = `Publish '${parsedTopic.type}' '${key}' to '${re.name}' failed: '${error}'`;
                logger.error(message);
                // biome-ignore lint/style/noNonNullAssertion: always Error
                logger.debug((error as Error).stack!);
            }

            usedConverters[endpointOrGroupID].push(converter);

            if (!scenesChanged && converter.key) {
                scenesChanged = converter.key.some((k) => SCENE_CONVERTER_KEYS.includes(k));
            }
        }

        for (const [ID, payload] of Object.entries(toPublish)) {
            // Released early: the device already reported its real state, a later optimistic value could overwrite a newer command.
            if (!isReleased() && !utils.objectIsEmpty(payload)) {
                await this.publishEntityState(toPublishEntity[ID], payload, "commandOptimistic"); // z2m-fork: T020 낙관값은 confirmed 관측이 아니다
            }
        }

        if (scenesChanged) {
            this.eventBus.emitScenesChanged({entity: re});
        }
    }

    private getDefinitionConverters(definition: zhc.Definition | zhc.Definition[]): ReadonlyArray<zhc.Tz.Converter> {
        if (Array.isArray(definition)) {
            return definition.length ? Array.from(new Set(definition.flatMap((d) => d.toZigbee))) : [];
        }

        return definition?.toZigbee;
    }
}
