"""Select 플랫폼."""

from __future__ import annotations

from homeassistant.components.select import SelectEntity

from .entity import Z2MEntity, setup_platform


async def async_setup_entry(hass, entry, async_add_entities) -> None:
    setup_platform(hass, entry, async_add_entities, "select", Z2MSelect)


class Z2MSelect(Z2MEntity, SelectEntity):
    def __init__(self, hub, definition) -> None:
        super().__init__(hub, definition)
        self._attr_options = [str(o) for o in self._config.get("options", [])]

    @property
    def current_option(self) -> str | None:
        v = self.value
        return str(v) if v is not None and str(v) in self._attr_options else None

    async def async_select_option(self, option: str) -> None:
        await self.async_send({self.definition["commandProperty"]: option})
