"""
HoloProject Server (Optimized)
FastAPI 기반 웹 서버 - Holodex API 프록시 및 로컬 DB 검색
성능 최적화 버전
"""
import asyncio
import hmac
import json
import os
import re
import time
from typing import Optional
from contextlib import asynccontextmanager
from concurrent.futures import ThreadPoolExecutor

from fastapi import FastAPI, Request, BackgroundTasks, HTTPException, Query
from fastapi.staticfiles import StaticFiles
from fastapi.responses import JSONResponse, FileResponse, ORJSONResponse
from fastapi.middleware.cors import CORSMiddleware
import httpx
from cachetools import TTLCache

import database as db
from allowed_channels import is_allowed_channel_id
from channels import CHANNEL_IDS

# --- 성능 최적화: orjson 사용 (더 빠른 JSON 파싱) ---
try:
    import orjson
    HAS_ORJSON = True
except ImportError:
    HAS_ORJSON = False

# --- LRU/TTL Cache (확장) ---
cache = TTLCache(maxsize=1000, ttl=60)  # 캐시 크기 확장

# --- Thread Pool for DB Operations ---
db_executor = ThreadPoolExecutor(max_workers=4)

# --- Environment Flags ---
IS_PRODUCTION = bool(os.environ.get("RAILWAY_ENVIRONMENT") or os.environ.get("NODE_ENV") == "production")
# 정적 프론트엔드 원본은 로컬/배포 모두 public/ 하나만 사용한다.
STATIC_DIR = os.environ.get("STATIC_DIR", "public").strip() or "public"
CHANNEL_IMAGE_CACHE_DIR = os.path.join(
    os.environ.get("RAILWAY_VOLUME_MOUNT_PATH", "").strip() or db.DB_DIR or ".",
    "channel_img_cache",
)
CHANNEL_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{10,64}$")
DATE_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}$")
YEAR_PATTERN = re.compile(r"^\d{4}$")
TRUST_PROXY_HEADERS = os.environ.get("TRUST_PROXY_HEADERS", "").lower() in {"1", "true", "yes"}
SYNC_CONCURRENCY = max(1, int(os.environ.get("SYNC_CONCURRENCY", "8")))
AUTO_SYNC_ENABLED = os.environ.get("AUTO_SYNC_ENABLED", "").lower() in {"1", "true", "yes"}
AUTO_SYNC_INTERVAL_SECONDS = max(900, int(os.environ.get("AUTO_SYNC_INTERVAL_SECONDS", "3600")))
AUTO_SYNC_INITIAL_DELAY_SECONDS = max(0, int(os.environ.get("AUTO_SYNC_INITIAL_DELAY_SECONDS", "300")))
MAX_QUERY_STRING_BYTES = 4096
MAX_SEARCH_TEXT_LENGTH = 200
MAX_FILTER_ITEMS = 50
MAX_SYNC_CHANNELS = int(os.environ.get("MAX_SYNC_CHANNELS", "200"))
MAX_SYNC_BODY_BYTES = 64 * 1024
MAX_PROXY_BODY_BYTES = 256 * 1024
ALLOWED_HOLODEX_PROXY_PATHS = {"live", "videos", "search/videoSearch"}
BLOCKED_STATIC_SUFFIXES = (
    ".bat",
    ".db",
    ".db.gz",
    ".env",
    ".ini",
    ".log",
    ".py",
    ".pyc",
    ".sqlite",
    ".sqlite3",
    ".toml",
)
BLOCKED_STATIC_NAMES = {"requirements.txt"}

# --- 보안: 관리 API 인증 (D-02) ---
DEFAULT_ADMIN_TOKEN = "dev-token-change-me"
ADMIN_TOKEN = os.environ.get("ADMIN_TOKEN", "").strip()


def has_strong_admin_token() -> bool:
    return bool(ADMIN_TOKEN) and ADMIN_TOKEN != DEFAULT_ADMIN_TOKEN


def get_client_ip(request: Request) -> str:
    # 프록시 헤더는 명시적으로 신뢰할 때만 사용한다.
    cf_ip = request.headers.get("CF-Connecting-IP") if TRUST_PROXY_HEADERS else None
    if cf_ip and re.fullmatch(r"[0-9A-Fa-f:.]{3,45}", cf_ip):
        return cf_ip
    return request.client.host if request.client else "unknown"


def is_local_request(request: Request) -> bool:
    client_host = request.client.host if request.client else "unknown"
    return client_host in {"127.0.0.1", "::1", "localhost"}


def verify_admin(request: Request):
    """관리 API 인증 검증"""
    if not IS_PRODUCTION and is_local_request(request):
        return

    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer ") and has_strong_admin_token():
        token = auth[7:].strip()
        if token and hmac.compare_digest(token, ADMIN_TOKEN):
            return

    raise HTTPException(status_code=401, detail="Unauthorized")


