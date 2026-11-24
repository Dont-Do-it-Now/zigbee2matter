"""Zigbee2Matter REST/WS 클라이언트 허브 (C7/C4).

- REST: GET /api/v1/devices (devices[].entities = HaEntityDefinition), POST /api/v1/commands
- WS : /api/v1/events (Bearer). snapshot -> event(delta/availability/inventory/snapshot). epoch/sequence 불일치,
       resync 프레임, 유휴 타임아웃 시 재연결(=새 snapshot)로 resync 한다.
"""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from typing import Any

import aiohttp
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.dispatcher import async_dispatcher_send

from .const import (
    API_PREFIX,
    COMMAND_DEADLINE_MS,
    MODE_HYBRID,
    RECONNECT_MAX,
    RECONNECT_MIN,
    SIGNAL_CONNECTION,
    SIGNAL_ENTITIES,
    SIGNAL_STATE,
    SIGNAL_TRANSIENT,
    WS_IDLE_TIMEOUT,
)

_LOGGER = logging.getLogger(__name__)


class AuthError(Exception):
    """토큰 거부(401/403)."""


class CannotConnect(Exception):
    """연결 실패."""


class Zigbee2MatterHub:
    def __init__(
        self,
        hass: HomeAssistant,
        entry_id: str,
        host: str,
        port: int,
        token: str,
        ssl: bool,
        verify_ssl: bool,
        mode: str,
    ) -> None:
        self.hass = hass
        self.entry_id = entry_id
        self.host = host
        self.port = port
        self._token = token
        self.ssl = ssl
        self.verify_ssl = verify_ssl
        self.mode = mode
        self.devices: dict[str, dict[str, Any]] = {}  # ieee16 -> device
        self.entities: dict[str, dict[str, Any]] = {}  # uniqueId -> definition
        self.hidden: list[dict[str, Any]] = []  # hybrid 로 제외된 정의
        self.states: dict[str, dict[str, Any]] = {}  # stateKey -> {"value": {}, "available": bool|None}
        self.connected = False
        self._task: asyncio.Task | None = None
        self._refresh_task: asyncio.Task | None = None
        self._epoch: str | None = None
        self._seq: int | None = None
        self._entry = None
        self._got_snapshot = False

    # --- 공통 ---
    @property
    def _base(self) -> str:
        return f"{'https' if self.ssl else 'http'}://{self.host}:{self.port}{API_PREFIX}"

    @property
    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self._token}"}

    def _ssl_arg(self) -> bool | None:
        # aiohttp: ssl=False 면 검증 생략, None 이면 기본 검증
        return None if (not self.ssl or self.verify_ssl) else False

    # --- REST ---
    async def async_fetch_devices(self) -> list[dict[str, Any]]:
        session = async_get_clientsession(self.hass)
        try:
            async with session.get(
                f"{self._base}/devices",
                headers=self._headers,
                ssl=self._ssl_arg(),
                timeout=aiohttp.ClientTimeout(total=15),
            ) as resp:
                if resp.status in (401, 403):
                    raise AuthError
                if resp.status != 200:
                    raise CannotConnect(f"HTTP {resp.status}")
                body = await resp.json()
        except (aiohttp.ClientError, TimeoutError) as err:
            raise CannotConnect(str(err)) from err
        devices = body.get("devices") if isinstance(body, dict) else None
        if not isinstance(devices, list):
            raise CannotConnect("unexpected /devices payload")
        return devices

    async def async_refresh_inventory(self) -> None:
        devices = await self.async_fetch_devices()
        self.devices = {}
        entities: dict[str, dict[str, Any]] = {}
        hidden: list[dict[str, Any]] = []
        for device in devices:
            self.devices[_ieee16(str(device.get("id", "")))] = device
            for definition in device.get("entities") or []:
                if not isinstance(definition, dict) or "uniqueId" not in definition:
                    continue
                if self.mode == MODE_HYBRID and definition.get("matterCovered"):
                    hidden.append(definition)
                    continue
                entities[definition["uniqueId"]] = definition
        self.entities = entities
        self.hidden = hidden
        async_dispatcher_send(self.hass, SIGNAL_ENTITIES.format(entry_id=self.entry_id))

    async def async_command(self, definition: dict[str, Any], payload: dict[str, Any]) -> None:
        session = async_get_clientsession(self.hass)
        body = {
            "requestId": str(uuid.uuid4()),
            "correlationId": str(uuid.uuid4()),
            "deadline": int(time.time() * 1000) + COMMAND_DEADLINE_MS,
            "operation": "set",
            "target": {"key": definition["stateKey"]},
            "value": payload,
        }
        try:
            async with session.post(
                f"{self._base}/commands",
                json=body,
                headers=self._headers,
                ssl=self._ssl_arg(),
                timeout=aiohttp.ClientTimeout(total=35),
            ) as resp:
                if resp.status >= 400:
                    raise HomeAssistantError(f"Zigbee2Matter command rejected (HTTP {resp.status}): {await resp.text()}")
        except (aiohttp.ClientError, TimeoutError) as err:
            raise HomeAssistantError(f"Zigbee2Matter command failed: {err}") from err

    # --- 상태 ---
    def state_value(self, state_key: str) -> dict[str, Any]:
        return self.states.get(state_key, {}).get("value") or {}

    def state_available(self, state_key: str) -> bool:
        if not self.connected:
            return False
        return self.states.get(state_key, {}).get("available") is not False

    def _apply_record(self, record: dict[str, Any]) -> None:
        key = record.get("key")
        if not isinstance(key, str):
            return
        value = record.get("observedValue")
        self.states[key] = {
            "value": value if isinstance(value, dict) else {},
            "available": record.get("availability"),
        }
        async_dispatcher_send(self.hass, SIGNAL_STATE.format(entry_id=self.entry_id, state_key=key))

    def _replace_records(self, records: list[Any]) -> None:
        old = set(self.states)
        self.states = {}
        for record in records:
            if isinstance(record, dict):
                self._apply_record(record)
        for key in old - set(self.states):
            async_dispatcher_send(self.hass, SIGNAL_STATE.format(entry_id=self.entry_id, state_key=key))

    # --- WS ---
    def start(self, entry) -> None:
        self._entry = entry
        self._task = entry.async_create_background_task(self.hass, self._run(), "zigbee2matter-ws")

    async def async_stop(self) -> None:
        for task in (self._task, self._refresh_task):
            if task:
                task.cancel()
        self._task = self._refresh_task = None

    def _set_connected(self, value: bool) -> None:
        if self.connected != value:
            self.connected = value
            async_dispatcher_send(self.hass, SIGNAL_CONNECTION.format(entry_id=self.entry_id))

    async def _run(self) -> None:
        delay = RECONNECT_MIN
        while True:
            self._got_snapshot = False
            try:
                await self._session()
            except asyncio.CancelledError:
                raise
            except AuthError:
                _LOGGER.error("Zigbee2Matter WS authentication failed; starting reauth")
                self._set_connected(False)
                if self._entry is not None:
                    self._entry.async_start_reauth(self.hass)
                return
            except Exception as err:  # noqa: BLE001
                _LOGGER.warning("Zigbee2Matter WS disconnected: %s", err)
            self._set_connected(False)
            if self._got_snapshot:
                delay = RECONNECT_MIN
            await asyncio.sleep(delay)
            delay = min(delay * 2, RECONNECT_MAX)

    async def _session(self) -> None:
        session = async_get_clientsession(self.hass)
        scheme = "wss" if self.ssl else "ws"
        url = f"{scheme}://{self.host}:{self.port}{API_PREFIX}/events"
        self._epoch = self._seq = None
        try:
            ws_ctx = session.ws_connect(url, headers=self._headers, ssl=self._ssl_arg(), heartbeat=None)
            ws = await ws_ctx.__aenter__()
        except aiohttp.WSServerHandshakeError as err:
            if err.status in (401, 403):
                raise AuthError from err
            raise
        try:
            while True:
                msg = await ws.receive(timeout=WS_IDLE_TIMEOUT)
                if msg.type != aiohttp.WSMsgType.TEXT:
                    if msg.type == aiohttp.WSMsgType.CLOSE and msg.data in (4401, 4403):
                        raise AuthError
                    return  # CLOSE/ERROR -> 재연결
                frame = msg.json()
                if not self._handle_frame(frame):
                    return
        finally:
            await ws_ctx.__aexit__(None, None, None)

    def _handle_frame(self, frame: Any) -> bool:
        """False 를 돌려주면 재연결(resync)한다."""
        if not isinstance(frame, dict):
            return False
        ftype = frame.get("type")
        if ftype == "ping":
            return True
        if ftype == "resync":
            _LOGGER.debug("resync requested: %s", frame.get("reason"))
            return False
        if ftype == "snapshot":
            self._epoch = frame.get("epoch")
            self._seq = frame.get("sequence")
            payload = frame.get("payload") or {}
            self._replace_records(payload.get("records") or [])
            self._got_snapshot = True
            self._set_connected(True)
            return True
        if ftype != "event":
            return True
        event = frame.get("event") or {}
        seq = event.get("sequence")
        if event.get("epoch") != self._epoch or self._seq is None or seq != self._seq + 1:
            return False  # epoch 변경 / gap -> resync
        self._seq = seq
        etype = event.get("type")
        payload = event.get("payload")
        if etype == "snapshot" and isinstance(payload, dict):
            self._replace_records(payload.get("records") or [])
        elif etype in ("delta", "availability") and isinstance(payload, dict):
            if payload.get("removed"):
                self.states.pop(event.get("key"), None)
                async_dispatcher_send(self.hass, SIGNAL_STATE.format(entry_id=self.entry_id, state_key=event.get("key")))
            else:
                self._apply_record(payload)
        elif etype == "inventory":
            self._schedule_refresh()
        elif etype == "transient" and isinstance(payload, dict):
            # 순간 이벤트는 상태에 병합하지 않고 event 엔티티로만 전달한다(C4).
            ieee = ieee_from_key(str(event.get("key", "")))
            if ieee:
                async_dispatcher_send(self.hass, SIGNAL_TRANSIENT.format(entry_id=self.entry_id, ieee=ieee), payload)
        return True

    def _schedule_refresh(self) -> None:
        if self._refresh_task and not self._refresh_task.done():
            return

        async def _refresh() -> None:
            await asyncio.sleep(2)  # inventory 이벤트 연속 발생 합치기
            try:
                await self.async_refresh_inventory()
            except (AuthError, CannotConnect) as err:
                _LOGGER.warning("inventory refresh failed: %s", err)

        self._refresh_task = self.hass.async_create_background_task(_refresh(), "zigbee2matter-refresh")


def _ieee16(value: str) -> str:
    value = value.lower()
    return value[2:] if value.startswith("0x") else value


def ieee_from_key(key: str) -> str:
    """`dev:<net>:<ieee16>:<ep>:<feature>` -> ieee16."""
    parts = key.split(":")
    return parts[2] if len(parts) > 2 else ""
