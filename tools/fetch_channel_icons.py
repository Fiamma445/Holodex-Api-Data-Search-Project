"""
선택 가능한 탤런트와 로컬 DB에 쌓인 채널 아이콘을 정적 파일로 내려받는다.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sqlite3
import sys
from pathlib import Path
from typing import Any

import httpx

ROOT = Path(__file__).resolve().parents[1]
FRONTEND_ROOT = ROOT / "public"
ICON_DIRS = [FRONTEND_ROOT / "channel-icons"]
CHANNEL_INDEX_PATHS = [FRONTEND_ROOT / "channel-index.json"]
DEFAULT_DB_PATH = ROOT / "videos.db"
CONCURRENCY = 12

INDIE_CHANNEL_IDS = {
    "UCrV1Hf5r8P148idjoSfrGEQ",
    "UCLIpj4TmXviSTNE_U5WG_Ug",
    "UCt30jJgChL8qeT9VPadidSw",
    "UClS3cnIUM9yzsBPQzeyX_8Q",
}
ENGLISH_NAME_OVERRIDES = {
    "UCrV1Hf5r8P148idjoSfrGEQ": "Yuuki Sakuna",
    "UCLIpj4TmXviSTNE_U5WG_Ug": "Kurageu Roa",
    "UCt30jJgChL8qeT9VPadidSw": "Shigure Ui",
    "UClS3cnIUM9yzsBPQzeyX_8Q": "Amagai Ruka",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Download channel icons for local use")
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--only", nargs="*", default=[])
    parser.add_argument("--db", default=os.environ.get("DB_PATH", str(DEFAULT_DB_PATH)))
    parser.add_argument("--seed-only", action="store_true")
    return parser.parse_args()


def normalize_channel(channel_id: str | None, name: str | None = "", photo: str | None = "", org: str | None = ""):
    if not channel_id or not channel_id.startswith("UC"):
        return None

    display_name = (name or ENGLISH_NAME_OVERRIDES.get(channel_id) or channel_id).strip()
    return {
        "id": channel_id,
        "name": display_name,
        "englishName": ENGLISH_NAME_OVERRIDES.get(channel_id, display_name),
        "photo": photo or "",
        "org": org or ("Indie" if channel_id in INDIE_CHANNEL_IDS else "Hololive"),
    }


def remember_channel(channels: dict[str, dict[str, str]], item: dict[str, str] | None) -> None:
    if not item:
        return

    current = channels.get(item["id"])
    if not current:
        channels[item["id"]] = item
        return

    channels[item["id"]] = {
        **current,
        "name": current["name"] if not current["name"].startswith("UC") else item["name"],
        "englishName": current["englishName"] if not current["englishName"].startswith("UC") else item["englishName"],
        "photo": current["photo"] or item["photo"],
        "org": current["org"] or item["org"],
    }


def load_seed_targets() -> dict[str, dict[str, str]]:
    sys.path.insert(0, str(ROOT))
    from tools.sync_seed_db import load_seed_targets as load_targets

    channels: dict[str, dict[str, str]] = {}
    for target in load_targets(None):
        remember_channel(channels, normalize_channel(target["id"], target["name"]))
    return channels


def load_db_targets(db_path: Path) -> dict[str, dict[str, str]]:
    channels: dict[str, dict[str, str]] = {}
    if not db_path.exists():
        return channels

    with sqlite3.connect(db_path) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            "SELECT channel_id, channel_name, json_data FROM videos WHERE json_data IS NOT NULL"
        ).fetchall()

    for row in rows:
        try:
            data: dict[str, Any] = json.loads(row["json_data"] or "{}")
        except (TypeError, json.JSONDecodeError):
            data = {}

        channel = data.get("channel") or {}
        remember_channel(
            channels,
            normalize_channel(
                row["channel_id"] or channel.get("id"),
                row["channel_name"] or channel.get("name") or channel.get("english_name"),
                channel.get("photo") or "",
                channel.get("org") or "",
            ),
        )

        for member in data.get("mentions") or []:
            if not isinstance(member, dict):
                continue
            remember_channel(
                channels,
                normalize_channel(
                    member.get("id"),
                    member.get("name") or member.get("english_name"),
                    member.get("photo") or "",
                    member.get("org") or "",
                ),
            )

    return channels


def load_targets(args: argparse.Namespace) -> list[dict[str, str]]:
    channels = load_seed_targets()
    if not args.seed_only:
        for item in load_db_targets(Path(args.db)).values():
            remember_channel(channels, item)

    targets = sorted(channels.values(), key=lambda item: item["name"].casefold())
    if not args.only:
        return targets

    needles = {item.casefold() for item in args.only}
    return [
        target for target in targets
        if target["id"].casefold() in needles or target["name"].casefold() in needles
    ]


async def download_icon(client: httpx.AsyncClient, channel_id: str, force: bool) -> bool:
    for directory in ICON_DIRS:
        directory.mkdir(parents=True, exist_ok=True)

    primary_path = ICON_DIRS[0] / f"{channel_id}.png"
    if primary_path.exists() and not force:
        for directory in ICON_DIRS[1:]:
            target_path = directory / f"{channel_id}.png"
            if not target_path.exists():
                target_path.write_bytes(primary_path.read_bytes())
        return False

    url = f"https://holodex.net/statics/channelImg/{channel_id}.png"
    response = await client.get(url, follow_redirects=True)
    response.raise_for_status()
    content_type = response.headers.get("content-type", "")
    if not content_type.startswith("image/"):
        raise ValueError(f"Unexpected content type: {content_type}")

    for directory in ICON_DIRS:
        (directory / f"{channel_id}.png").write_bytes(response.content)
    return True


async def download_all_icons(targets: list[dict[str, str]], force: bool) -> tuple[int, int]:
    saved = 0
    failed = 0
    semaphore = asyncio.Semaphore(CONCURRENCY)

    async with httpx.AsyncClient(timeout=30.0) as client:
        async def run_one(index: int, target: dict[str, str]) -> None:
            nonlocal saved, failed
            async with semaphore:
                try:
                    did_save = await download_icon(client, target["id"], force)
                    saved += int(did_save)
                    action = "saved" if did_save else "cached"
                    print(f"[{index}/{len(targets)}] {action} {target['name']}")
                except Exception as error:
                    failed += 1
                    print(f"[{index}/{len(targets)}] failed {target['name']}: {error}")

        await asyncio.gather(*(run_one(index, target) for index, target in enumerate(targets, start=1)))

    return saved, failed


def write_channel_index(targets: list[dict[str, str]]) -> None:
    index = [
        {
            "id": target["id"],
            "name": target["name"],
            "englishName": target["englishName"],
            "photo": target["photo"],
            "icon": f"/channel-icons/{target['id']}.png",
            "org": target["org"],
        }
        for target in targets
    ]
    for path in CHANNEL_INDEX_PATHS:
        path.write_text(json.dumps(index, ensure_ascii=False, indent=2), encoding="utf-8")


async def main_async(args: argparse.Namespace) -> None:
    targets = load_targets(args)
    if not targets:
        raise SystemExit("No icon targets found")

    saved, failed = await download_all_icons(targets, args.force)
    write_channel_index(targets)
    print(f"Icons ready: {len(targets)} targets, {saved} downloaded, {failed} failed")


def main() -> None:
    asyncio.run(main_async(parse_args()))


if __name__ == "__main__":
    main()