async def read_limited_json(request: Request, max_bytes: int):
    """요청 본문 크기를 제한한 뒤 JSON을 읽는다."""
    content_length = request.headers.get("content-length")
    if content_length:
        try:
            if int(content_length) > max_bytes:
                raise HTTPException(status_code=413, detail="Request body too large")
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="Invalid content length") from exc

    body = await request.body()
    if len(body) > max_bytes:
        raise HTTPException(status_code=413, detail="Request body too large")
    if not body:
        return {}

    try:
        return json.loads(body)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail="Invalid JSON") from exc


def normalize_sync_channels(channels):
    """동기화 대상 채널 목록을 검증하고 중복을 제거한다."""
    if channels is None:
        return list(CHANNEL_IDS), {}
    if not isinstance(channels, list):
        raise HTTPException(status_code=422, detail="channels must be a list")
    if len(channels) > MAX_SYNC_CHANNELS:
        raise HTTPException(status_code=422, detail="too many channels")

    channel_ids = []
    channel_names = {}
    seen = set()
    for item in channels:
        if not isinstance(item, dict):
            raise HTTPException(status_code=422, detail="invalid channel item")

        channel_id = str(item.get("id", "")).strip()
        if not CHANNEL_ID_PATTERN.fullmatch(channel_id):
            raise HTTPException(status_code=422, detail="invalid channel id")
        if not is_allowed_channel_id(channel_id):
            raise HTTPException(status_code=422, detail="channel is not allowed")
        if channel_id in seen:
            continue

        seen.add(channel_id)
        channel_ids.append(channel_id)
        channel_name = str(item.get("name") or channel_id).strip()
        channel_names[channel_id] = channel_name[:120]

    if not channel_ids:
        raise HTTPException(status_code=422, detail="channels must not be empty")

    return channel_ids, channel_names


def normalize_text_param(value: Optional[str], field_name: str, max_length: int = MAX_SEARCH_TEXT_LENGTH) -> Optional[str]:
    """사용자 문자열 파라미터 길이를 제한한다."""
    if value is None:
        return None
    normalized = value.strip()
    if len(normalized) > max_length:
        raise HTTPException(status_code=422, detail=f"{field_name} is too long")
    return normalized


def validate_optional_channel_id(channel_id: Optional[str]) -> Optional[str]:
    if channel_id is None:
        return None
    normalized = channel_id.strip()
    if not CHANNEL_ID_PATTERN.fullmatch(normalized):
        raise HTTPException(status_code=422, detail="invalid channel id")
    return normalized


def require_channel_id(channel_id: Optional[str]) -> str:
    normalized = validate_optional_channel_id(channel_id)
    if not normalized:
        raise HTTPException(status_code=422, detail="channel_id is required")
    return normalized


def validate_year(value: str) -> str:
    normalized = value.strip()
    if not YEAR_PATTERN.fullmatch(normalized):
        raise HTTPException(status_code=422, detail="invalid year")
    year = int(normalized)
    if year < 2000 or year > 2100:
        raise HTTPException(status_code=422, detail="invalid year")
    return normalized


def parse_channel_id_list(value: Optional[str], field_name: str) -> Optional[str]:
    if not value:
        return None
    members = [member.strip() for member in value.split(",") if member.strip()]
    if len(members) > MAX_FILTER_ITEMS:
        raise HTTPException(status_code=422, detail=f"{field_name} has too many items")
    for member in members:
        if not CHANNEL_ID_PATTERN.fullmatch(member):
            raise HTTPException(status_code=422, detail=f"invalid {field_name}")
    return ",".join(members)


def parse_dates_filter(value: Optional[str]) -> Optional[list]:
    if not value:
        return None
    dates = [date.strip() for date in value.split(",") if date.strip()]
    if len(dates) > MAX_FILTER_ITEMS:
        raise HTTPException(status_code=422, detail="filter_dates has too many items")
    for date in dates:
        if not DATE_PATTERN.fullmatch(date):
            raise HTTPException(status_code=422, detail="invalid filter_dates")
    return dates


def parse_years_filter(value: Optional[str]) -> Optional[list]:
    if not value:
        return None
    years = [validate_year(year) for year in value.split(",") if year.strip()]
    if len(years) > MAX_FILTER_ITEMS:
        raise HTTPException(status_code=422, detail="filter_years has too many items")
    return [int(year) for year in years]


def parse_months_filter(value: Optional[str]) -> Optional[list]:
    if not value:
        return None
    try:
        months = [int(month.strip()) for month in value.split(",") if month.strip()]
    except ValueError as exc:
        raise HTTPException(status_code=422, detail="invalid filter_months") from exc
    if len(months) > 12:
        raise HTTPException(status_code=422, detail="filter_months has too many items")
    if any(month < 1 or month > 12 for month in months):
        raise HTTPException(status_code=422, detail="invalid filter_months")
    return months


