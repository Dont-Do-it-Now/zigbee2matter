"""Sensor 플랫폼."""

from __future__ import annotations

from homeassistant.components.sensor import SensorDeviceClass, SensorEntity, SensorStateClass

from .entity import Z2MEntity, setup_platform


async def async_setup_entry(hass, entry, async_add_entities) -> None:
    setup_platform(hass, entry, async_add_entities, "sensor", Z2MSensor)


def _enum(cls, value):
    try:
        return cls(value) if value else None
    except ValueError:
        return None


class Z2MSensor(Z2MEntity, SensorEntity):
    def __init__(self, hub, definition) -> None:
        super().__init__(hub, definition)
        self._attr_device_class = _enum(SensorDeviceClass, definition.get("deviceClass"))
        self._attr_state_class = _enum(SensorStateClass, definition.get("stateClass"))
        self._attr_native_unit_of_measurement = definition.get("unit")

    @property
    def native_value(self):
        v = self.value
        if isinstance(v, (dict, list)):
            return None
        return v
