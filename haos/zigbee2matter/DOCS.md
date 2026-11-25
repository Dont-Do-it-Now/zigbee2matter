# Zigbee2Matter add-on

A bridge that exposes Zigbee devices to Matter ecosystems without an MQTT broker.

For the Korean installation guide, see the [localized documentation](https://dont-do-it-now.github.io/zigbee2matter/?lang=ko#guide/haos).

## Home Assistant OS installation
1. Select **Add Zigbee2Matter repository to Home Assistant** to add the prefilled repository URL.
2. Close the dialog, refresh the App store, and install **Zigbee2Matter**.
3. In the app configuration, select the required **Zigbee coordinator device** from the detected devices. For a network coordinator, enter `tcp://host:port` under **Manual port (advanced)**.
4. Start the app. The Matter bridge is enabled by default; the IPv4 advertisement option only adds IPv4 mDNS. IPv6 mDNS remains enabled and is required for Matter discovery.

### Connect the bridge to Home Assistant Matter

Installing the app does not add Zigbee devices through ZHA. Zigbee2Matter manages the Zigbee network and exposes supported devices through one Matter bridge. Home Assistant must pair that bridge through its Matter integration and Matter Server; after pairing, supported Zigbee devices are available as bridged Matter devices.

1. Add the official **Matter** integration in Home Assistant and install its Matter Server app if prompted.
2. In Zigbee2Matter app configuration, set **API bind host** to `0.0.0.0`, set an **API token**, and enable port `8090/tcp` in the app's Network settings.
3. From a trusted device on the same LAN, open a Matter commissioning window and obtain its setup code:

   ```sh
   curl -X POST http://HOME_ASSISTANT_IP:8090/api/v1/matter/commissioning \
     -H 'Authorization: Bearer YOUR_API_TOKEN' \
     -H 'Content-Type: application/json' \
     -d '{"administratorId":"home-assistant","durationMs":900000}'
   ```

4. In the Home Assistant Matter integration, add a new device and enter the returned setup code. The bridge is commissioned once; pair Zigbee devices to Zigbee2Matter, not individually to the Matter integration.

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

## Local development
For local development, run `haos/prepare-local.sh` (Windows: `haos/prepare-local.ps1`), then copy `haos/zigbee2matter` to `/addons/zigbee2matter` on Home Assistant OS and install it as a local app.

## Release images
The app version is defined by `version` in `config.yaml`. When the version is updated, GitHub Actions publishes amd64 and aarch64 images to GHCR.

## Status
Installation, update, restart, Home Assistant Core stop, backup restore, and amd64/aarch64 runtime acceptance have not been verified.
