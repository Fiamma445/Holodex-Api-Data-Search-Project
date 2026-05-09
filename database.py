"""
HoloProject Database Module
SQLite를 사용한 비디오 데이터베이스 관리
"""
import sqlite3
import json
import os
import shutil
import gzip
import tempfile
import threading
import time
import urllib.request
from functools import lru_cache
from typing import Optional
from contextlib import contextmanager

DEFAULT_DB_PATH = os.path.join(os.path.dirname(__file__), 'videos.db')
DEFAULT_DB_GZIP_PATH = f"{DEFAULT_DB_PATH}.gz"
SEED_DB_URL = os.environ.get("SEED_DB_URL", "").strip()
SEED_DB_MIN_VIDEO_COUNT = int(os.environ.get("SEED_DB_MIN_VIDEO_COUNT", "50000"))
SEED_DB_ASYNC = os.environ.get("SEED_DB_ASYNC", "").lower() not in {"0", "false", "no"}
seed_restore_status = {
    "state": "idle",
    "error": None,
    "startedAt": None,
    "completedAt": None,
}


def is_railway_runtime() -> bool:
    """Railway 런타임인지 확인한다."""
    return bool(
        os.environ.get("RAILWAY_ENVIRONMENT")
        or os.environ.get("RAILWAY_PROJECT_ID")
        or os.environ.get("RAILWAY_SERVICE_ID")
    )


def is_path_inside(path: str, parent: str) -> bool:
    """경로가 지정한 상위 디렉터리 안에 있는지 확인한다."""
    try:
        target = os.path.abspath(path)
        root = os.path.abspath(parent)
        return os.path.commonpath([target, root]) == root
    except ValueError:
        return False


def resolve_db_path() -> str:
    """환경에 맞는 SQLite DB 경로를 결정한다."""
    explicit_path = os.environ.get("DB_PATH", "").strip()
    volume_mount = os.environ.get("RAILWAY_VOLUME_MOUNT_PATH", "").strip()

    if explicit_path:
        if volume_mount and is_railway_runtime() and not is_path_inside(explicit_path, volume_mount):
            raise RuntimeError(
                "DB_PATH must point inside the Railway persistent volume. "
                f"Current DB_PATH={explicit_path}, volume={volume_mount}"
            )
        return explicit_path

    if volume_mount:
        return os.path.join(volume_mount, "videos.db")

    if is_railway_runtime():
        raise RuntimeError(
            "Railway persistent volume is not configured. "
            "Attach a Railway Volume and set DB_PATH=/data/videos.db before deploying."
        )

    return DEFAULT_DB_PATH


DB_PATH = resolve_db_path()

DB_DIR = os.path.dirname(DB_PATH)
if DB_DIR:
    os.makedirs(DB_DIR, exist_ok=True)


def seed_persistent_db_if_needed() -> None:
    """볼륨 DB가 없을 때 이미지 안의 기존 DB를 1회 복사한다."""
    source = os.path.abspath(DEFAULT_DB_PATH)
    compressed_source = os.path.abspath(DEFAULT_DB_GZIP_PATH)
    target = os.path.abspath(DB_PATH)
    if source == target:
        return

    if os.path.exists(target):
        if not SEED_DB_URL or has_seeded_video_data(target):
            return
        move_unseeded_db_aside(target)

    if SEED_DB_URL:
        if is_railway_runtime() and SEED_DB_ASYNC:
            start_seed_restore_thread(SEED_DB_URL, target)
            return
        restore_seed_from_url(SEED_DB_URL, target)
        return

    if os.path.exists(source):
        shutil.copy2(source, target)
        print(f"Database copied to persistent path: {target}")
        return

    if os.path.exists(compressed_source):
        with gzip.open(compressed_source, "rb") as compressed, open(target, "wb") as output:
            shutil.copyfileobj(compressed, output)
        print(f"Compressed database seed restored to persistent path: {target}")


def start_seed_restore_thread(url: str, target: str) -> None:
    """Railway 기동을 막지 않도록 외부 seed 복원을 백그라운드에서 실행한다."""
    seed_restore_status.update({
        "state": "restoring",
        "error": None,
        "startedAt": time.time(),
        "completedAt": None,
    })

    def worker() -> None:
        try:
            restore_seed_from_url(url, target)
            seed_restore_status.update({"state": "ready", "completedAt": time.time()})
        except Exception as exc:
            seed_restore_status.update({
                "state": "failed",
                "error": type(exc).__name__,
                "completedAt": time.time(),
            })
            print(f"External database seed restore failed: {exc}")

    thread = threading.Thread(target=worker, name="seed-db-restore", daemon=True)
    thread.start()
    print(f"External database seed restore started in background: {target}")


def has_seeded_video_data(path: str) -> bool:
    """기존 DB가 seed로 쓸 만큼 충분한 영상 데이터를 갖고 있는지 확인한다."""
    try:
        if os.path.getsize(path) < 10 * 1024 * 1024:
            return False

        conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        try:
            cursor = conn.cursor()
            cursor.execute(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'videos'"
            )
            if cursor.fetchone()[0] == 0:
                return False

            cursor.execute("SELECT COUNT(*) FROM videos")
            return cursor.fetchone()[0] >= SEED_DB_MIN_VIDEO_COUNT
        finally:
            conn.close()
    except (OSError, sqlite3.Error):
        return False


def move_unseeded_db_aside(target: str) -> None:
    """빈 DB나 부분 DB를 seed 복원 전에 백업 위치로 이동한다."""
    if os.path.getsize(target) == 0:
        os.remove(target)
        return

    backup_path = f"{target}.preseed-{int(time.time())}.bak"
    shutil.move(target, backup_path)
    print(f"Existing unseeded database moved aside: {backup_path}")


