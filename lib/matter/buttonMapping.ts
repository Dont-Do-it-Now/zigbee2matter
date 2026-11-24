/** 버튼 action을 Matter Switch 이벤트로 바꾸는 순수 경계 (T044). */

export type MatterSwitchEvent = "initialPress" | "shortRelease" | "longPress" | "multiPressComplete";

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

export function assertButtonCommand(): never {
    throw new Error("button events do not accept write commands");
}
