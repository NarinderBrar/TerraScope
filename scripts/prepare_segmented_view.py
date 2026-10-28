"""Pack verified LangSplat category fields into registered, nearest-sampled class IDs.

Run with ../.venv-langsplat/bin/python scripts/prepare_segmented_view.py.
This preserves the source atlas layout and never modifies geometry or registration.
"""
import argparse
import hashlib
import json
from pathlib import Path

import numpy as np

CATEGORIES = [('buildings', 'building'), ('vegetation', 'vegetation'),
              ('roads', 'road'), ('vehicles', 'vehicle'), ('air-conditioning', 'air-conditioning')]


def classify(fields, minimum=6):
    """Strongest supported category wins; stable ties prefer the earlier category."""
    labels = np.zeros_like(fields[0], dtype=np.uint8)
    best = np.full_like(labels, minimum - 1)
    for index, field in enumerate(fields, 1):
        wins = field > best
        labels[wins] = index
        best[wins] = field[wins]
    return labels


def main():
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=root.parent / 'Ref/LangSplat/output/semantic_categories_v1')
    args = parser.parse_args()
    report = json.loads((args.source / 'batch-report.json').read_text())
    if report['status'] != 'complete' or report.get('failed'):
        raise ValueError('Category extraction must complete before publishing')
    hashes = json.loads((root / 'apps/web/src/data/splatSourceHashes.json').read_text())
    output = root / 'apps/web/public/semantics'
    for scene, source_hash in hashes.items():
        if scene not in report['completed']:
            raise ValueError(f'{scene}: missing completed scene')
        fields, inputs, reference = [], [], None
        for category, stem in CATEGORIES:
            path = args.source / scene / f'{scene}-{stem}-glow.json'
            meta = json.loads(path.read_text())
            if (meta['scene'] != scene or meta['category'] != category
                    or meta['coordinateFrame'] != 'registered-model-local'
                    or meta['sourceSha256'] != source_hash
                    or meta['asset'] != f'{scene}-{stem}-glow.bin'):
                raise ValueError(f'{path}: source or category mismatch')
            if reference is None:
                reference = meta
            for key in ['boundsMin', 'boundsMax', 'gridSize', 'atlasSize', 'byteLength']:
                if meta[key] != reference[key]:
                    raise ValueError(f'{path}: inconsistent {key}')
            if meta['gridSize'] != [512, 512, 64] or meta['atlasSize'] != [4096, 4096] or meta['byteLength'] != 512 * 512 * 64:
                raise ValueError(f'{path}: unexpected atlas dimensions')
            if meta['nonzeroVoxels'] == 0 and meta['status'] == 'no-evidence':
                field = np.zeros(meta['byteLength'], dtype=np.uint8)
            else:
                data = (path.parent / meta['asset']).read_bytes()
                if len(data) != meta['byteLength'] or hashlib.sha256(data).hexdigest() != meta['assetSha256']:
                    raise ValueError(f'{path}: invalid binary')
                field = np.frombuffer(data, dtype=np.uint8)
            fields.append(field)
            inputs.append({'id': len(fields), 'category': category,
                           'sourceAssetSha256': meta['assetSha256'],
                           'metadataSha256': hashlib.sha256(path.read_bytes()).hexdigest()})
        labels = classify(fields)
        data = labels.tobytes()
        for item in inputs:
            item['voxels'] = int(np.count_nonzero(labels == item['id']))
        asset = f'{scene}-segments.bin'
        metadata = {key: reference[key] for key in ['scene', 'coordinateFrame', 'sourceSha256', 'boundsMin', 'boundsMax', 'gridSize', 'atlasSize', 'byteLength', 'minimumLocalZ']}
        metadata.update(schemaVersion=1, kind='langsplat-segmented-view', asset=asset,
                        assetSha256=hashlib.sha256(data).hexdigest(), classes=inputs,
                        minimumWeight=6, classification='strongest-category; stable ties in class ID order',
                        limitations='Experimental similarity classifications. Small objects may be unresolved.')
        for name, payload in [(asset, data), (f'{scene}-segments.json', (json.dumps(metadata, indent=2) + '\n').encode())]:
            part = output / (name + '.part')
            part.write_bytes(payload)
            part.replace(output / name)
        print(scene, {item['category']: item['voxels'] for item in inputs}, flush=True)


if __name__ == '__main__':
    main()
