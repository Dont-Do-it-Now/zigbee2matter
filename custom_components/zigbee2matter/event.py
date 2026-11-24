"""Event 플랫폼 (버튼 action). transient 이벤트만 받으며 상태는 병합하지 않는다(C4)."""

from __future__ import annotations

from typing import Any

from homeassistant.components.event import EventDeviceClass, EventEntity
from homeassistant.core import callback
from homeassistant.helpers.dispatcher import async_dispatcher_connect

from .const import SIGNAL_TRANSIENT
from .entity import Z2MEntity, setup_platform
from .hub import ieee_from_key


async def async_setup_entry(hass, entry, async_add_entities) -> None:
    setup_platform(hass, entry, async_add_entities, "event", Z2MEvent)


class Z2MEvent(Z2MEntity, EventEntity):
    def __init__(self, hub, definition) -> None:
        super().__init__(hub, definition)
        self._attr_event_types = [str(v) for v in self._config.get("eventTypes", [])]
        if definition.get("deviceClass") == "button":
            self._attr_device_class = EventDeviceClass.BUTTON

    async def async_added_to_hass(self) -> None:
        await super().async_added_to_hass()
        ieee = ieee_from_key(self.state_key)
        self.async_on_remove(
            async_dispatcher_connect(
                self.hass, SIGNAL_TRANSIENT.format(entry_id=self.hub.entry_id, ieee=ieee), self._on_transient
            )
        )

    @callback
    def _on_transient(self, payload: dict[str, Any]) -> None:
        data = payload.get("data")
        action = payload.get("action")
        if action is None and isinstance(data, dict):
            action = data.get("action")
        if not isinstance(action, str) or action not in self._attr_event_types:
            return
        attrs = {k: v for k, v in (data.items() if isinstance(data, dict) else []) if k != "action"}
        attrs.update({k: v for k, v in payload.items() if k.startswith("action_")})
        self._trigger_event(action, attrs)
        self.async_write_ha_state()
