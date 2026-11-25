# Zigbee2Matter add-on

A bridge that exposes Zigbee devices to Matter ecosystems without an MQTT broker.

For the Korean installation guide, see the [localized documentation](https://dont-do-it-now.github.io/zigbee2matter/?lang=ko#guide/haos).

## Home Assistant OS installation
1. Select **Add Zigbee2Matter repository to Home Assistant** to add the prefilled repository URL.
2. Close the dialog, refresh the App store, and install **Zigbee2Matter**.
3. Open the app configuration, select the coordinator's `serial_port` and `serial_adapter`, then start the app.

The repository publishes amd64 and aarch64 images. No file copying or local image build is required.

## Network
- Host networking is required for Matter mDNS (UDP 5353), UDP 5540, and IPv6 link-local traffic. Keep Home Assistant OS and Matter controllers on the same L2 network/VLAN.
- The frontend is available through ingress on port 8080. Because the app uses host networking, port 8080 is also bound on the LAN; restrict access with a firewall if needed.
- The management API defaults to `127.0.0.1:8090`. Configure an API token before binding it to a non-loopback address.

## Data and configuration
- The app stores `configuration.yaml`, the Zigbee database, and Matter fabric data under `/data` (`ZIGBEE2MATTER_DATA=/data`). Home Assistant backups include this directory.
- The app does not read `ZIGBEE2MQTT_DATA` or an existing Zigbee2MQTT app directory. Use a separate migration tool to migrate existing data.
- Advanced device and group settings can be written to `/data/configuration.yaml`. App options are passed as environment variables and take precedence.

## Coordinator connection
Set `serial_port` to `/dev/serial/by-id/...` or `tcp://host:port`. A TCP coordinator also requires `serial_adapter`.

## Local development
For local development, run `haos/prepare-local.sh` (Windows: `haos/prepare-local.ps1`), then copy `haos/zigbee2matter` to `/addons/zigbee2matter` on Home Assistant OS and install it as a local app.

## Release images
The app version is defined by `version` in `config.yaml`. When the version is updated, GitHub Actions publishes amd64 and aarch64 images to GHCR.

## Status
Installation, update, restart, Home Assistant Core stop, backup restore, and amd64/aarch64 runtime acceptance have not been verified.
