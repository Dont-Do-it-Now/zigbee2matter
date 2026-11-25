# Changelog

## 2026.11.25.20
- Log Matter commissioning window lifecycle, finalized fabric changes, and operational CASE session transitions without exposing pairing codes or certificate payloads.

## 2026.11.25.19
- Automatically select the sole non-virtual IPv6 interface for Matter mDNS to avoid advertising operational addresses on Home Assistant and Docker bridges.

## 2026.11.25.18
- Advertise Matter mDNS on all external network interfaces by default and remove the interface selector.
- Keep the Matter platform list visible when a status request fails, and handle Home Assistant status errors separately.

## 2026.11.25.17
- Select the only non-virtual IPv6 network interface for Matter mDNS when no interface is configured.
- Document automatic interface selection and fallback behavior.

## 2026.11.25.16
- Show only committed Matter platforms and hide fabrics from canceled commissioning attempts.
- Block opening another commissioning window while a Matter commissioning attempt is still in progress.

## 2026.11.25.15
- Fix Matter multi-admin pairing with fresh commissioning codes for additional platforms.
- Remove the Home Assistant Matter Server node before deleting its local fabric.
- Map Zigbee presence, illuminance, and water leak sensors to Matter sensor types; initialize contact sensor state.
- Avoid mapping battery voltage as electrical power and clarify SmartThings Matter hub requirements.

## 2026.11.25.14
- Fix the Matter bridge failing to start after a restart once it had been paired. Affected storage is repaired automatically, keeping existing pairings.
- Publish a new app version to Home Assistant only after its image is available, so updates no longer fail right after a release.

## 2026.11.25.13
- Expose multi-gang Zigbee switches as one Matter device with a switch per gang instead of separate devices. Existing multi-gang devices are re-created once after the update.
- Show the connected state after connecting to Home Assistant.
- Open the Matter integration and add-on pages inside the Home Assistant app instead of a new browser tab.

## 2026.11.25.12
- Fix the Matter bridge failing to start ("Behaviors have errors") because the bridge serial number exceeded the Matter length limit.
- Shorten long device names to the Matter label limits instead of failing.
- Log the detailed cause when the Matter bridge fails to start.

## 2026.11.25.11
- Show a clear "Matter bridge is not running" state on the Matter connections page.
- Show errors next to the action, including inside the disconnect dialog.
- Show the right Home Assistant action for each Matter Server state (install, open add-on page, connected).
- Improve Korean line breaks, token sign-in with Enter, and the expired pairing code state.

## 2026.11.25.10
- Show Zigbee2Matter instead of Zigbee2MQTT in the web UI (titles, tooltips, onboarding), logs and Home Assistant device names.
- Open the Matter connections page when #/matter is entered in the address bar.
- Report the actual app version in the logs.

## 2026.11.25.9
- Show the Matter connections link in the frontend sidebar above Contribute.

## 2026.11.25.8
- Fix the frontend freezing right after it starts loading.

## 2026.11.25.7
- Fix the Matter bridge failing to start in the add-on because the Matter Node.js platform package was not installed.

## 2026.11.25.6
- Reflect Zigbee device rename, removal and capability changes live in every connected Matter ecosystem.
- Make Matter state updates faster and non-blocking.
- Add Apple, Google and SmartThings connections alongside existing ones.
- Add one-click Home Assistant connection with Matter Server install and start guidance, without controlling other add-ons.
- Provide the Matter page in English and Korean.
- Remove the token prompt when opened from the Home Assistant sidebar.

## 2026.11.25.5
- Match the Matter disconnect confirmation phrase and dialog text to the selected frontend language.

## 2026.11.25.4
- Add a Matter connection page with QR and manual setup codes.
- Explain sharing the bridge with additional Matter platforms through an existing controller.
- Require typing a localized confirmation phrase before removing a Matter fabric.
- Document Home Assistant Matter Server setup for existing and new servers.
- Label the MQTT-compatible topic as an internal BridgeBus message path.
- Improve coordinator discovery conflict diagnostics and setup guidance.

## 2026.11.25.3
- Require selecting a Zigbee coordinator device in the HAOS app configuration.
- HAOS 앱 구성에서 Zigbee 코디네이터 장치를 필수로 선택하도록 변경.

## 2026.11.25.2
- Enable the Matter bridge by default in HAOS and document pairing it with Home Assistant Matter.
- HAOS에서 Matter 브리지를 기본 활성화하고 Home Assistant Matter 페어링 절차를 문서화.

## 2026.11.25.1
- Make coordinator selection optional and clarify the HAOS app configuration descriptions.
- Zigbee 코디네이터 선택을 선택 사항으로 처리하고 HAOS 앱 설정 설명을 명확히 함.

## 2026.11.25
- Start an independent Zigbee2Matter version line above the inherited Zigbee2MQTT version.
- 기존 Zigbee2MQTT 버전보다 높은 독립 Zigbee2Matter 버전 체계를 시작.
