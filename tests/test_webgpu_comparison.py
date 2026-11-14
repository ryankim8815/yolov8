import copy
import unittest

from scripts.compare_webgpu import agreement, compare


class WebgpuComparisonTests(unittest.TestCase):
    def test_matching_is_one_to_one_and_class_aware(self):
        box = dict(class_id=0, confidence=.9, xyxy=[0, 0, 10, 10])
        result = agreement({"image": [box, box]}, {"image": [box, {**box, "class_id": 1}]})
        self.assertEqual(result["matched"], 1)
        self.assertEqual(result["unmatched_reference"], 1)
        self.assertEqual(result["unmatched_candidate"], 1)

    def test_comparison_rejects_different_model_inputs_or_counts(self):
        record = dict(source_sha256="weights", settings={"imgsz": 640}, image_hashes={"a": "hash"},
                      iterations=256, warmup=30, repeats=3, predictions={"a": []})
        for key, value in [("source_sha256", "other"), ("settings", {"imgsz": 320}),
                           ("image_hashes", {"a": "other"}), ("iterations", 1),
                           ("warmup", 0), ("repeats", 1)]:
            records = {name: copy.deepcopy(record) for name in ["mps", "coreml", "webgpu"]}
            records["webgpu"][key] = value
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, key):
                compare(records)


if __name__ == "__main__":
    unittest.main()
