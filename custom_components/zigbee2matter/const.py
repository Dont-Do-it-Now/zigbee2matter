"""Zigbee2Matter 통합 상수."""

from homeassistant.const import Platform

DOMAIN = "zigbee2matter"

CONF_TOKEN = "token"
CONF_SSL = "ssl"
CONF_VERIFY_SSL = "verify_ssl"
CONF_MODE = "mode"

DEFAULT_PORT = 8090

# direct: 모든 엔티티를 이 통합이 노출. hybrid: HA Matter 통합이 이미 노출할 엔티티(matterCovered)는 건너뛴다.
MODE_DIRECT = "direct"
MODE_HYBRID = "hybrid"
MODES = [MODE_DIRECT, MODE_HYBRID]

API_PREFIX = "/api/v1"
COMMAND_DEADLINE_MS = 30_000
WS_IDLE_TIMEOUT = 90  # 서버 ping(30s) 3회 누락 시 재연결
RECONNECT_MIN = 1
RECONNECT_MAX = 60

PLATFORMS: list[Platform] = [
    Platform.LIGHT,
    Platform.SWITCH,
    Platform.SENSOR,
    Platform.BINARY_SENSOR,
    Platform.COVER,
    Platform.CLIMATE,
    Platform.LOCK,
    Platform.BUTTON,
    Platform.NUMBER,
    Platform.SELECT,
    Platform.EVENT,
]

SIGNAL_CONNECTION = f"{DOMAIN}_connection_{{entry_id}}"
SIGNAL_STATE = f"{DOMAIN}_state_{{entry_id}}_{{state_key}}"
SIGNAL_ENTITIES = f"{DOMAIN}_entities_{{entry_id}}"
SIGNAL_TRANSIENT = f"{DOMAIN}_transient_{{entry_id}}_{{ieee}}"
