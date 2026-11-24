"""Switch 플랫폼."""

from __future__ import annotations

from typing import Any

from homeassistant.components.switch import SwitchEntity

from .entity import Z2MEntity, setup_platform


def matches(value: Any, expected: Any) -> bool | None:
    if value is None:
        return None
    return value == expected or str(value).upper() == str(expected).upper()


async def async_setup_entry(hass, entry, async_add_entities) -> None:
    setup_platform(hass, entry, async_add_entities, "switch", Z2MSwitch)


class Z2MSwitch(Z2MEntity, SwitchEntity):
    @property
    def is_on(self) -> bool | None:
        return matches(self.value, self._config.get("onValue"))

    async def async_turn_on(self, **kwargs: Any) -> None:
        await self.async_send({self.definition["commandProperty"]: self._config["onValue"]})

    async def async_turn_off(self, **kwargs: Any) -> None:
        await self.async_send({self.definition["commandProperty"]: self._config["offValue"]})
