export interface MatterLocale {
    readonly confirmationPhrase: string;
    readonly confirmationPrompt: string;
    readonly dialogTitle: string;
    readonly description: string;
    readonly cancel: string;
    readonly disconnect: string;
    readonly invalidConfirmation: string;
}

const MATTER_LOCALES: Readonly<Record<string, MatterLocale>> = {
    en: {
        confirmationPhrase: "disconnect",
        confirmationPrompt: 'Type "disconnect" to continue.',
        dialogTitle: "Disconnect Matter platform",
        description: "Disconnect only {platform}. Zigbee devices and other Matter platforms remain connected.",
        cancel: "Cancel",
        disconnect: "Disconnect",
        invalidConfirmation: 'Type "disconnect" to remove this Matter connection.',
    },
    ko: {
        confirmationPhrase: "연결해제",
        confirmationPrompt: "계속하려면 연결해제를 입력하세요.",
        dialogTitle: "Matter 연결 해제",
        description: "{platform} 연결만 해제합니다. Zigbee 기기와 다른 Matter 플랫폼 연결은 삭제되지 않습니다.",
        cancel: "취소",
        disconnect: "연결 해제",
        invalidConfirmation: "연결해제를 입력해야 연결을 해제할 수 있습니다.",
    },
};

export function getMatterLocale(languageHeader: string | string[] | undefined): MatterLocale {
    const language = (Array.isArray(languageHeader) ? languageHeader[0] : languageHeader)
        ?.split(",", 1)[0]
        ?.split(";", 1)[0]
        ?.trim()
        ?.toLowerCase()
        .split("-", 1)[0];

    return MATTER_LOCALES[language ?? ""] ?? MATTER_LOCALES.en!;
}
