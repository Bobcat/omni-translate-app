"""Principals and the anonymous-identity token.

Every API request resolves exactly one principal; every document, job and
usage event has exactly one owner. The anonymous id is only ever accepted in
a signed token we issued ourselves — a raw unsigned id from a client means
nothing. Signing is stdlib HMAC-SHA256; the identity row (status, expiry)
lives in the store, so the token itself carries no claims to expire.
"""
from __future__ import annotations

import hashlib
import hmac
import secrets
import uuid
from dataclasses import dataclass
from typing import Literal


@dataclass(frozen=True)
class Principal:
    tenant: str
    kind: Literal["user", "anonymous"]
    id: uuid.UUID
    plan_code: str


def new_identity_id() -> uuid.UUID:
    return uuid.uuid4()


def generate_secret() -> str:
    return secrets.token_urlsafe(32)


def sign_identity(identity_id: uuid.UUID, secret: str) -> str:
    """Return the opaque token for ``identity_id``: ``<id>.<hmac>``."""
    digest = hmac.new(
        secret.encode("utf-8"), str(identity_id).encode("ascii"), hashlib.sha256
    ).hexdigest()
    return f"{identity_id}.{digest}"


def verify_identity_token(token: str, secret: str) -> uuid.UUID | None:
    """Return the identity id from a validly signed token, else ``None``."""
    text = str(token or "").strip()
    if "." not in text:
        return None
    raw_id, _, signature = text.partition(".")
    try:
        identity_id = uuid.UUID(raw_id)
    except ValueError:
        return None
    expected = sign_identity(identity_id, secret).partition(".")[2]
    if not hmac.compare_digest(signature, expected):
        return None
    return identity_id
