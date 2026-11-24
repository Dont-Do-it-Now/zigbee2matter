import path from "node:path";

/**
 * 구 변수(ZIGBEE2MQTT_DATA)는 폴백으로 쓰지 않는다. 원본 Zigbee2MQTT 디렉터리를 그대로 열면 원본이 변경될 수 있다(Q4).
 * 감지 시 경고와 이관 안내만 stderr로 남기고(logger는 data 경로에 의존하므로 사용하지 않는다), 새 경로를 사용한다.
 */
function setPath(): string {
    if (process.env.ZIGBEE2MQTT_DATA !== undefined && process.env.ZIGBEE2MATTER_DATA === undefined) {
        process.stderr.write(
            "[zigbee2matter] ZIGBEE2MQTT_DATA is set but ignored. Set ZIGBEE2MATTER_DATA and " +
                "import the existing data with the migration tool instead of opening the original directory.\n",
        );
    }

    return process.env.ZIGBEE2MATTER_DATA ?? path.normalize(path.join(__dirname, "..", "..", "data"));
}

let dataPath = setPath();

function joinPath(file: string): string {
    return path.resolve(dataPath, file);
}

function getPath(): string {
    return dataPath;
}

function _testReload(): void {
    dataPath = setPath();
}

// biome-ignore lint/style/useNamingConvention: test
export default {joinPath, getPath, _testReload};
