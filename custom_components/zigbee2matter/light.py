"""Light 플랫폼."""

from __future__ import annotations

from typing import Any

from homeassistant.components.light import (
    ATTR_BRIGHTNESS,
    ATTR_COLOR_TEMP_KELVIN,
    ATTR_HS_COLOR,
    ATTR_XY_COLOR,
    ColorMode,
    LightEntity,
)

from .entity import Z2MEntity, setup_platform

_MODES = {"xy": ColorMode.XY, "hs": ColorMode.HS, "color_temp": ColorMode.COLOR_TEMP, "brightness": ColorMode.BRIGHTNESS}


async def async_setup_entry(hass, entry, async_add_entities) -> None:
    setup_platform(hass, entry, async_add_entities, "light", Z2MLight)


class Z2MLight(Z2MEntity, LightEntity):
    def __init__(self, hub, definition) -> None:
        super().__init__(hub, definition)
        modes = {_MODES[m] for m in self._config.get("colorModes", []) if m in _MODES}
        if len(modes) > 1:
            modes.discard(ColorMode.BRIGHTNESS)
        if not self._config.get("brightness") and modes == {ColorMode.BRIGHTNESS}:
            modes = {ColorMode.ONOFF}
        self._attr_supported_color_modes = modes or {ColorMode.ONOFF}
        if ColorMode.COLOR_TEMP in modes:
            if self._config.get("maxMireds"):
                self._attr_min_color_temp_kelvin = int(1_000_000 / self._config["maxMireds"])
            if self._config.get("minMireds"):
                self._attr_max_color_temp_kelvin = int(1_000_000 / self._config["minMireds"])

    @property
    def is_on(self) -> bool | None:
        v = self.value
        return None if v is None else str(v).upper() == str(self._config.get("onValue", "ON")).upper()

    @property
    def color_mode(self) -> ColorMode:
        mode = _MODES.get(str(self.raw("color_mode")))
        if mode in self._attr_supported_color_modes:
            return mode
        return next(iter(self._attr_supported_color_modes))

    @property
    def brightness(self) -> int | None:
        b = self.raw("brightness")
        return None if not isinstance(b, (int, float)) else min(255, round(b * 255 / 254))

    @property
    def color_temp_kelvin(self) -> int | None:
        m = self.raw("color_temp")
        return int(1_000_000 / m) if isinstance(m, (int, float)) and m > 0 else None

    @property
    def xy_color(self) -> tuple[float, float] | None:
        c = self.raw("color")
        return (c["x"], c["y"]) if isinstance(c, dict) and "x" in c and "y" in c else None

    @property
    def hs_color(self) -> tuple[float, float] | None:
        c = self.raw("color")
        return (c["hue"], c["saturation"]) if isinstance(c, dict) and "hue" in c and "saturation" in c else None

    async def async_turn_on(self, **kwargs: Any) -> None:
        payload: dict[str, Any] = {self.definition["commandProperty"]: self._config.get("onValue", "ON")}
        if ATTR_BRIGHTNESS in kwargs:
            payload["brightness"] = round(kwargs[ATTR_BRIGHTNESS] * 254 / 255)
        if ATTR_COLOR_TEMP_KELVIN in kwargs:
            payload["color_temp"] = round(1_000_000 / kwargs[ATTR_COLOR_TEMP_KELVIN])
        if ATTR_XY_COLOR in kwargs:
            x, y = kwargs[ATTR_XY_COLOR]
            payload["color"] = {"x": x, "y": y}
        if ATTR_HS_COLOR in kwargs:
            h, s = kwargs[ATTR_HS_COLOR]
            payload["color"] = {"hue": h, "saturation": s}
        await self.async_send(payload)

    async def async_turn_off(self, **kwargs: Any) -> None:
        await self.async_send({self.definition["commandProperty"]: self._config.get("offValue", "OFF")})
