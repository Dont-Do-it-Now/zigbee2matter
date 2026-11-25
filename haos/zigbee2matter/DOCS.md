# Zigbee2Matter add-on

A bridge that exposes Zigbee devices to Matter ecosystems without an MQTT broker.

For the Korean installation guide, see the [localized documentation](https://dont-do-it-now.github.io/zigbee2matter/?lang=ko#guide/haos).

## Home Assistant OS installation
1. Select **Add Zigbee2Matter repository to Home Assistant** to add the prefilled repository URL.
2. Close the dialog, refresh the App store, and install **Zigbee2Matter**.
3. In the app configuration, select the required **Zigbee coordinator device** from the detected devices. For a network coordinator, enter `tcp://host:port` under **Manual port (advanced)**.
4. Start the app. The Matter bridge is enabled by default and advertises Matter mDNS over both IPv4 and IPv6.

### Connect the bridge to Home Assistant Matter

Installing the app does not add Zigbee devices through ZHA. Zigbee2Matter manages the Zigbee network and exposes supported devices through one Matter bridge. Home Assistant must pair that bridge through its Matter integration and Matter Server; after pairing, supported Zigbee devices are available as bridged Matter devices.

1. Check whether the Home Assistant **Matter** integration already has a Matter Server connection. Reuse the existing server; do not install a second one.
2. If there is no Matter Server, add the official **Matter** integration in Home Assistant and follow its prompt to install and connect the official Matter Server app. If a server already exists, select that server when configuring the integration. See the [Home Assistant Matter guide](https://www.home-assistant.io/integrations/matter/).
3. Set an **API token** in the Zigbee2Matter app configuration. Keep the API bind host at its default `127.0.0.1`; the UI does not require exposing port `8090` on the LAN.
4. Open the Zigbee2Matter app's ingress panel and select **Matter 연결**. Enter the API token if prompted, start the first connection to display a QR code and manual setup code, then choose **Add Matter device** in Home Assistant's Matter integration and scan the QR or enter the code.

The bridge is commissioned once; pair Zigbee devices to Zigbee2Matter, not individually to the Matter integration. Basic Matter pairing uses the app's ingress UI and does not require exposing port `8090`.

To add the same bridge to another Matter ecosystem later, use **Share device** in the controller that is already connected, then scan its newly generated sharing QR code or enter its sharing code in the other platform. Do not reuse the first commissioning code for additional platforms. See the [Home Assistant Matter guide](https://www.home-assistant.io/integrations/matter/) for the current sharing steps and controller-specific requirements.

Keep IPv6 multicast/mDNS available between Home Assistant and the bridge on the same local network. Do not connect the same coordinator to ZHA or Zigbee2MQTT at the same time.

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
Choose the USB/serial coordinator from **Coordinator device**. For a network coordinator or custom path, set **Manual port (advanced)** to `tcp://host:port` or `/dev/serial/by-id/...`. A TCP coordinator also requires `serial_adapter`.

Only one app or integration can use a serial coordinator at a time. If the coordinator is already configured in ZHA, Zigbee2MQTT, or another app, stop or remove that integration before starting Zigbee2Matter. If startup reports that no USB adapter was found, check both the selected device path and whether another app is holding the coordinator.

## Local development
For local development, run `haos/prepare-local.sh` (Windows: `haos/prepare-local.ps1`), then copy `haos/zigbee2matter` to `/addons/zigbee2matter` on Home Assistant OS and install it as a local app.

## Release images
To release, bump only `version` in the root `package.json`. GitHub Actions builds and publishes amd64 and aarch64 images to GHCR, then writes that version to `config.yaml` (do not edit it by hand) so Home Assistant sees it only after the image exists.

## Status
Installation, update, restart, Home Assistant Core stop, backup restore, and amd64/aarch64 runtime acceptance have not been verified.
