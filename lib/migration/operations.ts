/** T063~T066 이관 운영 orchestration 경계. 파일 I/O와 서비스 제어는 호출자가 소유한다. */

import {
    type AutomationReference,
    type AutomationSource,
    buildAutomationMap,
    type EntityMapping,
    findAutomationRisks,
    proposeMappings,
    scanAutomationReferences,
} from "./automationMap";
import {type CutoverInput, type CutoverPlan, planCutover} from "./cutover";
import {type ImportDataInput, type ImportDataPlan, planImportData} from "./importData";
import {evaluatePreflight, type PreflightInput, type PreflightReport} from "./preflight";

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
        /** T066: 호출자가 읽어 온 HA 자동화/z2m 설정 텍스트. 참조를 수집해 references에 합친다. */
        readonly sources?: readonly AutomationSource[];
        /** T066: 신규 Direct/Matter entity ID. 일치 후보는 사용자 검토 대기("ambiguous")로만 제안한다. */
        readonly newEntityIds?: readonly string[];
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
        // 쓰기 직전 execute 단계로 재검증한다(frame counter unknown이면 차단).
        const executePlan = planImportData({...input.importData, phase: "execute"});
        if (!executePlan.canProceed) {
            stagedImport = blocked("staged-import", "execute 단계 재검증에서 import 계획이 차단되었습니다.");
        } else {
            try {
                stagedImport = completed("staged-import", await options.executeStagedImport(executePlan));
            } catch {
                stagedImport = failed("staged-import", "staged import 실행에 실패했습니다.");
            }
        }
    }

    const canPlanCutover = stagedImport.status === "completed" || stagedImport.status === "ready";
    let cutover: MigrationStageResult<CutoverPlan>;
    if (!canPlanCutover) {
        cutover = blocked<CutoverPlan>("cutover", "staged import가 완료되지 않아 cutover 계획을 만들지 않았습니다.");
    } else {
        const cutoverPlan = planCutover({...input.cutover, phase: "plan"});
        cutover = cutoverPlan.canProceed
            ? completed("cutover", cutoverPlan)
            : {stage: "cutover", status: "blocked", value: cutoverPlan, error: {code: "BLOCKED", message: "cutover 계획에 차단 항목이 있습니다."}};
    }

    const rollback =
        cutover.value && cutover.status !== "blocked"
            ? completed<RollbackPlan>("rollback", {actions: [...cutover.value.rollbackActions], onFailure: cutover.value.onFailure})
            : blocked<RollbackPlan>("rollback", "cutover 계획이 없어 rollback 계획을 만들지 않았습니다.");

    let automationMap: MigrationStageResult<AutomationMapResult>;
    try {
        const references = [...input.automation.references, ...scanAutomationReferences(input.automation.sources ?? [])];
        const built = buildAutomationMap(references, input.automation.mappings);
        const map = input.automation.newEntityIds ? proposeMappings(built, input.automation.newEntityIds) : built;
        automationMap = completed("automation-map", {map, risks: findAutomationRisks(references, map)});
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
