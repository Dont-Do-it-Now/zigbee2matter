# Changelog

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
