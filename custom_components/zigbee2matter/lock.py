"""Lock 플랫폼. 잠금/해제는 비멱등 명령으로 취급해 자동 재시도하지 않는다(C3)."""

from __future__ import annotations

from typing import Any

from homeassistant.components.lock import LockEntity

from .entity import Z2MEntity, setup_platform
from .switch import matches


async def async_setup_entry(hass, entry, async_add_entities) -> None:
    setup_platform(hass, entry, async_add_entities, "lock", Z2MLock)


class Z2MLock(Z2MEntity, LockEntity):
    @property
    def is_locked(self) -> bool | None:
        return matches(self.value, self._config.get("lockedValue"))

    async def async_lock(self, **kwargs: Any) -> None:
        await self.async_send({self.definition["commandProperty"]: self._config["lockedValue"]})

    async def async_unlock(self, **kwargs: Any) -> None:
        await self.async_send({self.definition["commandProperty"]: self._config["unlockedValue"]})
