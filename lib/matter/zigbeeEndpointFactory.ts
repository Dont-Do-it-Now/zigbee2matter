/**
 * Zigbee expose를 matter.js bridged endpoint로 조립하는 production 경계.
 *
 * SDK 정의는 동적으로 로드하고, 승인된 조명 매핑만 선택한다. 정의가 없는
 * expose를 임의의 Matter device type으로 바꾸지 않는다.
 */
import type {MappingExpose} from "./mappingRegistry";
import type {MatterEndpointFactory, MatterMainModule} from "./sdkRuntime";
import type {EndpointRegistryEntry} from "./endpointRegistry";
import {matterLevelToZigbee, validateColorTemperatureMireds, zigbeeBrightnessToMatter} from "./lightingMapping";
import {celsiusToMatter, humidityPercentToMatter} from "./sensorMapping";

interface EndpointDefinition {
    with(behavior: unknown): unknown;
}

interface EndpointEvents {
    onOff?: {onOff$Changed?: {on(listener: (value: boolean) => void): void}};
    levelControl?: {currentLevel$Changed?: {on(listener: (value: number) => void): void}};
    colorControl?: {colorTemperatureMireds$Changed?: {on(listener: (value: number) => void): void}};
}

interface MatterEndpointInstance {
    number?: unknown;
    events?: EndpointEvents;
    set(values: Record<string, unknown>): Promise<void>;
    close(): Promise<void>;
}

interface MatterEndpointConstructor {
    new (definition: unknown, options?: Record<string, unknown>): MatterEndpointInstance;
}

interface ZigbeeMatterEndpointSource {
    name: string;
    exposes: readonly MappingExpose[];
    send: (payload: Record<string, unknown>) => Promise<void>;
}

type MatterCapability = "light" | "colorTemperature" | "temperature" | "humidity" | "contact" | "occupancy";

interface EndpointDefinitionPlan {
    definition: EndpointDefinition;
    capability: MatterCapability;
}

interface FactoryOptions {
    loadSdk: () => Promise<MatterMainModule>;
    resolve: (entry: EndpointRegistryEntry) => Promise<ZigbeeMatterEndpointSource | undefined>;
}

export class ZigbeeMatterEndpointFactory implements MatterEndpointFactory {
    private readonly endpoints = new Map<string, MatterEndpointInstance>();
    private readonly capabilities = new Map<string, MatterCapability>();
    private readonly stateUpdates = new Set<string>();

    constructor(private readonly options: FactoryOptions) {}

    async create(entry: EndpointRegistryEntry): Promise<{endpoint: unknown}> {
        const source = await this.options.resolve(entry);
        if (source === undefined) throw new Error(`Matter source is unavailable for ${entry.key}`);

        const sdk = await this.options.loadSdk();
        const Endpoint = sdk.Endpoint as MatterEndpointConstructor | undefined;
        if (!Endpoint) throw new Error("Matter SDK does not expose Endpoint");

        const plan = await this.definitionFor(sdk, source.exposes);
        const {BridgedDeviceBasicInformationServer} = await import("@matter/main/behaviors/bridged-device-basic-information");
        const endpoint = new Endpoint(plan.definition.with(BridgedDeviceBasicInformationServer), {
            id: entry.endpointId,
            bridgedDeviceBasicInformation: {
                nodeLabel: source.name,
                productName: source.name,
                productLabel: source.name,
                serialNumber: entry.endpointId,
                reachable: true,
            },
        });

        this.bindCommands(endpoint, entry.endpointId, source.send);
        this.endpoints.set(entry.endpointId, endpoint);
        this.capabilities.set(entry.endpointId, plan.capability);

        return {endpoint};
    }

    readAssignedNumber(entry: EndpointRegistryEntry, endpoint: unknown, added: unknown): number {
        const endpointNumber = (endpoint as MatterEndpointInstance).number;
        const addedNumber = (added as {number?: unknown} | undefined)?.number;
        const number = endpointNumber ?? addedNumber;
        if (!Number.isSafeInteger(number) || number < 1 || number > 0xfffe) {
            throw new Error(`Matter endpoint '${entry.endpointId}' did not receive a valid number`);
        }

        return number;
    }

    async remove(entry: EndpointRegistryEntry): Promise<void> {
        const endpoint = this.endpoints.get(entry.endpointId);
        if (endpoint === undefined) return;

        try {
            await endpoint.close();
        } finally {
            this.endpoints.delete(entry.endpointId);
            this.stateUpdates.delete(entry.endpointId);
            this.capabilities.delete(entry.endpointId);
        }
    }

