console.log("🚀 api.js loaded!");

// Use local proxy path
const API_BASE_URL = '/api/v2';
const LOCAL_API_URL = '/api';

// === 클립 캐시 (클라이언트 측) ===
const CLIP_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const CLIP_CACHE_MAX_ENTRIES = 300;
const clipCache = new Map();
const inFlightLiveRequests = new Map();

// 캐시 키 생성
function getClipCacheKey(channelId, offset, searchQuery, lang) {
    const normalizedChannelId = channelId || '';
    const normalizedOffset = Number.isFinite(offset) ? offset : 0;
    const normalizedQuery = (searchQuery || '').trim();
    const normalizedLang = lang || 'all';
    return `${normalizedChannelId}:${normalizedOffset}:${normalizedQuery}:${normalizedLang}`;
}

// 캐시에서 가져오기
function getFromClipCache(key) {
    const cached = clipCache.get(key);
    if (!cached) return null;

    // TTL 확인
    if (Date.now() > cached.expiry) {
        clipCache.delete(key);
        return null;
    }

    // Refresh recency so frequently used keys are less likely to be evicted.
    clipCache.delete(key);
    clipCache.set(key, cached);

    return cached.data;
}

// 캐시에 저장
function setToClipCache(key, data) {
    clipCache.set(key, {
        data: data,
        expiry: Date.now() + CLIP_CACHE_TTL
    });
    pruneClipCache();
}

function pruneClipCache() {
    if (clipCache.size <= CLIP_CACHE_MAX_ENTRIES) return;

    const now = Date.now();
    for (const [key, value] of clipCache.entries()) {
        if (value.expiry <= now) {
            clipCache.delete(key);
        }
    }

    while (clipCache.size > CLIP_CACHE_MAX_ENTRIES) {
        const oldestKey = clipCache.keys().next().value;
        if (!oldestKey) break;
        clipCache.delete(oldestKey);
    }
}

// Helper to fetch data from the API (GET)
async function fetchFromApi(endpoint, params = {}) {
    const url = new URL(API_BASE_URL + endpoint, window.location.origin);
    Object.keys(params).forEach(key => {
        const value = params[key];
        if (value === undefined || value === null) return;
        url.searchParams.append(key, value);
    });

    const apiKey = localStorage.getItem('holodex_api_key');
    const headers = {};
    if (apiKey) {
        headers['X-APIKEY'] = apiKey;
    }

    try {
        const response = await fetch(url, { headers });
        if (!response.ok) {
            throw new Error(`API Error: ${response.status} ${response.statusText}`);
        }
        const contentType = response.headers.get('content-type');
        if (!contentType || !contentType.includes('application/json')) {
            throw new Error(`Invalid content type: ${contentType}`);
        }
        return await response.json();
    } catch (error) {
        console.error('❌ API fetch failed:', error);
        return null;
    }
}

// Helper for Local DB Search (콜라보 필터, 날짜 필터, 년/월 필터, 비디오 타입 필터)
async function searchLocalDb(query, channelId, offset = 0, collab = '', collabMode = 'or', hideUnarchived = false, filterDates = [], filterYears = null, filterMonths = null, videoType = 'all') {
    const url = new URL(LOCAL_API_URL + '/search', window.location.origin);
    url.searchParams.append('q', query || '');
    url.searchParams.append('channel_id', channelId);
    url.searchParams.append('offset', offset);
    url.searchParams.append('limit', 32);

    // 콜라보 멤버 필터 (배열 또는 문자열)
    if (collab) {
        // 배열이면 콤마로 연결, 문자열이면 그대로
        const collabStr = Array.isArray(collab) ? collab.join(',') : collab;
        if (collabStr) {
            url.searchParams.append('collab', collabStr);
            url.searchParams.append('collab_mode', collabMode); // OR 또는 AND
        }
    }

    // 언아카이브 숨기기 필터
    if (hideUnarchived) {
        url.searchParams.append('hide_unarchived', 'true');
    }

    // 날짜 필터 (배열)
    if (filterDates && filterDates.length > 0) {
        url.searchParams.append('filter_dates', filterDates.join(','));
    }

    // 년도 필터 (배열 - 다중 선택)
    if (filterYears && filterYears.length > 0) {
        url.searchParams.append('filter_years', filterYears.join(','));
    }

    // 월 필터 (배열 - 다중 선택)
    if (filterMonths && filterMonths.length > 0) {
        url.searchParams.append('filter_months', filterMonths.join(','));
    }

    // 비디오 타입 필터 (노래: music)
    if (videoType && videoType !== 'all') {
        url.searchParams.append('video_type', videoType);
    }

    try {
        const response = await fetch(url);
        if (!response.ok) return { items: [], total: 0 };
        return await response.json();
    } catch (error) {
        return { items: [], total: 0 };
    }
}