def restore_seed_from_url(url: str, target: str) -> None:
    """외부 저장소의 seed DB를 내려받아 빈 영구 DB 경로에 복원한다."""
    seed_restore_status.update({
        "state": "restoring",
        "error": None,
        "startedAt": time.time(),
        "completedAt": None,
    })
    suffix = ".db.gz" if url.split("?", 1)[0].endswith(".gz") else ".db"
    temp_download_path = ""
    temp_db_path = ""
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as temp_file:
            temp_download_path = temp_file.name

        request = urllib.request.Request(url, headers={"User-Agent": "HoloSearchSeed/1.0"})
        with urllib.request.urlopen(request, timeout=120) as response, open(temp_download_path, "wb") as output:
            shutil.copyfileobj(response, output)

        target_dir = os.path.dirname(os.path.abspath(target)) or None
        with tempfile.NamedTemporaryFile(delete=False, suffix=".db", dir=target_dir) as temp_db_file:
            temp_db_path = temp_db_file.name

        if suffix.endswith(".gz"):
            with gzip.open(temp_download_path, "rb") as compressed, open(temp_db_path, "wb") as output:
                shutil.copyfileobj(compressed, output)
        else:
            shutil.copy2(temp_download_path, temp_db_path)

        os.replace(temp_db_path, target)
        seed_restore_status.update({"state": "ready", "completedAt": time.time()})
        print(f"External database seed restored to persistent path: {target}")
    finally:
        for path in (temp_download_path, temp_db_path):
            if path and os.path.exists(path):
                os.remove(path)


def get_seed_status() -> dict:
    """운영 DB seed 복원 상태를 민감 정보 없이 반환한다."""
    exists = os.path.exists(DB_PATH)
    size = os.path.getsize(DB_PATH) if exists else 0
    seeded = has_seeded_video_data(DB_PATH) if exists and size >= 10 * 1024 * 1024 else False
    return {
        "configured": bool(SEED_DB_URL),
        "async": is_railway_runtime() and SEED_DB_ASYNC,
        "state": seed_restore_status["state"],
        "error": seed_restore_status["error"],
        "startedAt": seed_restore_status["startedAt"],
        "completedAt": seed_restore_status["completedAt"],
        "dbExists": exists,
        "dbBytes": size,
        "seeded": seeded,
    }


seed_persistent_db_if_needed()


@contextmanager
def get_connection():
    """데이터베이스 연결 컨텍스트 매니저"""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
    finally:
        conn.close()


