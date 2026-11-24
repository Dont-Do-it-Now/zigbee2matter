import path from "node:path";
import tmp from "tmp";
import {describe, expect, it, vi} from "vitest";
import data from "../lib/util/data";

describe("Data", () => {
    describe("Get path", () => {
        it("Should return correct path", () => {
            const expected = path.normalize(path.join(__dirname, "..", "data"));
            const actual = data.getPath();
            expect(actual).toBe(expected);
        });

        it("Should return correct path when ZIGBEE2MATTER_DATA set", () => {
            const expected = tmp.dirSync().name;
            process.env.ZIGBEE2MATTER_DATA = expected;
            data._testReload();

            try {
                const actual = data.getPath();
                expect(actual).toBe(expected);
                expect(data.joinPath("test")).toStrictEqual(path.join(expected, "test"));
                expect(data.joinPath("/test")).toStrictEqual(path.resolve(expected, "/test"));
            } finally {
                delete process.env.ZIGBEE2MATTER_DATA;
                data._testReload();
            }
        });

        it("Should ignore legacy ZIGBEE2MQTT_DATA (no fallback) and warn", () => {
            const legacy = tmp.dirSync().name;
            const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
            process.env.ZIGBEE2MQTT_DATA = legacy;
            data._testReload();

            try {
                expect(data.getPath()).toBe(path.normalize(path.join(__dirname, "..", "data")));
                expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("ZIGBEE2MQTT_DATA is set but ignored"));
            } finally {
                delete process.env.ZIGBEE2MQTT_DATA;
                stderrSpy.mockRestore();
                data._testReload();
            }
        });

        it("Should prefer ZIGBEE2MATTER_DATA over legacy ZIGBEE2MQTT_DATA without warning", () => {
            const expected = tmp.dirSync().name;
            const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
            process.env.ZIGBEE2MATTER_DATA = expected;
            process.env.ZIGBEE2MQTT_DATA = tmp.dirSync().name;
            data._testReload();

            try {
                expect(data.getPath()).toBe(expected);
                expect(stderrSpy).not.toHaveBeenCalled();
            } finally {
                delete process.env.ZIGBEE2MATTER_DATA;
                delete process.env.ZIGBEE2MQTT_DATA;
                stderrSpy.mockRestore();
                data._testReload();
            }
        });

        it("Should return data path when joinPath with empty string", () => {
            const expected = data.getPath();
            expect(data.joinPath("")).toStrictEqual(expected);
        });
    });
});
