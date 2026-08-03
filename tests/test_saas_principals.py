from __future__ import annotations

import unittest
import uuid
from pathlib import Path
from tempfile import TemporaryDirectory

from app.saas_setup import _load_or_create_signing_secret
from saas.principals import sign_identity, verify_identity_token

SECRET = "test-secret"
OTHER_SECRET = "other-secret"


class PrincipalTokenTests(unittest.TestCase):
    def test_roundtrip(self) -> None:
        identity_id = uuid.uuid4()
        token = sign_identity(identity_id, SECRET)
        self.assertEqual(verify_identity_token(token, SECRET), identity_id)

    def test_tampered_signature_rejected(self) -> None:
        identity_id = uuid.uuid4()
        token = sign_identity(identity_id, SECRET)
        tampered = token[:-1] + ("0" if token[-1] != "0" else "1")
        self.assertIsNone(verify_identity_token(tampered, SECRET))

    def test_tampered_id_rejected(self) -> None:
        token = sign_identity(uuid.uuid4(), SECRET)
        forged = f"{uuid.uuid4()}.{token.partition('.')[2]}"
        self.assertIsNone(verify_identity_token(forged, SECRET))

    def test_wrong_secret_rejected(self) -> None:
        token = sign_identity(uuid.uuid4(), SECRET)
        self.assertIsNone(verify_identity_token(token, OTHER_SECRET))

    def test_garbage_rejected(self) -> None:
        for token in ("", "not-a-token", "abc.", ".def", str(uuid.uuid4())):
            self.assertIsNone(verify_identity_token(token, SECRET))

    def test_generated_host_secret_survives_new_app_context(self) -> None:
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "saas-signing.key"
            first = _load_or_create_signing_secret(path)
            second = _load_or_create_signing_secret(path)
        self.assertEqual(first, second)
        self.assertGreaterEqual(len(first), 32)


if __name__ == "__main__":
    unittest.main()
