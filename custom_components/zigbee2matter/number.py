"""Number 플랫폼."""

from __future__ import annotations

from homeassistant.components.number import NumberDeviceClass, NumberEntity

from .entity import Z2MEntity, setup_platform


async def async_setup_entry(hass, entry, async_add_entities) -> None:
    setup_platform(hass, entry, async_add_entities, "number", Z2MNumber)


class Z2MNumber(Z2MEntity, NumberEntity):
    def __init__(self, hub, definition) -> None:
        super().__init__(hub, definition)
        c = self._config
        if "min" in c:
            self._attr_native_min_value = c["min"]
        if "max" in c:
            self._attr_native_max_value = c["max"]
        if "step" in c:
            self._attr_native_step = c["step"]
        self._attr_native_unit_of_measurement = definition.get("unit")
        try:
            self._attr_device_class = NumberDeviceClass(definition["deviceClass"]) if definition.get("deviceClass") else None
        except ValueError:
            self._attr_device_class = None

    @property
    def native_value(self) -> float | None:
        v = self.value
        return v if isinstance(v, (int, float)) else None

    async def async_set_native_value(self, value: float) -> None:
        await self.async_send({self.definition["commandProperty"]: value})