// Trigger Sync
async function triggerSync() {
    const apiKey = localStorage.getItem('holodex_api_key');
    if (!apiKey) return;

    try {
        await fetch(LOCAL_API_URL + '/sync', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ apiKey })
        });
        console.log("🔄 Sync triggered");
    } catch (e) {
        console.error("Failed to trigger sync", e);
    }
}

// Call sync on load
// Call sync on load - DISABLED
// triggerSync();

/**
 * Get Channel Information (Single)
 */
async function getChannelInfo(channelId) {
    return await fetchFromApi(`/channels/${channelId}`);
}

/**
 * Get Channel Information (Batch)
 * Uses /users endpoint to fetch multiple channels at once
 */
async function getChannelsInfo(channelIds) {
    const ids = Array.isArray(channelIds) ? channelIds.join(',') : channelIds;
    return await fetchFromApi('/users', {
        id: ids
    });
}

/**
 * Get Live and Upcoming Streams (Batch Optimized)
 */
async function getLiveStreams(channelIds) {
    const ids = Array.isArray(channelIds) ? channelIds.join(',') : channelIds;
    const requestKey = ids || '';
    const existing = inFlightLiveRequests.get(requestKey);
    if (existing) {
        return existing;
    }

    const requestPromise = (async () => {
        try {
            // Single Request for all channels
            const results = await fetchFromApi('/live', {
                channel_id: ids,
                status: 'live,upcoming',
                type: 'stream',
                sort: 'start_scheduled',
                order: 'asc',
                limit: 50 // Increased limit to cover all channels
            });

            if (!results) return [];

            return results.sort((a, b) => {
                if (a.status === 'live' && b.status !== 'live') return -1;
                if (a.status !== 'live' && b.status === 'live') return 1;
                return new Date(a.start_scheduled) - new Date(b.start_scheduled);
            });
        } catch (error) {
            console.error("Error fetching live streams:", error);
            return [];
        }
    })();

    inFlightLiveRequests.set(requestKey, requestPromise);

    try {
        return await requestPromise;
    } finally {
        if (inFlightLiveRequests.get(requestKey) === requestPromise) {
            inFlightLiveRequests.delete(requestKey);
        }
    }
}

/**
 * Get Sync Status
 */
async function getSyncStatus() {
    try {
        const response = await fetch(LOCAL_API_URL + '/sync/status');
        if (!response.ok) return { isSyncing: false };
        return await response.json();
    } catch (e) {
        console.error("Failed to get sync status", e);
        return { isSyncing: false };
    }
}

/**
 * Get Recent Videos - Uses SQLite DB for Search (필터 지원: 콜라보, 날짜, 년/월, 비디오 타입)
 * @param {string} videoType - 'all' 또는 'music' (선택, 기본값: 'all')
 */
async function getRecentVideos(channelId, offset = 0, searchQuery = '', channelName = '', collab = '', collabMode = 'or', hideUnarchived = false, filterDates = [], filterYears = null, filterMonths = null, videoType = 'all') {
    return await searchLocalDb(searchQuery, channelId, offset, collab, collabMode, hideUnarchived, filterDates, filterYears, filterMonths, videoType);
}

/**
 * Get Recent Videos DIRECTLY from API (Bypassing DB)
 * @param {string} channelId - 채널 ID
 * @param {number} offset - 오프셋
 * @param {string} mentionedChannelId - 콜라보 멤버 ID (필터용)
 */
async function getRecentVideosFromApi(channelId, offset = 0, mentionedChannelId = '') {
    const params = {
        channel_id: channelId,
        status: 'past,missing',
        type: 'stream',
        limit: 32,
        offset: offset,
        paginated: '1',
        include: 'mentions'  // 콜라보 멤버 정보 포함
    };

    // 콜라보 멤버 필터
    if (mentionedChannelId) {
        params.mentioned_channel_id = mentionedChannelId;
    }

    return await fetchFromApi('/v2/videos', params);
}

