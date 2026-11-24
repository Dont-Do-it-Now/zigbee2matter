import {describe, expect, it, vi} from "vitest";

import {buildAutomationMap, findAutomationRisks} from "../../../lib/migration/automationMap";
import {type CutoverInput, planCutover, validateCutover} from "../../../lib/migration/cutover";
import {type ImportDataInput, planImportData} from "../../../lib/migration/importData";
import {runMigrationOperations} from "../../../lib/migration/operations";
import {evaluatePreflight, type PreflightInput} from "../../../lib/migration/preflight";

const SHA = "a".repeat(64);
const hex = (char: string, length: number): string => char.repeat(length);

function importInput(overrides: Partial<ImportDataInput> = {}): ImportDataInput {
    return {
        sourceDataDir: "/opt/zigbee2mqtt/data",
        targetDataDir: "/opt/zigbee2matter/data",
        sourceSchemaVersion: "5",
        supportedSchemaVersions: ["5"],
        files: [
            {role: "database", relativePath: "database.db", sha256: SHA},
            {role: "coordinator-backup", relativePath: "coordinator_backup.json", sha256: SHA},
            {role: "configuration", relativePath: "configuration.yaml", sha256: SHA},
            {role: "state", relativePath: "state.json", sha256: SHA},
        ],
        sourceIdentity: {
            ieeeAddr: `0x${hex("1", 16)}`,
            panId: "0x1a62",
            extendedPanId: `0x${hex("2", 16)}`,
            channel: 15,
            networkKeyFingerprint: hex("b", 64),
        },
        frameCounter: {source: 1000, target: 1000},
        ...overrides,
    };
}

function cutoverInput(overrides: Partial<CutoverInput> = {}): CutoverInput {
    return {
        sourceServiceId: "zigbee2mqtt.service",
        targetServiceId: "zigbee2matter.service",
        sourceRunning: true,
        exclusiveConfirmed: false,
        targetReady: true,
        targetRunning: false,
        backupAvailable: true,
        sourceUnchanged: true,
        sourceFrameCounter: 500,
        targetFrameCounter: 500,
        counterPreserved: true,
        ...overrides,
    };
}

const codes = (issues: ReadonlyArray<{code: string; severity: string}>, severity?: string): string[] =>
    issues.filter((issue) => severity === undefined || issue.severity === severity).map((issue) => issue.code);

describe("path normalization (POSIX vs Windows) in importData", () => {
    it("treats Windows drive paths as case-insensitive and separator-agnostic collisions", () => {
        const plan = planImportData(importInput({sourceDataDir: "C:\\Data\\Z2M\\", targetDataDir: "c:/data/z2m"}));
        expect(codes(plan.issues, "block")).toContain("SOURCE_TARGET_COLLISION");
        expect(plan.canProceed).toBe(false);
    });

    it("treats UNC paths case-insensitively as well", () => {
        const plan = planImportData(importInput({sourceDataDir: "\\\\NAS\\share\\data", targetDataDir: "//nas/SHARE/data/"}));
        expect(codes(plan.issues, "block")).toContain("SOURCE_TARGET_COLLISION");
    });

    it("keeps POSIX paths case-sensitive (Data and data are different directories)", () => {
        const plan = planImportData(importInput({sourceDataDir: "/srv/Data", targetDataDir: "/srv/data"}));
        expect(codes(plan.issues)).not.toContain("SOURCE_TARGET_COLLISION");
        expect(codes(plan.issues, "block")).toEqual([]);
    });

    it("collapses duplicate and trailing separators for POSIX paths", () => {
        const collision = planImportData(importInput({sourceDataDir: "/srv//data/", targetDataDir: "/srv/data"}));
        expect(codes(collision.issues)).toContain("SOURCE_TARGET_COLLISION");
        const ok = planImportData(importInput({sourceDataDir: "/srv/a//data/", targetDataDir: "/srv/b/data"}));
        expect(ok.copyActions[0]).toMatchObject({sourcePath: "/srv/a/data/database.db", targetPath: "/srv/b/data/database.db"});
    });

    it("blocks empty paths", () => {
        expect(codes(planImportData(importInput({sourceDataDir: "  ", targetDataDir: "/x"})).issues, "block")).toContain("PATH_INVALID");
    });

    it.each([
        "../etc/passwd",
        "a/../b",
        "/abs/path",
        "C:/win/path",
        "C:\\win\\path",
        "a//b",
        "",
    ])("rejects file path %j outside the data boundary", (relativePath) => {
        const plan = planImportData(importInput({files: [...importInput().files, {role: "devices", relativePath, sha256: SHA}]}));
        expect(codes(plan.issues, "block")).toContain("PATH_INVALID");
        expect(plan.canProceed).toBe(false);
    });

    it("rejects a duplicate role/path and a bad or missing hash; allows many external converters", () => {
        const dup = planImportData(importInput({files: [...importInput().files, {role: "database", relativePath: "db2.db", sha256: SHA}]}));
        expect(codes(dup.issues, "block")).toContain("FILE_DUPLICATE");
        const badHash = planImportData(
            importInput({files: [...importInput().files, {role: "devices", relativePath: "devices.yaml", sha256: "xyz"}]}),
        );
        expect(codes(badHash.issues, "block")).toContain("FILE_HASH_MISSING");
        const converters = planImportData(
            importInput({
                files: [
                    ...importInput().files,
                    {role: "external-converter", relativePath: "external_converters/a.js", sha256: SHA},
                    {role: "external-converter", relativePath: "external_converters/b.js", sha256: SHA},
                ],
            }),
        );
        expect(codes(converters.issues, "block")).toEqual([]);
        expect(converters.copyActions.filter((action) => action.role === "external-converter")).toHaveLength(2);
    });
});

