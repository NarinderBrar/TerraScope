"""Check streamed fine-level geometry against the registered source SOG frame.

Requires numpy, scipy and OpenCV. Samples 512 positions per chunk, checks
nearest conversion-input positions in 3D, and retains evidence by the provenance.
This checks conversion continuity; the original imagery registration remains the
geographic authority. Run after npm run prepare:skyfall-lods.
"""
import hashlib
import json
import os
from pathlib import Path
import sys
import zipfile

import cv2
import numpy as np
from scipy.spatial import cKDTree

ROOT = Path(__file__).resolve().parents[1]
SPLATS = ROOT / "apps/web/public/splats"
CACHE = Path(os.environ.get("SKYFALL_CACHE_DIR", "/tmp/terrascope-skyfall")) / "lod"


def positions(meta, read):
    images = []
    for file in meta["means"]["files"]:
        image = cv2.imdecode(np.frombuffer(read(file), dtype=np.uint8), cv2.IMREAD_UNCHANGED)
        assert image is not None and image.shape[2] in (3, 4), file
        image = image.reshape(-1, image.shape[2])[:meta["count"]]
        # OpenCV omits the channel when WebP encodes implicit fully opaque alpha.
        if image.shape[1] == 4:
            assert np.all(image[:, 3] == 255), "Position texture alpha must be opaque"
        images.append(image[:, [2, 1, 0]].astype(np.float64))
    t = (images[1] * 256 + images[0]) / 65535
    value = np.array(meta["means"]["mins"]) * (1 - t) + np.array(meta["means"]["maxs"]) * t
    return (np.sign(value) * np.expm1(np.abs(value))).astype(np.float32)


def check(scene):
    directory = SPLATS / "streamed" / scene
    provenance = json.loads((directory / "provenance.json").read_text())
    source = SPLATS / f"{scene}.sog"
    assert hashlib.sha256(source.read_bytes()).hexdigest() == provenance["sourceSha256"]
    with zipfile.ZipFile(source) as archive:
        original = positions(json.loads(archive.read("meta.json")), archive.read)
    index = json.loads((directory / "lod-meta.json").read_text())
    levels = {}
    for level in range(3):
        if level == 0:
            expected = original
        else:
            label = "medium" if level == 1 else "coarse"
            expected = ply_positions(CACHE / f'{scene}-{provenance["sourceSha256"]}-{label}.ply')
        tree = cKDTree(expected)
        distances = []
        counts = 0
        for file in index["filenames"]:
            if not file.startswith(f"{level}_"):
                continue
            path = directory / file
            meta = json.loads(path.read_text())
            points = positions(meta, lambda name: (path.parent / name).read_bytes())
            counts += len(points)
            sample = points[np.linspace(0, len(points) - 1, min(len(points), 512), dtype=np.int64)]
            distances.append(tree.query(sample, workers=1)[0])
        assert counts == len(expected), f"{scene}: LOD {level + 1} count changed"
        distance = np.concatenate(distances)
        maximum = float(distance.max())
        assert maximum < 0.15, f"{scene}: LOD {level + 1} geometry changed coordinate frame ({maximum})"
        levels[str(level + 1)] = {"splats": counts, "sampledPositions": len(distance),
                                "maxNearestInputDistanceModelUnits": maximum,
                                "p99NearestInputDistanceModelUnits": float(np.quantile(distance, 0.99))}
        print(f"{scene} LOD {level + 1}: {len(distance)} positions checked; max displacement {maximum:.6f} model units", flush=True)
        del tree
    fine = levels["1"]
    evidence = {"sourceSha256": provenance["sourceSha256"], "fullDetailSplats": fine["splats"],
                "sampledPositions": fine["sampledPositions"], "maxNearestSourceDistanceModelUnits": fine["maxNearestInputDistanceModelUnits"],
                "p99NearestSourceDistanceModelUnits": fine["p99NearestInputDistanceModelUnits"],
                "thresholdModelUnits": 0.15, "method": "512 uniform positions per chunk; 3D nearest conversion-input position in the registered frame",
                "levels": levels}
    (directory / "alignment.json").write_text(json.dumps(evidence, indent=2) + "\n")


def ply_positions(path):
    with path.open("rb") as file:
        header = []
        while True:
            line = file.readline().decode("ascii").strip()
            header.append(line)
            if line == "end_header":
                break
        assert "format binary_little_endian 1.0" in header
        count = int(next(line for line in header if line.startswith("element vertex ")).split()[-1])
        properties = [line.split() for line in header if line.startswith("property ")]
        assert all(prop[1] == "float" for prop in properties)
        assert [prop[2] for prop in properties[:3]] == ["x", "y", "z"]
        data = np.fromfile(file, dtype="<f4", count=count * len(properties)).reshape(count, len(properties))
        # Both native SOG and these intermediates use the converter's PLY frame.
        return data[:, :3].copy()


if __name__ == "__main__":
    scenes = sys.argv[1:]
    if not scenes:
        scenes = [asset["id"] for asset in json.loads((SPLATS / "manifest.json").read_text())["assets"]]
    for scene in scenes:
        assert scene in [asset["id"] for asset in json.loads((SPLATS / "manifest.json").read_text())["assets"]]
        check(scene)
