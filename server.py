"""
HoloProject Server (Optimized)
FastAPI 기반 웹 서버 - Holodex API 프록시 및 로컬 DB 검색
성능 최적화 버전
"""
import asyncio
import hmac
import os
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
STATIC_DIR = "public" if IS_PRODUCTION else "."

# --- 보안: 관리 API 인증 (D-02) ---
DEFAULT_ADMIN_TOKEN = "dev-token-change-me"
ADMIN_TOKEN = os.environ.get("ADMIN_TOKEN", "").strip()


def has_strong_admin_token() -> bool:
    return bool(ADMIN_TOKEN) and ADMIN_TOKEN != DEFAULT_ADMIN_TOKEN


def get_client_ip(request: Request) -> str:
    # Cloudflare proxy preserves original client IP in this header.
    cf_ip = request.headers.get("CF-Connecting-IP")
    if cf_ip:
        return cf_ip
    return request.client.host if request.client else "unknown"


def is_local_request(request: Request) -> bool:
    return get_client_ip(request) in {"127.0.0.1", "::1", "localhost"}


def verify_admin(request: Request):
    """관리 API 인증 검증 - Bearer 토큰 또는 X-APIKEY 방식"""
    # X-APIKEY 헤더가 있으면 인증 통과 (사용자의 Holodex API 키)
    api_key = request.headers.get("X-APIKEY", "")
    if api_key:
        return

    # Bearer 토큰 방식 (ADMIN_TOKEN 확인)
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer ") and has_strong_admin_token():
        token = auth[7:].strip()
        if token and hmac.compare_digest(token, ADMIN_TOKEN):
            return

    # 로컬 개발 환경 허용
    if not IS_PRODUCTION and is_local_request(request):
        return

    raise HTTPException(status_code=401, detail="Unauthorized")


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



def get_cache_duration(url: str) -> int:
    """URL에 따른 캐시 지속 시간 (초)"""
    if '/channels/' in url:
        return 3600  # 1시간
    if '/live' in url:
        return 30    # 30초 (더 빠른 업데이트)
    if '/videos' in url:
        return 300   # 5분
    return 30        # 기본 30초


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


async def sync_channel_videos(channel_id: str, api_key: Optional[str], full_sync: bool = False):
    """채널 비디오 동기화 (상세 진행률 추가)"""
    global http_client, sync_status
    
    # 채널명 찾기 (프론트엔드 전달 이름 우선)
    channel_names = sync_status.get("channelNames", {})
    if channel_id in channel_names:
        channel_name = channel_names[channel_id]
    else:
        from channels import CHANNELS
        channel_info = next((ch for ch in CHANNELS if ch["id"] == channel_id), None)
        channel_name = channel_info["name"] if channel_info else channel_id
    
    sync_status["currentChannel"] = channel_name
    print(f"🔄 Syncing videos for {channel_name} ({channel_id}) (Full Sync: {full_sync})...")
    
    offset = 0
    retry_count = 0
    LIMIT = 100
    MAX_RETRIES = 5
    channel_video_count = 0
    
    headers = {"X-APIKEY": api_key} if api_key else {}
    
    while True:
        # 취소 확인
        if sync_status.get("cancelled", False):
            print(f"⏹️ Sync cancelled for {channel_name}")
            break
            
        try:
            url = f"https://holodex.net/api/v2/videos?channel_id={channel_id}&status=past,missing&type=stream&limit={LIMIT}&offset={offset}&include=mentions"
            
            response = await http_client.get(url, headers=headers)
            
            # Rate limit 처리
            if response.status_code == 429:
                retry_count += 1
                if retry_count > MAX_RETRIES:
                    print(f"❌ Max retries exceeded for {channel_name}")
                    break
                backoff_ms = min(3000 * (2 ** (retry_count - 1)), 30000)
                print(f"⚠️ Rate Limit (429) for {channel_name}. Retry {retry_count}/{MAX_RETRIES}, waiting {backoff_ms/1000}s...")
                await asyncio.sleep(backoff_ms / 1000)
                continue
            
            retry_count = 0
            
            if response.status_code != 200:
                raise Exception(f"API Error: {response.status_code}")
            
            videos = response.json()
            
            if not videos:
                break
            
            # Thread Pool에서 DB 작업 실행 (비동기화)
            loop = asyncio.get_event_loop()
            new_count = await loop.run_in_executor(
                db_executor, 
                db.insert_videos_transaction, 
                videos
            )
            
            channel_video_count += len(videos)
            sync_status["totalVideos"] += len(videos)
            print(f"   {channel_name}: Fetched {len(videos)}, New: {new_count} (Total: {channel_video_count})")
            
            if new_count == 0 and not full_sync:
                break
            
            if len(videos) < LIMIT:
                break
            
            offset += LIMIT
            await asyncio.sleep(0.05)  # 50ms 딜레이
            
        except Exception as e:
            print(f"❌ Sync error for {channel_name}: {e}")
            break
    
    print(f"✅ Sync complete for {channel_name} ({channel_video_count} videos)")


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
        
        # 모든 채널 병렬 처리 (속도 우선)
        tasks = [sync_and_count(ch) for ch in channel_ids]
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
    yield
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

    if path.startswith("/api/"):
        limit = 120
        path_group = "api"
        if path in {"/api/sync", "/api/sync/cancel"}:
            limit = 20
            path_group = "sync"
        elif path == "/api/search":
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
        # JS/CSS: 긴 캐시 (배포 시 Cloudflare purge로 대응)
        response.headers["Cache-Control"] = "public, max-age=3600, s-maxage=86400"
    elif any(path.endswith(ext) for ext in (".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico", ".webp")):
        # 이미지: 장기 캐시
        response.headers["Cache-Control"] = "public, max-age=86400, s-maxage=604800"

    return response


