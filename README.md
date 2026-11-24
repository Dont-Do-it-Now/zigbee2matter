<div align="center">
  <img src="images/logo.png" width="150" height="150" alt="Zigbee2Matter logo">
  <h1>Zigbee2Matter</h1>
  <p>A Zigbee-to-Matter bridge built from the Zigbee2MQTT codebase.</p>
  <p><a href="README.ko.md">한국어 README</a> · <a href="docs/README.md">Design documentation</a> · <a href="LICENSE">License</a></p>
</div>

Zigbee2Matter connects a Zigbee network to Matter ecosystems while keeping the proven Zigbee device, converter, coordinator, and interview paths from Zigbee2MQTT. It replaces the broker-dependent runtime boundary with an in-process bridge bus and adds Matter, REST, and WebSocket adapters.

This repository is a fork and an independent project. It is not an official Zigbee2MQTT or Connectivity Standards Alliance product.

### Upstream baseline

The independent `main` history starts from one source snapshot: Zigbee2MQTT `2.14.3`, upstream commit `3c841fdfd66c92239921ef84fde8f039c64e1662`, released on 2026-11-01. The independent Zigbee2Matter history was created on 2026-11-24. The original upstream commit history is intentionally not part of `main`; see [`docs/evidence/T003.md`](docs/evidence/T003.md) for the exact source boundary and reproduction details.

## What it does

- Keeps the Zigbee-herdsman and Zigbee converter layers as the Zigbee source of truth.
- Exposes bridged devices through Matter endpoints and persistent endpoint identities.
- Provides Home Assistant Direct, Home Assistant Matter, and hybrid adapter boundaries.
- Provides authenticated REST and WebSocket APIs for devices, commands, diagnostics, snapshots, and deltas.
- Keeps platform consumers isolated with bounded queues, replay, epoch changes, and resynchronization.
- Supports Docker/Linux deployment, coordinator discovery, recovery, migration planning, backup encryption, and release gates.
- Preserves the existing frontend compatibility path without reintroducing an MQTT broker or MQTT client runtime.

## Scope and boundaries

Zigbee2Matter is a Matter Bridge. The following are intentionally outside the core scope:

- Matter Controller behavior for managing arbitrary third-party Matter devices.
- Thread Border Router, Z-Wave, generic Wi-Fi device onboarding, and a separate automation engine.
- Automatic coordinator firmware flashing or an unapproved coordinator fallback.
- Silent automation migration or guessed entity identity preservation.

The Zigbee network remains the device state source. Matter fabric, ACL, commissioning, and reporting state belong to the Matter SDK. REST and WebSocket clients use the shared command and event contracts rather than reaching into Zigbee internals.

## Architecture

```text
Zigbee coordinator
        │
zigbee-herdsman + converters
        │
Zigbee2Matter Core
  ├── EventStream / state / command router
  ├── in-process BridgeBus (no broker)
  ├── Matter SDK adapter
  ├── Home Assistant adapters
  └── REST + WebSocket API server
        │
Matter fabrics · Home Assistant · existing frontend · other Matter controllers
```

The main contracts are documented in [`docs/CONTRACTS.md`](docs/CONTRACTS.md): stable identities, revisioned state, explicit command results, ordered events with replay/resync, adapter boundaries, and redacted scoped API errors.

## Current implementation

The implementation is being developed from the task cards in [`docs/TASK_INDEX.md`](docs/TASK_INDEX.md). The corresponding files in [`docs/evidence/`](docs/evidence/) record what is implemented and what has not been executed yet.

Implemented areas include:

- Zigbee coordinator discovery, pairing, recovery, availability, groups, bindings, converters, and OTA boundaries.
- Event stream, device queues, deduplication, retry policy, fan-out, backpressure, and loop prevention.
- Matter endpoint persistence, dynamic endpoints, mapping registries, commissioning, fabrics, reporting, and multi-bridge isolation.
- HA entity identity, Direct/Matter/Hybrid routing, REST, WebSocket, diagnostics, backup, migration, cutover, quality gates, and Docker configuration.
- A Matter.js 0.18 adapter boundary using the `@matter/main` `ServerNode` lifecycle. The SDK package is loaded explicitly at runtime; an unavailable or incompatible SDK fails clearly instead of being silently emulated.

Build, test, TypeScript, lint, installation, hardware, and long-running acceptance commands are intentionally recorded as `NOT RUN` when they have not been executed. Do not interpret an implementation record as proof of hardware or platform acceptance.

## Quick start

### Requirements

- Node.js `22.13.0` or a compatible version declared in `package.json`.
- pnpm `11.26.0`.
- A supported Zigbee coordinator and its compatible firmware.
- IPv6 and local multicast support for Matter commissioning and mDNS.
- A Matter SDK installation matching the version recorded by the current task evidence when Matter runtime is enabled.

### Install and build

```bash
pnpm install --frozen-lockfile
pnpm run build
```

### Run

```bash
pnpm start
```

Use the existing Zigbee2MQTT configuration flow for coordinator and Zigbee settings. Matter-specific configuration belongs under [`docs/04-matter/`](docs/04-matter/).

### Docker

The deployment skeleton is in [`docker/`](docker/). It supports persistent data, host networking for mDNS, USB coordinator access, and explicitly configured TCP coordinator access. Review the device path and network settings before starting a container.

## API

