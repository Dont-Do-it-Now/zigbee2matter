/**
 * Zigbee expose를 matter.js bridged endpoint로 조립하는 production 경계.
 *
 * SDK 정의는 동적으로 로드하고, 승인된 조명 매핑만 선택한다. 정의가 없는
 * expose를 임의의 Matter device type으로 바꾸지 않는다.
 */
import type {MappingExpose} from "./mappingRegistry";
import type {MatterEndpointFactory, MatterMainModule} from "./sdkRuntime";
import type {EndpointRegistryEntry} from "./endpointRegistry";
import {
    matterColorToZigbee,
    matterColorXyToZigbee,
    matterLevelToZigbee,
    validateColorTemperatureMireds,
    zigbeeBrightnessToMatter,
    zigbeeColorToMatter,
    zigbeeColorXyToMatter,
} from "./lightingMapping";
import {celsiusToMatter, humidityPercentToMatter} from "./sensorMapping";
import {toWattHours, toWatts} from "./energyMapping";
import {mapCoverPosition} from "./coverMapping";
import {mapButtonAction} from "./buttonMapping";

interface EndpointDefinition {
    with(behavior: unknown): unknown;
}

interface EndpointEvents {
    onOff?: {onOff$Changed?: {on(listener: (value: boolean) => void): void}};
    levelControl?: {currentLevel$Changed?: {on(listener: (value: number) => void): void}};
    colorControl?: {
        colorTemperatureMireds$Changed?: {on(listener: (value: number) => void): void};
        currentHue$Changed?: {on(listener: (value: number) => void): void};
        currentSaturation$Changed?: {on(listener: (value: number) => void): void};
        currentX$Changed?: {on(listener: (value: number) => void): void};
        currentY$Changed?: {on(listener: (value: number) => void): void};
    };
    windowCovering?: {
        targetPositionLiftPercent100ths$Changed?: {on(listener: (value: number | null) => void): void};
        targetPositionTiltPercent100ths$Changed?: {on(listener: (value: number | null) => void): void};
    };
    thermostat?: {
        systemMode$Changed?: {on(listener: (value: number) => void): void};
        occupiedHeatingSetpoint$Changed?: {on(listener: (value: number) => void): void};
        occupiedCoolingSetpoint$Changed?: {on(listener: (value: number) => void): void};
        unoccupiedHeatingSetpoint$Changed?: {on(listener: (value: number) => void): void};
        unoccupiedCoolingSetpoint$Changed?: {on(listener: (value: number) => void): void};
    };
    switch?: {
        initialPress?: {on(listener: (value: unknown) => void): void};
        shortRelease?: {on(listener: (value: unknown) => void): void};
        longPress?: {on(listener: (value: unknown) => void): void};
        multiPressComplete?: {on(listener: (value: {totalNumberOfPressesCounted?: number}) => void): void};
    };
}

interface MatterEndpointInstance {
    number?: unknown;
    events?: EndpointEvents;
    set(values: Record<string, unknown>): Promise<void>;
    close(): Promise<void>;
    delete?(): Promise<void>;
}

interface MatterEndpointConstructor {
    new (definition: unknown, options?: Record<string, unknown>): MatterEndpointInstance;
}

interface ZigbeeMatterEndpointSource {
    name: string;
    available: boolean;
    exposes: readonly MappingExpose[];
    send: (payload: Record<string, unknown>) => Promise<void>;
}

type MatterCapability = "light" | "color" | "colorTemperature" | "cover" | "button" | "energy" | "temperature" | "humidity" | "contact" | "occupancy" | "lock" | "thermostat";

interface EndpointDefinitionPlan {
    definition: EndpointDefinition;
    capability: MatterCapability;
    supportsTilt?: boolean;
    supportsPower?: boolean;
    supportsEnergy?: boolean;
}

interface CoverPositionState {
    lift?: number;
    tilt?: number;
}

interface FactoryOptions {
    loadSdk: () => Promise<MatterMainModule>;
    resolve: (entry: EndpointRegistryEntry) => Promise<ZigbeeMatterEndpointSource | undefined>;
    onCommandError?: (endpointId: string, error: unknown) => void;
}

