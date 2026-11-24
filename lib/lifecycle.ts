export type ServicePhase = "idle" | "starting" | "running" | "stopping" | "stopped" | "failed";

export interface LifecycleComponent {
    name: string;
    start: () => Promise<void>;
    stop: () => Promise<void>;
}

export class ServiceUnavailableError extends Error {
    readonly code = "UNAVAILABLE" as const;
}

/** T022 lifecycle coordinator. Composition root supplies storage, Zigbee, state and adapters in that order. */
export default class ServiceLifecycle {
    private readonly started: LifecycleComponent[] = [];
    private currentPhase: ServicePhase = "idle";

    get phase(): ServicePhase {
        return this.currentPhase;
    }

    get acceptingCommands(): boolean {
        return this.currentPhase === "running";
    }

    async start(components: ReadonlyArray<LifecycleComponent>): Promise<void> {
        if (this.currentPhase !== "idle" && this.currentPhase !== "stopped" && this.currentPhase !== "failed") {
            throw new Error(`cannot start services while phase is ${this.currentPhase}`);
        }

        this.currentPhase = "starting";
        this.started.length = 0;

        try {
            for (const component of components) {
                await component.start();
                this.started.push(component);
            }

            this.currentPhase = "running";
        } catch (error) {
            this.currentPhase = "failed";
            await this.stopStarted(false);
            throw error;
        }
    }

    async stop(): Promise<void> {
        if (this.currentPhase === "idle" || this.currentPhase === "stopped") {
            this.currentPhase = "stopped";

            return;
        }

        this.currentPhase = "stopping";
        try {
            await this.stopStarted(true);
        } finally {
            this.currentPhase = "stopped";
        }
    }

    assertCommandsAllowed(): void {
        if (!this.acceptingCommands) {
            throw new ServiceUnavailableError(`commands are unavailable during ${this.currentPhase}`);
        }
    }

    private async stopStarted(reportErrors: boolean): Promise<void> {
        const errors: unknown[] = [];

        for (const component of [...this.started].reverse()) {
            try {
                await component.stop();
            } catch (error) {
                errors.push(error);
            }
        }

        this.started.length = 0;

        if (reportErrors && errors.length > 0) {
            throw new AggregateError(errors, "one or more services failed to stop");
        }
    }
}
