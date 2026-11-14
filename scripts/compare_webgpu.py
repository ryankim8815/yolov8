"""Validate matching benchmark inputs and report timing + detection agreement."""
import argparse
import json
from pathlib import Path

from app.config import ROOT
from scripts.common import write_json


def iou(a, b):
    intersection = max(0, min(a[2], b[2]) - max(a[0], b[0])) * max(0, min(a[3], b[3]) - max(a[1], b[1]))
    area = lambda box: max(0, box[2] - box[0]) * max(0, box[3] - box[1])
    return intersection / (area(a) + area(b) - intersection + 1e-7)


def agreement(reference, candidate, threshold=.9):
    matched, missing, extra, overlaps, score_errors = 0, 0, 0, [], []
    examples = []
    for name, targets in reference.items():
        guesses = candidate[name]
        used = set()
        image_missing = 0
        for box in sorted(targets, key=lambda b: -b["confidence"]):
            options = [(iou(box["xyxy"], guess["xyxy"]), index) for index, guess in enumerate(guesses)
                       if index not in used and box["class_id"] == guess["class_id"]]
            overlap, index = max(options, default=(0, -1))
            if overlap >= threshold:
                used.add(index)
                matched += 1
                overlaps.append(overlap)
                score_errors.append(abs(box["confidence"] - guesses[index]["confidence"]))
            else:
                image_missing += 1
        missing += image_missing
        image_extra = len(guesses) - len(used)
        extra += image_extra
        if image_missing or image_extra:
            examples.append(dict(image=name, unmatched_reference=image_missing, unmatched_candidate=image_extra))
    return dict(iou_threshold=threshold, matched=matched, unmatched_reference=missing, unmatched_candidate=extra,
                reference_recall=matched / (matched + missing) if matched + missing else 1,
                candidate_precision=matched / (matched + extra) if matched + extra else 1,
                mean_matched_iou=sum(overlaps) / len(overlaps) if overlaps else None,
                mean_abs_confidence_difference=sum(score_errors) / len(score_errors) if score_errors else None,
                examples=examples[:20], note="Prediction agreement with MPS, not ground-truth accuracy or mAP.")


def compare(records):
    reference = records["mps"]
    keys = ["source_sha256", "settings", "image_hashes", "iterations", "warmup", "repeats"]
    for backend, record in records.items():
        for key in keys:
            if record[key] != reference[key]:
                raise ValueError(f"Cannot compare {backend}: {key} differs")
        if set(record["predictions"]) != set(reference["predictions"]):
            raise ValueError(f"Cannot compare {backend}: prediction image set differs")
    return {"timings": {k: {"pooled": v["predict_ms"], "rounds": [r["predict_ms"] for r in v["rounds"]], "load_ms": v["load_ms"]} for k, v in records.items()},
            "webgpu_mean_latency_ratio": {k: records["webgpu"]["predict_ms"]["mean"] / records[k]["predict_ms"]["mean"] for k in ("mps", "coreml")},
            "agreement_with_mps": {k: agreement(reference["predictions"], records[k]["predictions"]) for k in ("webgpu", "coreml")},
            "settings": reference["settings"], "images": len(reference["predictions"]), "source_sha256": reference["source_sha256"],
            "iterations_per_round": reference["iterations"], "warmup_per_round": reference["warmup"], "repeats": reference["repeats"]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, default=ROOT / "artifacts/webgpu-poc")
    args = parser.parse_args()
    records = {name: json.loads((args.directory / f"{name}.json").read_text()) for name in ("webgpu", "mps", "coreml")}
    result = compare(records)
    write_json(args.directory / "comparison.json", result)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
