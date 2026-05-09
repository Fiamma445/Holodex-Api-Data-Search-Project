"""
Build or refresh the base HoloSearch SQLite DB for all selectable talents.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import sys
from pathlib import Path
from typing import Any

import httpx

ROOT = Path(__file__).resolve().parents[1]
FRONTEND_ROOT = ROOT / "public"
API_BASE = "https://holodex.net/api/v2"
VIDEO_LIMIT = 50
PROGRESS_VERSION = 1

EXCLUDED_GROUP_TOKENS = ("HOLOSTARS",)
EXCLUDED_NAME_TOKENS = ("OFFICIAL", "CARD GAME", "MIDNIGHT GRAND ORCHESTRA")

EXTRA_CHANNELS = [
    {"id": "UCrV1Hf5r8P148idjoSfrGEQ", "name": "Yuuki Sakuna"},
    {"id": "UCLIpj4TmXviSTNE_U5WG_Ug", "name": "Kurageu Roa"},
    {"id": "UCt30jJgChL8qeT9VPadidSw", "name": "Shigure Ui"},
    {"id": "UClS3cnIUM9yzsBPQzeyX_8Q", "name": "Amagai Ruka"},
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Sync every selectable talent into videos.db")
    parser.add_argument("--api-key", default=os.environ.get("HOLODEX_API_KEY", ""))
    parser.add_argument("--db", default=os.environ.get("DB_PATH", str(ROOT / "videos.db")))
    parser.add_argument("--channels", help="Optional JSON file with [{id,name}] seed targets")
    parser.add_argument("--progress", default=str(ROOT / ".seed_sync_progress.json"))
    parser.add_argument("--sleep", type=float, default=0.15)
    parser.add_argument("--max-pages", type=int, default=0)
    parser.add_argument("--page-log-interval", type=int, default=1)
    parser.add_argument("--only", nargs="*", default=[])
    parser.add_argument("--filters", choices=["both", "uploads", "mentions"], default="both")
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--list-targets", action="store_true")
    return parser.parse_args()


def import_database(db_path: str):
    os.environ["DB_PATH"] = db_path
    sys.path.insert(0, str(ROOT))
    import database as db

    return db


def normalize_channel(item: dict[str, Any]) -> dict[str, str] | None:
    channel_id = item.get("id")
    if not channel_id:
        return None
    name = item.get("english_name") or item.get("englishName") or item.get("name") or channel_id
    return {"id": channel_id, "name": name}


def unescape_js_string(value: str) -> str:
    return value.replace("\\'", "'").replace('\\"', '"').replace("\\\\", "\\")


def is_seed_candidate(channel: dict[str, Any]) -> bool:
    group = f"{channel.get('group') or ''} {channel.get('suborg') or ''}".upper()
    name = f"{channel.get('name') or ''} {channel.get('english_name') or ''}".upper()
    if channel.get("org") != "Hololive" or channel.get("type") != "vtuber":
        return False
    if any(token in group for token in EXCLUDED_GROUP_TOKENS):
        return False
    return not any(token in name for token in EXCLUDED_NAME_TOKENS)


def load_json_channels(path: Path, apply_hololive_filter: bool) -> list[dict[str, str]]:
    if not path.exists():
        return []
    data = json.loads(path.read_text(encoding="utf-8-sig"))
    items = data if isinstance(data, list) else data.get("channels", [])
    if apply_hololive_filter:
        items = [item for item in items if is_seed_candidate(item)]
    return [normalized for item in items if (normalized := normalize_channel(item))]


def parse_js_channels(path: Path) -> list[dict[str, str]]:
    if not path.exists():
        return []
    text = path.read_text(encoding="utf-8", errors="ignore")
    pattern = re.compile(r"name:\s*(['\"])((?:\\.|(?!\1).)+)\1[^{}]+?id:\s*['\"](UC[-\w]{22})['\"]")
    return [
        {"id": channel_id, "name": unescape_js_string(name)}
        for _, name, channel_id in pattern.findall(text)
    ]


def parse_generation_channels(path: Path) -> list[dict[str, str]]:
    if not path.exists():
        return []
    text = path.read_text(encoding="utf-8", errors="ignore")
    start = text.find("function renderGenerationList")
    end = text.find("const toKorean", start)
    if start == -1 or end == -1:
        return []
    pattern = re.compile(r"name:\s*(['\"])((?:\\.|(?!\1).)+)\1[^{}]+?id:\s*['\"](UC[-\w]{22})['\"]")
    return [
        {"id": channel_id, "name": unescape_js_string(name)}
        for _, name, channel_id in pattern.findall(text[start:end])
    ]


def parse_allowed_indie_channels(path: Path) -> list[dict[str, str]]:
    if not path.exists():
        return []
    text = path.read_text(encoding="utf-8", errors="ignore")
    start = text.find("const ALLOWED_INDIE_CHANNELS")
    end = text.find("];", start)
    if start == -1 or end == -1:
        return []
    block = text[start:end]
    pattern = re.compile(r"id:\s*['\"](UC[-\w]{22})['\"][^{}]+?english_name:\s*['\"]([^'\"]+)['\"]")
    return [{"id": channel_id, "name": name} for channel_id, name in pattern.findall(block)]


def unique_channels(channels: list[dict[str, str]]) -> list[dict[str, str]]:
    by_id: dict[str, dict[str, str]] = {}
    for channel in channels:
        if channel["id"] not in by_id or by_id[channel["id"]]["name"].startswith("UC"):
            by_id[channel["id"]] = channel
    return sorted(by_id.values(), key=lambda item: item["name"].casefold())


def load_seed_targets(channels_path: str | None) -> list[dict[str, str]]:
    if channels_path:
        return unique_channels(load_json_channels(Path(channels_path), False))

    channels = parse_generation_channels(FRONTEND_ROOT / "app.js")
    channels += parse_js_channels(FRONTEND_ROOT / "src" / "data" / "channels.js")
    channels += load_json_channels(ROOT / "channels.json", True)
    channels += load_json_channels(ROOT / "channels2.json", True)
    channels += parse_allowed_indie_channels(FRONTEND_ROOT / "api.js")
    channels += EXTRA_CHANNELS
    return unique_channels(channels)


def load_progress(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"version": PROGRESS_VERSION, "done": []}
    data = json.loads(path.read_text(encoding="utf-8"))
    if data.get("version") != PROGRESS_VERSION:
        return {"version": PROGRESS_VERSION, "done": []}
    return data


def save_progress(path: Path, progress: dict[str, Any]) -> None:
    path.write_text(json.dumps(progress, ensure_ascii=False, indent=2), encoding="utf-8")


async def fetch_video_page(
    client: httpx.AsyncClient,
    api_key: str,
    filter_name: str,
    channel_id: str,
    offset: int,
) -> list[dict[str, Any]]:
    params = {
        filter_name: channel_id,
        "status": "past,missing",
        "type": "stream",
        "limit": VIDEO_LIMIT,
        "offset": offset,
        "sort": "available_at",
        "order": "desc",
        "include": "mentions,songs",
    }
    headers = {"X-APIKEY": api_key} if api_key else {}

    for attempt in range(8):
        response = await client.get(f"{API_BASE}/videos", params=params, headers=headers)
        if response.status_code != 429:
            response.raise_for_status()
            return response.json()
        retry_after = response.headers.get("retry-after")
        delay = int(retry_after) if retry_after and retry_after.isdigit() else min(90, 2 ** attempt)
        await asyncio.sleep(delay)
    response.raise_for_status()
    return []


async def sync_query(client, db, args, channel, filter_name: str, label: str) -> int:
    offset = 0
    total_saved = 0
    page_count = 0

    while True:
        videos = await fetch_video_page(client, args.api_key, filter_name, channel["id"], offset)
        if not videos:
            break

        saved = 0 if args.dry_run else db.insert_videos_transaction(videos)
        total_saved += saved
        page_count += 1
        if args.page_log_interval > 0 and page_count % args.page_log_interval == 0:
            print(f"{channel['name']} · {label} offset={offset} fetched={len(videos)} saved={saved}")

        offset += len(videos)
        if len(videos) < VIDEO_LIMIT or (args.max_pages and page_count >= args.max_pages):
            break
        await asyncio.sleep(args.sleep)

    return total_saved


def wanted_filters(value: str) -> list[tuple[str, str]]:
    if value == "uploads":
        return [("channel_id", "uploads")]
    if value == "mentions":
        return [("mentioned_channel_id", "mentions")]
    return [("channel_id", "uploads"), ("mentioned_channel_id", "mentions")]


async def sync_targets(db, args, targets: list[dict[str, str]]) -> None:
    progress_path = Path(args.progress)
    progress = load_progress(progress_path)
    done = set(progress.get("done", []))
    timeout = httpx.Timeout(30.0)

    async with httpx.AsyncClient(timeout=timeout) as client:
        for index, channel in enumerate(targets, start=1):
            print(f"[{index}/{len(targets)}] {channel['name']} ({channel['id']})")
            for filter_name, label in wanted_filters(args.filters):
                key = f"{filter_name}:{channel['id']}"
                if key in done and not args.force:
                    print(f"{channel['name']} · {label} skipped")
                    continue
                try:
                    await sync_query(client, db, args, channel, filter_name, label)
                except Exception as error:
                    print(f"{channel['name']} · {label} failed: {error}")
                    continue
                if not args.dry_run:
                    done.add(key)
                    progress["done"] = sorted(done)
                    save_progress(progress_path, progress)


def filter_targets(targets: list[dict[str, str]], only: list[str]) -> list[dict[str, str]]:
    if not only:
        return targets
    needles = {item.casefold() for item in only}
    return [
        target for target in targets
        if target["id"].casefold() in needles or target["name"].casefold() in needles
    ]


def main() -> None:
    args = parse_args()
    targets = filter_targets(load_seed_targets(args.channels), args.only)
    if not targets:
        raise SystemExit("No seed targets found")

    if args.list_targets:
        for target in targets:
            print(f"{target['id']}\t{target['name']}")
        print(f"Seed targets: {len(targets)} channels")
        return

    if not args.api_key:
        raise SystemExit("HOLODEX_API_KEY is required for Holodex video sync")

    db = None if args.dry_run else import_database(args.db)
    if db is not None:
        db.init_db()

    print(f"Seed targets: {len(targets)} channels")
    print(f"DB path: {args.db}")
    asyncio.run(sync_targets(db, args, targets))


if __name__ == "__main__":
    main()