# --- API Endpoints ---
@app.post("/api/sync")
async def trigger_sync(request: Request, background_tasks: BackgroundTasks):
    """동기화 트리거 (인증 필요)"""
    global sync_status
    
    if sync_status["isSyncing"]:
        return JSONResponse({"message": "Sync already in progress"}, status_code=409)
    
    body = await request.json()
    api_key = body.get("apiKey")
    full_sync = body.get("fullSync", False)
    channels = body.get("channels")  # [{id, name}, ...] 형태

    verify_admin(request)  # D-02: 관리 API 인증
    
    # 채널 목록 처리
    if channels:
        channel_ids = [ch["id"] for ch in channels]
        # 채널 이름 매핑 딕셔너리 생성
        channel_names = {ch["id"]: ch["name"] for ch in channels}
    else:
        channel_ids = CHANNEL_IDS
        channel_names = {}
    
    print(f"🚀 Starting background sync for {len(channel_ids)} channels (Full: {full_sync})...")
    
    # 상태 초기화
    sync_status["isSyncing"] = True
    sync_status["syncedChannels"] = 0
    sync_status["totalVideos"] = 0
    sync_status["currentChannel"] = None
    sync_status["cancelled"] = False
    sync_status["totalChannels"] = len(channel_ids)
    sync_status["channelNames"] = channel_names  # 채널 이름 저장
    
    background_tasks.add_task(run_sync, api_key, full_sync, channel_ids)
    
    return {"message": "Sync started in background"}


@app.get("/api/sync/status")
async def get_sync_status():
    """동기화 상태 조회"""
    return sync_status


@app.post("/api/sync/cancel")
async def cancel_sync(request: Request):
    """동기화 취소 (인증 필요)"""
    verify_admin(request)  # D-02: 관리 API 인증
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
    video_type: Optional[str] = Query(default=None, pattern="^(all|music)$"),
):
    """로컬 DB 검색 (콜라보/날짜/년월 필터, 비디오 타입 필터)"""
    hide_flag = str(hide_unarchived).lower() == "true"
    
    # filter_dates 파싱: comma-separated string → list
    dates_list = None
    if filter_dates:
        dates_list = [d.strip() for d in filter_dates.split(',') if d.strip()]
    
    # filter_years 파싱: comma-separated string → list of int
    years_list = None
    if filter_years:
        try:
            years_list = [int(y.strip()) for y in filter_years.split(',') if y.strip()]
        except ValueError as exc:
            raise HTTPException(status_code=422, detail="filter_years must be comma-separated integers") from exc
    
    # filter_months 파싱: comma-separated string → list of int
    months_list = None
    if filter_months:
        try:
            months_list = [int(m.strip()) for m in filter_months.split(',') if m.strip()]
        except ValueError as exc:
            raise HTTPException(status_code=422, detail="filter_months must be comma-separated integers") from exc
        if any(m < 1 or m > 12 for m in months_list):
            raise HTTPException(status_code=422, detail="filter_months must be between 1 and 12")
    
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



# --- Statistics API Endpoints ---
@app.get("/api/stats/yearly")
async def get_yearly_stats(channel_id: str):
    """년도별 방송 통계"""
    try:
        loop = asyncio.get_event_loop()
        stats = await loop.run_in_executor(db_executor, db.get_yearly_stats, channel_id)
        return {"items": stats}
    except Exception as e:
        print(f"Yearly stats failed: {e}")
        return JSONResponse({"error": str(e)}, status_code=500)


@app.get("/api/stats/monthly")
async def get_monthly_stats(channel_id: str, year: str):
    """월별 방송 통계"""
    try:
        loop = asyncio.get_event_loop()
        stats = await loop.run_in_executor(db_executor, db.get_monthly_stats, channel_id, year)
        return {"items": stats}
    except Exception as e:
        print(f"Monthly stats failed: {e}")
        return JSONResponse({"error": str(e)}, status_code=500)


