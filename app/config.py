from __future__ import annotations

import json
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[1]
SETTINGS_PATH = REPO_ROOT / "config" / "settings.json"
LOCAL_SETTINGS_PATH = REPO_ROOT / "config" / "local.json"


def _load_json_object(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    raw = path.read_text(encoding="utf-8")
    if raw.strip() == "":
        return {}
    payload = json.loads(raw)
    return dict(payload) if isinstance(payload, dict) else {}


def _merge(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    merged = dict(base)
    for key, value in override.items():
        existing = merged.get(key)
        if isinstance(existing, dict) and isinstance(value, dict):
            merged[key] = _merge(existing, value)
        else:
            merged[key] = value
    return merged


def load_settings() -> dict[str, Any]:
    return _merge(_load_json_object(SETTINGS_PATH), _load_json_object(LOCAL_SETTINGS_PATH))


SETTINGS = load_settings()


def get_setting(path: str, default: Any = None) -> Any:
    cur: Any = SETTINGS
    for part in str(path).split("."):
        if not isinstance(cur, dict) or part not in cur:
            return default
        cur = cur[part]
    return cur


def get_bool(path: str, default: bool = False) -> bool:
    return bool(get_setting(path, default))


def get_float(path: str, default: float = 0.0, *, min_value: float | None = None) -> float:
    value = float(get_setting(path, default))
    if min_value is not None:
        value = max(float(min_value), value)
    return value


def get_int(path: str, default: int = 0, *, min_value: int | None = None) -> int:
    value = int(get_setting(path, default))
    if min_value is not None:
        value = max(int(min_value), value)
    return value


def get_str(path: str, default: str = "") -> str:
    return str(get_setting(path, default) or "")


def optional_str(path: str) -> str | None:
    value = get_setting(path, None)
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def rooted_path(path: str) -> str:
    p = str(path or "").strip()
    if not p.startswith("/"):
        p = "/" + p
    root_path = get_str("service.root_path", "").rstrip("/")
    if root_path in {"", "/"}:
        return p
    return root_path + p

