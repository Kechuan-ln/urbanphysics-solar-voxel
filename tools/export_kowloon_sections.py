"""Export the three published hours into shared 25 m tiles without tracing rays.

Run next to the frozen annual viewer so the original coordinate and flag rules
also apply to this export. New writes go only to the provided staging folder.
"""

from __future__ import annotations

import argparse
import gzip
import json
import struct
import sys
import time
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np

HOURS = (4111, 4118, 4119)
BINS = 128
SIDE = 200
TILE = 5


def atomic(path, data):
    pending = path.with_suffix(path.suffix + ".pending")
    pending.write_bytes(data)
    pending.replace(path)


def write_tile(path, points, arrays):
    """Values are bit-exact. Gzip sees the four byte lanes of reflection separately."""
    path.mkdir(exist_ok=True)
    scatter, reflection, direct, scatter_flag, reflection_flag, direct_flag = arrays
    parts = [struct.pack("<I", len(points)), points.astype("<f4", copy=False).tobytes()]
    for i, hour in enumerate(HOURS):
        parts.append(np.packbits(scatter[i] != 0, bitorder="little").tobytes())
        parts.append(scatter_flag[i].tobytes())
        parts.append((direct_flag[i] | ((direct[i] > 0).astype("u1") << 2)).tobytes())
        data = np.ascontiguousarray(reflection[i].T, dtype="<f4")
        bytes_by_lane = data.view("u1").reshape(-1, 4).T.tobytes()
        raw = bytes_by_lane + reflection_flag[i].tobytes()
        atomic(path / f"reflection-{hour}.bin.gz", gzip.compress(raw, compresslevel=4, mtime=0))
    atomic(path / "base.bin.gz", gzip.compress(b"".join(parts), compresslevel=5, mtime=0))


def read_band(store, y, reader, pool):
    selection = list(HOURS)
    tasks, points, x_index, count = [], [], [], 0
    for positions, xy, files in store.parts:
        ids = np.flatnonzero(xy[:, 1] // TILE == y)
        points.append(positions[ids])
        x_index.append(xy[ids, 0])
        chunk_ids = ids // store.chunk_points
        boundaries = np.r_[0, np.flatnonzero(np.diff(chunk_ids)) + 1, len(ids)]
        for begin, end in zip(boundaries[:-1], boundaries[1:], strict=True):
            if begin == end:
                continue
            span = ids[begin:end]
            tasks.append(
                (
                    files[chunk_ids[begin]],
                    span % store.chunk_points,
                    slice(count + begin, count + end),
                    positions[span, :3],
                    store.timestamps[selection],
                    store.dni[selection],
                    store.commit,
                    selection,
                )
            )
        count += len(ids)
    arrays = tuple(
        np.empty((len(HOURS), count, BINS) if directional else (len(HOURS), count), dtype=dtype)
        for directional, dtype in (
            (True, "<f4"),
            (True, "<f4"),
            (False, "<f8"),
            (True, "u1"),
            (True, "u1"),
            (False, "u1"),
        )
    )
    for offset, fields in pool.map(reader, tasks, chunksize=6):
        for staging, field in zip(arrays, fields, strict=True):
            staging[:, offset] = field
    return np.concatenate(points), np.concatenate(x_index), arrays


def export(args):
    sys.path.insert(0, str(args.reader))
    from hk_1km_viewer import AnnualStore, read_day_part

    start = time.monotonic()
    store = AnnualStore(args.annual)
    if store.commit != args.commit or len(store.directions) != BINS:
        raise ValueError("wrong annual run or direction layout")
    if [int(store.timestamps[h]) for h in HOURS] != [1655766000, 1655791200, 1655794800]:
        raise ValueError("expected the published 2022-06-21 Hong Kong hours")
    tiles = args.output / "bundle/tiles"
    tiles.mkdir(parents=True, exist_ok=True)
    table = np.zeros((len(HOURS), BINS), dtype="<f4")
    exported = 0

    with ProcessPoolExecutor(max_workers=args.workers) as pool:
        for y in range(SIDE // TILE):
            row_path = args.output / f"row-{y:02}.json"
            if row_path.exists():
                row = json.loads(row_path.read_text())
            else:
                points, x_index, arrays = read_band(store, y, read_day_part, pool)
                sky = arrays[0]
                cap = sky.max(axis=1, initial=0)
                if np.any((sky != 0) & (sky != cap[:, None, :])):
                    raise ValueError(f"scatter is not a single radiance per direction at row {y}")
                for x in range(SIDE // TILE):
                    ids = np.flatnonzero(x_index // TILE == x)
                    write_tile(tiles / f"{x:02}-{y:02}", points[ids], [a[:, ids] for a in arrays])
                row = {"voxels": len(points), "scatter": cap.tolist()}
                atomic(row_path, json.dumps(row).encode())
            cap = np.asarray(row["scatter"], dtype="<f4")
            if np.any((table != 0) & (cap != 0) & (cap != table)):
                raise ValueError(f"inconsistent scatter directions at row {y}")
            np.maximum(table, cap, out=table)
            exported += row["voxels"]
            print(
                json.dumps(
                    {
                        "row": y + 1,
                        "rows": SIDE // TILE,
                        "voxels": exported,
                        "seconds": round(time.monotonic() - start, 1),
                    }
                ),
                flush=True,
            )

    if exported != store.total_points:
        raise ValueError("native voxel inventory is incomplete")
    manifest = {
        "format": "kowloon-section-tiles-v1",
        "sourceCommit": store.commit,
        "hours": HOURS,
        "bins": BINS,
        "size": SIDE,
        "step": 5,
        "origin": -497.5,
        "tileSize": TILE,
        "voxels": exported,
        "scatter": table.tolist(),
        "sun": [{"direction": (-store.sun[h]).tolist(), "dni": float(store.dni[h])} for h in HOURS],
    }
    atomic(args.output / "bundle/index.json", json.dumps(manifest, separators=(",", ":")).encode())
    print(json.dumps({"complete": True, "voxels": exported}), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("annual", type=Path)
    parser.add_argument("reader", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("commit")
    parser.add_argument("--workers", type=int, default=6)
    export(parser.parse_args())