describe("importData plan", () => {
    it("is ready and never copies configuration as a plain file; mqtt is excluded from the configuration action", () => {
        const plan = planImportData(importInput({configuration: {homeassistant: {enabled: false}, mqtt: {server: "mqtt://broker", password: "p"}}}));

        expect(plan.canProceed).toBe(true);
        expect(plan.copyActions.map((action) => action.role)).not.toContain("configuration");
        expect(plan.configuration?.excludedTopLevelKeys).toEqual(["mqtt"]);
        expect(plan.configuration?.configuration).toEqual({homeassistant: {enabled: false}});
        expect(JSON.stringify(plan)).not.toContain("mqtt://broker");
        expect(plan.commitPolicy).toBe("stage-then-atomic-promote");
        expect(plan.onFailure).toBe("leave-source-unchanged");
        expect(codes(plan.issues)).toContain("MQTT_EXCLUDED");
    });

    it("blocks missing required roles, unsupported schema, missing secret/devices/groups references", () => {
        const plan = planImportData(
            importInput({
                sourceSchemaVersion: "1",
                files: [{role: "database", relativePath: "database.db", sha256: SHA}],
                configuration: {devices: "devices.yaml", groups: ["groups.yaml"]},
                usesSecret: true,
            }),
        );
        const blocked = codes(plan.issues, "block");
        expect(blocked).toContain("SCHEMA_UNSUPPORTED");
        expect(blocked.filter((code) => code === "FILE_MISSING").length).toBeGreaterThanOrEqual(5);
        expect(codes(plan.issues, "warn")).toContain("FILE_OPTIONAL_MISSING");
    });

    it("blocks invalid identity and a mismatching target identity", () => {
        const bad = planImportData(importInput({sourceIdentity: {...importInput().sourceIdentity, channel: 27, panId: "zz"}}));
        expect(codes(bad.issues, "block")).toContain("IDENTITY_INVALID");

        const mismatch = planImportData(importInput({targetIdentity: {...importInput().sourceIdentity, channel: 20}}));
        expect(codes(mismatch.issues, "block")).toContain("IDENTITY_MISMATCH");
        const same = planImportData(
            importInput({targetIdentity: {...importInput().sourceIdentity, ieeeAddr: hex("1", 16).toUpperCase(), panId: "1A62"}}),
        );
        expect(codes(same.issues)).not.toContain("IDENTITY_MISMATCH");
    });
});