The standalone API server exposes the versioned REST and WebSocket boundaries described in [`docs/CONTRACTS.md`](docs/CONTRACTS.md):

```text
GET  /api/v1/devices
GET  /api/v1/groups
GET  /api/v1/jobs
GET  /api/v1/bridges
GET  /api/v1/diagnostics
GET  /api/v1/tokens
POST /api/v1/tokens
DELETE /api/v1/tokens/:id
POST /api/v1/commands
WS   /api/v1/events
```

REST requests use `Authorization: Bearer <token>`. WebSocket clients may use the compatibility `token` query parameter. New API access is fail-closed unless an explicit anonymous scope is configured. Tokens are hashed at rest, scopes are ordered `read < control < admin`, and external errors omit secrets and stack traces.
The management API can use `api.ssl_cert` and `api.ssl_key` for HTTPS/WSS; both values must point to readable certificate and private-key files.

The WebSocket event stream uses an epoch and monotonically increasing sequence. A gap, epoch change, invalid replay request, or queue overflow requires a snapshot/resynchronization instead of silently applying incomplete state.

## Matter and Home Assistant

Matter commissioning is a bridge registration flow, not a per-Zigbee-device QR flow. The Matter SDK owns fabric credentials, ACLs, commissioning transport, and attribute reporting. Zigbee device identity and Matter endpoint identity are kept separate and persisted per bridge.

Home Assistant can be connected through:

- **Direct mode:** the HA integration uses the REST/WebSocket contracts without a Matter Server dependency.
- **Matter mode:** Home Assistant's official Matter integration and Matter Server act as the controller.
- **Hybrid mode:** Direct and Matter bindings are kept distinct and duplicate entity keys are rejected.

See [`docs/04-matter/`](docs/04-matter/) and [`docs/05-platform/`](docs/05-platform/) for the detailed contracts.

## Migration and recovery

Migration is staged and source-preserving:

1. Preflight validates versions, paths, coordinator identity, network identity fingerprints, and frame counters.
2. Import verifies source hashes and copies into a staging directory.
3. Configuration import excludes the legacy top-level `mqtt` section.
4. The staged directory is promoted atomically after validation.
5. A target backup remains available for rollback; source data is not modified by failure handling.

Do not reuse a data directory between independent bridge instances. Read [`docs/06-migration/`](docs/06-migration/) and create a backup before any cutover.

## Development

The repository is TypeScript with pnpm, Vitest, and Biome. Read [`AGENTS.md`](AGENTS.md) and the relevant task card before changing code.

```bash
pnpm install --include=dev
pnpm run build
pnpm run check
pnpm test
```

The repository also contains a separate fork test configuration:

```bash
pnpm run test:fork
```

The current working task instructions may deliberately prohibit these commands during an implementation pass. In that case, record them as `NOT RUN` and perform them in the authorized verification pass.

## Documentation map

- [`docs/README.md`](docs/README.md) — design rules and chapter map.
- [`docs/CONTRACTS.md`](docs/CONTRACTS.md) — cross-module contracts.
- [`docs/TASK_INDEX.md`](docs/TASK_INDEX.md) — implementation queue.
- [`docs/evidence/`](docs/evidence/) — implementation evidence and explicit `NOT RUN` verification records.
- [`docs/01-product/`](docs/01-product/) — scope, licensing, and product decisions.
- [`docs/02-core/`](docs/02-core/) — Core, transport, state, and upstream boundaries.
- [`docs/03-zigbee/`](docs/03-zigbee/) — coordinator, pairing, converter, and OTA behavior.
- [`docs/04-matter/`](docs/04-matter/) — SDK, commissioning, fabrics, endpoints, networking, and mappings.
- [`docs/05-platform/`](docs/05-platform/) — APIs, Home Assistant, frontend, and deployment.
- [`docs/06-migration/`](docs/06-migration/) — import, cutover, and automation migration.
- [`docs/07-quality/`](docs/07-quality/) — hardware, concurrency, performance, fault, security, and soak gates.
- [`docs/08-roadmap/`](docs/08-roadmap/) — release and automation pipeline.

## Upstream relationship

Zigbee2Matter is maintained as an independent fork. The sibling `Zigbee2Matter-upstream` checkout, when present in a developer workspace, is reference-only and is not the working tree. Upstream synchronization must use the ledger and patch classification in [`docs/02-core/upstream/`](docs/02-core/upstream/); do not blindly merge MQTT-era changes into the Matter transport boundary.

Upstream project: [Koenkk/zigbee2mqtt](https://github.com/Koenkk/zigbee2mqtt). The original project and its contributors retain their applicable copyrights and licenses.

## Contributing

Please keep changes focused, preserve the documented contracts, and add or update the relevant evidence record. Never include credentials, network keys, fabric keys, or raw setup codes in logs or issues.

For Git work, use feature-separated Conventional Commits and keep pushes manual. The repository's smart-commit workflow is the authority for commit grouping and messages; it does not authorize automatic pushes.

Before contributing, also read [`CONTRIBUTING.md`](CONTRIBUTING.md), [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md), and [`AI_POLICY.md`](AI_POLICY.md).

## License

Zigbee2Matter is distributed under the GPL-3.0 license. See [`LICENSE`](LICENSE) and preserve upstream notices when redistributing. Matter.js, when installed, remains under its own Apache-2.0 license and requires the applicable notices. Matter certification, vendor IDs, logos, and trademarks are separate from open-source licensing.
