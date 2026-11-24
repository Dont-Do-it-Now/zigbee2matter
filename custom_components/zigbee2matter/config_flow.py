"""Config flow: 호스트/포트/토큰 입력 + 연결 검증."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

import voluptuous as vol
from homeassistant.config_entries import ConfigFlow, ConfigFlowResult, OptionsFlow
from homeassistant.const import CONF_HOST, CONF_PORT
from homeassistant.core import callback
from homeassistant.helpers.selector import (
    SelectSelector,
    SelectSelectorConfig,
    SelectSelectorMode,
)

from .const import (
    CONF_MODE,
    CONF_SSL,
    CONF_TOKEN,
    CONF_VERIFY_SSL,
    DEFAULT_PORT,
    DOMAIN,
    MODE_DIRECT,
    MODES,
)
from .hub import AuthError, CannotConnect, Zigbee2MatterHub

_MODE_SELECTOR = SelectSelector(
    SelectSelectorConfig(options=MODES, mode=SelectSelectorMode.DROPDOWN, translation_key="mode")
)


async def _validate(hass, data: Mapping[str, Any]) -> None:
    hub = Zigbee2MatterHub(
        hass, "validate", data[CONF_HOST], data[CONF_PORT], data[CONF_TOKEN],
        data.get(CONF_SSL, False), data.get(CONF_VERIFY_SSL, True), MODE_DIRECT,
    )
    await hub.async_fetch_devices()


class Zigbee2MatterConfigFlow(ConfigFlow, domain=DOMAIN):
    VERSION = 1

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        errors: dict[str, str] = {}
        if user_input is not None:
            await self.async_set_unique_id(f"{user_input[CONF_HOST]}:{user_input[CONF_PORT]}")
            self._abort_if_unique_id_configured()
            try:
                await _validate(self.hass, user_input)
            except AuthError:
                errors["base"] = "invalid_auth"
            except CannotConnect:
                errors["base"] = "cannot_connect"
            else:
                return self.async_create_entry(title=f"Zigbee2Matter ({user_input[CONF_HOST]})", data=user_input)

        schema = vol.Schema(
            {
                vol.Required(CONF_HOST): str,
                vol.Required(CONF_PORT, default=DEFAULT_PORT): int,
                vol.Required(CONF_TOKEN): str,
                vol.Required(CONF_SSL, default=False): bool,
                vol.Required(CONF_VERIFY_SSL, default=True): bool,
                vol.Required(CONF_MODE, default=MODE_DIRECT): _MODE_SELECTOR,
            }
        )
        return self.async_show_form(
            step_id="user", data_schema=self.add_suggested_values_to_schema(schema, user_input), errors=errors
        )

    async def async_step_reauth(self, entry_data: Mapping[str, Any]) -> ConfigFlowResult:
        return await self.async_step_reauth_confirm()

    async def async_step_reauth_confirm(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        errors: dict[str, str] = {}
        entry = self._get_reauth_entry()
        if user_input is not None:
            data = {**entry.data, CONF_TOKEN: user_input[CONF_TOKEN]}
            try:
                await _validate(self.hass, data)
            except AuthError:
                errors["base"] = "invalid_auth"
            except CannotConnect:
                errors["base"] = "cannot_connect"
            else:
                return self.async_update_reload_and_abort(entry, data=data)
        return self.async_show_form(
            step_id="reauth_confirm", data_schema=vol.Schema({vol.Required(CONF_TOKEN): str}), errors=errors
        )

    @staticmethod
    @callback
    def async_get_options_flow(config_entry) -> OptionsFlow:
        return Zigbee2MatterOptionsFlow()


class Zigbee2MatterOptionsFlow(OptionsFlow):
    async def async_step_init(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        if user_input is not None:
            return self.async_create_entry(data=user_input)
        current = self.config_entry.options.get(CONF_MODE, self.config_entry.data.get(CONF_MODE, MODE_DIRECT))
        return self.async_show_form(
            step_id="init",
            data_schema=vol.Schema({vol.Required(CONF_MODE, default=current): _MODE_SELECTOR}),
        )