describe("frame counter policy (plan warns, execute blocks)", () => {
    it("importData: unknown target counter is a warning in plan and a block in execute", () => {
        const plan = planImportData(importInput({frameCounter: {source: 10}}));
        expect(plan.issues.find((issue) => issue.code === "FRAME_COUNTER_UNKNOWN")?.severity).toBe("warn");
        expect(plan.canProceed).toBe(true);
        const execute = planImportData(importInput({frameCounter: {source: 10}, phase: "execute"}));
        expect(execute.issues.find((issue) => issue.code === "FRAME_COUNTER_UNKNOWN")?.severity).toBe("block");
        expect(execute.canProceed).toBe(false);
    });

    it("importData: rollback and invalid counters are always blocked", () => {
        expect(codes(planImportData(importInput({frameCounter: {source: 10, target: 9}})).issues, "block")).toContain("FRAME_COUNTER_ROLLBACK");
        for (const frameCounter of [{source: -1}, {source: 1.5}, {source: 1, target: -2}, {source: Number.MAX_SAFE_INTEGER + 1}]) {
            expect(codes(planImportData(importInput({frameCounter})).issues, "block")).toContain("FRAME_COUNTER_INVALID");
        }
    });

    it("cutover: unknown target counter warns in plan phase, blocks in execute phase", () => {
        const plan = validateCutover(cutoverInput({targetFrameCounter: undefined}));
        expect(plan.find((issue) => issue.code === "FRAME_COUNTER_UNKNOWN")?.severity).toBe("warn");
        const execute = validateCutover(
            cutoverInput({
                phase: "execute",
                sourceRunning: false,
                sourceStopConfirmed: true,
                exclusiveConfirmed: true,
                targetFrameCounter: undefined,
            }),
        );
        expect(execute.find((issue) => issue.code === "FRAME_COUNTER_UNKNOWN")?.severity).toBe("block");
    });

    it("cutover: lower target counter is a rollback block; a lower-than-source counter never passes", () => {
        expect(codes(validateCutover(cutoverInput({targetFrameCounter: 499})), "block")).toContain("FRAME_COUNTER_ROLLBACK");
        expect(codes(validateCutover(cutoverInput({targetFrameCounter: 500})), "block")).toEqual([]);
        expect(codes(validateCutover(cutoverInput({sourceFrameCounter: -1})), "block")).toContain("FRAME_COUNTER_INVALID");
        expect(codes(validateCutover(cutoverInput({targetFrameCounter: 1.5})), "block")).toContain("FRAME_COUNTER_INVALID");
    });
});

describe("cutover plan", () => {
    it("plan phase: running source is fine, stop/exclusive are not yet required; sequence and rollback are fixed", () => {
        const plan = planCutover(cutoverInput());

        expect(plan.canProceed).toBe(true);
        expect(plan.ready).toBe(true);
        expect(plan.actions).toEqual([
            "verify-backup",
            "stop-source",
            "confirm-source-stopped",
            "confirm-exclusive",
            "verify-frame-counter",
            "start-target",
            "verify-target",
            "commit",
        ]);
        expect(plan.actions.indexOf("stop-source")).toBeLessThan(plan.actions.indexOf("start-target"));
        expect(plan.rollbackActions).toEqual(["stop-target-for-rollback", "restore-source", "verify-source-restored", "verify-counter-preserved"]);
        expect(plan.onFailure).toBe("stop-target-then-restore-source");
        expect(plan.preserve).toEqual({sourceData: true, networkIdentity: true, frameCounter: true});
    });

    it("blocked cutover is reported with every cause instead of throwing", () => {
        const plan = planCutover(
            cutoverInput({
                sourceServiceId: " ",
                targetServiceId: "",
                sourceRunning: false,
                targetReady: false,
                targetRunning: true,
                backupAvailable: false,
                sourceUnchanged: false,
                counterPreserved: false,
            }),
        );

        expect(plan.canProceed).toBe(false);
        expect(plan.ready).toBe(false);
        expect(codes(plan.issues, "block")).toEqual(
            expect.arrayContaining([
                "SOURCE_ID_MISSING",
                "TARGET_ID_MISSING",
                "SOURCE_NOT_RUNNING",
                "TARGET_NOT_READY",
                "TARGET_ALREADY_RUNNING",
                "BACKUP_NOT_AVAILABLE",
                "SOURCE_CHANGED",
                "COUNTER_NOT_PRESERVED",
            ]),
        );
        expect(plan.rollbackActions.length).toBeGreaterThan(0); // rollback guidance stays available when blocked
    });

    it("blocks identical service ids and dual occupancy", () => {
        expect(codes(validateCutover(cutoverInput({targetServiceId: "zigbee2mqtt.service"})), "block")).toContain("SERVICE_COLLISION");
    });

    it("execute phase requires a confirmed stop and exclusive occupancy", () => {
        const base = cutoverInput({phase: "execute", sourceRunning: false, sourceStopConfirmed: true, exclusiveConfirmed: true});
        expect(planCutover(base).canProceed).toBe(true);
        expect(codes(validateCutover({...base, sourceRunning: true}), "block")).toContain("SOURCE_NOT_STOPPED");
        expect(codes(validateCutover({...base, sourceStopConfirmed: undefined}), "block")).toContain("SOURCE_NOT_STOPPED");
        expect(codes(validateCutover({...base, exclusiveConfirmed: false}), "block")).toContain("EXCLUSIVE_NOT_CONFIRMED");
    });
});

