"""
Compact a SQLite DB and gzip it into a deployable seed file.
"""
from __future__ import annotations

import argparse
import gzip
import os
import shutil
import sqlite3
import tempfile
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build videos.db.gz from a SQLite database")
    parser.add_argument("--db", default="videos.db")
    parser.add_argument("--out", default="videos.db.gz")
    return parser.parse_args()


def quote_sqlite_path(path: Path) -> str:
    return "'" + str(path).replace("'", "''") + "'"


def vacuum_copy(source: Path, target: Path) -> None:
    if target.exists():
        target.unlink()
    with sqlite3.connect(source) as connection:
        connection.execute(f"VACUUM INTO {quote_sqlite_path(target)}")


def gzip_copy(source: Path, target: Path) -> None:
    if target.exists():
        target.unlink()
    with open(source, "rb") as raw, gzip.open(target, "wb", compresslevel=9) as compressed:
        shutil.copyfileobj(raw, compressed)


def main() -> None:
    args = parse_args()
    source = Path(args.db).resolve()
    output = Path(args.out).resolve()

    if not source.exists():
        raise SystemExit(f"DB not found: {source}")

    with tempfile.TemporaryDirectory() as temp_dir:
        compact = Path(temp_dir) / "videos.compact.db"
        vacuum_copy(source, compact)
        gzip_copy(compact, output)

    print(f"Seed built: {output} ({os.path.getsize(output):,} bytes)")


if __name__ == "__main__":
    main()
