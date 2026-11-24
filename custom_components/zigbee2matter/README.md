# Zigbee2Matter Home Assistant 통합

Zigbee2Matter 공통 API(REST `/api/v1/devices`, `/api/v1/commands`, WS `/api/v1/events`)로 직접 연동하는 custom integration (HA Direct).
Matter Server가 필요 없다. 상태는 WS snapshot→delta로 push, epoch/sequence gap/resync 시 자동 재연결한다.

## 설치
- HACS: 사용자 저장소로 추가(Integration) 후 설치. 저장소 루트의 `hacs.json` 사용.
- 수동: `custom_components/zigbee2matter/`를 HA `config/custom_components/`에 복사 후 HA 재시작.

## 설정
설정 > 기기 및 서비스 > 통합 추가 > Zigbee2Matter. 호스트, 포트(기본 8090), API 토큰(read+control 권한 이상), HTTPS 여부, 모드를 입력한다.
토큰이 평문 전송되므로 TLS 또는 신뢰 네트워크에서만 사용한다.

## 모드 비교
| 모드 | 경로 | 이 통합 엔티티 | 비고 |
|---|---|---|---|
| Direct | HA ↔ Zigbee2Matter API | 전부 | Matter 불필요, 기능(config/diagnostic 포함) 최대 |
| Matter | HA 공식 Matter 통합 → Zigbee2Matter Matter Bridge | 사용 안 함 | 이 통합을 설치하지 않고 Matter commissioning만 사용 |
| Hybrid | 둘 다 | `matterCovered`가 아닌 것만(진단/설정/Matter 미지원) | 조명/스위치/커버/잠금/온도조절/주요 센서는 Matter 쪽이 노출, 중복 방지 |

unique_id는 `zigbee2matter:dev:<network>:<ieee>:<endpoint>:ha/<platform>/<objectId>`(DeviceKey 기반)이며 이름 변경과 무관하다.
Hybrid로 바꾸면 중복 엔티티의 기존 등록분이 정리된다. `action`은 HA `event` 엔티티(device_class button, 기기당 1개)로 노출되며 WS `transient` 이벤트로만 트리거된다(상태 병합 없음). 그룹, composite/list/text는 아직 지원하지 않는다.

## 서버 요건 (통합 요청)
`/api/v1/devices`의 각 device에 `entities`(`lib/ha` `HaBridge.restEntities`) 와 선택 `vendor`/`model`이 채워져야 엔티티가 생성된다.