describe("preflight", () => {
    const base: PreflightInput = {
        versions: {zigbee2mqtt: "2.1.0", herdsman: "4.0.0", converters: "23.0.0"},
        adapter: {adapter: "ember", port: "/dev/ttyUSB0", transport: "serial", firmware: "7.4"},
        devices: [{ieeeAddr: "0x00124b0001", name: "a"}, {ieeeAddr: "0x00124b0002", name: "b"}],
        paths: {
            sourceDataDir: "C:\\z2m\\data",
            targetDataDir: "D:\\matter\\data",
            requiredBackups: ["coordinator_backup.json"],
            availableBackups: ["Coordinator_Backup.json"],
        },
    };

    it("passes a clean input and compares Windows-style backup names case-insensitively", () => {
        expect(evaluatePreflight(base)).toMatchObject({canProceed: true, ready: true, issues: []});
    });

    it("detects path collision across separators/case/trailing slash and duplicate files", () => {
        const report = evaluatePreflight({
            ...base,
            paths: {...base.paths, sourceDataDir: "C:\\Z2M\\Data\\", targetDataDir: "c:/z2m/data", files: ["A/b.json", "a\\B.JSON"]},
        });
        expect(codes(report.issues, "block")).toEqual(expect.arrayContaining(["DATA_PATH_COLLISION", "DUPLICATE_PATH"]));
        expect(report.canProceed).toBe(false);
    });

    it("blocks missing backups, duplicate/missing device ids, unsupported adapters and unknown transport", () => {
        const report = evaluatePreflight({
            ...base,
            adapter: {adapter: "mystery", transport: "unknown"},
            devices: [{ieeeAddr: "0x00ABC"}, {ieeeAddr: "00abc"}, {ieeeAddr: " "}, {ieeeAddr: "0x1", supported: false, name: "odd"}],
            paths: {...base.paths, availableBackups: []},
        });
        expect(codes(report.issues, "block")).toEqual(
            expect.arrayContaining([
                "ADAPTER_UNSUPPORTED",
                "TRANSPORT_UNKNOWN",
                "DUPLICATE_DEVICE_ID",
                "DEVICE_ID_MISSING",
                "DEVICE_UNSUPPORTED",
                "BACKUP_MISSING",
            ]),
        );
        expect(codes(report.issues, "warn")).toContain("FIRMWARE_UNKNOWN");
    });

    it("blocks tcp transport without adapter/port and unsupported listed versions; warns on unknown versions", () => {
        const tcp = evaluatePreflight({...base, adapter: {transport: "tcp", firmware: "1"}});
        expect(codes(tcp.issues, "block")).toContain("TCP_ADAPTER_REQUIRED");
        const version = evaluatePreflight({...base, versions: {zigbee2mqtt: "0.1.0"}, supportedVersions: {zigbee2mqtt: ["2.1.0"]}});
        expect(codes(version.issues, "block")).toContain("VERSION_UNSUPPORTED");
        expect(codes(version.issues, "warn")).toContain("VERSION_UNKNOWN");
    });

    it("blocks duplicate or empty automation ids", () => {
        const report = evaluatePreflight({...base, automationIds: ["a", "a", " "]});
        expect(codes(report.issues, "block").filter((code) => code === "DUPLICATE_AUTOMATION_ID")).toHaveLength(2);
    });
});

