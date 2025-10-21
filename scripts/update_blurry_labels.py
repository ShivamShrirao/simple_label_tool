#!/usr/bin/env python3
"""Utility to rename existing labels in the SQLite database.

This script replaces the phrase "blurry image" with "pixelated, low res"
inside the `labels_json` field for every row in the `images` table. It keeps
all other labels untouched and leaves rows without the old phrase unchanged.

Usage:
    python scripts/update_blurry_labels.py [--db data/labels.db]
"""

from __future__ import annotations

import argparse
import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path


OLD_VALUE = "blurry image"
NEW_VALUE = "pixelated, low res"


def utc_timestamp() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def update_labels(db_path: Path) -> int:
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    updated_rows = 0

    try:
        cursor = conn.execute(
            "SELECT id, labels_json FROM images WHERE labels_json LIKE ?",
            (f"%{OLD_VALUE}%",),
        )

        rows = cursor.fetchall()
        for row in rows:
            raw = row["labels_json"]
            if not raw:
                continue

            try:
                payload = json.loads(raw)
            except json.JSONDecodeError:
                continue

            if not isinstance(payload, dict):
                continue

            changed = False
            for category, labels in payload.items():
                if not isinstance(labels, list):
                    continue

                new_labels = [NEW_VALUE if label == OLD_VALUE else label for label in labels]
                if new_labels != labels:
                    payload[category] = new_labels
                    changed = True

            if not changed:
                continue

            conn.execute(
                "UPDATE images SET labels_json = ?, updated_at = ? WHERE id = ?",
                (json.dumps(payload, sort_keys=True), utc_timestamp(), row["id"]),
            )
            updated_rows += 1

        conn.commit()
    finally:
        conn.close()

    return updated_rows


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--db",
        type=Path,
        default=Path("data/labels.db"),
        help="Path to the SQLite database (default: data/labels.db)",
    )
    args = parser.parse_args()

    if not args.db.exists():
        raise SystemExit(f"Database not found: {args.db}")

    updated = update_labels(args.db)
    print(f"Updated {updated} row(s).")


if __name__ == "__main__":
    main()
