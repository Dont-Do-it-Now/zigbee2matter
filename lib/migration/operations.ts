/** T063~T066 이관 운영 orchestration 경계. 파일 I/O와 서비스 제어는 호출자가 소유한다. */
import {evaluatePreflight, type PreflightInput, type PreflightReport} from "./preflight";
import {
    planImportData,
    type ImportDataInput,
    type ImportDataPlan,
} from "./importData";
import {buildAutomationMap, findAutomationRisks, type AutomationReference, type EntityMapping} from "./automationMap";
import {planCutover, type CutoverInput, type CutoverPlan} from "./cutover";

export type MigrationStage = "preflight" | "import-plan" | "staged-import" | "cutover" | "rollback" | "automation-map";
export type MigrationStageStatus = "completed" | "ready" | "blocked" | "failed";

export interface MigrationStageResult<T> {
    readonly stage: MigrationStage;
    readonly status: MigrationStageStatus;
    readonly value?: T;
    readonly error?: {readonly code: "BLOCKED" | "EXECUTION_FAILED"; readonly message: string};
}

export interface MigrationOperationsInput {
    readonly preflight: PreflightInput;
    readonly importData: ImportDataInput;
    readonly cutover: CutoverInput;
    readonly automation: {
        readonly references: readonly AutomationReference[];
        readonly mappings: readonly EntityMapping[];
    };
}

/** staged import의 파일 I/O를 호출자가 주입한다. 이 API 자체는 파일을 읽거나 쓰지 않는다. */
export type StagedImportExecutor = (plan: ImportDataPlan) => Promise<unknown>;

export interface MigrationOperationsOptions {
    readonly executeStagedImport?: StagedImportExecutor;
}

export interface AutomationMapResult {
    readonly map: readonly EntityMapping[];
    readonly risks: readonly string[];
}

export interface RollbackPlan {
    readonly actions: readonly CutoverPlan["rollbackActions"][number][];
    readonly onFailure: CutoverPlan["onFailure"];
}

export interface MigrationOperationsResult {
    readonly status: MigrationStageStatus;
    readonly preflight: MigrationStageResult<PreflightReport>;
    readonly importPlan: MigrationStageResult<ImportDataPlan>;
    readonly stagedImport: MigrationStageResult<unknown>;
    readonly cutover: MigrationStageResult<CutoverPlan>;
    readonly rollback: MigrationStageResult<RollbackPlan>;
    readonly automationMap: MigrationStageResult<AutomationMapResult>;
}

/** 정책 함수들을 순서대로 호출하고, 실제 부작용은 주입된 staged import 실행기에만 위임한다. */
export async function runMigrationOperations(
    input: MigrationOperationsInput,
    options: MigrationOperationsOptions = {},
): Promise<MigrationOperationsResult> {
    const preflightReport = evaluatePreflight(input.preflight);
    const preflight = completed("preflight", preflightReport);

    const importPlan = preflightReport.canProceed
        ? completed("import-plan", planImportData(input.importData))
        : blocked<ImportDataPlan>("import-plan", "preflight가 차단되어 import 계획을 만들지 않았습니다.");

    let stagedImport: MigrationStageResult<unknown>;
    if (importPlan.value === undefined || !importPlan.value.canProceed) {
        stagedImport = blocked("staged-import", "import 계획이 차단되어 staged import를 실행하지 않았습니다.");
    } else if (options.executeStagedImport === undefined) {
        stagedImport = ready("staged-import", importPlan.value);
    } else {
        try {
            stagedImport = completed("staged-import", await options.executeStagedImport(importPlan.value));
        } catch {
            stagedImport = failed("staged-import", "staged import 실행에 실패했습니다.");
        }
    }

    const canPlanCutover = stagedImport.status === "completed" || stagedImport.status === "ready";
    const cutover = canPlanCutover
        ? completed("cutover", planCutover(input.cutover))
        : blocked<CutoverPlan>("cutover", "staged import가 완료되지 않아 cutover 계획을 만들지 않았습니다.");

    const rollback = cutover.value
        ? completed<RollbackPlan>("rollback", {actions: [...cutover.value.rollbackActions], onFailure: cutover.value.onFailure})
        : blocked<RollbackPlan>("rollback", "cutover 계획이 없어 rollback 계획을 만들지 않았습니다.");

    let automationMap: MigrationStageResult<AutomationMapResult>;
    try {
        const map = buildAutomationMap(input.automation.references, input.automation.mappings);
        automationMap = completed("automation-map", {map, risks: findAutomationRisks(input.automation.references, map)});
    } catch {
        automationMap = failed("automation-map", "automation 대응표 생성에 실패했습니다.");
    }

    const stages = [preflight, importPlan, stagedImport, cutover, rollback, automationMap];
    const status = stages.some((stage) => stage.status === "failed")
        ? "failed"
        : stages.some((stage) => stage.status === "blocked")
          ? "blocked"
          : stages.some((stage) => stage.status === "ready")
            ? "ready"
            : "completed";

    return {status, preflight, importPlan, stagedImport, cutover, rollback, automationMap};
}

function completed<T>(stage: MigrationStage, value: T): MigrationStageResult<T> {
    return {stage, status: "completed", value};
}

function ready<T>(stage: MigrationStage, value: T): MigrationStageResult<T> {
    return {stage, status: "ready", value};
}

function blocked<T>(stage: MigrationStage, message: string): MigrationStageResult<T> {
    return {stage, status: "blocked", error: {code: "BLOCKED", message}};
}

function failed<T>(stage: MigrationStage, message: string): MigrationStageResult<T> {
    return {stage, status: "failed", error: {code: "EXECUTION_FAILED", message}};
}