def normalize_holodex_proxy_path(path: str) -> str:
    """프록시는 프론트가 실제로 쓰는 Holodex 경로만 허용한다."""
    normalized = path.strip("/")
    if "\\" in normalized or ".." in normalized or "//" in normalized:
        raise HTTPException(status_code=404, detail="Not found")
    if normalized not in ALLOWED_HOLODEX_PROXY_PATHS:
        raise HTTPException(status_code=404, detail="Not found")
    return normalized


def is_blocked_static_path(path: str) -> bool:
    """정적 파일 마운트가 민감 파일을 노출하지 못하게 막는다."""
    normalized = path.lstrip("/").lower()
    if not normalized:
        return False
    if normalized.startswith((".git/", ".guard/", ".agent/")):
        return True
    if normalized in BLOCKED_STATIC_NAMES:
        return True
    return any(normalized.endswith(suffix) for suffix in BLOCKED_STATIC_SUFFIXES)


# --- 보안: Rate Limiting (D-05) ---
rate_limit_cache = TTLCache(maxsize=1000, ttl=60)  # IP별 요청 횟수 (1분)


def check_rate_limit(request: Request, limit: int = 30, path_group: str = "default"):
    """IP + 경로 그룹 기반 rate limiting (분당 limit회)"""
    client_ip = get_client_ip(request)
    # IP + 경로 그룹으로 독립 카운터 운영
    cache_key = f"{client_ip}:{path_group}"
    current_count = rate_limit_cache.get(cache_key, 0)
    if current_count >= limit:
        raise HTTPException(status_code=429, detail="Too many requests")
    rate_limit_cache[cache_key] = current_count + 1



# --- Sync Status (상세 정보 추가) ---
sync_status = {
    "isSyncing": False,
    "lastSyncTime": None,
    "totalChannels": len(CHANNEL_IDS),
    "syncedChannels": 0,
    "currentChannel": None,      # 현재 처리 중인 채널명
    "totalVideos": 0,            # 총 다운로드한 영상 수
    "cancelled": False           # 취소 플래그
}

# --- HTTP Client (최적화) ---
http_client: Optional[httpx.AsyncClient] = None
VIDEO_SYNC_LIMIT = 50
VIDEO_SYNC_MAX_RETRIES = 5
VIDEO_SYNC_DELAY_SEC = 0.05


def get_sync_channel_name(channel_id: str) -> str:
    """동기화 화면에 표시할 채널명을 찾는다."""
    channel_names = sync_status.get("channelNames", {})
    if channel_id in channel_names:
        return channel_names[channel_id]

    from channels import CHANNELS
    channel_info = next((ch for ch in CHANNELS if ch["id"] == channel_id), None)
    return channel_info["name"] if channel_info else channel_id


def build_video_sync_url(filter_name: str, channel_id: str, offset: int) -> str:
    """Holodex 영상 동기화 URL을 만든다."""
    return (
        "https://holodex.net/api/v2/videos"
        f"?{filter_name}={channel_id}"
        f"&status=past,missing&type=stream&limit={VIDEO_SYNC_LIMIT}"
        f"&offset={offset}&sort=available_at&order=desc&include=mentions,songs"
    )


def should_stop_video_sync(filter_name: str, full_sync: bool, new_count: int) -> bool:
    """빠른 갱신은 새 영상이 없는 지점에서 멈추고, 전체 동기화만 끝까지 훑는다."""
    if full_sync:
        return False
    return new_count == 0


def resolve_sync_api_key(body_api_key: Optional[str]) -> str:
    """DB 동기화에는 서버 환경변수 키를 우선 사용한다."""
    server_key = os.environ.get("HOLODEX_API_KEY", "").strip()
    if server_key:
        return server_key
    if not IS_PRODUCTION and body_api_key:
        return body_api_key.strip()
    raise HTTPException(status_code=500, detail="Sync API key is not configured")