describe("automation map and orchestration", () => {
    it("marks unmapped references missing and lists automations at risk; duplicate mappings throw", () => {
        const references = [
            {automationId: "morning", entityId: "light.a", kind: "device" as const},
            {automationId: "night", entityId: "light.b", kind: "device" as const},
            {automationId: "night", entityId: "light.c", kind: "group" as const},
        ];
        const map = buildAutomationMap(references, [
            {legacyEntityId: "light.a", status: "mapped", directEntityId: "zigbee2matter:dev:x"},
            {legacyEntityId: "light.b", status: "ambiguous"},
        ]);

        expect(map.map((entry) => entry.status)).toEqual(["mapped", "ambiguous", "missing"]);
        expect(findAutomationRisks(references, map)).toEqual(["night"]);
        expect(() =>
            buildAutomationMap(references, [{legacyEntityId: "x", status: "mapped"}, {legacyEntityId: "x", status: "mapped"}]),
        ).toThrow("duplicate");
    });

    const operationsInput = (overrides: {cutover?: Partial<CutoverInput>; importData?: Partial<ImportDataInput>} = {}) => ({
        preflight: {
            versions: {zigbee2mqtt: "2.1.0", herdsman: "4.0.0", converters: "23.0.0"},
            adapter: {adapter: "ember", port: "/dev/ttyUSB0", firmware: "7.4"},
            devices: [{ieeeAddr: "0x00124b0001"}],
            paths: {sourceDataDir: "/a", targetDataDir: "/b", requiredBackups: [], availableBackups: []},
        } satisfies PreflightInput,
        importData: importInput(overrides.importData),
        cutover: cutoverInput(overrides.cutover),
        automation: {references: [], mappings: []},
    });

    it("without an executor the staged import is only `ready`, and the whole run is `ready`", async () => {
        const result = await runMigrationOperations(operationsInput());
        expect(result.stagedImport.status).toBe("ready");
        expect(result.cutover.status).toBe("completed");
        expect(result.status).toBe("ready");
    });

    it("executes staged import only after the execute-phase recheck (unknown target counter blocks writing)", async () => {
        const executor = vi.fn(async () => "written");
        const blocked = await runMigrationOperations(operationsInput({importData: {frameCounter: {source: 5}}}), {executeStagedImport: executor});
        expect(executor).not.toHaveBeenCalled();
        expect(blocked.stagedImport.status).toBe("blocked");
        expect(blocked.cutover.status).toBe("blocked");
        expect(blocked.rollback.status).toBe("blocked");
        expect(blocked.status).toBe("blocked");

        const done = await runMigrationOperations(operationsInput(), {executeStagedImport: executor});
        expect(executor).toHaveBeenCalledTimes(1);
        expect(done.stagedImport).toMatchObject({status: "completed", value: "written"});
        expect(done.status).toBe("completed");
    });

    it("an executor failure is reported as failed without leaking the error text", async () => {
        const result = await runMigrationOperations(operationsInput(), {
            executeStagedImport: async () => {
                throw new Error("EACCES /secret/path");
            },
        });
        expect(result.stagedImport.status).toBe("failed");
        expect(JSON.stringify(result)).not.toContain("/secret/path");
        expect(result.status).toBe("failed");
        expect(result.cutover.status).toBe("blocked");
    });

    it("a blocked cutover is reported with its plan and issues while rollback guidance is withheld", async () => {
        const result = await runMigrationOperations(operationsInput({cutover: {backupAvailable: false}}));
        expect(result.cutover.status).toBe("blocked");
        expect(result.cutover.error?.code).toBe("BLOCKED");
        expect(codes(result.cutover.value?.issues ?? [], "block")).toContain("BACKUP_NOT_AVAILABLE");
        expect(result.rollback.status).toBe("blocked");
        expect(result.status).toBe("blocked");
    });

    it("a blocked preflight stops everything downstream", async () => {
        const input = operationsInput();
        input.preflight.devices = [{ieeeAddr: "0x1"}, {ieeeAddr: "0x1"}];
        const result = await runMigrationOperations(input);
        expect(result.preflight.value?.canProceed).toBe(false);
        expect(result.importPlan.status).toBe("blocked");
        expect(result.stagedImport.status).toBe("blocked");
        expect(result.cutover.status).toBe("blocked");
    });
});
