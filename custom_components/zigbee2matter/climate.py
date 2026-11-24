"""Climate 플랫폼."""

from __future__ import annotations

from typing import Any

from homeassistant.components.climate import (
    ClimateEntity,
    ClimateEntityFeature,
    HVACAction,
    HVACMode,
)
from homeassistant.const import ATTR_TEMPERATURE, UnitOfTemperature

from .entity import Z2MEntity, setup_platform

_ACTIONS = {"idle": HVACAction.IDLE, "heat": HVACAction.HEATING, "cool": HVACAction.COOLING, "fan_only": HVACAction.FAN}


async def async_setup_entry(hass, entry, async_add_entities) -> None:
    setup_platform(hass, entry, async_add_entities, "climate", Z2MClimate)


class Z2MClimate(Z2MEntity, ClimateEntity):
    _attr_temperature_unit = UnitOfTemperature.CELSIUS
    _enable_turn_on_off_backwards_compatibility = False

    def __init__(self, hub, definition) -> None:
        super().__init__(hub, definition)
        c = self._config
        self._attr_min_temp = c.get("minTemp", 7)
        self._attr_max_temp = c.get("maxTemp", 35)
        self._attr_target_temperature_step = c.get("step")
        modes = []
        for m in c.get("modes") or []:
            try:
                modes.append(HVACMode(m))
            except ValueError:
                continue
        self._attr_hvac_modes = modes
        feats = ClimateEntityFeature(0)
        if c.get("heatingSetpointProperty"):
            feats |= ClimateEntityFeature.TARGET_TEMPERATURE
        if HVACMode.OFF in modes and len(modes) > 1:
            feats |= ClimateEntityFeature.TURN_ON | ClimateEntityFeature.TURN_OFF
        self._attr_supported_features = feats

    @property
    def current_temperature(self) -> float | None:
        v = self.raw(self._config.get("currentTemperatureProperty"))
        return v if isinstance(v, (int, float)) else None

    @property
    def target_temperature(self) -> float | None:
        v = self.raw(self._config.get("heatingSetpointProperty"))
        return v if isinstance(v, (int, float)) else None

    @property
    def hvac_mode(self) -> HVACMode | None:
        try:
            return HVACMode(self.raw(self._config.get("modeProperty")))
        except ValueError:
            return None

    @property
    def hvac_action(self) -> HVACAction | None:
        return _ACTIONS.get(str(self.raw(self._config.get("runningStateProperty"))))

    async def async_set_temperature(self, **kwargs: Any) -> None:
        if ATTR_TEMPERATURE in kwargs:
            await self.async_send({self._config["heatingSetpointProperty"]: kwargs[ATTR_TEMPERATURE]})

    async def async_set_hvac_mode(self, hvac_mode: HVACMode) -> None:
        await self.async_send({self._config["modeProperty"]: hvac_mode.value})
