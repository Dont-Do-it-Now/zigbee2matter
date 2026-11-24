"""Button 플랫폼."""

from __future__ import annotations

from homeassistant.components.button import ButtonEntity

from .entity import Z2MEntity, setup_platform


async def async_setup_entry(hass, entry, async_add_entities) -> None:
    setup_platform(hass, entry, async_add_entities, "button", Z2MButton)


class Z2MButton(Z2MEntity, ButtonEntity):
    async def async_press(self) -> None:
        await self.async_send({self.definition["commandProperty"]: self._config["pressValue"]})
