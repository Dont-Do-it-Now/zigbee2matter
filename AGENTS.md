# Agents Instructions for zigbee2matter

## Priority Guidelines

When generating code for this repository:

1. **Version Compatibility**: Always respect the exact versions of Node.js, TypeScript, and libraries used in this project
2. **Codebase Patterns**: Scan the codebase for established patterns before generating code
3. **Architectural Consistency**: Maintain the layered architecture and established module boundaries
4. **Performance**: Keep to best-practices to maintain high performance
5. **Code Quality**: Prioritize maintainability, type safety, and consistency with existing patterns
6. **Testing**: Follow the established Vitest testing patterns

## Technology Stack & Versions

### Core Technologies

- **Runtime**: Node.js
- **Language**: TypeScript
- **Package Manager**: pnpm

### Development Tools

- **Testing**: Vitest with @vitest/coverage-v8
- **Benchmarking**: Vitest
- **Code Quality**: Biome (formatting, linting)
- **Build**: TypeScript compiler

## Project Architecture

### Project Structure

```
lib/                   # TypeScript source code
├── controller.ts      # Main controller orchestrating components
├── eventBus.ts        # Event-driven communication
├── zigbee.ts          # Zigbee network management (layer on top of zigbee-herdsman)
├── bridgeBus/         # In-process bridge bus replacing MQTT broker dependency
├── matter/            # Matter SDK integration and device mapping
├── api/               # REST and WebSocket API
├── ha/                # Home Assistant entity mapping and bridge
├── state.ts           # State management
├── extension/         # Extension system
|   ├── extension.ts   # Abstract base class
│   └── *.ts           # Logic-specific extensions
├── model/             # Domain models (Device, Group)
├── util/              # Utility functions
└── types/             # TypeScript type definitions
    └── api.ts         # Public REST/WS/Matter API
test/                  # Vitest test files with mocks
├── fork/              # Fork-specific tests (bridgeBus, matter, api, ha, migration)
dist/                  # Compiled JavaScript output
data/                  # Runtime configuration and database
```

### Key Architectural Principles

1. **Separation of Concerns**: `Extension`-inheriting extensions drive specific aspects (publishing, receiving, binding, grouping, health reporting, etc.)
2. **Event-Driven**: Strongly-typed event communication across bridgeBus, Zigbee and extensions through `EventBus`
3. **Type Safety**: Everything is strongly typed using types from `lib/types`
4. **No MQTT broker dependency**: External MQTT is replaced by `bridgeBus` (in-process). Matter, REST, and WebSocket adapters subscribe directly.

## Code Style & Formatting

See [Biome configuration](biome.json)

## Code Documentation

Use JSDoc, following existing patterns.

## Additional Resources

- [GitHub Repository](https://github.com/Dont-Do-it-Now/zigbee2matter)
- Project documentation: [Zigbee2Matter GitHub Pages](https://Dont-Do-it-Now.github.io/zigbee2matter/)
- Upstream project: [Koenkk/zigbee2mqtt](https://github.com/Koenkk/zigbee2mqtt)
