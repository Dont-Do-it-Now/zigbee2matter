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

## HAOS 로컬 설치
1. 개발 PC에서 `haos/prepare-local.sh`(Windows: `haos/prepare-local.ps1`) 실행 -> `haos/zigbee2matter/app/` 에 빌드용 소스가 복사됩니다.
2. `haos/zigbee2matter` 폴더 전체를 HAOS 의 `/addons/zigbee2matter` 로 복사(Samba `addons` 공유 또는 SSH).
3. 설정 -> 애드온 -> 애드온 스토어 -> 새로고침 -> 로컬 애드온 "Zigbee2Matter" 설치(첫 빌드는 tsc/pnpm 때문에 오래 걸립니다).

## 사전 빌드 이미지(선택)
`prepare-local` 후 `haos/zigbee2matter` 를 컨텍스트로 이미지를 빌드해 레지스트리에 push 하고, `config.yaml` 의 `image: ghcr.io/OWNER/zigbee2matter-addon-{arch}` 주석을 해제(OWNER 교체)합니다. 이 경우 `repository.yaml` 저장소로 설치합니다.

## 상태
설치·업데이트·재시작·HA Core 중지·백업 복원·amd64/aarch64 시험은 NOT RUN 입니다.