// Helper to send data to the API (POST)
async function postToApi(endpoint, body = {}) {
    const url = new URL(API_BASE_URL + endpoint, window.location.origin);
    const apiKey = localStorage.getItem('holodex_api_key');
    const headers = {
        'Content-Type': 'application/json'
    };
    if (apiKey) {
        headers['X-APIKEY'] = apiKey;
    }

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(body)
        });
        if (!response.ok) {
            throw new Error(`API Error: ${response.status} ${response.statusText}`);
        }
        return await response.json();
    } catch (error) {
        console.error('❌ API post failed:', error);
        return null;
    }
}

/**
 * Get Clips - Uses Holodex Search API for better performance
 * @param {string} channelId - 채널 ID
 * @param {number} offset - 오프셋
 * @param {string} searchQuery - 검색어
 * @param {string} channelName - 채널 이름
 * @param {string} lang - 언어 필터 (all, ja, ko, en, zh)
 */
async function getClips(channelId, offset = 0, searchQuery = '', channelName = '', lang = 'all') {
    // 캐시 키 생성 및 캐시 확인
    const cacheKey = getClipCacheKey(channelId, offset, searchQuery, lang);
    const cached = getFromClipCache(cacheKey);
    if (cached) {
        console.log('⚡ Clip cache hit:', cacheKey);
        return cached;
    }

    let result;

    if (searchQuery) {
        // 검색 시 videoSearch API 사용
        const body = {
            sort: 'newest',
            target: ['clip'],
            conditions: [
                { text: searchQuery }
            ],
            vch: [channelId],  // 언급된 채널 필터링
            paginated: true,
            offset: offset,
            limit: 32
        };

        // 언어 필터 추가 (all이 아닐 때만)
        if (lang && lang !== 'all') {
            body.lang = [lang];
        }

        const apiResult = await postToApi('/search/videoSearch', body);

        if (!apiResult) {
            return { items: [], total: 0 };
        }

        result = {
            items: apiResult.items || [],
            total: apiResult.total || 0
        };
    } else {
        // No search - Standard List
        const params = {
            mentioned_channel_id: channelId,
            type: 'clip',
            sort: 'available_at',
            order: 'desc',
            limit: 32,
            offset: offset,
            paginated: '1'
        };

        // 언어 필터 추가 (all이 아닐 때만)
        if (lang && lang !== 'all') {
            params.lang = lang;
        }

        const clipResult = await fetchFromApi('/videos', params);

        if (!clipResult) {
            return { items: [], total: 0 };
        }

        result = clipResult;
    }

    // 캐시에 저장
    setToClipCache(cacheKey, result);
    return result;
}

// === 채널 검색 (탤런트 커스텀용) ===

// 허용된 개인세 채널 ID
const ALLOWED_INDIE_IDS = [
    'UCt30jJgChL8qeT9VPadidSw', // 시구레 우이
    'UClS3cnIUM9yzsBPQzeyX_8Q', // 아마가이 루카
    'UCrV1Hf5r8P148idjoSfrGEQ', // 유우키 사쿠나
    'UCLIpj4TmXviSTNE_U5WG_Ug'  // 쿠라게우 로아
];

