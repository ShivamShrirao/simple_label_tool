#!/usr/bin/env python3
"""Export label data for completed images into sidecar JSON files.

This utility reads the SQLite database used by the labeling tool, finds every
image whose status is marked as ``done``, and writes the stored ``labels_json``
payload into a ``.json`` file that sits alongside the source image. The JSON
files use the same base name as their corresponding images.
"""

from __future__ import annotations

import argparse
import json
import sqlite3
from pathlib import Path
from typing import Tuple


BASE_DIR = Path(__file__).resolve().parent.parent
DEFAULT_DB_PATH = BASE_DIR / "data" / "labels.db"
DEFAULT_CONFIG_PATH = BASE_DIR / "config.json"


def load_config(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as fh:
        return json.load(fh)


def resolve_image_directory(config: dict) -> Path:
    configured = config.get("image_directory", "images")
    image_dir = Path(configured)
    if not image_dir.is_absolute():
        image_dir = (BASE_DIR / image_dir).resolve()
    image_dir.mkdir(parents=True, exist_ok=True)
    return image_dir


def export_labels(db_path: Path, config_path: Path, overwrite: bool = True) -> Tuple[int, int]:
    if not db_path.exists():
        raise FileNotFoundError(f"Database not found: {db_path}")
    if not config_path.exists():
        raise FileNotFoundError(f"Config not found: {config_path}")

    config = load_config(config_path)
    image_dir = resolve_image_directory(config)

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    exported = 0
    skipped = 0

    try:
        rows = conn.execute(
            """
            SELECT filename, labels_json
            FROM images
            WHERE status = 'done' AND labels_json IS NOT NULL AND labels_json != ''
            """
        ).fetchall()
    finally:
        conn.close()

    for row in rows:
        filename = row["filename"]
        labels_json = row["labels_json"]

        if not labels_json:
            skipped += 1
            continue

        json_rel_path = Path(filename).with_suffix(".json")
        json_path = image_dir / json_rel_path
        json_path.parent.mkdir(parents=True, exist_ok=True)

        if json_path.exists() and not overwrite:
            skipped += 1
            continue

        content = labels_json
        try:
            parsed = json.loads(labels_json)
        except json.JSONDecodeError:
            parsed = None

        with json_path.open("w", encoding="utf-8") as fh:
            if isinstance(parsed, (dict, list)):
                json.dump(parsed, fh, indent=2, sort_keys=True)
                fh.write("\n")
            else:
                fh.write(content)
                if not content.endswith("\n"):
                    fh.write("\n")

        exported += 1

    return exported, skipped


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--db",
        type=Path,
        default=DEFAULT_DB_PATH,
        help=f"Path to the SQLite database (default: {DEFAULT_DB_PATH})",
    )
    parser.add_argument(
        "--config",
        type=Path,
        default=DEFAULT_CONFIG_PATH,
        help=f"Path to the config file (default: {DEFAULT_CONFIG_PATH})",
    )
    parser.add_argument(
        "--skip-existing",
        action="store_true",
        help="Skip exporting if the JSON file already exists.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    exported, skipped = export_labels(args.db, args.config, overwrite=not args.skip_existing)
    print(f"Wrote {exported} file(s).", end="")
    if skipped:
        print(f" Skipped {skipped} row(s).")
    else:
        print()


if __name__ == "__main__":
    main()
