import bind from "bind-decorator";
import type {Zigbee2MQTTAPI} from "../types/api";
import logger from "../util/logger";
import type {BridgeBus, BridgeBusInfo, BridgeBusPublishOptions, BridgeBusStats} from "./types";

const NS = "z2m:bridgeBus";

/** Broker-less bridgeBus: publish -> EventBus + retained snapshot, onMessage -> EventBus. */
export default class InProcessBridgeBus implements BridgeBus {
    private connected = false;
    private eventBus: EventBus;
    private defaultPublishOptions: BridgeBusPublishOptions;
    public retainedMessages: {[s: string]: {topic: string; payload: string; options: BridgeBusPublishOptions}} = {};

    get info(): BridgeBusInfo {
        return {version: undefined, server: "in-process"};
    }

    get stats(): BridgeBusStats {
        return {connected: this.isConnected(), queued: 0};
    }

    constructor(eventBus: EventBus, baseTopic: string) {
        this.eventBus = eventBus;
        this.defaultPublishOptions = {clientOptions: {}, baseTopic, skipLog: false, meta: {}};
    }

    async connect(): Promise<void> {
        this.connected = true;
        const stateData: Zigbee2MQTTAPI["bridge/state"] = {state: "online"};
        await this.publish("bridge/state", JSON.stringify(stateData), {clientOptions: {retain: true}});
    }

    async disconnect(): Promise<void> {
        if (this.connected) {
            const stateData: Zigbee2MQTTAPI["bridge/state"] = {state: "offline"};
            await this.publish("bridge/state", JSON.stringify(stateData), {clientOptions: {retain: true}});
        }

        this.eventBus.removeListeners(this);
        this.connected = false;
    }

    isConnected(): boolean {
        return this.connected;
    }

    @bind public onMessage(topic: string, message: Buffer | string): void {
        logger.debug(() => `Received message on '${topic}' with data '${message.toString()}'`, NS);
        this.eventBus.emitBridgeBusMessage({topic, message: message.toString()});
    }

    async publish(topic: string, payload: string, options: Partial<BridgeBusPublishOptions> = {}): Promise<void> {
        if (topic.includes("+") || topic.includes("#")) {
            logger.error(`Topic '${topic}' includes wildcard characters, skipping publish.`);
            return;
        }

        const finalOptions = {...this.defaultPublishOptions, ...options};
        topic = `${finalOptions.baseTopic}/${topic}`;

        if (finalOptions.clientOptions.retain) {
            if (payload) {
                this.retainedMessages[topic] = {payload, options: finalOptions, topic: topic.substring(finalOptions.baseTopic.length + 1)};
            } else {
                delete this.retainedMessages[topic];
            }
        }

        if (!finalOptions.skipLog) {
            logger.info(() => `Publish: topic '${topic}', payload '${payload}'`, NS);
        }

        this.eventBus.emitBridgeBusMessagePublished({topic, payload, options: finalOptions});
    }
}
