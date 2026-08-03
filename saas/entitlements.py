"""Entitlement resolution.

Application code asks the resolved set, never the plan name — the plan is
metadata, not the authorization mechanism. Missing keys fail safe: a feature
that is not explicitly enabled is not enabled, and reading a missing numeric
limit is an error, never an implicit zero or unlimited.

Config-backed initially; the service interface stays stable so storage can
move to Postgres (plan_entitlements table) without touching callers.
"""
from __future__ import annotations

from typing import Any, Mapping

from saas.errors import ENTITLEMENT_DISABLED, ENTITLEMENT_UNKNOWN, SaasError
from saas.principals import Principal


class EntitlementSet:
    """The resolved entitlement values for one principal."""

    def __init__(self, plan_code: str, values: Mapping[str, Any]) -> None:
        self.plan_code = plan_code
        self._values = dict(values)

    def has(self, key: str) -> bool:
        return key in self._values

    def is_enabled(self, key: str) -> bool:
        return bool(self._values.get(key, False))

    def require_enabled(self, key: str) -> None:
        if not self.is_enabled(key):
            raise SaasError(
                ENTITLEMENT_DISABLED,
                f"entitlement not enabled: {key}",
                status_code=403,
                details={"entitlement": key, "plan": self.plan_code},
            )

    def get_int(self, key: str, default: int | None = None) -> int:
        value = self._values.get(key, default)
        if value is None:
            raise SaasError(
                ENTITLEMENT_UNKNOWN,
                f"entitlement not configured: {key}",
                status_code=500,
                details={"entitlement": key, "plan": self.plan_code},
            )
        return int(value)

    def get_str(self, key: str, default: str = "") -> str:
        return str(self._values.get(key, default) or "")

    def snapshot(self) -> dict[str, Any]:
        """A copy, e.g. to persist with a job so config changes mid-run
        cannot create inconsistent decisions."""
        return dict(self._values)


class EntitlementService:
    """Resolves principals to entitlement sets."""

    def __init__(self, plans: Mapping[str, Mapping[str, Any]]) -> None:
        self._plans = {str(code): dict(values) for code, values in plans.items()}

    def resolve(self, principal: Principal) -> EntitlementSet:
        # Unknown plan → empty set: everything fails closed.
        return EntitlementSet(principal.plan_code, self._plans.get(principal.plan_code, {}))

    @staticmethod
    def flatten(config: Mapping[str, Any], *, prefix: str = "") -> dict[str, Any]:
        """Nested config to dotted keys: ``{"image_translation": {"enabled":
        true}}`` becomes ``{"image_translation.enabled": true}``. Dict values
        are treated as nesting, not as values — config-backed plans have no
        dict-valued entitlements."""
        flat: dict[str, Any] = {}
        for key, value in config.items():
            dotted = f"{prefix}.{key}" if prefix else str(key)
            if isinstance(value, Mapping):
                flat.update(EntitlementService.flatten(value, prefix=dotted))
            else:
                flat[dotted] = value
        return flat