def init_db():
    """데이터베이스 테이블 및 인덱스 초기화"""
    with get_connection() as conn:
        cursor = conn.cursor()
        
        # 테이블 생성
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS videos (
                id TEXT PRIMARY KEY,
                title TEXT,
                channel_id TEXT,
                channel_name TEXT,
                published_at TEXT,
                available_at TEXT,
                duration INTEGER,
                status TEXT,
                type TEXT,
                topic_id TEXT,
                json_data TEXT
            )
        ''')

        cursor.execute('''
            CREATE TABLE IF NOT EXISTS video_songs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                video_id TEXT NOT NULL,
                channel_id TEXT,
                channel_name TEXT,
                video_title TEXT,
                available_at TEXT,
                song_title TEXT NOT NULL,
                original_artist TEXT,
                start_sec INTEGER,
                end_sec INTEGER,
                art TEXT,
                itunesid TEXT,
                raw_json TEXT,
                FOREIGN KEY(video_id) REFERENCES videos(id)
            )
        ''')

        cursor.execute('''
            CREATE TABLE IF NOT EXISTS video_mentions (
                video_id TEXT NOT NULL,
                mention_id TEXT NOT NULL,
                mention_name TEXT,
                mention_english_name TEXT,
                mention_photo TEXT,
                raw_json TEXT,
                PRIMARY KEY(video_id, mention_id),
                FOREIGN KEY(video_id) REFERENCES videos(id)
            )
        ''')
        
        # 인덱스 생성
        indexes = [
            'CREATE INDEX IF NOT EXISTS idx_channel_id ON videos(channel_id)',
            'CREATE INDEX IF NOT EXISTS idx_available_at ON videos(available_at DESC)',
            'CREATE INDEX IF NOT EXISTS idx_title ON videos(title)',
            'CREATE INDEX IF NOT EXISTS idx_channel_available ON videos(channel_id, available_at DESC)',
            'CREATE INDEX IF NOT EXISTS idx_video_songs_channel ON video_songs(channel_id, available_at DESC)',
            'CREATE INDEX IF NOT EXISTS idx_video_songs_title ON video_songs(song_title)',
            'CREATE INDEX IF NOT EXISTS idx_video_songs_video ON video_songs(video_id)',
            'CREATE INDEX IF NOT EXISTS idx_video_mentions_member ON video_mentions(mention_id, video_id)',
            'CREATE INDEX IF NOT EXISTS idx_video_mentions_video ON video_mentions(video_id)'
        ]
        for sql in indexes:
            cursor.execute(sql)

        backfill_video_mentions(cursor)
        
        conn.commit()
        print(f'✅ Database initialized: {DB_PATH}')


def insert_video(video: dict) -> bool:
    """단일 비디오 삽입 (중복 무시)"""
    with get_connection() as conn:
        cursor = conn.cursor()
        channel = video.get('channel') or {}
        
        cursor.execute('''
            INSERT OR IGNORE INTO videos 
            (id, title, channel_id, channel_name, published_at, available_at, duration, status, type, topic_id, json_data)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ''', (
            video.get('id'),
            video.get('title'),
            channel.get('id'),
            channel.get('name', ''),
            video.get('published_at'),
            video.get('available_at'),
            video.get('duration'),
            video.get('status'),
            video.get('type'),
            video.get('topic_id'),
            json.dumps(video, ensure_ascii=False)
        ))
        inserted = cursor.rowcount > 0
        replace_video_mentions(cursor, video)
        conn.commit()
        clear_channel_index_cache()
        return inserted


def replace_video_mentions(cursor, video: dict) -> None:
    """영상 멘션을 검색용 정규화 테이블에 반영한다."""
    video_id = video.get('id')
    if not video_id:
        return

    cursor.execute("DELETE FROM video_mentions WHERE video_id = ?", (video_id,))
    mentions = video.get('mentions') or []
    rows = []
    seen_ids = set()
    for mention in mentions:
        if not isinstance(mention, dict):
            continue
        mention_id = (mention.get('id') or '').strip()
        if not mention_id or mention_id in seen_ids:
            continue
        seen_ids.add(mention_id)
        rows.append((
            video_id,
            mention_id,
            mention.get('name') or '',
            mention.get('english_name') or '',
            mention.get('photo') or '',
            json.dumps(mention, ensure_ascii=False)
        ))

    if not rows:
        return

    cursor.executemany('''
        INSERT OR REPLACE INTO video_mentions
        (video_id, mention_id, mention_name, mention_english_name, mention_photo, raw_json)
        VALUES (?, ?, ?, ?, ?, ?)
    ''', rows)


def backfill_video_mentions(cursor) -> None:
    """기존 DB에 멘션 인덱스가 비어 있으면 한 번만 채운다."""
    cursor.execute("SELECT COUNT(*) AS count FROM video_mentions")
    existing_count = cursor.fetchone()["count"]
    if existing_count:
        return

    cursor.execute("SELECT id, json_data FROM videos")
    rows = cursor.fetchall()
    for row in rows:
        try:
            video = json.loads(row["json_data"])
        except (json.JSONDecodeError, TypeError):
            continue
        replace_video_mentions(cursor, video)


def coerce_song_seconds(value) -> Optional[int]:
    """Holodex 곡 시간 값을 초 단위 정수로 변환한다."""
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)):
        return int(value)
    text = str(value).strip()
    if text.isdigit():
        return int(text)
    parts = text.split(":")
    if not all(part.isdigit() for part in parts):
        return None
    seconds = 0
    for part in parts:
        seconds = seconds * 60 + int(part)
    return seconds


def replace_video_songs(cursor, video: dict) -> None:
    """영상에 포함된 Holodex songs 배열을 노래 구간 테이블에 반영한다."""
    video_id = video.get('id')
    if not video_id:
        return

    cursor.execute("DELETE FROM video_songs WHERE video_id = ?", (video_id,))
    songs = video.get('songs') or []
    if not songs:
        return

    channel = video.get('channel') or {}
    rows = []
    for song in songs:
        if not isinstance(song, dict):
            continue
        title = (song.get('name') or song.get('title') or '').strip()
        if not title:
            continue
        rows.append((
            video_id,
            channel.get('id'),
            channel.get('name', ''),
            video.get('title'),
            video.get('available_at') or video.get('published_at'),
            title,
            song.get('original_artist') or song.get('artist') or '',
            coerce_song_seconds(song.get('start')),
            coerce_song_seconds(song.get('end')),
            song.get('art') or '',
            str(song.get('itunesid') or ''),
            json.dumps(song, ensure_ascii=False)
        ))

    if not rows:
        return

    cursor.executemany('''
        INSERT INTO video_songs
        (video_id, channel_id, channel_name, video_title, available_at, song_title, original_artist,
         start_sec, end_sec, art, itunesid, raw_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ''', rows)


def insert_videos_transaction(videos: list) -> int:
    """트랜잭션으로 여러 비디오 삽입"""
    if not videos:
        return 0
    
    new_count = 0
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("BEGIN TRANSACTION")
        
        for video in videos:
            channel = video.get('channel') or {}
            video_id = video.get('id')
            if not video_id:
                continue

            json_data = json.dumps(video, ensure_ascii=False)
            cursor.execute('''
                UPDATE videos
                SET title = ?, channel_id = ?, channel_name = ?, published_at = ?, available_at = ?,
                    duration = ?, status = ?, type = ?, topic_id = ?, json_data = ?
                WHERE id = ?
            ''', (
                video.get('title'),
                channel.get('id'),
                channel.get('name', ''),
                video.get('published_at'),
                video.get('available_at'),
                video.get('duration'),
                video.get('status'),
                video.get('type'),
                video.get('topic_id'),
                json_data,
                video_id
            ))

            if cursor.rowcount == 0:
                cursor.execute('''
                    INSERT INTO videos
                    (id, title, channel_id, channel_name, published_at, available_at, duration, status, type, topic_id, json_data)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ''', (
                    video_id,
                    video.get('title'),
                    channel.get('id'),
                    channel.get('name', ''),
                    video.get('published_at'),
                    video.get('available_at'),
                    video.get('duration'),
                    video.get('status'),
                    video.get('type'),
                    video.get('topic_id'),
                    json_data
                ))
                new_count += 1

            replace_video_songs(cursor, video)
            replace_video_mentions(cursor, video)
        
        cursor.execute("COMMIT")
        clear_channel_index_cache()
    
    return new_count


def append_video_scope_filter(sql: str, params: list, channel_id: Optional[str], video_type: Optional[str]):
    """채널 기준 영상 범위를 붙인다."""
    if not channel_id:
        return sql, params

    if video_type == "collab":
        sql += """
            AND id IN (
                SELECT own.id
                FROM videos own
                JOIN video_mentions own_vm ON own_vm.video_id = own.id
                WHERE own.channel_id = ?
                UNION
                SELECT vm.video_id
                FROM video_mentions vm
                WHERE vm.mention_id = ?
            )
        """
        params.extend([channel_id, channel_id])
        return sql, params

    sql += " AND channel_id = ?"
    params.append(channel_id)
    return sql, params


def append_collab_member_filter(sql: str, params: list, collab_member: Optional[str], collab_mode: str):
    """콜라보 멤버 필터를 멘션 인덱스 기반으로 붙인다."""
    if not collab_member:
        return sql, params

    members = [member.strip() for member in collab_member.split(',') if member.strip()]
    if not members:
        return sql, params

    def is_channel_id(value: str) -> bool:
        return value.startswith("UC")

    def append_member_condition(member: str):
        like = f"%{member}%"
        if is_channel_id(member):
            return (
                """
                    (
                        channel_id = ?
                        OR id IN (
                            SELECT vm.video_id
                            FROM video_mentions vm
                            WHERE vm.mention_id = ?
                        )
                    )
                """,
                [member, member]
            )
        return (
            """
                (
                    channel_id = ?
                    OR channel_name LIKE ?
                    OR id IN (
                        SELECT vm.video_id
                        FROM video_mentions vm
                        WHERE vm.mention_id = ?
                           OR vm.mention_name LIKE ?
                           OR vm.mention_english_name LIKE ?
                    )
                )
            """,
            [member, like, member, like, like]
        )

    if collab_mode == 'and':
        for member in members:
            condition, condition_params = append_member_condition(member)
            sql += f" AND {condition}"
            params.extend(condition_params)
        return sql, params

    conditions = []
    for member in members:
        condition, condition_params = append_member_condition(member)
        conditions.append(condition)
        params.extend(condition_params)
    sql += f" AND ({' OR '.join(conditions)})"
    return sql, params


def search_videos(query: Optional[str], channel_id: Optional[str], limit: int = 32, offset: int = 0, collab_member: Optional[str] = None, collab_mode: str = "or", hide_unarchived: bool = False, filter_dates: Optional[list] = None, filter_years: Optional[list] = None, filter_months: Optional[list] = None, video_type: Optional[str] = None) -> list:
    """비디오 검색 (콜라보 멤버 필터, 언아카이브 숨기기, 날짜 필터, 년/월 다중 필터, 비디오 타입 필터)
    collab_member: 단일 이름 또는 comma-separated 이름 목록
    collab_mode: 'or' 또는 'and'
    hide_unarchived: True면 언아카이브(삭제/비공개) 영상 제외
    filter_dates: 날짜 목록 (YYYY-MM-DD 형식)
    filter_years: 년도 목록 (빠른 선택 다중)
    filter_months: 월 목록 (빠른 선택 다중)
    video_type: 'music'이면 노래(Original_Song, Music_Cover)만 필터링
    """
    with get_connection() as conn:
        cursor = conn.cursor()
        
        sql = "SELECT json_data FROM videos WHERE 1=1"
        params = []
        
        sql, params = append_video_scope_filter(sql, params, channel_id, video_type)
        
        if query:
            sql += " AND title LIKE ?"
            params.append(f"%{query}%")
        
        # 비디오 타입 필터 (노래: Original_Song + Music_Cover)
        if video_type == 'music':
            sql += " AND topic_id IN ('Original_Song', 'Music_Cover')"
        
        # 언아카이브 영상 제외 (status가 'missing'이거나 placeholder thumbnail)
        if hide_unarchived:
            sql += " AND status != 'missing'"
            # placeholder 썸네일은 'mqdefault' 패턴이 없는 경우로 추정
            sql += " AND json_data NOT LIKE '%\"topic_id\": null%'"
        
        # 년/월 다중 필터: 년도가 선택된 경우에만 적용 (월은 년도 필수)
        if filter_years and len(filter_years) > 0:
            year_month_conditions = []
            if filter_months and len(filter_months) > 0:
                # 년도+월 조합: 각 년도와 각 월의 조합
                for year in filter_years:
                    for month in filter_months:
                        year_month_prefix = f"{year}-{month:02d}"
                        year_month_conditions.append("available_at LIKE ?")
                        params.append(f"{year_month_prefix}%")
            else:
                # 년도만 필터: 각 년도의 모든 영상
                for year in filter_years:
                    year_month_conditions.append("available_at LIKE ?")
                    params.append(f"{year}-%")
            sql += f" AND ({' OR '.join(year_month_conditions)})"
        # 월만 선택 시 무시 (년도 필수)
        
        # 날짜 필터: 선택된 날짜에 해당하는 영상만
        if filter_dates and len(filter_dates) > 0:
            date_conditions = []
            for date in filter_dates:
                # available_at이 해당 날짜로 시작하는 영상
                date_conditions.append("available_at LIKE ?")
                params.append(f"{date}%")
            sql += f" AND ({' OR '.join(date_conditions)})"
        
        sql, params = append_collab_member_filter(sql, params, collab_member, collab_mode)
        
        sql += " ORDER BY available_at DESC LIMIT ? OFFSET ?"
        params.extend([limit, offset])
        
        cursor.execute(sql, params)
        rows = cursor.fetchall()
        
        return [json.loads(row['json_data']) for row in rows]


def count_videos(query: Optional[str], channel_id: Optional[str], collab_member: Optional[str] = None, collab_mode: str = "or", hide_unarchived: bool = False, filter_dates: Optional[list] = None, filter_years: Optional[list] = None, filter_months: Optional[list] = None, video_type: Optional[str] = None) -> int:
    """비디오 개수 조회 (콜라보 멤버 필터, 언아카이브 숨기기, 날짜/년/월 필터, 비디오 타입 필터)"""
    with get_connection() as conn:
        cursor = conn.cursor()
        
        sql = "SELECT COUNT(*) as count FROM videos WHERE 1=1"
        params = []
        
        sql, params = append_video_scope_filter(sql, params, channel_id, video_type)
        
        if query:
            sql += " AND title LIKE ?"
            params.append(f"%{query}%")
        
        # 비디오 타입 필터 (노래: Original_Song + Music_Cover)
        if video_type == 'music':
            sql += " AND topic_id IN ('Original_Song', 'Music_Cover')"
        
        # 언아카이브 영상 제외
        if hide_unarchived:
            sql += " AND status != 'missing'"
            sql += " AND json_data NOT LIKE '%\"topic_id\": null%'"
        
        # 년/월 다중 필터: 년도가 선택된 경우에만 적용 (월은 년도 필수)
        if filter_years and len(filter_years) > 0:
            year_month_conditions = []
            if filter_months and len(filter_months) > 0:
                # 년도+월 조합: 각 년도와 각 월의 조합
                for year in filter_years:
                    for month in filter_months:
                        year_month_prefix = f"{year}-{month:02d}"
                        year_month_conditions.append("available_at LIKE ?")
                        params.append(f"{year_month_prefix}%")
            else:
                # 년도만 필터: 각 년도의 모든 영상
                for year in filter_years:
                    year_month_conditions.append("available_at LIKE ?")
                    params.append(f"{year}-%")
            sql += f" AND ({' OR '.join(year_month_conditions)})"
        # 월만 선택 시 무시 (년도 필수)
        
        # 날짜 필터: 선택된 날짜에 해당하는 영상만
        if filter_dates and len(filter_dates) > 0:
            date_conditions = []
            for date in filter_dates:
                date_conditions.append("available_at LIKE ?")
                params.append(f"{date}%")
            sql += f" AND ({' OR '.join(date_conditions)})"
        
        sql, params = append_collab_member_filter(sql, params, collab_member, collab_mode)
        
        cursor.execute(sql, params)
        row = cursor.fetchone()
        
        return row['count'] if row else 0


def build_song_search_where(query: Optional[str], channel_id: Optional[str], collab_member: Optional[str] = None, collab_mode: str = "or"):
    """노래 검색 조건과 파라미터를 만든다."""
    sql = " FROM video_songs vs LEFT JOIN videos v ON v.id = vs.video_id WHERE 1=1"
    params = []
    if channel_id:
        sql += """
            AND (
                vs.channel_id = ?
                OR EXISTS (
                    SELECT 1
                    FROM json_each(COALESCE(json_extract(v.json_data, '$.mentions'), '[]')) mention
                    WHERE json_extract(mention.value, '$.id') = ?
                )
            )
        """
        params.extend([channel_id, channel_id])
    if query:
        like = f"%{query}%"
        sql += " AND (vs.song_title LIKE ? OR vs.original_artist LIKE ? OR vs.video_title LIKE ?)"
        params.extend([like, like, like])
    if collab_member:
        members = [member.strip() for member in collab_member.split(',') if member.strip()]
        if members:
            if collab_mode == "and":
                for member in members:
                    sql += " AND v.json_data LIKE ?"
                    params.append(f"%{member}%")
            else:
                conditions = ["v.json_data LIKE ?" for _ in members]
                sql += f" AND ({' OR '.join(conditions)})"
                params.extend([f"%{member}%" for member in members])
    return sql, params


def get_song_order_sql(sort: str) -> str:
    """노래 목록 정렬 조건을 반환한다."""
    if sort == "title":
        return " ORDER BY lower(vs.song_title), vs.available_at DESC"
    if sort == "artist":
        return " ORDER BY lower(vs.original_artist), lower(vs.song_title), vs.available_at DESC"
    return " ORDER BY vs.available_at DESC, vs.id DESC"


OFFICIAL_SONG_TOPICS = {"Original_Song", "Music_Cover"}
LIVE_PERFORMANCE_MARKERS = (
    "3d live",
    "solo live",
    "graduation live",
    "live ver",
    "live version",
    "3dライブ",
    "ソロライブ",
    "卒業ライブ",
    "生誕ライブ",
    "ライブver"
)
NON_VOCAL_MARKERS = (
    "instrumental",
    "off vocal",
    "offvocal",
    "inst."
)
COMPILATION_MARKERS = (
    "medley",
    "メドレー",
    "200曲"
)
CHANNEL_NAME_NOISE = {"ch", "ch.", "channel", "official"}


def is_live_performance_song(row: dict) -> bool:
    """정식 곡 토픽 안에 섞인 라이브 공연 클립을 걸러낸다."""
    combined = f"{row.get('song_title') or ''} {row.get('video_title') or ''}"
    lowered = combined.lower()
    return any(marker in lowered for marker in LIVE_PERFORMANCE_MARKERS)


def is_non_vocal_song(row: dict) -> bool:
    """보컬곡 목록을 흐리는 반주 버전을 제외한다."""
    combined = f"{row.get('song_title') or ''} {row.get('video_title') or ''}"
    lowered = combined.lower()
    return any(marker in lowered for marker in NON_VOCAL_MARKERS)


def is_compilation_song(row: dict) -> bool:
    """비디오 단위 멘션 때문에 곡별 참여자가 흐려지는 메들리 영상을 제외한다."""
    combined = f"{row.get('song_title') or ''} {row.get('video_title') or ''}"
    lowered = combined.lower()
    return any(marker.lower() in lowered for marker in COMPILATION_MARKERS)


def normalize_artist_name(value: Optional[str]) -> str:
    """원곡자 비교용으로 공백과 흔한 장식을 정리한다."""
    return " ".join((value or "").replace("。", " ").strip(".,()[]【】").lower().split())


def selected_member_aliases(row: dict, selected_channel_id: Optional[str]) -> set:
    """선택 멤버의 영문명과 채널명 토큰을 원곡자 판정 후보로 모은다."""
    aliases = set()
    if not selected_channel_id:
        return aliases

    try:
        from channels import CHANNELS
        channel = next((item for item in CHANNELS if item.get("id") == selected_channel_id), None)
        if channel and channel.get("name"):
            aliases.add(normalize_artist_name(channel["name"]))
    except Exception:
        pass

    if row.get("channel_id") == selected_channel_id:
        channel_name = (row.get("channel_name") or "").replace("/", " ").replace("|", " ")
        for token in channel_name.split():
            normalized = normalize_artist_name(token)
            if normalized and normalized not in CHANNEL_NAME_NOISE:
                aliases.add(normalized)

    return aliases


def is_selected_member_artist(row: dict, selected_channel_id: Optional[str]) -> bool:
    """원곡자가 선택 멤버 본인인지 확인한다."""
    artist = normalize_artist_name(row.get("original_artist"))
    return bool(artist) and artist in selected_member_aliases(row, selected_channel_id)


def is_official_song(row: dict) -> bool:
    """분류 탭에 올릴 수 있는 정식 보컬곡인지 확인한다."""
    topic_id = row.get("video_topic_id") or ""
    if topic_id not in OFFICIAL_SONG_TOPICS:
        return False
    return not is_live_performance_song(row) and not is_non_vocal_song(row) and not is_compilation_song(row)


def classify_song(row: dict, selected_channel_id: Optional[str]) -> str:
    """Holodex 토픽과 멘션 태그 기반으로 정식 노래 영상을 분류한다."""
    title = row.get("song_title") or ""
    video_title = row.get("video_title") or ""
    topic_id = row.get("video_topic_id") or ""
    mention_count = row.get("mention_count") or 0
    host_channel_id = row.get("channel_id") or ""

    if topic_id == "Music_Cover":
        return "cover"

    is_own_channel = bool(selected_channel_id) and host_channel_id == selected_channel_id
    combined = f"{title} {video_title}".lower()
    guest_hints = ("ft.", "feat.", "feat ", "with hololive", "startend", "×")
    has_guest_hint = any(hint in combined for hint in guest_hints)
    if topic_id == "Original_Song" and is_own_channel and is_selected_member_artist(row, selected_channel_id):
        return "original"
    if topic_id == "Original_Song" and is_own_channel and mention_count == 0 and not has_guest_hint:
        return "original"

    return "unit_guest"


def load_song_rows(query: Optional[str], channel_id: Optional[str], sort: str = "recent", collab_member: Optional[str] = None, collab_mode: str = "or") -> list:
    """검색 조건에 맞는 노래 구간 전체를 읽는다."""
    with get_connection() as conn:
        cursor = conn.cursor()
        where_sql, params = build_song_search_where(query, channel_id, collab_member, collab_mode)
        sql = """
            SELECT vs.id, vs.video_id, vs.channel_id, vs.channel_name, vs.video_title, vs.available_at,
                   vs.song_title, vs.original_artist, vs.start_sec, vs.end_sec, vs.art, vs.itunesid,
                   v.topic_id AS video_topic_id,
                   COALESCE(json_array_length(json_extract(v.json_data, '$.mentions')), 0) AS mention_count
        """ + where_sql + get_song_order_sql(sort) + " LIMIT ? OFFSET ?"
        cursor.execute(sql, [*params, 100000, 0])
        songs = []
        for row in cursor.fetchall():
            item = dict(row)
            item["category"] = classify_song(item, channel_id) if is_official_song(item) else "all"
            songs.append(item)
        return songs


def get_songs_response(query: Optional[str], channel_id: Optional[str], limit: int = 32, offset: int = 0, sort: str = "recent", category: str = "all", collab_member: Optional[str] = None, collab_mode: str = "or") -> dict:
    """분류 탭과 요약을 포함한 노래 검색 응답을 만든다."""
    songs = load_song_rows(query, channel_id, sort, collab_member, collab_mode)
    official_songs = [song for song in songs if song["category"] != "all"]
    counts = {
        "all": len(songs),
        "original": 0,
        "unit_guest": 0,
        "cover": 0
    }
    video_ids = set()
    latest_at = None
    for song in songs:
        if song["category"] != "all":
            counts[song["category"]] += 1
        if song.get("video_id"):
            video_ids.add(song["video_id"])
        if song.get("available_at") and (latest_at is None or song["available_at"] > latest_at):
            latest_at = song["available_at"]

    filtered = songs if category == "all" else [
        song for song in official_songs if song["category"] == category
    ]
    paged = filtered[offset:offset + limit]
    return {
        "items": paged,
        "total": len(filtered),
        "summary": {
            "totalSongs": len(songs),
            "totalVideos": len(video_ids),
            "latestAt": latest_at,
            "categoryCounts": counts
        }
    }


def song_row_has_allowed_context(row: dict) -> bool:
    """허용된 채널이 올렸거나 허용된 멤버가 멘션된 노래 기록만 통과시킨다."""
    try:
        from allowed_channels import is_allowed_channel_id

        if is_allowed_channel_id(row.get("channel_id")):
            return True

        video_data = json.loads(row.get("video_json_data") or "{}")
        mentions = video_data.get("mentions") or []
        return any(
            isinstance(member, dict) and is_allowed_channel_id(member.get("id"))
            for member in mentions
        )
    except Exception:
        return False


def get_song_detail_title_candidates(title: str) -> list:
    """같은 곡 제목의 표기 변형을 묶기 위한 기준 제목을 만든다."""
    normalized = " ".join((title or "").strip().split())
    if not normalized:
        return []

    candidates = [normalized]
    separators = (" / ", " ／ ", " | ", " ｜ ")
    for separator in separators:
        if separator in normalized:
            candidates.append(normalized.split(separator, 1)[0].strip())

    trailing_notes = (" [", " 【", " (", " （")
    for marker in trailing_notes:
        if marker in normalized:
            candidates.append(normalized.split(marker, 1)[0].strip())

    seen = set()
    unique_candidates = []
    for candidate in candidates:
        if len(candidate) < 2 or candidate in seen:
            continue
        seen.add(candidate)
        unique_candidates.append(candidate)
    return unique_candidates


def append_song_detail_title_conditions(conditions: list, params: list, title: str) -> None:
    """상세보기에서 원제목과 부제/라이브 표기 변형을 함께 찾는다."""
    for candidate in get_song_detail_title_candidates(title):
        conditions.append("LOWER(TRIM(vs.song_title)) = LOWER(TRIM(?))")
        params.append(candidate)

        if len(candidate) < 3:
            continue

        for suffix in (" /%", " ／%", " [%", " 【%", " (%", " （%"):
            conditions.append("LOWER(TRIM(vs.song_title)) LIKE LOWER(TRIM(?))")
            params.append(f"{candidate}{suffix}")


def get_song_details_response(title: Optional[str], artist: Optional[str] = None, itunesid: Optional[str] = None, limit: int = 300, offset: int = 0) -> dict:
    """같은 곡을 부른 모든 로컬 DB 기록을 조회한다."""
    title = (title or "").strip()
    artist = (artist or "").strip()
    itunesid = (itunesid or "").strip()
    if not title and not itunesid:
        return {"items": [], "total": 0}

    conditions = []
    params = []
    if itunesid:
        conditions.append("TRIM(vs.itunesid) = ?")
        params.append(itunesid)
    if title:
        append_song_detail_title_conditions(conditions, params, title)

    with get_connection() as conn:
        cursor = conn.cursor()
        sql = f"""
            SELECT vs.id, vs.video_id, vs.channel_id, vs.channel_name, vs.video_title, vs.available_at,
                   vs.song_title, vs.original_artist, vs.start_sec, vs.end_sec, vs.art, vs.itunesid,
                   v.topic_id AS video_topic_id,
                   v.json_data AS video_json_data,
                   COALESCE(json_array_length(json_extract(v.json_data, '$.mentions')), 0) AS mention_count
            FROM video_songs vs
            LEFT JOIN videos v ON v.id = vs.video_id
            WHERE ({' OR '.join(conditions)})
            ORDER BY vs.available_at DESC, vs.id DESC
            LIMIT 1000
        """
        cursor.execute(sql, params)

        items = []
        seen = set()
        for row in cursor.fetchall():
            item = dict(row)
            if not song_row_has_allowed_context(item):
                continue

            dedupe_key = (
                item.get("video_id"),
                item.get("song_title"),
                item.get("start_sec"),
                item.get("end_sec"),
            )
            if dedupe_key in seen:
                continue
            seen.add(dedupe_key)

            item.pop("video_json_data", None)
            item["category"] = classify_song(item, item.get("channel_id")) if is_official_song(item) else "all"
            items.append(item)

        paged = items[offset:offset + limit]
        return {
            "items": paged,
            "total": len(items),
            "query": {
                "title": title,
                "artist": artist,
                "itunesid": itunesid
            }
        }


def get_latest_video_date(channel_id: str) -> Optional[str]:
    """채널의 최신 비디오 날짜 조회"""
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT available_at FROM videos WHERE channel_id = ? ORDER BY available_at DESC LIMIT 1",
            (channel_id,)
        )
        row = cursor.fetchone()
        return row['available_at'] if row else None


# === 통계 쿼리 함수 ===

def get_db_signature() -> tuple[int, int]:
    try:
        stat = os.stat(DB_PATH)
        return stat.st_mtime_ns, stat.st_size
    except OSError:
        return 0, 0


def clear_channel_index_cache() -> None:
    get_channel_index_for_signature.cache_clear()


def build_channel_index() -> list:
    """DB에 쌓인 호스트/멘션 채널 목록을 반환한다."""
    channels = {}

    def remember(channel_id, name="", photo="", org=""):
        if not channel_id or not str(channel_id).startswith("UC"):
            return
        current = channels.get(channel_id, {})
        channels[channel_id] = {
            "id": channel_id,
            "name": current.get("name") or name or channel_id,
            "englishName": current.get("englishName") or name or channel_id,
            "photo": current.get("photo") or photo or "",
            "icon": f"/channel-icons/{channel_id}.png",
            "org": current.get("org") or org or "Hololive",
            "count": int(current.get("count") or 0) + 1,
        }

    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("""
            SELECT channel_id, channel_name, json_data
            FROM videos
            WHERE json_data IS NOT NULL
        """)

        for row in cursor.fetchall():
            try:
                data = json.loads(row["json_data"] or "{}")
            except (json.JSONDecodeError, TypeError):
                data = {}

            channel = data.get("channel") or {}
            remember(
                row["channel_id"] or channel.get("id"),
                row["channel_name"] or channel.get("name") or channel.get("english_name"),
                channel.get("photo") or "",
                channel.get("org") or "",
            )

            for member in data.get("mentions") or []:
                if not isinstance(member, dict):
                    continue
                remember(
                    member.get("id"),
                    member.get("name") or member.get("english_name"),
                    member.get("photo") or "",
                    member.get("org") or "",
                )

    return sorted(channels.values(), key=lambda item: item["name"].casefold())


@lru_cache(maxsize=4)
def get_channel_index_for_signature(db_mtime_ns: int, db_size: int) -> tuple:
    return tuple(build_channel_index())


def get_channel_index() -> list:
    cached_items = get_channel_index_for_signature(*get_db_signature())
    return [dict(item) for item in cached_items]


def get_yearly_stats(channel_id: str) -> list:
    """년도별 방송 개수 집계"""
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("""
            SELECT strftime('%Y', available_at) as year, COUNT(*) as count 
            FROM videos 
            WHERE channel_id = ? 
            GROUP BY year 
            ORDER BY year
        """, (channel_id,))
        return [{"year": row["year"], "count": row["count"]} for row in cursor.fetchall()]


def get_monthly_stats(channel_id: str, year: str) -> list:
    """월별 방송 개수 집계"""
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("""
            SELECT strftime('%m', available_at) as month, COUNT(*) as count 
            FROM videos 
            WHERE channel_id = ? 
            AND strftime('%Y', available_at) = ?
            GROUP BY month 
            ORDER BY month
        """, (channel_id, year))
        # 12개월 전체를 채워서 반환 (없는 월은 0)
        result = {f"{i:02d}": 0 for i in range(1, 13)}
        for row in cursor.fetchall():
            result[row["month"]] = row["count"]
        return [{"month": int(m), "count": c} for m, c in result.items()]


def get_yearly_membership_stats(channel_id: str) -> list:
    """년도별 멤버십 방송 개수 집계"""
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("""
            SELECT strftime('%Y', available_at) as year, COUNT(*) as count 
            FROM videos 
            WHERE channel_id = ? 
            AND (
                json_extract(json_data, '$.topic_id') = 'membersonly'
                OR title LIKE '%メン限%' 
                OR title LIKE '%Members%' 
                OR title LIKE '%メンバー限定%' 
                OR title LIKE '%멤버십%' 
                OR title LIKE '%Membersonly%'
            )
            GROUP BY year 
            ORDER BY year
        """, (channel_id,))
        return [{"year": row["year"], "count": row["count"]} for row in cursor.fetchall()]


def get_monthly_membership_stats(channel_id: str, year: str) -> list:
    """월별 멤버십 방송 통계 (topic_id + 제목 키워드 병용)"""
    with get_connection() as conn:
        cursor = conn.cursor()
        # json_data의 topic_id가 'membersonly'이거나 제목에 멤버십 키워드 포함
        cursor.execute("""
            SELECT strftime('%m', available_at) as month, COUNT(*) as count 
            FROM videos 
            WHERE channel_id = ? 
            AND strftime('%Y', available_at) = ?
            AND (
                json_extract(json_data, '$.topic_id') = 'membersonly'
                OR title LIKE '%メン限%' 
                OR title LIKE '%Members%' 
                OR title LIKE '%メンバー限定%' 
                OR title LIKE '%멤버십%' 
                OR title LIKE '%Membersonly%'
            )
            GROUP BY month 
            ORDER BY month
        """, (channel_id, year))
        # 12개월 전체를 채워서 반환 (없는 월은 0)
        result = {f"{i:02d}": 0 for i in range(1, 13)}
        for row in cursor.fetchall():
            result[row["month"]] = row["count"]
        return [{"month": int(m), "count": c} for m, c in result.items()]


def get_collab_stats(channel_id: str) -> list:
    """콜라보 멤버별 횟수 집계 (mentions 필드 활용, photo URL 포함)"""
    with get_connection() as conn:
        cursor = conn.cursor()
        # json_data에서 mentions 추출
        cursor.execute("""
            SELECT json_data FROM videos 
            WHERE channel_id = ? AND json_data IS NOT NULL
        """, (channel_id,))
        
        collab_counts = {}
        for row in cursor.fetchall():
            try:
                data = json.loads(row["json_data"])
                mentions = data.get("mentions", [])
                for member in mentions:
                    member_id = member.get("id")
                    member_name = member.get("name") or member.get("english_name", "Unknown")
                    member_photo = member.get("photo", "")  # photo URL 추가
                    if member_id:
                        if member_id not in collab_counts:
                            collab_counts[member_id] = {
                                "id": member_id,
                                "name": member_name,
                                "photo": member_photo,  # photo 필드 추가
                                "count": 0
                            }
                        collab_counts[member_id]["count"] += 1
                        # photo가 없으면 업데이트 (나중에 찾은 photo로)
                        if not collab_counts[member_id]["photo"] and member_photo:
                            collab_counts[member_id]["photo"] = member_photo
            except (json.JSONDecodeError, TypeError):
                continue
        
        # 횟수 기준 내림차순 정렬 후 상위 30개 반환
        sorted_collabs = sorted(collab_counts.values(), key=lambda x: x["count"], reverse=True)
        return sorted_collabs[:30]


def get_yearly_collab_stats(channel_id: str, year: str) -> list:
    """특정 연도의 콜라보 멤버별 횟수 집계 (photo URL 포함)"""
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("""
            SELECT json_data FROM videos 
            WHERE channel_id = ? 
            AND json_data IS NOT NULL
            AND strftime('%Y', available_at) = ?
        """, (channel_id, year))
        
        collab_counts = {}
        for row in cursor.fetchall():
            try:
                data = json.loads(row["json_data"])
                mentions = data.get("mentions", [])
                for member in mentions:
                    member_id = member.get("id")
                    member_name = member.get("name") or member.get("english_name", "Unknown")
                    member_photo = member.get("photo", "")  # photo URL 추가
                    if member_id:
                        if member_id not in collab_counts:
                            collab_counts[member_id] = {
                                "id": member_id,
                                "name": member_name,
                                "photo": member_photo,  # photo 필드 추가
                                "count": 0
                            }
                        collab_counts[member_id]["count"] += 1
                        # photo가 없으면 업데이트
                        if not collab_counts[member_id]["photo"] and member_photo:
                            collab_counts[member_id]["photo"] = member_photo
            except (json.JSONDecodeError, TypeError):
                continue
        
        # 횟수 기준 내림차순 정렬 후 상위 30개 반환
        sorted_collabs = sorted(collab_counts.values(), key=lambda x: x["count"], reverse=True)
        return sorted_collabs[:30]


def get_topic_stats(channel_id: str) -> list:
    """전체 topic(컨텐츠/게임) 통계 - TOP 10"""
    with get_connection() as conn:
        cursor = conn.cursor()
        # membersonly, shorts, announce 등 컨텐츠가 아닌 태그 제외
        cursor.execute("""
            SELECT topic_id, COUNT(*) as cnt 
            FROM videos 
            WHERE channel_id = ? 
            AND topic_id IS NOT NULL 
            AND topic_id != ''
            AND topic_id NOT IN ('membersonly', 'shorts', 'announce', 'Original_Song', 'Music_Cover', 'watchalong', 'morning')
            GROUP BY topic_id 
            ORDER BY cnt DESC 
            LIMIT 10
        """, (channel_id,))
        return [{"topic": row[0], "count": row[1]} for row in cursor.fetchall()]


def get_yearly_topic_stats(channel_id: str, year: str) -> list:
    """연도별 topic(컨텐츠/게임) 통계 - TOP 10"""
    with get_connection() as conn:
        cursor = conn.cursor()
        # membersonly, shorts, announce 등 컨텐츠가 아닌 태그 제외
        cursor.execute("""
            SELECT topic_id, COUNT(*) as cnt 
            FROM videos 
            WHERE channel_id = ? 
            AND strftime('%Y', available_at) = ?
            AND topic_id IS NOT NULL 
            AND topic_id != ''
            AND topic_id NOT IN ('membersonly', 'shorts', 'announce', 'Original_Song', 'Music_Cover', 'watchalong', 'morning')
            GROUP BY topic_id 
            ORDER BY cnt DESC 
            LIMIT 10
        """, (channel_id, year))
        return [{"topic": row[0], "count": row[1]} for row in cursor.fetchall()]


# 모듈 로드 시 DB 초기화
init_db()

