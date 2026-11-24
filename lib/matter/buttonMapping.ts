/** 버튼 action을 Matter Switch 이벤트로 바꾸는 순수 경계 (T044). */

export type MatterSwitchEvent = "initialPress" | "shortRelease" | "longPress" | "longRelease" | "multiPressOngoing" | "multiPressComplete";

export interface ButtonEvent {
    event: MatterSwitchEvent;
    pressCount?: number;
}

export type ButtonActionResult = {supported: true; value: ButtonEvent} | {supported: false; reason: string};

const ACTIONS: Readonly<Record<string, MatterSwitchEvent>> = {
    initial_press: "initialPress",
    short_release: "shortRelease",
    long_press: "longPress",
    multi_press_complete: "multiPressComplete",
};

/** 의미가 확인된 action만 매핑하며, 알 수 없는 action은 보존하지 않고 미지원으로 반환한다. */
export function mapButtonAction(action: string, pressCount?: number): ButtonActionResult {
    const event = ACTIONS[action.trim().toLowerCase()];
    if (event === undefined) return {supported: false, reason: `unsupported button action: ${action}`};

    if (event === "multiPressComplete") {
        if (!Number.isSafeInteger(pressCount) || pressCount < 2) {
            return {supported: false, reason: "multi_press_complete requires pressCount >= 2"};
        }

        return {supported: true, value: {event, pressCount}};
    }

    if (pressCount !== undefined) {
        return {supported: false, reason: `${event} must not include pressCount`};
    }

    return {supported: true, value: {event}};
}

export type SwitchEventEmission =
    | {name: "initialPress" | "longPress"; payload: {newPosition: number}}
    | {name: "shortRelease" | "longRelease"; payload: {previousPosition: number}}
    | {name: "multiPressOngoing"; payload: {newPosition: number; currentNumberOfPressesCounted: number}}
    | {name: "multiPressComplete"; payload: {previousPosition: number; totalNumberOfPressesCounted: number}};

/** 순간 이벤트를 Matter Switch 이벤트 payload로 바꾼다. 눌림 위치 1, 중립 위치 0 (momentary). */
export function toSwitchEmission(value: ButtonEvent): SwitchEventEmission {
    if (value.event === "multiPressOngoing") {
        return {name: "multiPressOngoing", payload: {newPosition: 1, currentNumberOfPressesCounted: value.pressCount ?? 2}};
    }
    if (value.event === "multiPressComplete") {
        return {name: "multiPressComplete", payload: {previousPosition: 1, totalNumberOfPressesCounted: value.pressCount ?? 2}};
    }
    if (value.event === "shortRelease" || value.event === "longRelease") return {name: value.event, payload: {previousPosition: 1}};

    return {name: value.event, payload: {newPosition: 1}};
}

export interface ButtonSequence {
    /** 다버튼 리모컨의 버튼 식별자(`1_single`의 `1`). 없으면 단일 버튼. */
    button?: string;
    events: ButtonEvent[];
    /** hold 이후 release가 LongRelease가 되도록 하는 상태 전이. */
    longActive: boolean;
}

export type ButtonSequenceResult = ({supported: true} & ButtonSequence) | {supported: false; reason: string};

const PRESS_COUNTS: Readonly<Record<string, number>> = {single: 1, double: 2, triple: 3, quadruple: 4};
const BASE_ACTIONS = [
    "initial_press",
    "short_release",
    "long_press",
    "long_release",
    "multi_press_complete",
    "single",
    "double",
    "triple",
    "quadruple",
    "press_release",
    "hold_release",
    "hold",
    "press",
    "release",
];

/** 단일(접두 없는) 버튼의 식별자. */
export const DEFAULT_BUTTON = "";

/** action enum values에서 버튼 목록을 도출한다. 접두 버튼이 없으면 [DEFAULT_BUTTON]. 해석 불가 값은 무시(미지원). */
export function deriveButtons(values: readonly string[] | undefined): string[] {
    const found = new Set<string>();
    for (const value of values ?? []) {
        const parts = splitButtonAction(value);
        if (parts !== undefined) found.add(parts.button ?? DEFAULT_BUTTON);
    }
    if (found.size === 0) return [DEFAULT_BUTTON];

    return [...found].sort((a, b) =>
        a === b ? 0 : a === DEFAULT_BUTTON ? -1 : b === DEFAULT_BUTTON ? 1 : a.localeCompare(b, "en", {numeric: true}),
    );
}

/** `<button>_<base>` 또는 `<base>_<button>` 접두/접미 버튼 식별자를 분리한다. */
export function splitButtonAction(raw: string): {button?: string; base: string} | undefined {
    const action = raw.trim().toLowerCase();
    if (BASE_ACTIONS.includes(action)) return {base: action};
    const sorted = [...BASE_ACTIONS].sort((a, b) => b.length - a.length);
    for (const base of sorted) {
        if (action.endsWith(`_${base}`) && action.length > base.length + 1) return {button: action.slice(0, -(base.length + 1)), base};
        if (action.startsWith(`${base}_`) && action.length > base.length + 1) return {button: action.slice(base.length + 1), base};
    }

    return undefined;
}

/**
 * z2m action을 Matter Switch 이벤트 순서로 풀어낸다 (Matter Switch 클러스터 이벤트 시퀀스).
 * single -> InitialPress, ShortRelease, MultiPressComplete(1);
 * N회(double/triple/quadruple) -> InitialPress, ShortRelease, (MultiPressOngoing(i), ShortRelease)*(i=2..N), MultiPressComplete(N)
 * (Matter Switch 1.13.8, MSR+MSM 구성; 근거: @matter/types@0.18.0 clusters/switch.d.ts MultiPressOngoing/MultiPressComplete);
 * hold -> InitialPress, LongPress; release -> LongRelease(hold 이후) 또는 ShortRelease.
 */
export function mapButtonActionSequence(raw: string, longActive = false, pressCount?: number): ButtonSequenceResult {
    const parts = splitButtonAction(raw);
    if (parts === undefined) return {supported: false, reason: `unsupported button action: ${raw}`};

    const {button, base} = parts;
    const done = (events: ButtonEvent[], active = false): ButtonSequenceResult => ({supported: true, button, events, longActive: active});
    const count = PRESS_COUNTS[base];
    if (count !== undefined) {
        const events: ButtonEvent[] = [{event: "initialPress"}, {event: "shortRelease"}];
        for (let i = 2; i <= count; i++) events.push({event: "multiPressOngoing", pressCount: i}, {event: "shortRelease"});
        events.push({event: "multiPressComplete", pressCount: count});

        return done(events);
    }

    switch (base) {
        case "press":
        case "initial_press":
            return done([{event: "initialPress"}], longActive);
        case "hold":
            return done([{event: "initialPress"}, {event: "longPress"}], true);
        case "long_press":
            return done([{event: "longPress"}], true);
        case "press_release":
            return done([{event: "shortRelease"}]);
        case "hold_release":
            return done([{event: "longRelease"}]);
        case "release":
            return done([{event: longActive ? "longRelease" : "shortRelease"}]);
        case "short_release":
            return done([{event: "shortRelease"}]);
        case "long_release":
            return done([{event: "longRelease"}]);
        default: {
            const result = mapButtonAction(base, pressCount);

            return result.supported ? done([result.value]) : result;
        }
    }
}

export function assertButtonCommand(): never {
    throw new Error("button events do not accept write commands");
}