async def sync_video_query(channel_id: str, channel_name: str, api_key: Optional[str], full_sync: bool, filter_name: str, label: str) -> int:
    """단일 Holodex 영상 쿼리를 끝까지 동기화한다."""
    global http_client, sync_status

    offset = 0
    retry_count = 0
    channel_video_count = 0
    headers = {"X-APIKEY": api_key} if api_key else {}

    while True:
        if sync_status.get("cancelled", False):
            print(f"⏹️ Sync cancelled for {channel_name} ({label})")
            break

        try:
            sync_status["currentChannel"] = f"{channel_name} · {label}"
            url = build_video_sync_url(filter_name, channel_id, offset)
            response = await http_client.get(url, headers=headers)

            if response.status_code == 429:
                retry_count += 1
                if retry_count > VIDEO_SYNC_MAX_RETRIES:
                    print(f"❌ Max retries exceeded for {channel_name} ({label})")
                    break
                backoff_ms = min(3000 * (2 ** (retry_count - 1)), 30000)
                print(f"⚠️ Rate Limit (429) for {channel_name} ({label}). Retry {retry_count}/{VIDEO_SYNC_MAX_RETRIES}, waiting {backoff_ms/1000}s...")
                await asyncio.sleep(backoff_ms / 1000)
                continue

            retry_count = 0
            if response.status_code != 200:
                raise Exception(f"API Error: {response.status_code}")

            videos = response.json()
            if not videos:
                break

            loop = asyncio.get_event_loop()
            new_count = await loop.run_in_executor(
                db_executor,
                db.insert_videos_transaction,
                videos
            )

            channel_video_count += len(videos)
            sync_status["totalVideos"] += len(videos)
            print(f"   {channel_name} ({label}): Fetched {len(videos)}, New: {new_count} (Total: {channel_video_count})")

            if should_stop_video_sync(filter_name, full_sync, new_count):
                break

            if len(videos) < VIDEO_SYNC_LIMIT:
                break

            offset += VIDEO_SYNC_LIMIT
            await asyncio.sleep(VIDEO_SYNC_DELAY_SEC)

        except Exception as e:
            print(f"❌ Sync error for {channel_name} ({label}): {e}")
            break

    return channel_video_count


async def sync_channel_videos(channel_id: str, api_key: Optional[str], full_sync: bool = False):
    """채널 업로드와 해당 채널이 멘션된 영상을 함께 동기화한다."""
    channel_name = get_sync_channel_name(channel_id)
    print(f"🔄 Syncing videos for {channel_name} ({channel_id}) (Full Sync: {full_sync})...")

    own_count = await sync_video_query(channel_id, channel_name, api_key, full_sync, "channel_id", "업로드")
    mentioned_count = await sync_video_query(channel_id, channel_name, api_key, full_sync, "mentioned_channel_id", "멘션")

    print(f"✅ Sync complete for {channel_name} (uploads: {own_count}, mentions: {mentioned_count})")


async def run_sync(api_key: Optional[str], full_sync: bool, channel_ids: list = None):
    """백그라운드 동기화 실행 (개선된 진행률)"""
    global sync_status
    
    # 채널 목록이 없으면 기본값 사용
    if channel_ids is None:
        channel_ids = CHANNEL_IDS
    
    async def sync_and_count(channel_id):
        """채널 동기화 후 카운터 증가"""
        try:
            await sync_channel_videos(channel_id, api_key, full_sync)
        except Exception as e:
            print(f"❌ Failed for {channel_id}: {e}")
        finally:
            sync_status["syncedChannels"] += 1
    
    try:
        print(f"🚀 Starting sync for {len(channel_ids)} channels...")

        semaphore = asyncio.Semaphore(SYNC_CONCURRENCY)

        async def bounded_sync(channel_id):
            async with semaphore:
                await sync_and_count(channel_id)

        tasks = [bounded_sync(ch) for ch in channel_ids]
        await asyncio.gather(*tasks, return_exceptions=True)
        
        if sync_status.get("cancelled"):
            print("⏹️ Sync was cancelled by user")
        else:
            print(f"🏁 All channels synced! Total videos: {sync_status['totalVideos']}")
    except Exception as e:
        print(f"Global sync error: {e}")
    finally:
        sync_status["isSyncing"] = False
        sync_status["cancelled"] = False
        sync_status["lastSyncTime"] = int(time.time() * 1000)


def reset_sync_status(channel_ids: list[str], channel_names: dict | None = None) -> None:
    """동기화 상태를 새 작업 기준으로 초기화한다."""
    sync_status["isSyncing"] = True
    sync_status["syncedChannels"] = 0
    sync_status["totalVideos"] = 0
    sync_status["currentChannel"] = None
    sync_status["cancelled"] = False
    sync_status["totalChannels"] = len(channel_ids)
    sync_status["channelNames"] = channel_names or {}


async def auto_incremental_sync_loop() -> None:
    """운영 서버에서 주기적으로 신규 영상만 빠르게 동기화한다."""
    await asyncio.sleep(AUTO_SYNC_INITIAL_DELAY_SECONDS)
    while True:
        api_key = os.environ.get("HOLODEX_API_KEY", "").strip()
        if not api_key:
            print("AUTO_SYNC_ENABLED is true, but HOLODEX_API_KEY is missing. Skipping auto sync.")
        elif sync_status.get("isSyncing"):
            print("Auto sync skipped because another sync is already running.")
        else:
            channel_ids = list(CHANNEL_IDS)
            print(f"Starting scheduled incremental sync for {len(channel_ids)} channels.")
            reset_sync_status(channel_ids)
            await run_sync(api_key, full_sync=False, channel_ids=channel_ids)

        await asyncio.sleep(AUTO_SYNC_INTERVAL_SECONDS)


