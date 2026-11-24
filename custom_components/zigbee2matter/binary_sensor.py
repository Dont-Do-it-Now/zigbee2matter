"""Binary sensor 플랫폼."""

from __future__ import annotations

from homeassistant.components.binary_sensor import BinarySensorDeviceClass, BinarySensorEntity

from .entity import Z2MEntity, setup_platform
from .switch import matches


async def async_setup_entry(hass, entry, async_add_entities) -> None:
    setup_platform(hass, entry, async_add_entities, "binary_sensor", Z2MBinarySensor)


class Z2MBinarySensor(Z2MEntity, BinarySensorEntity):
    def __init__(self, hub, definition) -> None:
        super().__init__(hub, definition)
        try:
            self._attr_device_class = BinarySensorDeviceClass(definition["deviceClass"]) if definition.get("deviceClass") else None
        except ValueError:
            self._attr_device_class = None

    @property
    def is_on(self) -> bool | None:
        return matches(self.value, self._config.get("onValue"))