@app.get("/api/stats/yearly-membership")
async def get_yearly_membership_stats(channel_id: str):
    """년도별 멤버십 통계"""
    try:
        loop = asyncio.get_event_loop()
        stats = await loop.run_in_executor(db_executor, db.get_yearly_membership_stats, channel_id)
        return {"items": stats}
    except Exception as e:
        print(f"Yearly membership stats failed: {e}")
        return JSONResponse({"error": str(e)}, status_code=500)


@app.get("/api/stats/membership")
async def get_membership_stats(channel_id: str, year: str):
    """월별 멤버십 방송 통계"""
    try:
        loop = asyncio.get_event_loop()
        stats = await loop.run_in_executor(db_executor, db.get_monthly_membership_stats, channel_id, year)
        return {"items": stats}
    except Exception as e:
        print(f"Membership stats failed: {e}")
        return JSONResponse({"error": str(e)}, status_code=500)


@app.get("/api/stats/collab")
async def get_collab_stats(channel_id: str):
    """콜라보 멤버별 횟수"""
    try:
        loop = asyncio.get_event_loop()
        stats = await loop.run_in_executor(db_executor, db.get_collab_stats, channel_id)
        return {"items": stats}
    except Exception as e:
        print(f"Collab stats failed: {e}")
        return JSONResponse({"error": str(e)}, status_code=500)


@app.get("/api/stats/yearly-collab")
async def get_yearly_collab_stats(channel_id: str, year: str):
    """특정 연도의 콜라보 멤버별 통계"""
    try:
        loop = asyncio.get_event_loop()
        stats = await loop.run_in_executor(db_executor, db.get_yearly_collab_stats, channel_id, year)
        return {"items": stats}
    except Exception as e:
        print(f"Yearly collab stats failed: {e}")
        return JSONResponse({"error": str(e)}, status_code=500)


@app.get("/api/stats/topic")
async def get_topic_stats(channel_id: str):
    """전체 컨텐츠/게임 통계"""
    try:
        loop = asyncio.get_event_loop()
        stats = await loop.run_in_executor(db_executor, db.get_topic_stats, channel_id)
        return {"items": stats}
    except Exception as e:
        print(f"Topic stats failed: {e}")
        return JSONResponse({"error": str(e)}, status_code=500)


@app.get("/api/stats/yearly-topic")
async def get_yearly_topic_stats(channel_id: str, year: str):
    """연도별 컨텐츠/게임 통계"""
    try:
        loop = asyncio.get_event_loop()
        stats = await loop.run_in_executor(db_executor, db.get_yearly_topic_stats, channel_id, year)
        return {"items": stats}
    except Exception as e:
        print(f"Yearly topic stats failed: {e}")
        return JSONResponse({"error": str(e)}, status_code=500)


# --- Holodex API Proxy (최적화) ---
@app.api_route("/api/v2/{path:path}", methods=["GET", "POST"])
async def proxy_holodex(path: str, request: Request):
    """Holodex API 프록시"""
    global http_client
    
    # 캐시 키 생성
    cache_key = f"{request.method}:{request.url.path}?{request.url.query}"
    
    # GET 요청 캐시 확인
    if request.method == "GET" and cache_key in cache:
        print(f"⚡ Serving cached: {path}")
        return JSONResponse(cache[cache_key])
    
    # 프록시 요청
    target_url = f"https://holodex.net/api/v2/{path}"
    if request.url.query:
        target_url += f"?{request.url.query}"
    
    # API 키 헤더 전달
    headers = {}
    if "x-apikey" in request.headers:
        headers["X-APIKEY"] = request.headers["x-apikey"]
    
    try:
        if request.method == "GET":
            response = await http_client.get(target_url, headers=headers)
        else:
            body = await request.body()
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
        if response.status_code == 200 and request.method == "GET":
            cache[cache_key] = data
        
        return JSONResponse(data, status_code=response.status_code)
    
    except Exception as e:
        print(f"Proxy error: {e}")
        return JSONResponse({"error": str(e)}, status_code=500)


# --- Channel Image Proxy (Holodex) ---
@app.get("/api/statics/channelImg/{channel_id}")
async def get_channel_image(channel_id: str):
    """채널 아이콘 이미지 프록시 (CORS 우회)"""
    try:
        url = f"https://holodex.net/statics/channelImg/{channel_id}"
        response = await http_client.get(url, follow_redirects=True, timeout=10.0)
        
        if response.status_code == 200:
            # 이미지 직접 반환
            from fastapi.responses import Response
            return Response(
                content=response.content,
                media_type=response.headers.get("content-type", "image/jpeg"),
                headers={"Cache-Control": "public, max-age=86400"}  # 24시간 캐시
            )
        else:
            # 404 등 에러 시 기본 플레이스홀더 반환
            return JSONResponse({"error": "Image not found"}, status_code=404)
    except Exception as e:
        print(f"Channel image proxy error: {e}")
        return JSONResponse({"error": str(e)}, status_code=500)


# --- Static Files (개발: 루트, 배포: public/) ---

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
