#!/usr/bin/env python3
"""Summarise a viz:mark-turn film as numbers, not as a pose.

Reads `.atoma-mark-turn/frame-*.png` (or --dir) and prints one row per frame
plus a turn-wide summary. Used to judge a lighting change against the previous
capture without leaning on a single screenshot.

  python3 scripts/viz-mark-turn-analyze.py
  python3 scripts/viz-mark-turn-analyze.py --dir .atoma-mark-turn
"""

from __future__ import annotations

import argparse
import json
import math
import statistics
import sys
from pathlib import Path

from PIL import Image


def luminance(r: int, g: int, b: int) -> float:
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def chroma(r: int, g: int, b: int) -> float:
    return abs(r - g) + abs(b - g)


def blob_circularity(mask: list[tuple[int, int]]) -> float:
    """4 pi area / perimeter^2. 1 is a disc; lower is a smear (what refraction does)."""
    if not mask:
        return 0.0
    cells = set(mask)
    area = len(cells)
    perimeter = 0
    for x, y in cells:
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = x + dx, y + dy
            if (nx, ny) not in cells:
                perimeter += 1
    if perimeter == 0:
        return 1.0
    return (4.0 * math.pi * area) / (perimeter * perimeter)


def analyse_frame(path: Path) -> dict[str, float | int | str]:
    image = Image.open(path).convert("RGB")
    width, height = image.size
    pixels = list(image.getdata())
    lums = [luminance(r, g, b) for r, g, b in pixels]
    chromas = [chroma(r, g, b) for r, g, b in pixels]
    peak = max(lums)
    # Crystal vs field: the capture is cropped to the mark, but the corners are
    # still the dark welcome backdrop. A low floor keeps the subject.
    lit = [(i, lum) for i, lum in enumerate(lums) if lum > 12]
    lit_lums = [lum for _, lum in lit] or [0.0]
    lit_chroma = [chromas[i] for i, _ in lit] or [0.0]
    hot_floor = peak * 0.82
    hot = []
    for i, lum in enumerate(lums):
        if lum >= hot_floor and peak >= 40:
            hot.append((i % width, i // width))
    clip = sum(1 for lum in lums if lum >= 254.0)
    return {
        "file": path.name,
        "peak": round(peak, 1),
        "p50": round(statistics.median(lit_lums), 1),
        "p95": round(sorted(lit_lums)[max(0, int(len(lit_lums) * 0.95) - 1)], 1),
        "mean_lit": round(sum(lit_lums) / len(lit_lums), 1),
        "mean_chroma": round(sum(lit_chroma) / len(lit_chroma), 1),
        "hot_px": len(hot),
        "clip_px": clip,
        "hot_circularity": round(blob_circularity(hot), 3),
        "lit_px": len(lit),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--dir",
        default=".atoma-mark-turn",
        help="Directory written by npm run viz:mark-turn",
    )
    args = parser.parse_args()
    folder = Path(args.dir)
    frames = sorted(folder.glob("frame-*.png"))
    if not frames:
        print(f"viz:mark-turn-analyze: no frames in {folder}", file=sys.stderr)
        return 1
    rows = [analyse_frame(path) for path in frames]
    print(
        f"{'file':<16} {'peak':>6} {'p50':>6} {'p95':>6} {'mean':>6} "
        f"{'chroma':>7} {'hot':>6} {'clip':>6} {'circ':>6}"
    )
    for row in rows:
        print(
            f"{row['file']:<16} {row['peak']:6.1f} {row['p50']:6.1f} {row['p95']:6.1f} "
            f"{row['mean_lit']:6.1f} {row['mean_chroma']:7.1f} {row['hot_px']:6d} "
            f"{row['clip_px']:6d} {row['hot_circularity']:6.3f}"
        )
    peaks = [row["peak"] for row in rows]
    circs = [row["hot_circularity"] for row in rows if row["hot_px"] >= 8]
    chromas = [row["mean_chroma"] for row in rows]
    clips = [row["clip_px"] for row in rows]
    summary = {
        "frames": len(rows),
        "peak_min": min(peaks),
        "peak_max": max(peaks),
        "peak_mean": round(sum(peaks) / len(peaks), 1),
        "chroma_mean": round(sum(chromas) / len(chromas), 1),
        "clip_frames": sum(1 for c in clips if c > 0),
        "clip_px_max": max(clips),
        "hot_circularity_mean": round(sum(circs) / len(circs), 3) if circs else 0,
    }
    print("---")
    print(json.dumps(summary, indent=2))
    (folder / "analysis.json").write_text(json.dumps({"summary": summary, "frames": rows}, indent=2) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
