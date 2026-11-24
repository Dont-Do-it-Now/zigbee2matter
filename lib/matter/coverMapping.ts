/** 커튼/블라인드 위치·동작 경계 (T045). */

export type CoverAction = "open" | "close" | "stop";
export type CoverMovement = "opening" | "closing" | "stopped";

export function mapCoverAction(value: string): CoverAction | undefined {
    const action = value.trim().toLowerCase();

    return action === "open" || action === "close" || action === "stop" ? action : undefined;
}

export function mapCoverMovement(value: string): CoverMovement | undefined {
    const movement = value.trim().toLowerCase();

    if (["opening", "open", "forward", "up", "rising"].includes(movement)) return "opening";
    if (["closing", "close", "backward", "back", "reverse", "down", "declining"].includes(movement)) return "closing";
    if (["stopped", "stop", "pause", "paused"].includes(movement)) return "stopped";

    return undefined;
}

function assertPercent(value: number, name: string): void {
    if (!Number.isFinite(value) || value < 0 || value > 100) throw new Error(`${name} must be in 0..100`);
}

/**
 * z2m position/tilt(100=열림) -> Matter percent100ths(0=열림, 100=닫힘).
 * invert=true는 장치/옵션(invert_cover)이 z2m 값 의미를 뒤집은 경우 반전을 해제한다.
 */
export function zigbeeToMatterPercent100ths(value: number, invert = false): number {
    assertPercent(value, "cover position");

    return Math.round((invert ? value : 100 - value) * 100);
}

/** Matter percent100ths(0=열림) -> z2m position/tilt(100=열림). */
export function matterPercent100thsToZigbee(value: number, invert = false): number {
    if (!Number.isFinite(value) || value < 0 || value > 10000) throw new Error("cover percent100ths must be in 0..10000");
    const percent = value / 100;

    return invert ? percent : 100 - percent;
}
