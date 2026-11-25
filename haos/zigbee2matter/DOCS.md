# Zigbee2Matter add-on

Zigbee 기기를 Matter 로 노출하는 브리지입니다. MQTT broker 가 필요 없습니다.

## 데이터
- 모든 데이터(`configuration.yaml`, Zigbee DB, Matter fabric/키)는 `/data`(`ZIGBEE2MATTER_DATA=/data`)에 저장되며 HA 백업에 포함됩니다.
- `ZIGBEE2MQTT_DATA` 및 기존 Zigbee2MQTT add-on 디렉터리는 열지 않습니다. 이관은 별도 도구를 사용하세요.
- 장치·그룹 등 고급 설정은 `/data/configuration.yaml` 에 직접 작성합니다. 옵션은 환경 변수로 주입되며 env 가 우선합니다.

## 네트워크
- `host_network: true` 필수: Matter mDNS(UDP 5353)·UDP 5540·IPv6 link-local. HAOS 호스트와 Matter 컨트롤러가 같은 L2/VLAN 이어야 합니다.
- Frontend 는 ingress(8080)로 제공됩니다. host network 이므로 8080 이 LAN 에도 바인드됩니다. 신뢰할 수 없는 네트워크에서는 방화벽으로 차단하세요.
- 관리 API 는 기본 `127.0.0.1:8090`. loopback 이 아닌 호스트에는 API 토큰이 필요합니다.

## 시리얼
`serial_port` 에 `/dev/serial/by-id/...` 또는 `tcp://host:port`(adapter 필수)를 지정합니다.

## Home Assistant OS 설치
1. [Home Assistant에 Zigbee2Matter 저장소 추가](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2FDont-Do-it-Now%2Fzigbee2matter) 버튼을 눌러 미리 입력된 저장소를 추가합니다.
2. 앱 스토어에서 **Zigbee2Matter**를 설치합니다.
3. 앱 설정에서 코디네이터의 `serial_port`와 `serial_adapter`를 지정하고 시작합니다.

GitHub Actions가 amd64/aarch64 이미지를 빌드해 배포하므로 HAOS에 파일을 복사하거나 로컬에서 이미지를 빌드할 필요가 없습니다.

### 로컬 개발 설치
개발 PC에서 `haos/prepare-local.sh`(Windows: `haos/prepare-local.ps1`)를 실행한 뒤 `haos/zigbee2matter` 폴더를 HAOS의 `/addons/zigbee2matter`에 복사해 로컬 앱으로 설치합니다.

## 릴리스 이미지
애드온 버전은 `config.yaml`의 `version`이 기준입니다. 새 버전을 배포할 때 버전을 올리면 GitHub Actions가 해당 버전의 amd64/aarch64 이미지를 GHCR에 게시합니다.

## 상태
설치·업데이트·재시작·HA Core 중지·백업 복원·amd64/aarch64 시험은 NOT RUN 입니다.
