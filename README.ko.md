<div align="center">
  <img src="images/logo.png" width="150" height="150" alt="Zigbee2Matter 로고">
  <h1>Zigbee2Matter</h1>
  <p>Zigbee2MQTT 코드베이스를 기반으로 만든 Zigbee-to-Matter 브리지입니다.</p>
  <p><a href="README.md">English README</a> · <a href="LICENSE">라이선스</a></p>
</div>

Zigbee2Matter는 Zigbee2MQTT의 검증된 Zigbee 장치·converter·코디네이터·인터뷰 경로를 유지하면서 Zigbee 네트워크를 Matter 생태계에 연결합니다. 브로커에 의존하는 실행 경계를 in-process bridge bus로 교체하고 Matter, REST, WebSocket adapter를 추가합니다.

이 저장소는 독립적으로 유지되는 포크입니다. 공식 Zigbee2MQTT 또는 Connectivity Standards Alliance 제품이 아닙니다.

### 원본 기준점

독립 `main` 이력은 원본 스냅샷 하나에서 시작합니다. 기준은 Zigbee2MQTT `2.14.3`, upstream 커밋 `3c841fdfd66c92239921ef84fde8f039c64e1662`, 원본 릴리스일 `2026-11-01`입니다. Zigbee2Matter 독립 이력으로 전환한 날짜는 `2026-11-24`입니다. 원본의 긴 커밋 이력은 의도적으로 `main`에 포함하지 않았습니다.

## 제공 기능

- Zigbee-herdsman과 Zigbee converter 계층을 Zigbee 상태의 원본으로 유지합니다.
- 영속 endpoint identity를 사용해 장치를 Matter endpoint로 노출합니다.
- Home Assistant Direct, Home Assistant Matter, Hybrid adapter 경계를 제공합니다.
- 장치·명령·진단·snapshot·delta를 위한 인증 REST/WebSocket API를 제공합니다.
- bounded queue, replay, epoch 변경, resync로 플랫폼 소비자를 격리합니다.
- Docker/Linux 배포, 코디네이터 탐색·복구, 이관 계획, 백업 암호화, 릴리스 게이트를 제공합니다.
- MQTT broker나 MQTT client runtime을 다시 추가하지 않고 기존 frontend 호환 경로를 유지합니다.

## 범위와 경계

Zigbee2Matter는 Matter Bridge입니다. 다음은 핵심 범위에 포함하지 않습니다.

- 임의의 외부 Matter 장치를 관리하는 Matter Controller 기능
- Thread Border Router, Z-Wave, 일반 Wi-Fi 장치 등록, 별도 자동화 엔진
- 코디네이터 펌웨어 자동 변경 또는 승인되지 않은 fallback
- 자동화나 entity identity를 추정해 조용히 보존하는 이관

Zigbee 네트워크가 장치 상태의 원본입니다. Matter fabric·ACL·commissioning·reporting은 Matter SDK가 소유하고, REST/WebSocket 소비자는 Zigbee 내부를 직접 호출하지 않고 공통 명령·이벤트 계약을 사용합니다.

## 구조

```text
Zigbee 코디네이터
        │
zigbee-herdsman + converters
        │
Zigbee2Matter Core
  ├── EventStream / state / command router
  ├── in-process BridgeBus (broker 없음)
  ├── Matter SDK adapter
  ├── Home Assistant adapters
  └── REST + WebSocket API server
        │
Matter fabric · Home Assistant · 기존 frontend · 기타 Matter controller
```

공통 계약은 안정적인 identity, revision state, 명시적 command result, replay/resync 이벤트, adapter 경계, 비밀값을 제거한 API 오류를 중심으로 구성됩니다.

- 장치·그룹·브리지·endpoint의 안정적인 identity
- revision 상태와 재시작 epoch
- 명시적인 명령 결과(`accepted`, `executed`, `confirmed`, `failed`, `timeout`, `unknown`)
- replay와 resync를 지원하는 순서 있는 이벤트
- Core가 Matter/HTTP 구현에 의존하지 않는 adapter 경계
- scope 인증과 비밀값이 제거된 API 오류

## 현재 구현 상태

상세 작업 카드와 검증 기록은 로컬 `docs/`에 보관하며 저장소 이력에는 포함하지 않습니다.

현재 구현된 주요 영역:

- Zigbee 코디네이터 탐색, pairing, 복구, availability, 그룹, binding, converter, OTA 경계
- event stream, 기기별 queue, deduplication, retry, fan-out, backpressure, loop prevention
- Matter endpoint 영속화, 동적 endpoint, mapping registry, commissioning, fabric, reporting, 복수 브리지 격리
- HA entity identity, Direct/Matter/Hybrid routing, REST, WebSocket, 진단, backup, migration, cutover, quality gate, Docker 설정
- `@matter/main`의 `ServerNode` 수명주기를 사용하는 Matter.js 0.18 adapter 경계

실행하지 않은 build·test·TypeScript·lint·설치·장비·장시간 acceptance 명령은 `NOT RUN`으로 기록합니다. 구현 기록을 실제 장비나 플랫폼 수용 테스트의 증거로 해석하면 안 됩니다.

## 빠른 시작

### 요구 환경

- `package.json`에 선언된 Node.js 22.13.0 계열
- pnpm 11.26.0
- 지원되는 Zigbee 코디네이터와 호환 펌웨어
- Matter commissioning과 mDNS를 위한 IPv6 및 로컬 multicast
- Matter runtime 사용 시 해당 작업 증거에 기록된 Matter SDK 버전

### 설치와 빌드

```bash
pnpm install --frozen-lockfile
pnpm run build
```

