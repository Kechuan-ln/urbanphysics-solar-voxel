"""Materialize browser color volumes from the published lossless Kowloon tiles.

Display bytes encode a transfer function. The matching section bundle remains
the source for numeric queries, including original flags and float values.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import struct
import subprocess
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np

DEPTH = 24
CAPS = {"scatter": 60.0, "reflection": 30.0}
ASSET_LIMIT = 310_000_000


def encode(values, flags, cap):
    if np.any((flags != 0) & ~np.isfinite(values)):
        raise ValueError("non-finite known radiance")
    unit = np.sqrt(np.clip(np.where(flags, values, 0) / cap, 0, 1))
    return np.where(flags, 2 + np.rint(253 * unit), 1).astype("u1")


def mean(values, flags):
    n = np.count_nonzero(flags, axis=1)
    total = np.sum(np.where(flags, values, 0), axis=1, dtype="f8")
    return np.divide(total, n, out=np.zeros_like(total), where=n != 0), n


def write_gzip(path, data):
    packed = gzip.compress(data, compresslevel=4, mtime=0)
    path.write_bytes(packed)
    return len(packed)


def read_tile(folder, meta):
    b = gzip.decompress((folder / "base.bin.gz").read_bytes())
    n = struct.unpack_from("<I", b)[0]
    bins = meta["bins"]
    slot_bytes = n * (bins // 8 + bins + 1)
    start = 4 + 16 * n
    if len(b) != start + len(meta["hours"]) * slot_bytes:
        raise ValueError(f"base tile bytes differ: {folder.name}")
    points = np.frombuffer(b, dtype="<f4", count=n * 4, offset=4).reshape(n, 4)
    for i, hour in enumerate(meta["hours"]):
        offset = start + i * slot_bytes
        mask = np.frombuffer(b, dtype="u1", count=n * bins // 8, offset=offset)
        seen = np.unpackbits(mask, bitorder="little").reshape(n, bins)
        offset += len(mask)
        sf = np.frombuffer(b, dtype="u1", count=n * bins, offset=offset).reshape(n, bins)
        direct = np.frombuffer(b, dtype="u1", count=n, offset=offset + n * bins)
        raw = gzip.decompress((folder / f"reflection-{hour}.bin.gz").read_bytes())
        if len(raw) != n * bins * 5:
            raise ValueError(f"reflection tile bytes differ: {folder.name}, {hour}")
        lanes = np.frombuffer(raw, dtype="u1", count=n * bins * 4).reshape(4, -1)
        reflected = np.ascontiguousarray(lanes.T).view("<f4").reshape(bins, n).T
        rf = np.frombuffer(raw, dtype="u1", count=n * bins, offset=n * bins * 4).reshape(n, bins)
        sky = seen * np.asarray(meta["scatter"][i], dtype="<f4")
        yield points, i, direct, sky, sf, reflected, rf


def export(source, output, workers):
    started = time.monotonic()
    meta = json.loads((source / "index.json").read_text())
    if (
        meta["format"] != "kowloon-section-tiles-v1"
        or meta["size"] != 200
        or meta["bins"] != 128
        or meta["hours"] != [4111, 4118, 4119]
    ):
        raise ValueError("use the published June 21 full-resolution section bundle")
    side = meta["size"]
    bins = meta["bins"]
    hours = meta["hours"]
    size = side * side * DEPTH
    step = meta["step"]
    ground = np.zeros(side * side, dtype="<f4")
    admitted = np.zeros(size, dtype=bool)
    columns = np.zeros(side * side, dtype=bool)
    direct = np.zeros((len(hours), size), dtype="u1")
    colors = np.zeros((len(hours), 2, bins + 1, size), dtype="u1")
    found = sorted((source / "tiles").iterdir())
    for j, folder in enumerate(found, 1):
        for pts, slot, state, sc, sf, ref, rf in read_tile(folder, meta):
            xy = np.rint((pts[:, :2] - meta["origin"]) / step).astype("i4")
            level = np.rint((pts[:, 3] - 2.5) / step).astype("i4")
            col = xy[:, 1] * side + xy[:, 0]
            ids = level * (side * side) + col
            if np.any(xy < 0) or np.any(xy >= side) or np.any(level < 0) or np.any(level >= DEPTH):
                raise ValueError(f"coordinate outside native grid: {folder.name}")
            if slot == 0:
                if np.any(admitted[ids]) or len(np.unique(ids)) != len(ids):
                    raise ValueError(f"duplicate native voxel: {folder.name}")
                admitted[ids] = True
                columns[col] = True
                ground[col] = pts[:, 2] - pts[:, 3]
            direct[slot, ids] = np.where(state & 3, np.where(state & 4, 255, 2), 1)
            for k, (name, values, flags) in enumerate(
                (
                    ("scatter", sc, sf),
                    ("reflection", ref, rf),
                )
            ):
                cap = CAPS[name]
                colors[slot, k, :bins, ids] = encode(values, flags, cap)
                average, count = mean(values, flags)
                colors[slot, k, bins, ids] = encode(average, count, cap)
        if j % 200 == 0:
            print(
                json.dumps({"tiles": j, "seconds": round(time.monotonic() - started, 1)}),
                flush=True,
            )
    if np.count_nonzero(admitted) != meta["voxels"]:
        raise ValueError("color volumes and native voxel inventory differ")

    bundle = output / "bundle"
    bundle.mkdir(parents=True, exist_ok=True)
    total = write_gzip(bundle / "ground.bin.gz", ground.tobytes())
    for i, hour in enumerate(hours):
        total += write_gzip(bundle / f"direct-{hour}.bin.gz", direct[i].tobytes())
    with ThreadPoolExecutor(max_workers=workers) as pool:
        for i, hour in enumerate(hours):
            for k, name in enumerate(CAPS):

                def write_bin(d):
                    direction = "mean" if d == bins else str(d)
                    return write_gzip(
                        bundle / f"{name}-{hour}-{direction}.bin.gz", colors[i, k, d].tobytes()
                    )

                total += sum(pool.map(write_bin, range(bins + 1)))
                print(
                    json.dumps(
                        {
                            "hour": hour,
                            "component": name,
                            "bytes": total,
                            "seconds": round(time.monotonic() - started, 1),
                        }
                    ),
                    flush=True,
                )
    info = {
        "format": "kowloon-render-volume-v1",
        "sourceCommit": meta["sourceCommit"],
        "hours": hours,
        "size": side,
        "levels": DEPTH,
        "origin": meta["origin"] - step / 2,
        "step": step,
        "boundsZ": [float(ground[columns].min()), float(ground[columns].max() + DEPTH * step)],
        "caps": CAPS,
        "voxels": meta["voxels"],
        "bytes": total,
    }
    (bundle / "index.json").write_text(json.dumps(info, separators=(",", ":")) + "\n")
    pending = output / "kowloon-volume.pending.tar"
    target = output / "kowloon-volume.tar"
    subprocess.run(["tar", "--sort=name", "-C", str(bundle), "-cf", str(pending), "."], check=True)
    if pending.stat().st_size > ASSET_LIMIT:
        raise ValueError(f"volume pack exceeds the Pages budget: {pending.stat().st_size}")
    digest = hashlib.sha256()
    with pending.open("rb") as stream:
        for block in iter(lambda: stream.read(8 * 1024 * 1024), b""):
            digest.update(block)
    pending.replace(target)
    report = {
        "bytes": target.stat().st_size,
        "sha256": digest.hexdigest(),
        **{"voxels": info["voxels"], "seconds": round(time.monotonic() - started, 1)},
    }
    (output / "pack.json").write_text(json.dumps(report) + "\n")
    print(json.dumps(report), flush=True)


if __name__ == "__main__":
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("sections", type=Path)
    cli.add_argument("output", type=Path)
    cli.add_argument("--workers", type=int, default=6)
    args = cli.parse_args()
    export(args.sections, args.output, args.workers)
