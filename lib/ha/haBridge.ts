/**
 * HA 연동 서버측 어댑터(T049/T050/T051). Core 경계(C5): Matter/HTTP 구현을 import하지 않고
 * `HaIntegrationRouter`(+선택 `HaHybridPolicy`)만 사용한다.
 *
 * composition root(controller)가 할 일(통합 요청):
 *   const haBridge = new HaBridge(this.ha, {hybrid: this.haHybrid, mode: "direct"});
 *   device interview 성공/exposes 변경 → haBridge.syncDevice(device.ID, mapDeviceExposes(exposes, ctx))
 *   device 제거                       → haBridge.removeDevice(device.ID)
 *   state snapshot observe/availability → haBridge.applyState(record)   (StateRecord 형태)
 *   REST listRestDevices()              → {..., entities: haBridge.restEntities(device.ID)}
 */

import type {HaHybridPolicy} from "../api/haHybrid";
import type {HaCommand, HaIntegrationMode, HaIntegrationRouter} from "../api/haIntegration";
import {type EntityKey, parseEntityKey} from "../identity";
import {entityValue, type HaEntityDefinition} from "./entityMapping";

export interface HaBridgeOptions {
    /** 기본 "direct". "hybrid"면 matterCovered 엔티티는 Direct로 노출하지 않는다(T051). */
    readonly mode?: HaIntegrationMode;
    readonly hybrid?: HaHybridPolicy;
}

export interface HaStateRecordLike {
    readonly key: string;
    readonly observedValue?: unknown;
    readonly availability?: boolean;
    readonly observedAt?: number;
}

export class HaBridge {
    private mode: HaIntegrationMode;
    private readonly byDevice = new Map<string, HaEntityDefinition[]>();
    private readonly byStateKey = new Map<string, HaEntityDefinition[]>();

    constructor(
        private readonly router: HaIntegrationRouter,
        private readonly options: HaBridgeOptions = {},
    ) {
        this.mode = options.mode ?? "direct";
    }

    setMode(mode: HaIntegrationMode): void {
        this.mode = mode;
        this.options.hybrid?.setMode(mode);
    }

    /** Direct transport로 노출할 엔티티인가. matter 모드는 Direct 노출 없음, hybrid는 Matter 미커버만. */
    exposesDirect(definition: HaEntityDefinition): boolean {
        if (this.mode === "matter") return false;
        if (this.mode === "hybrid") return !definition.matterCovered;

        return true;
    }

    /** device의 엔티티 정의를 (재)등록한다. 사라진 엔티티는 removed 처리하지 않고 unavailable로 보존한다(사용자 삭제 정책 준수). */
    syncDevice(deviceId: string, definitions: readonly HaEntityDefinition[]): void {
        const previous = this.byDevice.get(deviceId) ?? [];
        const next = new Set(definitions.map((d) => d.key));
        for (const old of previous) {
            if (!next.has(old.key)) this.safe(() => this.router.setAvailability("direct", this.keyOf(old), false));
        }
        this.byDevice.set(deviceId, [...definitions]);
        this.rebuildStateIndex();
        for (const definition of definitions) {
            this.router.register("direct", this.keyOf(definition), definition.platform, definition.name);
            if (this.options.hybrid && this.exposesDirect(definition)) this.bindHybrid(definition);
        }
    }

    removeDevice(deviceId: string): void {
        for (const definition of this.byDevice.get(deviceId) ?? []) {
            this.safe(() => this.router.setAvailability("direct", this.keyOf(definition), false));
        }
        this.byDevice.delete(deviceId);
        this.rebuildStateIndex();
    }

    /** C2 StateRecord(또는 delta/availability payload) 반영. 해당 상태 키의 모든 엔티티에 전달한다. */
    applyState(record: HaStateRecordLike): void {
        for (const definition of this.byStateKey.get(record.key) ?? []) {
            const key = this.keyOf(definition);
            if (record.availability !== undefined) this.safe(() => this.router.setAvailability("direct", key, record.availability !== false));
            const value = entityValue(definition, record.observedValue);
            if (value !== undefined) this.safe(() => this.router.publishState("direct", key, value, record.observedAt ?? Date.now()));
        }
    }