// 한글 → 영문 전체 이름 매핑 (검색용, 성+이름 조합 포함)
const FULL_NAME_MAP = {
    // === 0기생 ===
    '소라': 'Tokino Sora',
    '토키노 소라': 'Tokino Sora',
    '토키노소라': 'Tokino Sora',
    '로보코': 'Robocosan',
    '로보코산': 'Robocosan',
    '로보코 씨': 'Robocosan',
    '미코': 'Sakura Miko',
    '사쿠라 미코': 'Sakura Miko',
    '사쿠라미코': 'Sakura Miko',
    '스이세이': 'Hoshimachi Suisei',
    '호시마치 스이세이': 'Hoshimachi Suisei',
    '호시마치스이세이': 'Hoshimachi Suisei',
    '아즈키': 'AZKi',
    'AZKi': 'AZKi',
    'azki': 'AZKi',

    // === 1기생 ===
    '후부키': 'Shirakami Fubuki',
    '시라카미 후부키': 'Shirakami Fubuki',
    '시라카미후부키': 'Shirakami Fubuki',
    '마츠리': 'Natsuiro Matsuri',
    '나츠이로 마츠리': 'Natsuiro Matsuri',
    '나츠이로마츠리': 'Natsuiro Matsuri',
    '아키로제': 'Aki Rosenthal',
    '아키 로젠탈': 'Aki Rosenthal',
    '하아토': 'Akai Haato',
    '아카이 하아토': 'Akai Haato',
    '하챠마': 'Akai Haato',

    // === 2기생 ===
    '아쿠아': 'Minato Aqua',
    '미나토 아쿠아': 'Minato Aqua',
    '미나토아쿠아': 'Minato Aqua',
    '시온': 'Murasaki Shion',
    '무라사키 시온': 'Murasaki Shion',
    '무라사키시온': 'Murasaki Shion',
    '아야메': 'Nakiri Ayame',
    '나키리 아야메': 'Nakiri Ayame',
    '나키리아야메': 'Nakiri Ayame',
    '스바루': 'Oozora Subaru',
    '오오조라 스바루': 'Oozora Subaru',
    '오오조라스바루': 'Oozora Subaru',
    '초코': 'Yuzuki Choco',
    '유즈키 초코': 'Yuzuki Choco',

    // === 게이머즈 ===
    '오카유': 'Nekomata Okayu',
    '네코마타 오카유': 'Nekomata Okayu',
    '네코마타오카유': 'Nekomata Okayu',
    '코로네': 'Inugami Korone',
    '이누가미 코로네': 'Inugami Korone',
    '이누가미코로네': 'Inugami Korone',
    '미오': 'Ookami Mio',
    '오오카미 미오': 'Ookami Mio',
    '오오카미미오': 'Ookami Mio',

    // === 3기생 ===
    '페코라': 'Usada Pekora',
    '우사다 페코라': 'Usada Pekora',
    '우사다페코라': 'Usada Pekora',
    '후레아': 'Shiranui Flare',
    '시라누이 후레아': 'Shiranui Flare',
    '노엘': 'Shirogane Noel',
    '시로가네 노엘': 'Shirogane Noel',
    '시로가네노엘': 'Shirogane Noel',
    '마린': 'Houshou Marine',
    '호쇼 마린': 'Houshou Marine',
    '호쇼마린': 'Houshou Marine',

    // === 4기생 ===
    '카나타': 'Amane Kanata',
    '아마네 카나타': 'Amane Kanata',
    '아마네카나타': 'Amane Kanata',
    '와타메': 'Tsunomaki Watame',
    '츠노마키 와타메': 'Tsunomaki Watame',
    '토와': 'Tokoyami Towa',
    '토코야미 토와': 'Tokoyami Towa',
    '루나': 'Himemori Luna',
    '히메모리 루나': 'Himemori Luna',
    '코코': 'Kiryu Coco',
    '키류 코코': 'Kiryu Coco',

    // === 5기생 ===
    '라미': 'Yukihana Lamy',
    '유키하나 라미': 'Yukihana Lamy',
    '네네': 'Momosuzu Nene',
    '모모스즈 네네': 'Momosuzu Nene',
    '모모스즈네네': 'Momosuzu Nene',
    '보탄': 'Shishiro Botan',
    '시시로 보탄': 'Shishiro Botan',
    '폴카': 'Omaru Polka',
    '오마루 폴카': 'Omaru Polka',

    // === 비밀결사 holoX ===
    '라플라스': 'La+ Darknesss',
    '라플러스': 'La+ Darknesss',
    '코요리': 'Hakui Koyori',
    '하쿠이 코요리': 'Hakui Koyori',
    '루이': 'Takane Lui',
    '타카네 루이': 'Takane Lui',
    '클로에': 'Sakamata Chloe',
    '사카마타 클로에': 'Sakamata Chloe',
    '이로하': 'Kazama Iroha',
    '카자마 이로하': 'Kazama Iroha',

    // === ReGLOSS (DEV_IS 1기) ===
    '카나데': 'Otonose Kanade',
    '오토노세 카나데': 'Otonose Kanade',
    '리리카': 'Ichijou Ririka',
    '이치조 리리카': 'Ichijou Ririka',
    '라덴': 'Juufuutei Raden',
    '쥬후테이 라덴': 'Juufuutei Raden',
    '주우후테이 라덴': 'Juufuutei Raden',
    '하지메': 'Todoroki Hajime',
    '토도로키 하지메': 'Todoroki Hajime',
    '아오': 'Hiodoshi Ao',
    '히오도시 아오': 'Hiodoshi Ao',

    // === FLOW GLOW (DEV_IS 2기) ===
    '리오나': 'Isaki Riona',
    '이사키 리오나': 'Isaki Riona',
    '니코': 'Koganei Niko',
    '코가네이 니코': 'Koganei Niko',
    '스우': 'Mizumiya Su',
    '미즈미야 스우': 'Mizumiya Su',
    '치하야': 'Rindo Chihaya',
    '린도 치하야': 'Rindo Chihaya',
    '비비': 'Kikirara Vivi',
    '키키라라 비비': 'Kikirara Vivi',

    // === 개인세 ===
    '사쿠나': 'Yuuki Sakuna',
    '유우키 사쿠나': 'Yuuki Sakuna',
    '유우키사쿠나': 'Yuuki Sakuna',
    '로아': 'Kurageu Roa',
    '쿠라게우 로아': 'Kurageu Roa',
    '우이': 'Shigure Ui',
    '시구레 우이': 'Shigure Ui',
    '루카': 'Amagai Ruka',
    '아마가이 루카': 'Amagai Ruka',

    // === 계약해지 ===
    '멜': 'Yozora Mel',
    '요조라 멜': 'Yozora Mel',
    '루시아': 'Uruha Rushia',
    '우루하 루시아': 'Uruha Rushia',

    // === hololive EN Myth ===
    '칼리오페': 'Mori Calliope',
    '모리 칼리오페': 'Mori Calliope',
    '키아라': 'Takanashi Kiara',
    '타카나시 키아라': 'Takanashi Kiara',
    '이나니스': "Ninomae Ina'nis",
    '니노마에 이나니스': "Ninomae Ina'nis",
    '이나': "Ninomae Ina'nis",
    '구라': 'Gawr Gura',
    '가우르 구라': 'Gawr Gura',
    '아멜리아': 'Watson Amelia',
    '왓슨 아멜리아': 'Watson Amelia',

    // === hololive EN Promise ===
    '아이리스': 'IRyS',
    'IRyS': 'IRyS',
    'irys': 'IRyS',
    '파우나': 'Ceres Fauna',
    '세레스 파우나': 'Ceres Fauna',
    '크로니': 'Ouro Kronii',
    '오로 크로니': 'Ouro Kronii',
    '무메이': 'Nanashi Mumei',
    '나나시 무메이': 'Nanashi Mumei',
    '베일즈': 'Hakos Baelz',
    '벨즈': 'Hakos Baelz',
    '하코스 베일즈': 'Hakos Baelz',
    '하코스 벨즈': 'Hakos Baelz',

    // === hololive EN Advent ===
    '노벨라': 'Shiori Novella',
    '시오리 노벨라': 'Shiori Novella',
    '비쥬': 'Koseki Bijou',
    '코세키 비쥬': 'Koseki Bijou',
    '네리사': 'Nerissa Ravencroft',
    '네리사 레이븐크로프트': 'Nerissa Ravencroft',
    '후와모코': 'Fuwawa & Mococo Abyssgard',
    '후와와': 'Fuwawa & Mococo Abyssgard',
    '모코코': 'Fuwawa & Mococo Abyssgard',
    '후와와 & 모코코': 'Fuwawa & Mococo Abyssgard',
    '후와와 & 모코코 어비스가드': 'Fuwawa & Mococo Abyssgard',
    'FUWAMOCO': 'Fuwawa & Mococo Abyssgard',
    'fuwamoco': 'Fuwawa & Mococo Abyssgard',

    // === hololive EN Justice ===
    '엘리자베스': 'Elizabeth Rose Bloodflame',
    '엘리자베스 로즈': 'Elizabeth Rose Bloodflame',
    '엘리자베스 로즈 블러드프레임': 'Elizabeth Rose Bloodflame',
    '로즈': 'Elizabeth Rose Bloodflame',
    '블러드프레임': 'Elizabeth Rose Bloodflame',
    '지지': 'Gigi Murin',
    '지지 무린': 'Gigi Murin',
    '세실리아': 'Cecilia Immergreen',
    '세실리아 이머그린': 'Cecilia Immergreen',
    '라오라': 'Raora Panthera',
    '라오라 판테라': 'Raora Panthera',

    // === hololive ID ===
    '리스': 'Ayunda Risu',
    '아윤다 리스': 'Ayunda Risu',
    '무나': 'Moona Hoshinova',
    '무나 호시노바': 'Moona Hoshinova',
    '이오피': 'Airani Iofifteen',
    '아이라니 이오피프틴': 'Airani Iofifteen',
    '올리': 'Kureiji Ollie',
    '쿠레이지 올리': 'Kureiji Ollie',
    '아냐': 'Anya Melfissa',
    '아냐 멜피사': 'Anya Melfissa',
    '레이네': 'Pavolia Reine',
    '파볼리아 레이네': 'Pavolia Reine',
    '제타': 'Vestia Zeta',
    '베스티아 제타': 'Vestia Zeta',
    '카엘라': 'Kaela Kovalskia',
    '카엘라 코발스키아': 'Kaela Kovalskia',
    '코보': 'Kobo Kanaeru',
    '코보 카나에루': 'Kobo Kanaeru',
};

