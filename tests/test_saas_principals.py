from __future__ import annotations

import unittest
import uuid

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


if __name__ == "__main__":
    unittest.main()