    async updateState(entry: EndpointRegistryEntry, state: Record<string, unknown>): Promise<void> {
        const endpoint = this.endpoints.get(entry.endpointId);
        if (endpoint === undefined) return;

        const capability = this.capabilities.get(entry.endpointId);
        if (!capability) return;

        const patch: Record<string, unknown> = {};
        if (typeof state.available === "boolean") {
            patch.bridgedDeviceBasicInformation = {reachable: state.available};
        }
        if (capability === "light" || capability === "colorTemperature") {
            if (state.state === "ON" || state.state === "OFF") patch.onOff = {onOff: state.state === "ON"};
            if (typeof state.brightness === "number") patch.levelControl = {currentLevel: zigbeeBrightnessToMatter(state.brightness).level};
            if (capability === "colorTemperature" && typeof state.color_temp === "number") {
                patch.colorControl = {colorTemperatureMireds: validateColorTemperatureMireds(state.color_temp)};
            }
        } else if (capability === "temperature" && (typeof state.temperature === "number" || state.temperature === null)) {
            const value = celsiusToMatter(state.temperature);
            if (value.known) patch.temperatureMeasurement = {measuredValue: value.value};
        } else if (capability === "humidity" && (typeof state.humidity === "number" || state.humidity === null)) {
            const value = humidityPercentToMatter(state.humidity);
            if (value.known) patch.relativeHumidityMeasurement = {measuredValue: value.value};
        } else if (capability === "contact" && typeof state.contact === "boolean") {
            patch.booleanState = {booleanStateValue: state.contact};
        } else if (capability === "occupancy" && typeof state.occupancy === "boolean") {
            patch.occupancySensing = {occupancy: state.occupancy ? 1 : 0};
        }
        if (Object.keys(patch).length === 0) return;

        this.stateUpdates.add(entry.endpointId);
        try {
            await endpoint.set(patch);
        } finally {
            this.stateUpdates.delete(entry.endpointId);
        }
    }

    private async definitionFor(_sdk: MatterMainModule, exposes: readonly MappingExpose[]): Promise<EndpointDefinitionPlan> {
        const flattened = flatten(exposes);
        const light = flatten(exposes).find((expose) => expose.type === "light");
        const temperature = flattened.find((expose) => expose.type === "numeric" && expose.name === "temperature");
        const humidity = flattened.find((expose) => expose.type === "numeric" && expose.name === "humidity");
        const contact = flattened.find((expose) => expose.type === "binary" && expose.name === "contact");
        const occupancy = flattened.find((expose) => expose.type === "binary" && expose.name === "occupancy");
        const matches = [light, temperature, humidity, contact, occupancy].filter((value) => value !== undefined);
        if (matches.length !== 1) throw new Error("Matter mapping is unsupported: endpoint must expose exactly one approved capability");

        if (light) {
            const hasColor = light.features?.some((feature) => feature.name === "color") ?? false;
            const hasColorTemperature = light.features?.some((feature) => feature.type === "numeric" && feature.name === "color_temp") ?? false;
            if (hasColor) throw new Error("Matter mapping is unsupported: full color light requires an approved ColorControl mapping");
            if (hasColorTemperature) {
                const {ColorTemperatureLightDevice} = await import("@matter/main/devices/color-temperature-light");
                return {definition: ColorTemperatureLightDevice as unknown as EndpointDefinition, capability: "colorTemperature"};
            }

            const hasBrightness = light.features?.some((feature) => feature.type === "numeric" && feature.name === "brightness") ?? false;
            if (hasBrightness) {
                const {DimmableLightDevice} = await import("@matter/main/devices/dimmable-light");
                return {definition: DimmableLightDevice as unknown as EndpointDefinition, capability: "light"};
            }

            const {OnOffLightDevice} = await import("@matter/main/devices/on-off-light");
            return {definition: OnOffLightDevice as unknown as EndpointDefinition, capability: "light"};
        }
        if (temperature) {
            const {TemperatureSensorDevice} = await import("@matter/main/devices/temperature-sensor");
            return {definition: TemperatureSensorDevice as unknown as EndpointDefinition, capability: "temperature"};
        }
        if (humidity) {
            const {HumiditySensorDevice} = await import("@matter/main/devices/humidity-sensor");
            return {definition: HumiditySensorDevice as unknown as EndpointDefinition, capability: "humidity"};
        }
        if (contact) {
            const {ContactSensorDevice} = await import("@matter/main/devices/contact-sensor");
            return {definition: ContactSensorDevice as unknown as EndpointDefinition, capability: "contact"};
        }

        if (occupancy) {
            const {OccupancySensorDevice} = await import("@matter/main/devices/occupancy-sensor");
            return {definition: OccupancySensorDevice as unknown as EndpointDefinition, capability: "occupancy"};
        }

        throw new Error("Matter mapping is unsupported");
    }

    private bindCommands(endpoint: MatterEndpointInstance, endpointId: string, send: ZigbeeMatterEndpointSource["send"]): void {
        endpoint.events?.onOff?.onOff$Changed?.on((value) => {
            if (this.stateUpdates.has(endpointId)) return;
            void send({state: value ? "ON" : "OFF"});
        });
        endpoint.events?.levelControl?.currentLevel$Changed?.on((value) => {
            if (this.stateUpdates.has(endpointId)) return;
            void send({brightness: matterLevelToZigbee(value)});
        });
        endpoint.events?.colorControl?.colorTemperatureMireds$Changed?.on((value) => {
            if (this.stateUpdates.has(endpointId)) return;
            void send({color_temp: validateColorTemperatureMireds(value)});
        });
    }
}

function flatten(exposes: readonly MappingExpose[]): MappingExpose[] {
    const result: MappingExpose[] = [];
    for (const expose of exposes) {
        result.push(expose);
        if (expose.features !== undefined) result.push(...flatten(expose.features));
    }
    return result;
}
