from __future__ import annotations

import unittest

from app.operation_ids import operation_payload_hash


class OperationPayloadHashTests(unittest.TestCase):
    def test_mapping_order_does_not_change_hash(self) -> None:
        first = operation_payload_hash(
            "image_translation",
            content=b"image",
            parameters={"source": "auto", "target": "en"},
        )
        second = operation_payload_hash(
            "image_translation",
            content=b"image",
            parameters={"target": "en", "source": "auto"},
        )

        self.assertEqual(first, second)

    def test_content_and_translation_inputs_change_hash(self) -> None:
        base = operation_payload_hash(
            "image_translation",
            content=b"image-a",
            parameters={"target": "en"},
        )
        changed_content = operation_payload_hash(
            "image_translation",
            content=b"image-b",
            parameters={"target": "en"},
        )
        changed_target = operation_payload_hash(
            "image_translation",
            content=b"image-a",
            parameters={"target": "de"},
        )

        self.assertNotEqual(base, changed_content)
        self.assertNotEqual(base, changed_target)


if __name__ == "__main__":
    unittest.main()
