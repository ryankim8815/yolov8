"""Package a YOLOv8 detect graph for Chrome. This module performs no model execution."""

from pathlib import Path
import ast
import json
import math
import numpy as np
from .config import ROOT

BUILTIN_ONNX = ROOT / "app/chrome/yolov8n.onnx"
ASSETS = ROOT / ".cache/chrome-runtime"


def model_metadata(path):
    """Read the static input and class order without loading an inference runtime."""
    import onnx

    model = onnx.load(path, load_external_data=False)
    shape = [dim.dim_value for dim in model.graph.input[0].type.tensor_type.shape.dim]
    if len(shape) != 4 or shape[:2] != [1, 3] or shape[2] != shape[3] or shape[2] <= 0:
        raise ValueError("Chrome 모델은 고정 크기 [1, 3, H, H] ONNX 입력이 필요합니다.")
    properties = {prop.key: prop.value for prop in model.metadata_props}
    names = ast.literal_eval(properties.get("names", "{}"))
    names = {int(index): str(name) for index, name in names.items()}
    if not names or sorted(names) != list(range(len(names))):
        raise ValueError("ONNX 클래스 메타데이터를 확인하세요.")
    output = [dim.dim_value for dim in model.graph.output[0].type.tensor_type.shape.dim]
    if len(output) != 3 or output[0] != 1 or output[1] != 4 + len(names):
        raise ValueError("Chrome 모델은 NMS 전 YOLOv8 detect 출력이 필요합니다.")
    return {
        "size": shape[2],
        "classes": [{"id": index, "name": names[index]} for index in sorted(names)],
    }


def tensor_offsets(raw):
    """Locate TensorProto.raw_data by protobuf field, including repeated identical biases."""

    def integer(pos):
        value = 0
        for shift in range(0, 70, 7):
            byte = raw[pos]
            pos += 1
            value |= (byte & 127) << shift
            if byte < 128:
                return value, pos
        raise ValueError("Invalid ONNX varint")

    def fields(start, end):
        pos = start
        while pos < end:
            tag, pos = integer(pos)
            wire = tag & 7
            if wire == 2:
                length, pos = integer(pos)
                yield tag >> 3, pos, pos + length
                pos += length
            elif wire == 0:
                _, pos = integer(pos)
            elif wire in (1, 5):
                pos += 8 if wire == 1 else 4
            else:
                raise ValueError("Invalid ONNX field")
        if pos != end:
            raise ValueError("Invalid ONNX length")

    start, end = next((a, b) for field, a, b in fields(0, len(raw)) if field == 7)
    offsets = {}
    for field, a, b in fields(start, end):
        if field == 5:
            entry = {n: (p, q) for n, p, q in fields(a, b)}
            if 9 in entry:
                offsets[raw[slice(*entry[8])].decode()] = entry[9][0]
    return offsets


def prepare_template(job):
    import onnx
    from onnx import numpy_helper

    model = onnx.load(job["initial_weights"])
    classes = job["dataset"]["classes"]
    count = len(classes)
    rows = (job.get("class_plan") or {}).get("classes")
    source_names = ast.literal_eval(
        next(p.value for p in model.metadata_props if p.key == "names")
    )
    by_name = {name: int(i) for i, name in source_names.items()}
    mapping = (
        [r["source_class_id"] for r in rows]
        if rows
        else [by_name.get(c["name"]) for c in classes]
    )
    rng = np.random.default_rng(42)
    for t in model.graph.initializer:
        if t.name in {
            f"model.22.cv3.{s}.2.{k}" for s in range(3) for k in ("weight", "bias")
        }:
            old = numpy_helper.to_array(t)
            shape = (count, *old.shape[1:])
            new = (
                rng.normal(0, 0.01, shape) if old.ndim == 4 else np.full(shape, -5.0)
            ).astype("float32")
            for target, source in enumerate(mapping):
                if source is not None:
                    new[target] = old[source]
            t.CopyFrom(numpy_helper.from_array(new, t.name))
    for node in model.graph.node:
        if node.name in {
            "/model.22/Constant_3",
            "/model.22/Constant_4",
            "/model.22/Constant_5",
        }:
            node.attribute[0].t.CopyFrom(
                numpy_helper.from_array(np.array([1, count, -1], dtype=np.int64))
            )
    model.graph.output[0].type.tensor_type.shape.dim[1].dim_value = 4 + count
    model.graph.ClearField(
        "value_info"
    )  # Intermediate shapes belong to the previous class mapping.
    for prop in model.metadata_props:
        if prop.key == "names":
            prop.value = repr({c["id"]: c["name"] for c in classes})
    onnx.checker.check_model(model)
    raw = model.SerializeToString()
    offsets = tensor_offsets(raw)
    params = {
        t.name: dict(shape=list(t.dims), offset=offsets[t.name])
        for t in model.graph.initializer
        if t.name.endswith((".weight", ".bias")) and ".dfl." not in t.name
    }
    size = model.graph.input[0].type.tensor_type.shape.dim[2].dim_value
    directory = Path(job["directory"])
    (directory / "template.onnx").write_bytes(raw)
    return dict(params=params, size=size, count=count)


def validate_weights(original, updated, params):
    if len(updated) != len(original):
        raise ValueError("ONNX 크기가 다릅니다.")
    previous = 0
    changed = False
    for p in sorted(params.values(), key=lambda p: p["offset"]):
        start = p["offset"]
        end = start + 4 * math.prod(p["shape"])
        if updated[previous:start] != original[previous:start]:
            raise ValueError("ONNX 그래프가 변경되었습니다.")
        values = np.frombuffer(
            updated, dtype="<f4", count=(end - start) // 4, offset=start
        )
        if not np.isfinite(values).all():
            raise ValueError("유효하지 않은 모델 가중치입니다.")
        changed |= updated[start:end] != original[start:end]
        previous = end
    if updated[previous:] != original[previous:] or not changed:
        raise ValueError("학습된 가중치를 확인할 수 없습니다.")