// 한글 이름 ↔ 영어 이름 역매핑 생성
const EN_TO_KR_NAME_MAP = {};
Object.entries(FULL_NAME_MAP).forEach(([kr, en]) => {
    // 가장 긴 한글 이름을 대표로 사용 (전체 이름)
    if (!EN_TO_KR_NAME_MAP[en] || kr.length > EN_TO_KR_NAME_MAP[en].length) {
        EN_TO_KR_NAME_MAP[en] = kr;
    }
});

// 특별 케이스: 영어 원문 유지
EN_TO_KR_NAME_MAP['IRyS'] = 'IRyS';
EN_TO_KR_NAME_MAP['Hakos Baelz'] = '하코스 벨즈';

// 한글 여부 판단 함수
function containsKorean(str) {
    return /[ㄱ-ㅎ|가-힣]/.test(str);
}

// 정확도 스코어 계산 함수
function calculateMatchScore(name, query) {
    const nameLower = name.toLowerCase();
    const queryLower = query.toLowerCase();

    // 완전 일치: 100점
    if (nameLower === queryLower) return 100;

    // 이름 시작 일치: 80점
    if (nameLower.startsWith(queryLower)) return 80;

    // 단어 시작 일치 (예: "Sakura Miko"에서 "miko" 검색): 70점
    const words = nameLower.split(/\s+/);
    if (words.some(w => w.startsWith(queryLower))) return 70;

    // 부분 문자열 일치: 50점
    if (nameLower.includes(queryLower)) return 50;

    // 불일치
    return 0;
}

