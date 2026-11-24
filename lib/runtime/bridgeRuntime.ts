/** Core·EventStream·API·Matter adapter를 묶는 composition root(T032/T053/T056/T057). */
import type EventBus from "../eventBus";
import {EventStream} from "../events";
import {ApiAuth, type AuthOptions} from "../api/auth";
import {ApiServer, type ApiServerOptions} from "../api/server";
import {AuthFailureRateLimiter} from "../api/rateLimit";
import {DiagnosticRegistry} from "../api/diagnostics";
import {MatterSdkRuntime, type MatterNodeOptions} from "../matter/sdkRuntime";
import type {RestDevice} from "../api/restRouter";

export interface BridgeRuntimeOptions {
    readonly eventCapacity?: number;
    readonly auth?: AuthOptions;
    readonly api?: Omit<ApiServerOptions, "auth" | "stream" | "listDevices" | "listDiagnostics" | "authFailureRateLimiter"> & {
        readonly listDevices: () => readonly RestDevice[];
        readonly executeCommand?: (input: unknown) => Promise<unknown>;
    };
}

export class BridgeRuntime {
    readonly events: EventStream;
    readonly auth: ApiAuth;
    readonly diagnostics: DiagnosticRegistry;
    readonly matter: MatterSdkRuntime;
    private readonly api?: ApiServer;
    private attachedEventBus?: EventBus;

    constructor(options: BridgeRuntimeOptions = {}) {
        this.events = new EventStream(options.eventCapacity);
        this.auth = new ApiAuth(options.auth);
        this.diagnostics = new DiagnosticRegistry();
        this.matter = new MatterSdkRuntime();
        if (options.api) {
            const limiter = new AuthFailureRateLimiter();
            this.api = new ApiServer({
                ...options.api,
                auth: this.auth,
                stream: this.events,
                listDiagnostics: () => this.diagnostics.snapshot(),
                authFailureRateLimiter: limiter,
            });
        }
    }

    attachEventBus(eventBus: EventBus): void {
        if (this.attachedEventBus) throw new Error("BridgeRuntime is already attached to an EventBus");
        this.events.attach(eventBus);
        this.attachedEventBus = eventBus;
    }

    async start(): Promise<void> {
        await this.api?.start();
    }

    async startMatter(options: MatterNodeOptions): Promise<void> {
        await this.matter.createNode(options);
        await this.matter.start();
    }

    async stop(): Promise<void> {
        await this.api?.stop();
        await this.matter.stop();
        if (this.attachedEventBus) {
            this.events.detach(this.attachedEventBus);
            this.attachedEventBus = undefined;
        }
    }

    get apiAddress(): ReturnType<ApiServer["address"]> | undefined {
        return this.api?.address();
    }
}
