/**
 * Zigbee expose를 matter.js bridged endpoint로 조립하는 production 경계.
 *
 * SDK 정의는 동적으로 로드하고, 승인된 조명 매핑만 선택한다. 정의가 없는
 * expose를 임의의 Matter device type으로 바꾸지 않는다.
 */
import type {MappingExpose} from "./mappingRegistry";
import type {MatterEndpointFactory, MatterMainModule} from "./sdkRuntime";
import type {EndpointRegistryEntry} from "./endpointRegistry";
import {matterLevelToZigbee, zigbeeBrightnessToMatter} from "./lightingMapping";

interface EndpointDefinition {
    with(behavior: unknown): unknown;
}

interface EndpointEvents {
    onOff?: {onOff$Changed?: {on(listener: (value: boolean) => void): void}};
    levelControl?: {currentLevel$Changed?: {on(listener: (value: number) => void): void}};
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

interface FactoryOptions {
    loadSdk: () => Promise<MatterMainModule>;
    resolve: (entry: EndpointRegistryEntry) => Promise<ZigbeeMatterEndpointSource | undefined>;
}

export class ZigbeeMatterEndpointFactory implements MatterEndpointFactory {
    private readonly endpoints = new Map<string, MatterEndpointInstance>();
    private readonly stateUpdates = new Set<string>();

    constructor(private readonly options: FactoryOptions) {}

    async create(entry: EndpointRegistryEntry): Promise<{endpoint: unknown}> {
        const source = await this.options.resolve(entry);
        if (source === undefined) throw new Error(`Matter source is unavailable for ${entry.key}`);

        const sdk = await this.options.loadSdk();
        const Endpoint = sdk.Endpoint as MatterEndpointConstructor | undefined;
        if (!Endpoint) throw new Error("Matter SDK does not expose Endpoint");

        const definition = await this.definitionFor(sdk, source.exposes);
        const {BridgedDeviceBasicInformationServer} = await import("@matter/main/behaviors/bridged-device-basic-information");
        const endpoint = new Endpoint(definition.with(BridgedDeviceBasicInformationServer), {
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
        }
    }

    async updateState(entry: EndpointRegistryEntry, state: Record<string, unknown>): Promise<void> {
        const endpoint = this.endpoints.get(entry.endpointId);
        if (endpoint === undefined) return;

        const patch: Record<string, unknown> = {};
        if (state.state === "ON" || state.state === "OFF") {
            patch.onOff = {onOff: state.state === "ON"};
        }
        if (typeof state.brightness === "number") {
            patch.levelControl = {currentLevel: zigbeeBrightnessToMatter(state.brightness).level};
        }
        if (Object.keys(patch).length === 0) return;

        this.stateUpdates.add(entry.endpointId);
        try {
            await endpoint.set(patch);
        } finally {
            this.stateUpdates.delete(entry.endpointId);
        }
    }

    private async definitionFor(_sdk: MatterMainModule, exposes: readonly MappingExpose[]): Promise<EndpointDefinition> {
        const light = flatten(exposes).find((expose) => expose.type === "light");
        if (!light) throw new Error("Matter mapping is unsupported: expose is not a light");

        const hasBrightness = light.features?.some((feature) => feature.type === "numeric" && feature.name === "brightness") ?? false;
        if (hasBrightness) {
            const {DimmableLightDevice} = await import("@matter/main/devices/dimmable-light");
            return DimmableLightDevice as unknown as EndpointDefinition;
        }

        const {OnOffLightDevice} = await import("@matter/main/devices/on-off-light");
        return OnOffLightDevice as unknown as EndpointDefinition;
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
