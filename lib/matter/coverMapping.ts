/** 커튼/블라인드 위치·동작 경계 (T045). */

export type CoverAction = "open" | "close" | "stop";
export type CoverMovement = "opening" | "closing" | "stopped";

export function mapCoverPosition(value: number, invert = false): number {
    assertPercent(value, "cover position");

    return invert ? 100 - value : value;
}

export function mapCoverTilt(value: number, invert = false): number {
    assertPercent(value, "cover tilt");

    return invert ? 100 - value : value;
}

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
