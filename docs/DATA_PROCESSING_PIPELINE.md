# Data Processing & Analysis Pipeline

HoloProject의 코어 밸류는 단순한 웹 서빙이 아닌, 비정형 **JSON 데이터의 구조화 및 ETL 파이프라인** 설계와 **복합 SQL 쿼리를 활용한 인사이트 도출**에 있습니다. 이 문서는 데이터 분석가 관점에서 수집된 채널 데이터를 어떻게 전처리하고 통계화했는지 증명합니다.

---

## 1. Data Transformation

### 1.1 하이브리드 스키마 설계
기존 RDBMS의 엄격한 스키마 한계를 우회하기 위해 **SQLite JSON1 Extension**을 활용한 하이브리드 모델링을 적용했습니다.

```sql
CREATE TABLE videos (
    id TEXT PRIMARY KEY,
    title TEXT,
    channel_id TEXT,
    available_at TEXT, -- ISO 8601 시계열 분석용
    topic_id TEXT,     -- 컨텐츠 분류 핵심 키
    json_data TEXT     -- 원본 비정형 메타데이터 보존
)
```
- **Why?**: 유튜브 API 정책 변경이나 신규 필드(ex: `mentions` 콜라보 구조)가 추가되더라도 DB 마이그레이션 없이 `json_data`에서 즉시 파싱하여 분석에 투입할 수 있는 유연성을 확보했습니다.

### 1.2 Data Cleansing
분석에 방해되는 노이즈 데이터를 SQL 단에서 필터링하여 지표의 신뢰성을 높였습니다.
- **동적 아카이브(Unarchived) 필터링 통제**: `status = 'missing'` 및 비정상 썸네일 구조(`"topic_id": null`) 데이터는 하드코딩으로 완전히 삭제하지 않고, 프론트엔드 UI의 **'Unarchived 토글 버튼'**과 연동하여 사용자가 켜고 끌 수 있게 동적 필터 로직으로 전환했습니다.
- **분석 도메인 분리**: 본 목적(게임/방송 통계)을 흐리는 노이즈인 `shorts`, `announce`, `morning` 등의 더미 태그는 SQL 단에서 `NOT IN` 조건으로 일괄 소거했습니다.

### 1.3 Collaboration 네트워크 통계 추출
단순한 메타데이터 수집을 넘어, 원본 데이터 내 배열로 중첩된 `mentions` 필드(합방 참여자 목록)를 파싱하여 버튜버 간의 콜라보레이션 횟수를 통계화하는 설계가 파이프라인 전처리 과정에 통합되어 있습니다. 이를 통해 시청자들은 타겟 멤버 중심의 1:N 방향성 네트워크 노드 가중치(Node Count)를 즉시 시각화하여 탐색할 수 있습니다.

---

## 2. Advanced SQL Analysis

백엔드 서버 내에 구현된 핵심 분석 쿼리와 동적 필터링 로직입니다.

### 2.1 Time-Series Aggregation
연도별/월별 추이를 파악하기 위해 `strftime` 함수를 기반으로 다차원 그룹핑을 수행합니다.

```sql
-- 연도별 멤버십 전용 방송 횟수 트렌드 분석
SELECT strftime('%Y', available_at) as year, COUNT(*) as count 
FROM videos 
WHERE channel_id = ? 
  -- 정형화된 topic_id 외에도 title 키워드를 다중 조건으로 스캔하여 누락 방지
  AND (
      json_extract(json_data, '$.topic_id') = 'membersonly'
      OR title LIKE '%メン限%' 
      OR title LIKE '%Members%' 
      OR title LIKE '%멤버십%'
  )
GROUP BY year 
ORDER BY year;
```

### 2.2 Cross-Join Analysis
단일 비디오 안에 다수의 멤버가 참여한 '콜라보레이션' 네트워크 구조를 분석하기 위한 파이프라인입니다. `json_data` 필드 내의 배열 형태인 `mentions`를 추출하여 통계화합니다.

```python
# database.py : get_collab_stats()
# SQL로 1차 고속 필터링 후, Python 메모리에서 JSON 파싱 및 집계 수행
SELECT json_data FROM videos 
WHERE channel_id = ? AND json_data IS NOT NULL

# 추출된 데이터 기반 네트워크 노드 가중치(Count) 및 메타(Photo) 병합 로직
for member in mentions:
    if member_id not in collab_counts:
        collab_counts[member_id] = { "id": member_id, "count": 0, "photo": ... }
    collab_counts[member_id]["count"] += 1
```

### 2.3 동적 다중 필터 조인 전략
사용자의 복합 필터(년/월 교차, 콜라보 멤버 OR/AND, 컨텐츠 타입)를 단일 쿼리로 최적화하여 조립합니다.

```sql
-- 예시: 2023년과 2024년의 특정 월(01, 02)에 방송된 음악(M/V) 컨텐츠 필터링
SELECT COUNT(*) as count FROM videos 
WHERE channel_id = ?
  -- 비디오 타입 필터
  AND topic_id IN ('Original_Song', 'Music_Cover')
  -- 년/월 Cross Join 필터 생성 구조
  AND (
      available_at LIKE '2023-01%' OR available_at LIKE '2023-02%' OR
      available_at LIKE '2024-01%' OR available_at LIKE '2024-02%'
  )
```

---

## 3. Data Extraction Flow

분석된 데이터는 최종적으로 대시보드 시각화(Chart.js)를 위한 JSON 규격화 과정을 거칩니다.
결측치(방송이 없었던 월)가 차트 렌더링에 오류를 발생시키지 않도록, `result = {f"{i:02d}": 0 for i in range(1, 13)}` 와 같이 **디폴트 12개월 배열 포맷팅 전처리**를 수행하여 데이터 정합성을 보장합니다.

---

## 4. Derived Statistical Metrics (핵심 산출 지표)

위 파이프라인과 쿼리를 통해 실제로 대시보드에 구현된 핵심 통계 데이터 산출물입니다. 백엔드에서 집계된 데이터는 프론트엔드로 전달되어 동적 시각화됩니다.

- **시계열 방송 트렌드 (Yearly/Monthly Streams)**
  - `available_at` (ISO 8601) 데이터를 파싱하여 연도별 누적 방송 횟수(Bar Chart)와 특정 연도 내 월별 방송 추이(Line Chart)를 추출합니다. 
  - 이를 통해 특정 멤버의 활동 성수기/비수기 및 장기적인 성장/휴식 사이클을 한눈에 파악할 수 있는 지표를 제공합니다.
- **콜라보레이션 네트워크 랭킹 (Collab Top 30 & Yearly Stats)**
  - 단일 멤버 기준 1:N 방향성 네트워크를 구축하여, 가장 빈번하게 합방을 진행한 타겟 멤버들의 랭킹(TOP 30)과 매칭 횟수를 도출합니다.
  - 연동된 필터를 통해 '특정 연도에 누구와 교류가 가장 많았는지' 추적 가능하므로, 멤버의 인맥 및 주요 콘텐츠 방향성을 분석하는 핵심 지표로 활용됩니다.