# --- Lifespan (안정성 개선) ---
@asynccontextmanager
async def lifespan(app: FastAPI):
    global http_client
    if IS_PRODUCTION and not has_strong_admin_token():
        print("⚠️ WARNING: ADMIN_TOKEN is missing or weak. Admin endpoints will reject requests.")
    # 타임아웃 증가 및 안정성 향상
    http_client = httpx.AsyncClient(
        timeout=httpx.Timeout(30.0, connect=10.0),  # 타임아웃 증가
        limits=httpx.Limits(max_connections=50, max_keepalive_connections=10),
        http2=False  # HTTP/1.1 사용 (호환성)
    )
    print("✅ HTTP client initialized (optimized)")
    auto_sync_task = None
    if AUTO_SYNC_ENABLED:
        auto_sync_task = asyncio.create_task(auto_incremental_sync_loop())
        print(f"✅ Auto incremental sync enabled every {AUTO_SYNC_INTERVAL_SECONDS}s")
    try:
        yield
    finally:
        if auto_sync_task:
            auto_sync_task.cancel()
            try:
                await auto_sync_task
            except asyncio.CancelledError:
                pass
    await http_client.aclose()
    db_executor.shutdown(wait=False)
    print("✅ HTTP client and DB executor closed")


# --- FastAPI App (최적화: ORJSONResponse 사용) ---
app = FastAPI(
    title="HoloProject", 
    lifespan=lifespan,
    default_response_class=ORJSONResponse if HAS_ORJSON else JSONResponse
)

# D-03: CORS 설정 - 운영 도메인 화이트리스트
ALLOWED_ORIGINS = os.environ.get(
    "ALLOWED_ORIGINS", 
    "http://localhost:3000,https://holo-search.xyz,https://holosearch.xyz"
).split(",")

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=False,  # 보안: credentials 허용 제거
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type", "Authorization", "X-APIKEY"],
)


@app.middleware("http")
async def edge_safety_middleware(request: Request, call_next):
    path = request.url.path

    if not path.startswith("/api/") and is_blocked_static_path(path):
        return JSONResponse({"error": "Not found"}, status_code=404)

    if path.startswith("/api/"):
        if len(str(request.url.query).encode("utf-8")) > MAX_QUERY_STRING_BYTES:
            return JSONResponse({"error": "Query string too large"}, status_code=413)

        limit = 120
        path_group = "api"
        if path in {"/api/sync", "/api/sync/cancel"}:
            limit = 20
            path_group = "sync"
        elif path in {"/api/search", "/api/songs", "/api/song-details"}:
            limit = 90
            path_group = "search"
        elif path.startswith("/api/v2/"):
            limit = 180
            path_group = "proxy"

        try:
            check_rate_limit(request, limit=limit, path_group=path_group)
        except HTTPException as exc:
            return JSONResponse({"error": exc.detail}, status_code=exc.status_code)

    response = await call_next(request)

    # 정적 파일 캐시 정책 (Cloudflare Edge + 브라우저)
    # s-maxage = CDN 캐시, max-age = 브라우저 캐시
    if path == "/" or path.endswith(".html"):
        # HTML: 짧은 캐시 (배포 후 빠른 반영)
        response.headers["Cache-Control"] = "public, max-age=60, s-maxage=300"
    elif path.endswith(".js") or path.endswith(".css"):
        # JS/CSS는 파일명 해시가 없어서 CDN에도 보관하지 않는다.
        response.headers["Cache-Control"] = "no-store, max-age=0"
    elif any(path.endswith(ext) for ext in (".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico", ".webp")):
        # 이미지: 장기 캐시
        response.headers["Cache-Control"] = "public, max-age=86400, s-maxage=604800"

    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    response.headers.setdefault("Permissions-Policy", "camera=(), microphone=(), geolocation=()")

    return response


# --- API Endpoints ---
@app.post("/api/sync")
async def trigger_sync(request: Request, background_tasks: BackgroundTasks):
    """동기화 트리거 (인증 필요)"""
    global sync_status
    
    if sync_status["isSyncing"]:
        return JSONResponse({"message": "Sync already in progress"}, status_code=409)

    verify_admin(request)

    body = await read_limited_json(request, MAX_SYNC_BODY_BYTES)
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="Invalid JSON")

    body_api_key = body.get("apiKey")
    if body_api_key is not None and not isinstance(body_api_key, str):
        raise HTTPException(status_code=422, detail="invalid api key")
    api_key = resolve_sync_api_key(body_api_key)

    full_sync = body.get("fullSync", False) is True
    channel_ids, channel_names = normalize_sync_channels(body.get("channels"))
    
    print(f"🚀 Starting background sync for {len(channel_ids)} channels (Full: {full_sync})...")
    
    reset_sync_status(channel_ids, channel_names)
    
    background_tasks.add_task(run_sync, api_key, full_sync, channel_ids)
    
    return {"message": "Sync started in background"}


