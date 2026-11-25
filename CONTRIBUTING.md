# Contributing to Zigbee2Matter

Zigbee2Matter is maintained by **Reizeo** as an independent fork of [Zigbee2MQTT](https://github.com/Koenkk/zigbee2mqtt).

> [!WARNING]
> Any AI-driven pull request with more than 500 lines of code will not be considered. If wanting to submit something that requires more, split the work into easily review-able pull requests that can be introduced in increments (e.g. pre-refactor, base feature, additional features).

Everybody is invited and welcomed to contribute to Zigbee2Matter.
Zigbee2Matter is written in TypeScript.
It uses [zigbee-herdsman](https://github.com/koenkk/zigbee-herdsman) for communication with the adapter/coordinator and [zigbee-herdsman-converters](https://github.com/koenkk/zigbee-herdsman-converters) to provide device-specific definitions.

- Pull requests are always created against the [**main**](https://github.com/Dont-Do-it-Now/zigbee2matter/tree/main) branch.
- You can run the tests locally by executing `pnpm test` (upstream tests) or `pnpm run test:fork` (fork-specific tests).
- Linting & formatting is enforced and can be run with `pnpm run check` (use `pnpm run check:w` to fix small issues automatically).
- If you want to add support for a new device, only [zigbee-herdsman-converters](https://github.com/koenkk/zigbee-herdsman-converters) needs to be changed. You can find a guide [here](https://www.zigbee2mqtt.io/advanced/support-new-devices/01_support_new_devices.html).

## Upstream relationship

This project is a fork of Zigbee2MQTT `2.14.3` (upstream commit `3c841fdfd66c92239921ef84fde8f039c64e1662`). The original project and its contributors retain their applicable copyrights under GPL-3.0.