/**
 * 채널 검색 - Hololive + 허용된 개인세만 반환
 * @param {string} query - 검색어
 * @returns {Promise<Array>} - 필터링된 채널 목록
 */
async function searchChannels(query) {
    console.log('🔍 searchChannels called with:', query);

    if (!query || query.trim().length < 2) {
        console.log('❌ Query too short');
        return [];
    }

    try {
        // Holodex API - Hololive 채널 전체 가져오기 (페이지네이션)
        console.log('📡 Fetching from /channels...');

        let allChannels = [];
        let offset = 0;
        const limit = 100;

        // 최대 3페이지 (300개)까지 가져오기
        for (let page = 0; page < 3; page++) {
            const result = await fetchFromApi('/channels', {
                type: 'vtuber',
                org: 'Hololive',
                limit: limit,
                offset: offset
            });

            if (!result || !Array.isArray(result) || result.length === 0) {
                break;
            }

            allChannels = [...allChannels, ...result];
            offset += limit;

            // 100개 미만이면 더 이상 없음
            if (result.length < limit) {
                break;
            }
        }

        console.log('📦 API result:', allChannels.length, 'total channels');

        if (allChannels.length === 0) {
            console.log('❌ No valid result from API');
            return [];
        }

        console.log('✅ Got', allChannels.length, 'channels from API');

        // === 허용된 개인세 목록 (Holodex에 없거나 org가 다른 채널들) ===
        const ALLOWED_INDIE_CHANNELS = [
            { id: 'UCrV1Hf5r8P148idjoSfrGEQ', name: '유우키 사쿠나', english_name: 'Yuuki Sakuna', photo: 'https://yt3.ggpht.com/CAO0J4GC4_G8VxiyulWcZZ3b44l27EFl-vSOER7ucwAL5IJIRxVk4XSQdhWn3PLXD-rQ-QVj=s800-c-k-c0x00ffffff-no-rj', org: 'Indie' },
            { id: 'UCLIpj4TmXviSTNE_U5WG_Ug', name: '쿠라게우 로아', english_name: 'Kurageu Roa', photo: 'https://yt3.ggpht.com/YF6d4zXLWFR6VjPpF01N8w0Wq-MfwMz6MZTDQbOF2TeSSMT4bwtIf2xGs8DfoufreyVcro4N7Bo=s800-c-k-c0x00ffffff-no-rj', org: 'Indie' },
            { id: 'UCt30jJgChL8qeT9VPadidSw', name: '시구레 우이', english_name: 'Shigure Ui', photo: 'https://yt3.ggpht.com/ytc/AIdro_m6xQ9ez0I8lnwswHqAns9ZRPsaCCutfzu6eUbM7pwzqsA=s800-c-k-c0x00ffffff-no-rj', org: 'Indie' },
            { id: 'UClS3cnIUM9yzsBPQzeyX_8Q', name: '아마가이 루카', english_name: 'Amagai Ruka', photo: 'https://yt3.ggpht.com/E_GIFETWLQYVBMYBzSfwr6VqmJRALcKYvruQcC5jyI9KqRszN9YaPWlT-C3PobxtTUplYNvrCg=s800-c-k-c0x00ffffff-no-rj', org: 'Indie' }
        ];

        // 개인세 목록을 allChannels에 추가
        allChannels = [...allChannels, ...ALLOWED_INDIE_CHANNELS];

        // 홀로스타즈 제외 (suborg 또는 group에 HOLOSTARS 포함 시 제외)
        // + 계약해지 멤버 제외 (루시아, 멜)
        const EXCLUDED_CHANNEL_IDS = [
            'UCl_gCybOJRIgOXw6Qb4qJzQ', // Uruha Rushia
            'UCD8HOxPs4Xvsm8H0ZxXGiBw', // Yozora Mel
        ];

        const filteredByOrg = allChannels.filter(ch => {
            // 계약해지 멤버 제외
            if (EXCLUDED_CHANNEL_IDS.includes(ch.id)) {
                return false;
            }

            const suborg = (ch.suborg || '').toUpperCase();
            const group = (ch.group || '').toUpperCase();
            // 홀로스타즈 계열은 제외
            if (suborg.includes('HOLOSTARS') || group.includes('HOLOSTARS')) {
                return false;
            }
            // 홀로라이브 또는 개인세(Indie) 허용
            return ch.org === 'Hololive' || ch.org === 'Indie';
        });

        console.log('🚫 Filtered (Holostars removed):', filteredByOrg.length, 'channels');

        // === 새 검색 로직: 한글/영어 감지 + 정확도 스코어링 ===
        const isKorean = containsKorean(query);
        const queryLower = query.toLowerCase();
        console.log(`🔤 Query type: ${isKorean ? 'Korean' : 'English'}`);

        // 결과 + 스코어 배열
        const scoredResults = [];

        // FULL_NAME_MAP 정확 매칭 확인 (한글 입력 시 우선)
        const exactMappedName = FULL_NAME_MAP[query];
        if (exactMappedName) {
            console.log('✨ Exact map match:', query, '→', exactMappedName);
        }

        for (const ch of filteredByOrg) {
            const englishName = ch.english_name || ch.name || '';
            const originalName = ch.name || '';  // 일본어 이름

            // 한글 이름 찾기 (역매핑)
            const koreanName = EN_TO_KR_NAME_MAP[englishName] || '';

            let score = 0;

            if (isKorean) {
                // === 한글 검색 로직 ===

                // 1. FULL_NAME_MAP 정확 매칭 시 최고점
                if (exactMappedName && englishName.toLowerCase() === exactMappedName.toLowerCase()) {
                    score = 100;
                }
                // 2. 한글 이름(역매핑)에서 검색
                else if (koreanName) {
                    score = calculateMatchScore(koreanName, query);
                }
                // 3. FULL_NAME_MAP의 모든 한글 키에서 부분 매칭 검색
                if (score === 0) {
                    for (const [krName, enName] of Object.entries(FULL_NAME_MAP)) {
                        if (krName.includes(query) && enName.toLowerCase() === englishName.toLowerCase()) {
                            // 부분 매칭 발견
                            score = Math.max(score, calculateMatchScore(krName, query));
                            break;
                        }
                    }
                }
            } else {
                // === 영어 검색 로직 ===
                // 영어 이름에서 직접 검색
                const englishScore = calculateMatchScore(englishName, query);
                const originalScore = calculateMatchScore(originalName, query);
                score = Math.max(englishScore, originalScore);
            }

            // 스코어가 있으면 결과에 추가
            if (score > 0) {
                scoredResults.push({ channel: ch, score, koreanName, englishName });
            }
        }

        // 스코어 내림차순 정렬
        scoredResults.sort((a, b) => b.score - a.score);

        console.log(`🎯 Found ${scoredResults.length} matches (sorted by score)`);
        if (scoredResults.length > 0) {
            console.log('📊 Top results:', scoredResults.slice(0, 5).map(r =>
                `${r.koreanName || r.englishName} (${r.score}점)`
            ));
        }

        // 결과 정규화
        return scoredResults.map(({ channel: ch, koreanName, englishName }) => {
            return {
                id: ch.id,
                name: koreanName || englishName,  // 한글 이름 우선
                englishName: englishName,
                originalName: ch.name,
                icon: ch.photo || null,
                org: ch.org,
                emoji: '',
                theme: {
                    primary: '#6366f1',
                    secondary: '#e0e7ff',
                    accent: '#4f46e5'
                }
            };
        });
    } catch (error) {
        console.error('❌ Channel search failed:', error);
        return [];
    }
}