@app.get("/api/sync/status")
async def get_sync_status():
    """동기화 상태 조회"""
    return {**sync_status, "dbSeed": db.get_seed_status()}


@app.post("/api/sync/cancel")
async def cancel_sync(request: Request):
    """동기화 취소 (인증 필요)"""
    verify_admin(request)
    global sync_status
    
    if not sync_status["isSyncing"]:
        return JSONResponse({"message": "No sync in progress"}, status_code=400)
    
    sync_status["cancelled"] = True
    print("⏹️ Sync cancel requested by user")
    
    return {"message": "Sync cancel requested"}


@app.get("/api/search")
async def search(
    q: Optional[str] = None,
    channel_id: Optional[str] = None,
    limit: int = Query(default=32, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    collab: Optional[str] = None,
    collab_mode: str = Query(default="or", pattern="^(or|and)$"),
    hide_unarchived: Optional[str] = None,
    filter_dates: Optional[str] = None,
    filter_years: Optional[str] = None,
    filter_months: Optional[str] = None,
    video_type: Optional[str] = Query(default=None, pattern="^(all|collab|music)$"),
):
    """로컬 DB 검색 (콜라보/날짜/년월 필터, 비디오 타입 필터)"""
    q = normalize_text_param(q, "q")
    channel_id = require_channel_id(channel_id)
    collab = parse_channel_id_list(collab, "collab")
    hide_flag = str(hide_unarchived).lower() == "true"
    dates_list = parse_dates_filter(filter_dates)
    years_list = parse_years_filter(filter_years)
    months_list = parse_months_filter(filter_months)
    
    print(f'🔍 DB Search: "{q}" in {channel_id}, collab={collab}, mode={collab_mode}, hideUnarchived={hide_flag}, dates={dates_list}, years={years_list}, months={months_list}, videoType={video_type}')
    
    try:
        loop = asyncio.get_event_loop()
        
        # 병렬로 검색 및 카운트 실행
        results_future = loop.run_in_executor(
            db_executor, db.search_videos, q, channel_id, limit, offset, collab, collab_mode, hide_flag, dates_list, years_list, months_list, video_type
        )
        count_future = loop.run_in_executor(
            db_executor, db.count_videos, q, channel_id, collab, collab_mode, hide_flag, dates_list, years_list, months_list, video_type
        )
        
        results, total = await asyncio.gather(results_future, count_future)
        
        return {
            "items": results,
            "total": total
        }
    except HTTPException:
        raise
    except Exception as e:
        print(f"Search failed: {e}")
        return JSONResponse({"error": "Search failed"}, status_code=500)


@app.get("/api/songs")
async def search_songs(
    q: Optional[str] = None,
    channel_id: Optional[str] = None,
    limit: int = Query(default=32, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    sort: str = Query(default="recent", pattern="^(recent|title|artist)$"),
    category: str = Query(default="all", pattern="^(all|original|unit_guest|cover)$"),
    collab: Optional[str] = None,
    collab_mode: str = Query(default="or", pattern="^(or|and)$"),
):
    """Holodex songs 기반 로컬 노래 DB 검색"""
    q = normalize_text_param(q, "q")
    channel_id = require_channel_id(channel_id)
    collab = parse_channel_id_list(collab, "collab")
    try:
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(
            db_executor, db.get_songs_response, q, channel_id, limit, offset, sort, category, collab, collab_mode
        )
    except Exception as e:
        print(f"Song search failed: {e}")
        return JSONResponse({"error": "Song search failed"}, status_code=500)


@app.get("/api/song-details")
async def song_details(
    title: Optional[str] = None,
    artist: Optional[str] = None,
    itunesid: Optional[str] = None,
    limit: int = Query(default=300, ge=1, le=300),
    offset: int = Query(default=0, ge=0),
):
    """로컬 DB에서 같은 곡의 모든 노래 기록을 조회"""
    title = normalize_text_param(title, "title", 300)
    artist = normalize_text_param(artist, "artist", 240)
    itunesid = normalize_text_param(itunesid, "itunesid", 80)
    if not title and not itunesid:
        raise HTTPException(status_code=422, detail="title or itunesid is required")

    try:
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(
            db_executor, db.get_song_details_response, title, artist, itunesid, limit, offset
        )
    except Exception as e:
        print(f"Song detail failed: {e}")
        return JSONResponse({"error": "Song detail failed"}, status_code=500)


@app.get("/api/channel-index")
async def get_channel_index():
    """로컬 DB에 저장된 채널 인덱스"""
    try:
        loop = asyncio.get_event_loop()
        items = await loop.run_in_executor(db_executor, db.get_channel_index)
        allowed_items = [
            item for item in items
            if is_allowed_channel_id(item.get("id") if isinstance(item, dict) else None)
        ]
        return {"items": allowed_items}
    except Exception as e:
        print(f"Channel index failed: {e}")
        return JSONResponse({"error": "Channel index failed"}, status_code=500)



# --- Statistics API Endpoints ---
@app.get("/api/stats/yearly")
async def get_yearly_stats(channel_id: str):
    """년도별 방송 통계"""
    channel_id = require_channel_id(channel_id)
    try:
        loop = asyncio.get_event_loop()
        stats = await loop.run_in_executor(db_executor, db.get_yearly_stats, channel_id)
        return {"items": stats}
    except Exception as e:
        print(f"Yearly stats failed: {e}")
        return JSONResponse({"error": "Stats request failed"}, status_code=500)


@app.get("/api/stats/monthly")
async def get_monthly_stats(channel_id: str, year: str):
    """월별 방송 통계"""
    channel_id = require_channel_id(channel_id)
    year = validate_year(year)
    try:
        loop = asyncio.get_event_loop()
        stats = await loop.run_in_executor(db_executor, db.get_monthly_stats, channel_id, year)
        return {"items": stats}
    except Exception as e:
        print(f"Monthly stats failed: {e}")
        return JSONResponse({"error": "Stats request failed"}, status_code=500)


@app.get("/api/stats/yearly-membership")
async def get_yearly_membership_stats(channel_id: str):
    """년도별 멤버십 통계"""
    channel_id = require_channel_id(channel_id)
    try:
        loop = asyncio.get_event_loop()
        stats = await loop.run_in_executor(db_executor, db.get_yearly_membership_stats, channel_id)
        return {"items": stats}
    except Exception as e:
        print(f"Yearly membership stats failed: {e}")
        return JSONResponse({"error": "Stats request failed"}, status_code=500)


@app.get("/api/stats/membership")
async def get_membership_stats(channel_id: str, year: str):
    """월별 멤버십 방송 통계"""
    channel_id = require_channel_id(channel_id)
    year = validate_year(year)
    try:
        loop = asyncio.get_event_loop()
        stats = await loop.run_in_executor(db_executor, db.get_monthly_membership_stats, channel_id, year)
        return {"items": stats}
    except Exception as e:
        print(f"Membership stats failed: {e}")
        return JSONResponse({"error": "Stats request failed"}, status_code=500)


@app.get("/api/stats/collab")
async def get_collab_stats(channel_id: str):
    """콜라보 멤버별 횟수"""
    channel_id = require_channel_id(channel_id)
    try:
        loop = asyncio.get_event_loop()
        stats = await loop.run_in_executor(db_executor, db.get_collab_stats, channel_id)
        return {"items": stats}
    except Exception as e:
        print(f"Collab stats failed: {e}")
        return JSONResponse({"error": "Stats request failed"}, status_code=500)


@app.get("/api/stats/yearly-collab")
async def get_yearly_collab_stats(channel_id: str, year: str):
    """특정 연도의 콜라보 멤버별 통계"""
    channel_id = require_channel_id(channel_id)
    year = validate_year(year)
    try:
        loop = asyncio.get_event_loop()
        stats = await loop.run_in_executor(db_executor, db.get_yearly_collab_stats, channel_id, year)
        return {"items": stats}
    except Exception as e:
        print(f"Yearly collab stats failed: {e}")
        return JSONResponse({"error": "Stats request failed"}, status_code=500)


@app.get("/api/stats/topic")
async def get_topic_stats(channel_id: str):
    """전체 컨텐츠/게임 통계"""
    channel_id = require_channel_id(channel_id)
    try:
        loop = asyncio.get_event_loop()
        stats = await loop.run_in_executor(db_executor, db.get_topic_stats, channel_id)
        return {"items": stats}
    except Exception as e:
        print(f"Topic stats failed: {e}")
        return JSONResponse({"error": "Stats request failed"}, status_code=500)


@app.get("/api/stats/yearly-topic")
async def get_yearly_topic_stats(channel_id: str, year: str):
    """연도별 컨텐츠/게임 통계"""
    channel_id = require_channel_id(channel_id)
    year = validate_year(year)
    try:
        loop = asyncio.get_event_loop()
        stats = await loop.run_in_executor(db_executor, db.get_yearly_topic_stats, channel_id, year)
        return {"items": stats}
    except Exception as e:
        print(f"Yearly topic stats failed: {e}")
        return JSONResponse({"error": "Stats request failed"}, status_code=500)


# --- Holodex API Proxy (최적화) ---
@app.api_route("/api/v2/{path:path}", methods=["GET", "POST"])
async def proxy_holodex(path: str, request: Request):
    """Holodex API 프록시"""
    global http_client
    path = normalize_holodex_proxy_path(path)

    forwarded_key = request.headers.get("x-apikey")
    if forwarded_key and len(forwarded_key) > 256:
        raise HTTPException(status_code=422, detail="invalid api key")
    proxy_api_key = forwarded_key
    if not proxy_api_key and path == "live":
        proxy_api_key = os.environ.get("HOLODEX_API_KEY", "").strip()
    
    # 캐시 키 생성
    cache_key = f"{request.method}:{request.url.path}?{request.url.query}"
    
    # 사용자 API 키가 붙은 응답은 다른 사용자에게 재사용하지 않는다.
    can_use_proxy_cache = request.method == "GET" and not forwarded_key

    # GET 요청 캐시 확인
    if can_use_proxy_cache and cache_key in cache:
        print(f"⚡ Serving cached: {path}")
        return JSONResponse(cache[cache_key])
    
    # 프록시 요청
    target_url = f"https://holodex.net/api/v2/{path}"
    if request.url.query:
        target_url += f"?{request.url.query}"
    
    # 라이브/예정은 일반 화면이라 서버 환경변수 키를 사용할 수 있다.
    headers = {}
    if proxy_api_key:
        headers["X-APIKEY"] = proxy_api_key
    
    try:
        if request.method == "GET":
            response = await http_client.get(target_url, headers=headers)
        else:
            content_length = request.headers.get("content-length")
            if content_length:
                try:
                    if int(content_length) > MAX_PROXY_BODY_BYTES:
                        raise HTTPException(status_code=413, detail="Request body too large")
                except ValueError as exc:
                    raise HTTPException(status_code=400, detail="Invalid content length") from exc
            body = await request.body()
            if len(body) > MAX_PROXY_BODY_BYTES:
                raise HTTPException(status_code=413, detail="Request body too large")
            response = await http_client.post(target_url, headers=headers, content=body)
        
        # 응답 내용이 비어있으면 빈 객체 반환
        if not response.content or len(response.content) == 0:
            return JSONResponse([], status_code=response.status_code)
        
        # JSON 파싱 시도
        try:
            data = response.json()
        except Exception:
            # JSON 파싱 실패 시 빈 배열 반환
            return JSONResponse([], status_code=response.status_code)
        
        # 성공 시 캐시 저장
        if response.status_code == 200 and can_use_proxy_cache:
            cache[cache_key] = data
        
        return JSONResponse(data, status_code=response.status_code)
    except HTTPException:
        raise
    except Exception as e:
        print(f"Proxy error: {e}")
        return JSONResponse({"error": "Proxy request failed"}, status_code=500)


# --- Channel Image Proxy (Holodex) ---
@app.get("/api/statics/channelImg/{channel_id}")
async def get_channel_image(channel_id: str):
    """채널 아이콘 이미지 프록시 (CORS 우회)"""
    if not CHANNEL_ID_PATTERN.fullmatch(channel_id):
        raise HTTPException(status_code=400, detail="Invalid channel id")

    cache_path = os.path.join(CHANNEL_IMAGE_CACHE_DIR, f"{channel_id}.png")
    if os.path.exists(cache_path):
        return FileResponse(
            cache_path,
            media_type="image/png",
            headers={"Cache-Control": "public, max-age=604800"}
        )

    try:
        url = f"https://holodex.net/statics/channelImg/{channel_id}.png"
        response = await http_client.get(url, follow_redirects=True, timeout=10.0)
        
        content_type = response.headers.get("content-type", "")
        if response.status_code == 200 and content_type.startswith("image/"):
            os.makedirs(CHANNEL_IMAGE_CACHE_DIR, exist_ok=True)
            temp_path = f"{cache_path}.tmp"
            with open(temp_path, "wb") as image_file:
                image_file.write(response.content)
            os.replace(temp_path, cache_path)

            # 이미지 직접 반환
            from fastapi.responses import Response
            return Response(
                content=response.content,
                media_type=content_type,
                headers={"Cache-Control": "public, max-age=604800"}  # 7일 캐시
            )
        else:
            # 404 등 에러 시 기본 플레이스홀더 반환
            return JSONResponse({"error": "Image not found"}, status_code=404)
    except Exception as e:
        print(f"Channel image proxy error: {e}")
        return JSONResponse({"error": "Channel image request failed"}, status_code=500)


# --- Static Files (로컬/배포 공통: public/) ---

@app.get("/")
async def serve_index():
    return FileResponse(f"{STATIC_DIR}/index.html")


# 정적 파일 마운트 (마지막에 배치)
app.mount("/", StaticFiles(directory=STATIC_DIR), name="static")


# --- Main ---
if __name__ == "__main__":
    import uvicorn
    
    print("🚀 Starting HoloProject Server (Python/FastAPI - Optimized)...")
    uvicorn.run(app, host="0.0.0.0", port=3000)
