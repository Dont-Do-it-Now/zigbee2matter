"""공통 엔티티 베이스와 플랫폼 setup 헬퍼."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import EntityCategory
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.entity import Entity
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN, SIGNAL_CONNECTION, SIGNAL_ENTITIES, SIGNAL_STATE
from .hub import Zigbee2MatterHub, ieee_from_key


class Z2MEntity(Entity):
    _attr_should_poll = False
    _attr_has_entity_name = True

    def __init__(self, hub: Zigbee2MatterHub, definition: dict[str, Any]) -> None:
        self.hub = hub
        self.definition = definition
        self._config: dict[str, Any] = definition.get("config") or {}
        self._property: str | None = definition.get("property")
        self._attr_unique_id = definition["uniqueId"]  # DeviceKey 기반(C1)
        # 주 엔티티(platform == objectId)는 기기 이름을 그대로 쓴다.
        self._attr_name = None if definition.get("objectId") == definition.get("platform") else definition.get("name")
        self._attr_entity_registry_enabled_default = bool(definition.get("enabledByDefault", True))
        category = definition.get("entityCategory")
        if category in ("config", "diagnostic"):
            self._attr_entity_category = EntityCategory(category)
        if definition.get("icon"):
            self._attr_icon = definition["icon"]
        ieee = ieee_from_key(definition["stateKey"])
        device = hub.devices.get(ieee, {})
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, ieee)},
            name=device.get("name") or ieee,
            manufacturer=device.get("vendor"),
            model=device.get("model"),
        )

    @property
    def state_key(self) -> str:
        return self.definition["stateKey"]

    @property
    def value(self) -> Any:
        return self.hub.state_value(self.state_key).get(self._property) if self._property else None

    def raw(self, prop: str | None) -> Any:
        return self.hub.state_value(self.state_key).get(prop) if prop else None

    @property
    def available(self) -> bool:
        return self.hub.state_available(self.state_key) and self.definition["uniqueId"] in self.hub.entities

    async def async_added_to_hass(self) -> None:
        entry_id = self.hub.entry_id
        self.async_on_remove(
            async_dispatcher_connect(
                self.hass, SIGNAL_STATE.format(entry_id=entry_id, state_key=self.state_key), self._refresh
            )
        )
        self.async_on_remove(async_dispatcher_connect(self.hass, SIGNAL_CONNECTION.format(entry_id=entry_id), self._refresh))

    @callback
    def _refresh(self) -> None:
        self.async_write_ha_state()

    async def async_send(self, payload: dict[str, Any]) -> None:
        await self.hub.async_command(self.definition, payload)


def setup_platform(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
    platform: str,
    factory: Callable[[Zigbee2MatterHub, dict[str, Any]], Entity],
) -> None:
    """현재 엔티티를 추가하고, inventory 갱신으로 생기는 신규 엔티티도 자동 등록한다."""
    hub: Zigbee2MatterHub = entry.runtime_data
    added: set[str] = set()

    @callback
    def _add() -> None:
        new = [
            factory(hub, d)
            for uid, d in hub.entities.items()
            if d.get("platform") == platform and uid not in added
        ]
        added.update(e.unique_id for e in new)
        if new:
            async_add_entities(new)

    _add()
    entry.async_on_unload(async_dispatcher_connect(hass, SIGNAL_ENTITIES.format(entry_id=entry.entry_id), _add))