// 전역 노출 (app.js에서 사용)
window.searchChannels = searchChannels;
window.getChannelsInfo = getChannelsInfo;

// === 통계 API 함수 ===
async function getYearlyStats(channelId) {
    try {
        const response = await fetch(`/api/stats/yearly?channel_id=${channelId}`);
        if (!response.ok) throw new Error('Failed to fetch yearly stats');
        return await response.json();
    } catch (error) {
        console.error('Yearly stats error:', error);
        return { items: [] };
    }
}

async function getMembershipStats(channelId, year) {
    try {
        const response = await fetch(`/api/stats/membership?channel_id=${channelId}&year=${year}`);
        if (!response.ok) throw new Error('Failed to fetch membership stats');
        return await response.json();
    } catch (error) {
        console.error('Membership stats error:', error);
        return { items: [] };
    }
}

async function getCollabStats(channelId) {
    try {
        const response = await fetch(`/api/stats/collab?channel_id=${channelId}`);
        if (!response.ok) throw new Error('Failed to fetch collab stats');
        return await response.json();
    } catch (error) {
        console.error('Collab stats error:', error);
        return { items: [] };
    }
}

async function getMonthlyStats(channelId, year) {
    try {
        const response = await fetch(`/api/stats/monthly?channel_id=${channelId}&year=${year}`);
        if (!response.ok) throw new Error('Failed to fetch monthly stats');
        return await response.json();
    } catch (error) {
        console.error('Monthly stats error:', error);
        return { items: [] };
    }
}