### 실행

```bash
pnpm start
```

코디네이터와 Zigbee 설정은 기존 Zigbee2MQTT 설정 흐름을 사용합니다. Matter 런타임 연결은 `lib/matter/` 아래 adapter 경계를 사용합니다.

Matter node를 사용하려면 설정에서 `matter.enabled: true`를 지정하세요. commissioning credential을 설정할 때는 `matter.passcode`와 `matter.discriminator`를 함께 지정해야 합니다. Matter SDK는 런타임에 로드되며, Matter node를 활성화하려면 고정된 SDK 패키지가 설치되어 있어야 합니다.

### Docker

[`docker/`](docker/)에 배포 설정이 있습니다. Matter mDNS를 위한 host network, 영속 data volume, USB 코디네이터, 명시적 TCP 코디네이터 설정을 지원합니다. 컨테이너 실행 전에 장치 경로와 네트워크를 확인하세요.

## API

독립 API 서버는 다음 경계를 제공합니다.

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

REST는 `Authorization: Bearer <token>`을 사용합니다. WebSocket은 기존 UI 호환을 위해 `token` query parameter도 사용할 수 있습니다. 신규 API는 명시적으로 anonymous scope를 설정하지 않으면 fail-closed입니다. token은 저장 시 hash만 남기고, scope는 `read < control < admin` 순서이며, 외부 오류에는 secret과 stack trace를 포함하지 않습니다.
관리 API는 `api.ssl_cert`와 `api.ssl_key`로 HTTPS/WSS를 사용할 수 있으며, 두 값 모두 읽을 수 있는 인증서·개인 키 파일을 가리켜야 합니다.

WebSocket 이벤트는 epoch와 증가하는 sequence를 사용합니다. gap, epoch 변경, 잘못된 replay, queue overflow가 발생하면 누락된 상태를 조용히 적용하지 않고 snapshot/resync를 요구합니다.

## Matter와 Home Assistant

Matter commissioning은 브리지 등록 흐름이며 Zigbee 장치별 QR 흐름이 아닙니다. fabric credential, ACL, commissioning transport, attribute reporting은 Matter SDK가 담당합니다. Zigbee device identity와 Matter endpoint identity는 분리해 브리지별로 저장합니다.

- **Direct mode:** Matter Server 없이 REST/WebSocket 계약으로 Home Assistant에 연결합니다.
- **Matter mode:** Home Assistant 공식 Matter integration과 Matter Server가 controller 역할을 합니다.
- **Hybrid mode:** Direct와 Matter binding을 분리하고 중복 entity key를 거부합니다.

관련 구현 경계는 `lib/matter/`와 `lib/api/` 아래에 있습니다.

## 이관과 복구

이관은 source를 보존하는 staged 방식입니다.

1. 버전, 경로, 코디네이터 identity, network identity fingerprint, frame counter를 사전 검사합니다.
2. source hash를 확인한 뒤 staging directory에 복사합니다.
3. 기존 configuration의 최상위 `mqtt` 항목은 이관하지 않습니다.
4. 검사 완료 후 staging directory를 원자적으로 승격합니다.
5. target backup을 유지해 rollback하며, 실패 시 원본 data는 변경하지 않습니다.

독립 브리지 사이에서 data directory를 공유하지 마세요. 전환 전에 backup을 생성하세요.

## 개발

TypeScript, pnpm, Vitest, Biome 기반입니다. 변경 전 [`AGENTS.md`](AGENTS.md)와 관련 작업 카드를 읽으세요.

```bash
pnpm install --include=dev
pnpm run build
pnpm run check
pnpm test
```

포크 전용 테스트 설정은 다음과 같습니다.

```bash
pnpm run test:fork
```

현재 작업 지시가 위 명령 실행을 금지하는 경우에는 `NOT RUN`으로 기록하고 승인된 검증 단계에서 실행하세요.

구현 근거와 미실행 검증 항목은 로컬 `docs/`에 보관하며 저장소 이력에는 포함하지 않습니다.

## Upstream 관계

Zigbee2Matter는 독립 포크로 유지됩니다. 개발자 작업공간에 형제 폴더 `Zigbee2Matter-upstream`이 있더라도 참조용이며 작업 트리가 아닙니다.

Upstream 동기화는 로컬 설계 ledger와 patch 분류를 사용하고, MQTT 시대의 변경을 Matter transport 경계에 무분별하게 병합하지 않습니다.

Upstream 프로젝트: [Koenkk/zigbee2mqtt](https://github.com/Koenkk/zigbee2mqtt). 원 프로젝트와 기여자의 저작권 및 해당 라이선스를 보존합니다.

## 기여

변경 범위를 좁게 유지하고 공통 계약을 보존하며 관련 evidence를 갱신하세요. credential, network key, fabric key, raw setup code를 로그나 issue에 포함하지 마세요.

Git 작업은 기능별 Conventional Commit으로 분리하고 push는 수동으로 유지합니다. 저장소의 smart-commit 절차가 커밋 그룹과 메시지의 기준이며 자동 push를 허용하지 않습니다.

기여 전 [`CONTRIBUTING.md`](CONTRIBUTING.md), [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md), [`AI_POLICY.md`](AI_POLICY.md)도 확인하세요.

## 라이선스

Zigbee2Matter는 GPL-3.0으로 배포됩니다. [`LICENSE`](LICENSE)를 확인하고 재배포 시 upstream 고지를 보존하세요. Matter.js 설치 시 해당 코드는 Apache-2.0 및 관련 NOTICE를 따릅니다. Matter 인증·Vendor ID·로고·상표는 오픈소스 라이선스와 별개의 사항입니다.
