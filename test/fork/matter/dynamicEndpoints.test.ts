// z2m-fork: DynamicEndpointRuntime rebuild/remove semantics (expose change rebuild keeps endpointId; failed remove keeps the registry entry).
import {describe, expect, it} from "vitest";
import "../../mocks/data";
import {DynamicEndpointCoordinator, DynamicEndpointRuntime} from "../../../lib/matter/dynamicEndpoints";
import {EndpointRegistry, type EndpointRegistryDocument, type EndpointRegistryEntry} from "../../../lib/matter/endpointRegistry";

const BRIDGE = "11111111-1111-4111-8111-111111111111" as never;
const KEY = "dev:22222222-2222-4222-8222-222222222222:00158d0001a2b3c4:1:matter";

async function setup(adapter: {
    create: (e: EndpointRegistryEntry) => Promise<{number: number}>;
    remove: (e: EndpointRegistryEntry) => Promise<undefined | {permanent: boolean}>;
}) {
    let saved: EndpointRegistryDocument | undefined;
    const registry = await EndpointRegistry.open(BRIDGE, {
        load: async () => saved,
        save: (_id, document) => {
            saved = document;

            return Promise.resolve();
        },
    });

    return {registry, runtime: new DynamicEndpointRuntime(new DynamicEndpointCoordinator(registry), adapter)};
}

describe("DynamicEndpointRuntime", () => {
    it("rebuild keeps the endpointId, re-adds the endpoint and writes no tombstone", async () => {
        const calls: string[] = [];
        let next = 2;
        const {registry, runtime} = await setup({
            create: (entry) => {
                calls.push(`create:${entry.endpointId}`);

                return Promise.resolve({number: next++});
            },
            remove: (entry) => {
                calls.push(`remove:${entry.endpointId}`);

                return Promise.resolve({permanent: true});
            },
        });

        const created = await runtime.create(KEY, true);
        await runtime.rebuild(KEY);

        const id = created.entry.endpointId;
        expect(calls).toEqual([`create:${id}`, `remove:${id}`, `create:${id}`]);
        expect(registry.get(KEY)?.endpointId).toBe(id);
        expect(registry.list().filter((entry) => entry.state === "removed")).toHaveLength(0);
    });

    it("a failed SDK removal does not tombstone; a retry then tombstones", async () => {
        let fail = true;
        const {registry, runtime} = await setup({
            create: async () => ({number: 2}),
            remove: () => (fail ? Promise.reject(new Error("sdk busy")) : Promise.resolve({permanent: true})),
        });

        await runtime.create(KEY, true);
        await expect(runtime.remove(KEY)).rejects.toThrow("sdk busy");
        expect(registry.get(KEY)).toBeDefined();

        fail = false;
        expect(await runtime.remove(KEY)).toBe(true);
        expect(registry.get(KEY)).toBeUndefined();
        expect(registry.list().filter((entry) => entry.state === "removed")).toHaveLength(1);
    });
});
