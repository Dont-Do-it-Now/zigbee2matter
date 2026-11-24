"""Cover 플랫폼."""

from __future__ import annotations

from typing import Any

from homeassistant.components.cover import ATTR_POSITION, CoverEntity, CoverEntityFeature

from .entity import Z2MEntity, setup_platform


async def async_setup_entry(hass, entry, async_add_entities) -> None:
    setup_platform(hass, entry, async_add_entities, "cover", Z2MCover)


class Z2MCover(Z2MEntity, CoverEntity):
    def __init__(self, hub, definition) -> None:
        super().__init__(hub, definition)
        feats = CoverEntityFeature.OPEN | CoverEntityFeature.CLOSE | CoverEntityFeature.STOP
        if self._config.get("positionProperty"):
            feats |= CoverEntityFeature.SET_POSITION
        self._attr_supported_features = feats

    @property
    def current_cover_position(self) -> int | None:
        p = self.raw(self._config.get("positionProperty"))
        return int(p) if isinstance(p, (int, float)) else None

    @property
    def is_closed(self) -> bool | None:
        p = self.current_cover_position
        if p is not None:
            return p == 0
        v = self.value
        return None if v is None else str(v).upper() == "CLOSE"

    async def async_open_cover(self, **kwargs: Any) -> None:
        await self.async_send({self.definition["commandProperty"]: self._config["openValue"]})

    async def async_close_cover(self, **kwargs: Any) -> None:
        await self.async_send({self.definition["commandProperty"]: self._config["closeValue"]})

    async def async_stop_cover(self, **kwargs: Any) -> None:
        await self.async_send({self.definition["commandProperty"]: self._config["stopValue"]})

    async def async_set_cover_position(self, **kwargs: Any) -> None:
        await self.async_send({self._config["positionProperty"]: kwargs[ATTR_POSITION]})
