import tempfile
import unittest
from pathlib import Path

import numpy as np

try:
    import onnx
    from onnx import numpy_helper
except ImportError:
    onnx = None

from app.chrome_model import (
    BUILTIN_ONNX,
    model_metadata,
    prepare_template,
    validate_weights,
)


@unittest.skipUnless(onnx, "Install requirements-chrome.txt for ONNX packaging tests")
class ChromeModelTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.job = {
            "initial_weights": str(BUILTIN_ONNX),
            "directory": self.directory.name,
            "dataset": {
                "classes": [{"id": 0, "name": "zebra"}, {"id": 1, "name": "새 상품"}]
            },
            "class_plan": {
                "classes": [{"source_class_id": 22}, {"source_class_id": None}]
            },
        }

    def test_bad_configured_model_remains_recoverable_through_the_server(self):
        from app.config import Settings
        from app.pipeline import Pipeline
        from app.runtime import Runtime

        for corrupt in (False, True):
            with self.subTest(corrupt=corrupt), tempfile.TemporaryDirectory() as state:
                path = Path(state) / "invalid.onnx"
                if corrupt:
                    path.write_bytes(b"invalid model")
                settings = Settings(
                    backend="chrome", model_path=path, camera_autostart=False
                )
                runtime = Runtime(settings, Pipeline, state)
                try:
                    pipeline = runtime._new_pipeline(
                        settings, runtime.model_id, camera=False
                    )
                    self.assertEqual(pipeline.status()["state"], "error")
                    self.assertFalse(pipeline.model_ready)
                finally:
                    runtime.stop()

    def test_template_preserves_retained_class_and_has_raw_detector_shape(self):
        config = prepare_template(self.job)
        path = Path(self.directory.name) / "template.onnx"
        metadata = model_metadata(path)
        self.assertEqual(
            metadata, {"size": 640, "classes": self.job["dataset"]["classes"]}
        )
        original = {
            t.name: numpy_helper.to_array(t)
            for t in onnx.load(BUILTIN_ONNX).graph.initializer
        }
        adapted = {
            t.name: numpy_helper.to_array(t) for t in onnx.load(path).graph.initializer
        }
        for stride in range(3):
            name = f"model.22.cv3.{stride}.2.weight"
            np.testing.assert_array_equal(adapted[name][0], original[name][22])
            self.assertEqual(adapted[name].shape[0], 2)
        raw = path.read_bytes()
        for name, parameter in config["params"].items():
            count = int(np.prod(parameter["shape"]))
            values = np.frombuffer(
                raw, dtype="<f4", count=count, offset=parameter["offset"]
            )
            np.testing.assert_array_equal(
                values.reshape(parameter["shape"]), adapted[name]
            )

    def test_checkpoint_accepts_weights_and_rejects_graph_changes_nan_and_no_training(
        self,
    ):
        config = prepare_template(self.job)
        original = (Path(self.directory.name) / "template.onnx").read_bytes()
        parameter = next(iter(config["params"].values()))
        updated = bytearray(original)
        offset = parameter["offset"]
        value = np.frombuffer(original, dtype="<f4", count=1, offset=offset)[0]
        updated[offset : offset + 4] = np.float32(value + 0.001).tobytes()
        validate_weights(original, updated, config["params"])
        for invalid in (original, updated[:-1]):
            with self.assertRaises(ValueError):
                validate_weights(original, invalid, config["params"])
        updated[0] ^= 1
        with self.assertRaises(ValueError):
            validate_weights(original, updated, config["params"])
        updated[0] ^= 1
        updated[offset : offset + 4] = np.float32(np.nan).tobytes()
        with self.assertRaises(ValueError):
            validate_weights(original, updated, config["params"])


if __name__ == "__main__":
    unittest.main()
