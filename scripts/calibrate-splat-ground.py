"""Measure the shared map/analysis datum from reconstructed street patches.

Uses source SOGs, Pillow and numpy. No model positions or horizontal registrations
are changed. Existing street-patch locations are retained; the first two scenes'
patches were selected on opaque, gridded top-down source projections.
Run from any directory: python3 scripts/calibrate-splat-ground.py
"""
import hashlib
import io
import json
from pathlib import Path
import zipfile

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
EVIDENCE = ROOT / "docs/splat-registration"
SPLATS = ROOT / "apps/web/public/splats"
INITIAL = {
    "JAX_068": {
        "reference": {"origin": {"lon": -81.66376054127814, "lat": 30.34881972282938},
                      "modelToMercator": [1.1617442851249093, 0.0004266472952384817, -0.0004266472952384817, 1.1617442851249093], "groundZ": 14},
        "patches": [[200, 10], [-220, -200], [-250, 0]],
    },
    "NYC_004": {
        "reference": {"origin": {"lon": -74.01480690018744, "lat": 40.71530642139432},
                      "modelToMercator": [1.191699539031423, 0.03620725592166198, -0.03620725592166198, 1.191699539031423], "groundZ": -45},
        "patches": [[-200, 0], [120, -50], [150, 0]],
    },
}


def measure(scene, locations):
    source = SPLATS / f"{scene}.sog"
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    with zipfile.ZipFile(source) as archive:
        meta = json.loads(archive.read("meta.json"))
        def image(name):
            return np.asarray(Image.open(io.BytesIO(archive.read(name))).convert("RGBA")).reshape(-1, 4)[:meta["count"]]
        lo, hi = [image(f)[:, :3].astype(np.float64) for f in meta["means"]["files"]]
        fraction = (hi * 256 + lo) / 65535
        value = np.array(meta["means"]["mins"]) * (1 - fraction) + np.array(meta["means"]["maxs"]) * fraction
        positions = np.sign(value) * np.expm1(np.abs(value))
        opaque = image(meta["sh0"]["files"][0])[:, 3] / 255 > 1 / (1 + np.exp(-1))
    samples = []
    for x, y in locations:
        mask = opaque & ((positions[:, 0] - x) ** 2 + (positions[:, 1] - y) ** 2 < 25)
        z = positions[mask, 2]
        if len(z) < 8:
            raise ValueError(f"{scene}: insufficient opaque source points at {(x, y)}")
        samples.append({"modelXY": [x, y], "medianZ": float(np.median(z)), "count": len(z), "radius": 5,
                        "heightFilter": "source SOG opacity > sigmoid(1); finite decoded local Z",
                        "heightQuantiles": dict(zip(["p10", "p25", "p50", "p75", "p90"], np.quantile(z, [.1, .25, .5, .75, .9]).tolist()))})
    return digest, samples


def main():
    datums = {}
    manifest = json.loads((SPLATS / "manifest.json").read_text())
    for asset in manifest["assets"]:
        scene = asset["id"]
        path = EVIDENCE / f"{scene}.json"
        evidence = json.loads(path.read_text())
        reference = evidence.get("georeference", INITIAL.get(scene, {}).get("reference"))
        locations = INITIAL[scene]["patches"] if scene in INITIAL else [s["modelXY"] for s in evidence["groundSamples"]]
        digest, samples = measure(scene, locations)
        assert digest == asset["sha256"], f"{scene}: source differs from integrated asset"
        a, b, c, d = reference["modelToMercator"]
        metres_per_unit = np.sqrt(abs(a * d - b * c)) * np.cos(np.deg2rad(reference["origin"]["lat"]))
        median = float(np.median([s["medianZ"] for s in samples]))
        ground = median - .2 / metres_per_unit
        old = evidence.get("verticalAlignment", {}).get("previousGroundZ", reference["groundZ"])
        evidence["georeference"] = {**reference, "groundZ": ground}
        evidence["groundSamples"] = samples
        evidence["sourceAssetSha256"] = digest
        evidence["groundHeightMethod"] = "Median of opaque source-SOG street-patch medians, less 0.20 ground metres. Shared map, entry camera and urban-analysis datum."
        evidence["verticalAlignment"] = {"previousGroundZ": old, "groundZ": ground, "medianStreetZ": median,
            "clearanceGroundMetres": .2, "groundMetresPerModelUnit": float(metres_per_unit),
            "method": "scripts/calibrate-splat-ground.py", "sourceSha256": digest,
            "limitation": "Representative flat datum, not a terrain model. Local street variation and reconstruction errors remain."}
        path.write_text(json.dumps(evidence, indent=2) + "\n")
        datums[scene] = {"groundZ": ground}
        print(f"{scene}: map Z {old:.3f} -> {ground:.3f}; typical street Z {median:.3f}", flush=True)
    (ROOT / "apps/web/src/data/splatGround.json").write_text(json.dumps(datums, indent=2) + "\n")


if __name__ == "__main__":
    main()