    definitions(deviceId?: string): HaEntityDefinition[] {
        if (deviceId !== undefined) return [...(this.byDevice.get(deviceId) ?? [])];

        return [...this.byDevice.values()].flat();
    }

    /** REST `/api/v1/devices` 의 `entities` 필드 값. 모드에 따라 Direct 비노출 엔티티를 제외한다. */
    restEntities(deviceId: string): HaEntityDefinition[] {
        return (this.byDevice.get(deviceId) ?? []).filter((d) => this.exposesDirect(d));
    }

    /** HA 서비스 호출 → Core command(set payload). 비멱등 toggle은 지원하지 않는다(C3). */
    translateCommand(definition: HaEntityDefinition, service: string, data: Record<string, unknown> = {}): HaCommand {
        const entity = parseEntityKey(definition.stateKey);
        if (!entity) throw new Error("invalid HA entity state key");

        return {entity, service: "set", data: commandPayload(definition, service, data)};
    }

    private keyOf(definition: HaEntityDefinition): EntityKey {
        const key = parseEntityKey(definition.key);
        if (!key) throw new Error(`invalid HA entity key: ${definition.key}`);

        return key;
    }

    private bindHybrid(definition: HaEntityDefinition): void {
        const hybrid = this.options.hybrid;
        if (!hybrid) return;
        if (hybrid.list("hybrid").some((binding) => binding.key === definition.key)) return;
        hybrid.bind({key: definition.key, directUniqueId: definition.uniqueId});
    }

    private rebuildStateIndex(): void {
        this.byStateKey.clear();
        for (const definition of this.byDevice.values()) {
            for (const d of definition) this.byStateKey.set(d.stateKey, [...(this.byStateKey.get(d.stateKey) ?? []), d]);
        }
    }

    /** 미등록 엔티티 등 개별 실패가 다른 엔티티 전달을 막지 않게 한다. */
    private safe(fn: () => void): void {
        try {
            fn();
        } catch {
            // router가 미등록/미구성 엔티티를 거부한 경우: 상태는 다음 delta에서 재시도된다.
        }
    }
}

function commandPayload(d: HaEntityDefinition, service: string, data: Record<string, unknown>): Record<string, unknown> {
    const cp = d.commandProperty;
    const cfg = d.config as Record<string, unknown>;
    const need = (): string => {
        if (!cp) throw new Error(`HA entity is read-only: ${d.key}`);

        return cp;
    };
    switch (d.platform) {
        case "light": {
            if (service === "turn_off") return {[need()]: cfg.offValue ?? "OFF"};
            if (service !== "turn_on") break;
            const payload: Record<string, unknown> = {[need()]: cfg.onValue ?? "ON"};
            for (const k of ["brightness", "color_temp", "color"] as const) if (data[k] !== undefined) payload[k] = data[k];

            return payload;
        }
        case "switch":
            if (service === "turn_on") return {[need()]: cfg.onValue};
            if (service === "turn_off") return {[need()]: cfg.offValue};
            break;
        case "lock":
            if (service === "lock") return {[need()]: cfg.lockedValue};
            if (service === "unlock") return {[need()]: cfg.unlockedValue};
            break;
        case "cover":
            if (service === "open_cover") return {[need()]: cfg.openValue};
            if (service === "close_cover") return {[need()]: cfg.closeValue};
            if (service === "stop_cover") return {[need()]: cfg.stopValue};
            if (service === "set_cover_position" && typeof cfg.positionProperty === "string") return {[cfg.positionProperty]: data.position};
            break;
        case "number":
        case "select":
            if (service === "set_value") return {[need()]: data.value};
            break;
        case "button":
            if (service === "press") return {[need()]: cfg.pressValue};
            break;
        case "climate":
            if (service === "set_temperature" && typeof cfg.heatingSetpointProperty === "string") {
                return {[cfg.heatingSetpointProperty]: data.temperature};
            }
            if (service === "set_hvac_mode" && typeof cfg.modeProperty === "string") return {[cfg.modeProperty]: data.mode};
            break;
        default:
            break;
    }
    throw new Error(`unsupported HA service ${service} for ${d.platform}`);
}
