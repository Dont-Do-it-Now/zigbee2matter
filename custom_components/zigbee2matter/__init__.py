"""Zigbee2Matter HA 통합 (HA Direct / Hybrid, T049/T051)."""

from __future__ import annotations

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ConfigEntryAuthFailed, ConfigEntryNotReady
from homeassistant.helpers import entity_registry as er

from .const import (
    CONF_MODE,
    CONF_SSL,
    CONF_TOKEN,
    CONF_VERIFY_SSL,
    MODE_DIRECT,
    PLATFORMS,
)
from .hub import AuthError, CannotConnect, Zigbee2MatterHub

type Zigbee2MatterConfigEntry = ConfigEntry[Zigbee2MatterHub]


async def async_setup_entry(hass: HomeAssistant, entry: Zigbee2MatterConfigEntry) -> bool:
    data = entry.data
    mode = entry.options.get(CONF_MODE, data.get(CONF_MODE, MODE_DIRECT))
    hub = Zigbee2MatterHub(
        hass,
        entry.entry_id,
        data["host"],
        data["port"],
        data[CONF_TOKEN],
        data.get(CONF_SSL, False),
        data.get(CONF_VERIFY_SSL, True),
        mode,
    )
    try:
        await hub.async_refresh_inventory()
    except AuthError as err:
        raise ConfigEntryAuthFailed from err
    except CannotConnect as err:
        raise ConfigEntryNotReady(str(err)) from err

    # Hybrid: HA Matter 통합이 노출하는 엔티티와 중복되는 기존 등록분만 정리한다(그 외는 사용자 정책 존중).
    registry = er.async_get(hass)
    hidden = {d["uniqueId"] for d in hub.hidden}
    for reg in er.async_entries_for_config_entry(registry, entry.entry_id):
        if reg.unique_id in hidden:
            registry.async_remove(reg.entity_id)

    entry.runtime_data = hub
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    hub.start(entry)
    entry.async_on_unload(entry.add_update_listener(_reload))
    return True


async def _reload(hass: HomeAssistant, entry: Zigbee2MatterConfigEntry) -> None:
    await hass.config_entries.async_reload(entry.entry_id)


async def async_unload_entry(hass: HomeAssistant, entry: Zigbee2MatterConfigEntry) -> bool:
    ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if ok:
        await entry.runtime_data.async_stop()
    return ok
