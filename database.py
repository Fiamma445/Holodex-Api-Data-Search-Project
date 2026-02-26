"""
HoloProject Database Module
SQLite를 사용한 비디오 데이터베이스 관리
"""
import sqlite3
import json
import os
from typing import Optional
from contextlib import contextmanager

DEFAULT_DB_PATH = os.path.join(os.path.dirname(__file__), 'videos.db')
DB_PATH = os.environ.get("DB_PATH", DEFAULT_DB_PATH)

DB_DIR = os.path.dirname(DB_PATH)
if DB_DIR:
    os.makedirs(DB_DIR, exist_ok=True)


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
        
        # 인덱스 생성
        indexes = [
            'CREATE INDEX IF NOT EXISTS idx_channel_id ON videos(channel_id)',
            'CREATE INDEX IF NOT EXISTS idx_available_at ON videos(available_at DESC)',
            'CREATE INDEX IF NOT EXISTS idx_title ON videos(title)',
            'CREATE INDEX IF NOT EXISTS idx_channel_available ON videos(channel_id, available_at DESC)'
        ]
        for sql in indexes:
            cursor.execute(sql)
        
        conn.commit()
        print('✅ Database initialized')


def insert_video(video: dict) -> bool:
    """단일 비디오 삽입 (중복 무시)"""
    with get_connection() as conn:
        cursor = conn.cursor()
        channel = video.get('channel', {})
        
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
        conn.commit()
        return cursor.rowcount > 0


def insert_videos_transaction(videos: list) -> int:
    """트랜잭션으로 여러 비디오 삽입"""
    if not videos:
        return 0
    
    new_count = 0
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("BEGIN TRANSACTION")
        
        for video in videos:
            channel = video.get('channel', {})
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
            if cursor.rowcount > 0:
                new_count += 1
        
        cursor.execute("COMMIT")
    
    return new_count


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
        
        if channel_id:
            sql += " AND channel_id = ?"
            params.append(channel_id)
        
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
        
        # 콜라보 멤버 필터: OR/AND 모드 지원
        if collab_member:
            members = [m.strip() for m in collab_member.split(',') if m.strip()]
            if members:
                if collab_mode == 'and':
                    # AND 모드: 모든 멤버가 포함된 영상만
                    for member in members:
                        sql += " AND json_data LIKE ?"
                        params.append(f'%{member}%')
                else:
                    # OR 모드: 하나라도 포함된 영상
                    or_conditions = []
                    for member in members:
                        or_conditions.append("json_data LIKE ?")
                        params.append(f'%{member}%')
                    sql += f" AND ({' OR '.join(or_conditions)})"
        
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
        
        if channel_id:
            sql += " AND channel_id = ?"
            params.append(channel_id)
        
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
        
        # 콜라보 멤버 필터: OR/AND 모드 지원
        if collab_member:
            members = [m.strip() for m in collab_member.split(',') if m.strip()]
            if members:
                if collab_mode == 'and':
                    # AND 모드: 모든 멤버가 포함된 영상만
                    for member in members:
                        sql += " AND json_data LIKE ?"
                        params.append(f'%{member}%')
                else:
                    # OR 모드: 하나라도 포함된 영상
                    or_conditions = []
                    for member in members:
                        or_conditions.append("json_data LIKE ?")
                        params.append(f'%{member}%')
                    sql += f" AND ({' OR '.join(or_conditions)})"
        
        cursor.execute(sql, params)
        row = cursor.fetchone()
        
        return row['count'] if row else 0


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

