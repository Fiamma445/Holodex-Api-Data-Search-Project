# Railway DB Persistence Note

## 결론

- Railway에서는 반드시 Volume에 `videos.db`를 저장한다.
- 현재 서버 코드는 Railway에서 Volume이 없으면 일부러 시작을 막는다.
- Volume이 붙어 있으면 기본 DB 경로는 `RAILWAY_VOLUME_MOUNT_PATH/videos.db`다.
- Railway 화면의 Mount Path가 `/data`라면 실제 DB는 `/data/videos.db`가 된다.

## 배포 전 확인

1. `web-volume`이 `web` 서비스에 연결되어 있는지 확인한다.
2. Mount Path는 지금처럼 `/data`면 된다.
3. Volume Size는 최소 `2 GB`, 여유 있게는 `5 GB` 이상을 추천한다.
4. `DB_PATH`는 비워두거나 `/data/videos.db`처럼 Volume 안쪽 경로만 쓴다.
5. `Wipe Volume`, `Delete Volume`은 DB 삭제 버튼이라 누르면 안 된다.

## 기본 Seed DB 운영

일반 사용자가 전체 동기화를 기다리는 구조는 이제 맞지 않는다.
운영자가 로컬에서 전체 탤런트 DB를 먼저 만들고, 그 DB를 배포 seed로 쓰는 방식으로 간다.

```powershell
$env:HOLODEX_API_KEY="..."
py tools\sync_seed_db.py --db videos.db
py tools\build_db_seed.py --db videos.db --out videos.db.gz
```

`videos.db.gz`가 앱 루트에 있으면 Railway Volume이 비어 있을 때 서버가 `/data/videos.db`로 1회 복원한다.
이후 사용자의 동기화는 빠른 갱신만 수행하고, 전체 재구축은 seed DB를 새로 만들 때만 한다.

## DB가 커졌을 때

`videos.db.gz`가 Git 저장소에 넣기 부담스러울 정도로 커지면 외부 저장소에 올리고 `SEED_DB_URL`을 설정한다.

```text
SEED_DB_URL=https://example.com/videos.db.gz
```

Volume이 비어 있고 로컬 `videos.db.gz`도 없으면 서버가 이 URL에서 seed를 내려받아 `/data/videos.db`로 복원한다.
이 방식이면 Git 저장소에는 코드만 두고, 대용량 DB는 object storage나 release asset으로 분리할 수 있다.

## 새 배포 시 주의

- Volume에 이미 `/data/videos.db`가 있으면 seed 복원은 다시 실행되지 않는다.
- seed를 강제로 갈아엎고 싶을 때만 Volume 백업 후 DB 파일을 교체한다.
- 지금 Railway에만 있는 휘발성 데이터는 새 Volume으로 자동 이전되지 않는다.
- 현재 구조상 대부분은 재동기화 가능한 데이터라면 새 seed DB로 다시 채우면 된다.