async function getYearlyMembershipStats(channelId) {
    try {
        const response = await fetch(`/api/stats/yearly-membership?channel_id=${channelId}`);
        if (!response.ok) throw new Error('Failed to fetch yearly membership stats');
        return await response.json();
    } catch (error) {
        console.error('Yearly membership stats error:', error);
        return { items: [] };
    }
}

async function getYearlyCollabStats(channelId, year) {
    try {
        const response = await fetch(`/api/stats/yearly-collab?channel_id=${channelId}&year=${year}`);
        if (!response.ok) throw new Error('Failed to fetch yearly collab stats');
        return await response.json();
    } catch (error) {
        console.error('Yearly collab stats error:', error);
        return { items: [] };
    }
}

async function getTopicStats(channelId) {
    try {
        const response = await fetch(`/api/stats/topic?channel_id=${channelId}`);
        if (!response.ok) throw new Error('Failed to fetch topic stats');
        return await response.json();
    } catch (error) {
        console.error('Topic stats error:', error);
        return { items: [] };
    }
}

async function getYearlyTopicStats(channelId, year) {
    try {
        const response = await fetch(`/api/stats/yearly-topic?channel_id=${channelId}&year=${year}`);
        if (!response.ok) throw new Error('Failed to fetch yearly topic stats');
        return await response.json();
    } catch (error) {
        console.error('Yearly topic stats error:', error);
        return { items: [] };
    }
}

// 전역 노출
window.getYearlyStats = getYearlyStats;
window.getMembershipStats = getMembershipStats;
window.getCollabStats = getCollabStats;
window.getMonthlyStats = getMonthlyStats;
window.getYearlyMembershipStats = getYearlyMembershipStats;
window.getYearlyCollabStats = getYearlyCollabStats;
window.getTopicStats = getTopicStats;
window.getYearlyTopicStats = getYearlyTopicStats;