export class ZigbeeMatterEndpointFactory implements MatterEndpointFactory {
    private readonly endpoints = new Map<string, MatterEndpointInstance>();
    private readonly capabilities = new Map<string, MatterCapability>();
    private readonly coverTilts = new Map<string, boolean>();
    private readonly coverPositions = new Map<string, CoverPositionState>();
    private readonly energyPower = new Map<string, boolean>();
    private readonly energyCumulative = new Map<string, boolean>();
    private readonly stateUpdates = new Set<string>();
    private readonly colorValues = new Map<string, {hue?: number; saturation?: number; x?: number; y?: number}>();

    constructor(private readonly options: FactoryOptions) {}

    async create(entry: EndpointRegistryEntry): Promise<{endpoint: unknown}> {
        const source = await this.options.resolve(entry);
        if (source === undefined) throw new Error(`Matter source is unavailable for ${entry.key}`);

        const sdk = await this.options.loadSdk();
        const Endpoint = sdk.Endpoint as MatterEndpointConstructor | undefined;
        if (!Endpoint) throw new Error("Matter SDK does not expose Endpoint");

        const plan = await this.definitionFor(sdk, source.exposes, source.send);
        const {BridgedDeviceBasicInformationServer} = await import("@matter/main/behaviors/bridged-device-basic-information");
        const endpoint = new Endpoint(plan.definition.with(BridgedDeviceBasicInformationServer), {
            id: entry.endpointId,
            bridgedDeviceBasicInformation: {
                nodeLabel: source.name,
                productName: source.name,
                productLabel: source.name,
                serialNumber: entry.endpointId,
                reachable: source.available,
            },
        });

        this.bindCommands(endpoint, entry.endpointId, source.send);
        this.endpoints.set(entry.endpointId, endpoint);
        this.capabilities.set(entry.endpointId, plan.capability);
        this.coverTilts.set(entry.endpointId, plan.supportsTilt === true);
        this.coverPositions.set(entry.endpointId, {});
        this.energyPower.set(entry.endpointId, plan.supportsPower === true);
        this.energyCumulative.set(entry.endpointId, plan.supportsEnergy === true);
        this.colorValues.set(entry.endpointId, {});

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

    async remove(entry: EndpointRegistryEntry): Promise<{permanent: boolean}> {
        const endpoint = this.endpoints.get(entry.endpointId);
        if (endpoint === undefined) return {permanent: true};

        try {
            if (endpoint.delete !== undefined) {
                await endpoint.delete();
                return {permanent: true};
            }

            await endpoint.close();
            return {permanent: false};
        } finally {
            this.endpoints.delete(entry.endpointId);
            this.stateUpdates.delete(entry.endpointId);
            this.capabilities.delete(entry.endpointId);
            this.coverTilts.delete(entry.endpointId);
            this.coverPositions.delete(entry.endpointId);
            this.energyPower.delete(entry.endpointId);
            this.energyCumulative.delete(entry.endpointId);
            this.colorValues.delete(entry.endpointId);
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
        if (capability === "light" || capability === "color" || capability === "colorTemperature") {
            if (state.state === "ON" || state.state === "OFF") patch.onOff = {onOff: state.state === "ON"};
            if (typeof state.brightness === "number") patch.levelControl = {currentLevel: zigbeeBrightnessToMatter(state.brightness).level};
            if (capability === "colorTemperature" && typeof state.color_temp === "number") {
                patch.colorControl = {colorTemperatureMireds: validateColorTemperatureMireds(state.color_temp)};
            }
            if (capability === "color") {
                const color = state.color;
                if (isRecord(color) && typeof color.hue === "number" && typeof color.saturation === "number") {
                    const mapped = zigbeeColorToMatter(color.hue, color.saturation);
                    patch.colorControl = {currentHue: mapped.hue, currentSaturation: mapped.saturation};
                } else if (isRecord(color) && typeof color.x === "number" && typeof color.y === "number") {
                    const mapped = zigbeeColorXyToMatter(color.x, color.y);
                    patch.colorControl = {currentX: mapped.x, currentY: mapped.y};
                }
            }
        } else if (capability === "cover") {
            const windowCovering: Record<string, unknown> = {};
            const positions = this.coverPositions.get(entry.endpointId) ?? {};
            if (typeof state.position === "number") {
                positions.lift = Math.round(mapCoverPosition(state.position) * 100);
                windowCovering.currentPositionLiftPercent100ths = positions.lift;
            }
            if (this.coverTilts.get(entry.endpointId) && typeof state.tilt === "number") {
                positions.tilt = Math.round(mapCoverPosition(state.tilt) * 100);
                windowCovering.currentPositionTiltPercent100ths = positions.tilt;
            }
            this.coverPositions.set(entry.endpointId, positions);
            if (Object.keys(windowCovering).length > 0) patch.windowCovering = windowCovering;
        } else if (capability === "energy") {
            if (this.energyPower.get(entry.endpointId) && typeof state.power === "number") {
                patch.electricalPowerMeasurement = {activePower: Math.round(toWatts(state.power, "W") * 1000)};
            }
            if (this.energyCumulative.get(entry.endpointId) && typeof state.energy === "number") {
                patch.electricalEnergyMeasurement = {cumulativeEnergyImported: {energy: Math.round(toWattHours(state.energy, "Wh") * 1000)}};
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
        } else if (capability === "lock") {
            const lockState = matterLockState(state.state ?? state.lock_state);
            if (lockState !== undefined) patch.doorLock = {lockState};
        } else if (capability === "thermostat") {
            const thermostat: Record<string, unknown> = {};
            const localTemperature = celsiusToMatterValue(state.local_temperature);
            if (localTemperature !== undefined) thermostat.localTemperature = localTemperature;
            const heatingSetpoint = celsiusToMatterValue(state.occupied_heating_setpoint);
            if (heatingSetpoint !== undefined) thermostat.occupiedHeatingSetpoint = heatingSetpoint;
            const coolingSetpoint = celsiusToMatterValue(state.occupied_cooling_setpoint);
            if (coolingSetpoint !== undefined) thermostat.occupiedCoolingSetpoint = coolingSetpoint;
            const unoccupiedHeatingSetpoint = celsiusToMatterValue(state.unoccupied_heating_setpoint);
            if (unoccupiedHeatingSetpoint !== undefined) thermostat.unoccupiedHeatingSetpoint = unoccupiedHeatingSetpoint;
            const unoccupiedCoolingSetpoint = celsiusToMatterValue(state.unoccupied_cooling_setpoint);
            if (unoccupiedCoolingSetpoint !== undefined) thermostat.unoccupiedCoolingSetpoint = unoccupiedCoolingSetpoint;
            const systemMode = matterSystemMode(state.system_mode);
            if (systemMode !== undefined) thermostat.systemMode = systemMode;
            if (Object.keys(thermostat).length > 0) patch.thermostat = thermostat;
        }
        if (Object.keys(patch).length === 0) return;

        this.stateUpdates.add(entry.endpointId);
        try {
            await endpoint.set(patch);
        } finally {
            this.stateUpdates.delete(entry.endpointId);
        }
    }

    private async definitionFor(
        _sdk: MatterMainModule,
        exposes: readonly MappingExpose[],
        send: ZigbeeMatterEndpointSource["send"],
    ): Promise<EndpointDefinitionPlan> {
        const flattened = flatten(exposes);
        const light = flatten(exposes).find((expose) => expose.type === "light");
        const temperature = flattened.find((expose) => expose.type === "numeric" && expose.name === "temperature");
        const humidity = flattened.find((expose) => expose.type === "numeric" && expose.name === "humidity");
        const contact = flattened.find((expose) => expose.type === "binary" && expose.name === "contact");
        const occupancy = flattened.find((expose) => expose.type === "binary" && expose.name === "occupancy");
        const cover = flattened.find((expose) => expose.type === "cover");
        const button = flattened.find((expose) => expose.type === "enum" && expose.name === "action");
        const power = flattened.find((expose) => expose.type === "numeric" && expose.name === "power");
        const cumulativeEnergy = flattened.find((expose) => expose.type === "numeric" && expose.name === "energy");
        const energy = power ?? cumulativeEnergy;
        const lock = flattened.find((expose) => expose.type === "lock");
        const thermostat = flattened.find((expose) => expose.type === "climate");
        const matches = [light, cover, button, energy, temperature, humidity, contact, occupancy, lock, thermostat].filter((value) => value !== undefined);
        if (matches.length !== 1) throw new Error("Matter mapping is unsupported: endpoint must expose exactly one approved capability");

        if (light) {
            const hasColor = light.features?.some((feature) => feature.name === "color") ?? false;
            const hasColorTemperature = light.features?.some((feature) => feature.type === "numeric" && feature.name === "color_temp") ?? false;
            if (hasColor) {
                const {ExtendedColorLightDevice} = await import("@matter/main/devices/extended-color-light");
                return {definition: ExtendedColorLightDevice as unknown as EndpointDefinition, capability: "color"};
            }
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
        if (cover) {
            const [{WindowCoveringDevice}, {WindowCoveringServer}] = await Promise.all([
                import("@matter/main/devices/window-covering"),
                import("@matter/main/behaviors/window-covering"),
            ]);
            const supportsTilt = cover.features?.some((feature) => feature.type === "numeric" && feature.name === "tilt") ?? false;
            const features = supportsTilt ? ["Lift", "PositionAwareLift", "Tilt", "PositionAwareTilt"] : ["Lift", "PositionAwareLift"];
            return {
                definition: WindowCoveringDevice.with(WindowCoveringServer.with(...features)) as unknown as EndpointDefinition,
                capability: "cover",
                supportsTilt,
            };
        }
        if (button) {
            const [{GenericSwitchDevice}, {SwitchServer}] = await Promise.all([
                import("@matter/main/devices/generic-switch"),
                import("@matter/main/behaviors/switch"),
            ]);
            return {
                definition: GenericSwitchDevice.with(
                    SwitchServer.with("MomentarySwitch", "MomentarySwitchRelease", "MomentarySwitchLongPress", "MomentarySwitchMultiPress"),
                ) as unknown as EndpointDefinition,
                capability: "button",
            };
        }
        if (energy) {
            const [{ElectricalMeterDevice}, {ElectricalPowerMeasurementServer}, {ElectricalEnergyMeasurementServer}] = await Promise.all([
                import("@matter/main/devices/electrical-meter"),
                import("@matter/main/behaviors/electrical-power-measurement"),
                import("@matter/main/behaviors/electrical-energy-measurement"),
            ]);
            return {
                definition: ElectricalMeterDevice.with(
                    ...(power ? [ElectricalPowerMeasurementServer] : []),
                    ...(cumulativeEnergy ? [ElectricalEnergyMeasurementServer.with("ImportedEnergy", "CumulativeEnergy")] : []),
                ) as unknown as EndpointDefinition,
                capability: "energy",
                supportsPower: power !== undefined,
                supportsEnergy: cumulativeEnergy !== undefined,
            };
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
        if (lock) {
            const [{DoorLockDevice}, {DoorLockServer}] = await Promise.all([
                import("@matter/main/devices/door-lock"),
                import("@matter/main/behaviors/door-lock"),
            ]);
            class ZigbeeDoorLockServer extends DoorLockServer {
                async handleLockOperation(operation: {actuation: string}): Promise<void> {
                    if (operation.actuation === "lock") await send({state: "LOCK"});
                    else if (operation.actuation === "unlock" || operation.actuation === "unbolt") await send({state: "UNLOCK"});
                }
            }
            return {
                definition: DoorLockDevice.with(ZigbeeDoorLockServer) as unknown as EndpointDefinition,
                capability: "lock",
            };
        }
        if (thermostat) {
            const [{ThermostatDevice}, {ThermostatServer}] = await Promise.all([
                import("@matter/main/devices/thermostat"),
                import("@matter/main/behaviors/thermostat"),
            ]);
            const systemMode = thermostat.features?.find((feature) => feature.type === "enum" && feature.name === "system_mode");
            const modes = systemMode?.values ?? [];
            const supportsHeating = modes.includes("heat") || modes.includes("emergency_heating") || thermostat.features?.some((feature) => feature.name === "occupied_heating_setpoint") === true;
            const supportsCooling = modes.includes("cool") || thermostat.features?.some((feature) => feature.name === "occupied_cooling_setpoint") === true;
            const supportsOccupancy = thermostat.features?.some((feature) => feature.name?.startsWith("unoccupied_")) === true;
            const features: string[] = [];
            if (supportsHeating) features.push("Heating");
            if (supportsCooling) features.push("Cooling");
            if (supportsOccupancy) features.push("Occupancy");
            if (modes.includes("auto") && supportsHeating && supportsCooling) features.push("AutoMode");
            if (features.length === 0) throw new Error("Matter thermostat mapping requires heating or cooling support");
            return {
                definition: ThermostatDevice.with(ThermostatServer.with(...features)) as unknown as EndpointDefinition,
                capability: "thermostat",
            };
        }

        throw new Error("Matter mapping is unsupported");
    }

    private bindCommands(endpoint: MatterEndpointInstance, endpointId: string, send: ZigbeeMatterEndpointSource["send"]): void {
        endpoint.events?.onOff?.onOff$Changed?.on((value) => {
            if (this.stateUpdates.has(endpointId)) return;
            this.sendCommand(endpointId, send, {state: value ? "ON" : "OFF"});
        });
        endpoint.events?.levelControl?.currentLevel$Changed?.on((value) => {
            if (this.stateUpdates.has(endpointId)) return;
            this.sendCommand(endpointId, send, {brightness: matterLevelToZigbee(value)});
        });
        endpoint.events?.colorControl?.colorTemperatureMireds$Changed?.on((value) => {
            if (this.stateUpdates.has(endpointId)) return;
            this.sendCommand(endpointId, send, {color_temp: validateColorTemperatureMireds(value)});
        });
        endpoint.events?.colorControl?.currentHue$Changed?.on((value) => {
            if (this.stateUpdates.has(endpointId)) return;
            const colors = this.colorValues.get(endpointId) ?? {};
            colors.hue = value;
            this.colorValues.set(endpointId, colors);
            if (colors.saturation !== undefined) this.sendCommand(endpointId, send, {color: matterColorToZigbee(value, colors.saturation)});
        });
        endpoint.events?.colorControl?.currentSaturation$Changed?.on((value) => {
            if (this.stateUpdates.has(endpointId)) return;
            const colors = this.colorValues.get(endpointId) ?? {};
            colors.saturation = value;
            this.colorValues.set(endpointId, colors);
            if (colors.hue !== undefined) this.sendCommand(endpointId, send, {color: matterColorToZigbee(colors.hue, value)});
        });
        endpoint.events?.colorControl?.currentX$Changed?.on((value) => {
            if (this.stateUpdates.has(endpointId)) return;
            const colors = this.colorValues.get(endpointId) ?? {};
            colors.x = value;
            this.colorValues.set(endpointId, colors);
            if (colors.y !== undefined) this.sendCommand(endpointId, send, {color: matterColorXyToZigbee(value, colors.y)});
        });
        endpoint.events?.colorControl?.currentY$Changed?.on((value) => {
            if (this.stateUpdates.has(endpointId)) return;
            const colors = this.colorValues.get(endpointId) ?? {};
            colors.y = value;
            this.colorValues.set(endpointId, colors);
            if (colors.x !== undefined) this.sendCommand(endpointId, send, {color: matterColorXyToZigbee(colors.x, value)});
        });
        endpoint.events?.windowCovering?.targetPositionLiftPercent100ths$Changed?.on((value) => {
            if (this.stateUpdates.has(endpointId) || value === null) return;
            const current = this.coverPositions.get(endpointId)?.lift;
            this.sendCommand(endpointId, send, current === value ? {state: "STOP"} : {position: mapCoverPosition(value / 100)});
        });
        endpoint.events?.windowCovering?.targetPositionTiltPercent100ths$Changed?.on((value) => {
            if (this.stateUpdates.has(endpointId) || value === null || !this.coverTilts.get(endpointId)) return;
            const current = this.coverPositions.get(endpointId)?.tilt;
            this.sendCommand(endpointId, send, current === value ? {state: "STOP"} : {tilt: mapCoverPosition(value / 100)});
        });
        endpoint.events?.thermostat?.systemMode$Changed?.on((value) => {
            if (this.stateUpdates.has(endpointId)) return;
            const mode = zigbeeSystemMode(value);
            if (mode !== undefined) this.sendCommand(endpointId, send, {system_mode: mode});
        });
        endpoint.events?.thermostat?.occupiedHeatingSetpoint$Changed?.on((value) => {
            if (this.stateUpdates.has(endpointId)) return;
            this.sendCommand(endpointId, send, {occupied_heating_setpoint: value / 100});
        });
        endpoint.events?.thermostat?.occupiedCoolingSetpoint$Changed?.on((value) => {
            if (this.stateUpdates.has(endpointId)) return;
            this.sendCommand(endpointId, send, {occupied_cooling_setpoint: value / 100});
        });
        endpoint.events?.thermostat?.unoccupiedHeatingSetpoint$Changed?.on((value) => {
            if (this.stateUpdates.has(endpointId)) return;
            this.sendCommand(endpointId, send, {unoccupied_heating_setpoint: value / 100});
        });
        endpoint.events?.thermostat?.unoccupiedCoolingSetpoint$Changed?.on((value) => {
            if (this.stateUpdates.has(endpointId)) return;
            this.sendCommand(endpointId, send, {unoccupied_cooling_setpoint: value / 100});
        });
        endpoint.events?.switch?.initialPress?.on(() => this.sendButtonAction(endpointId, send, "initial_press"));
        endpoint.events?.switch?.shortRelease?.on(() => this.sendButtonAction(endpointId, send, "short_release"));
        endpoint.events?.switch?.longPress?.on(() => this.sendButtonAction(endpointId, send, "long_press"));
        endpoint.events?.switch?.multiPressComplete?.on((value) => {
            const pressCount = value.totalNumberOfPressesCounted;
            if (pressCount === undefined) return;
            this.sendButtonAction(endpointId, send, "multi_press_complete", pressCount);
        });
    }

    private sendButtonAction(
        endpointId: string,
        send: ZigbeeMatterEndpointSource["send"],
        action: string,
        pressCount?: number,
    ): void {
        if (this.stateUpdates.has(endpointId)) return;
        const result = mapButtonAction(action, pressCount);
        if (!result.supported) return;
        this.sendCommand(endpointId, send, pressCount === undefined ? {action} : {action, pressCount});
    }

    private sendCommand(endpointId: string, send: ZigbeeMatterEndpointSource["send"], payload: Record<string, unknown>): void {
        void send(payload).catch((error) => this.options.onCommandError?.(endpointId, error));
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

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function matterLockState(value: unknown): number | undefined {
    if (value === "LOCK" || value === "LOCKED" || value === true) return 1;
    if (value === "UNLOCK" || value === "UNLOCKED" || value === false) return 2;
    return undefined;
}

function celsiusToMatterValue(value: unknown): number | undefined {
    if (typeof value !== "number") return undefined;
    const mapped = celsiusToMatter(value);
    return mapped.known ? mapped.value : undefined;
}

function matterSystemMode(value: unknown): number | undefined {
    if (value === "off") return 0;
    if (value === "auto") return 1;
    if (value === "cool") return 3;
    if (value === "heat") return 4;
    if (value === "emergency_heating") return 5;
    return undefined;
}

function zigbeeSystemMode(value: number): "off" | "auto" | "cool" | "heat" | "emergency_heating" | undefined {
    if (value === 0) return "off";
    if (value === 1) return "auto";
    if (value === 3) return "cool";
    if (value === 4) return "heat";
    if (value === 5) return "emergency_heating";
    return undefined;
}
