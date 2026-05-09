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
    const normalizedLang = normalizeClipLangs(lang).join(',');
    return `${normalizedChannelId}:${normalizedOffset}:${normalizedQuery}:${normalizedLang}`;
}

function normalizeClipLangs(value) {
    const values = Array.isArray(value) ? value : [value];
    const langs = values
        .filter(item => typeof item === 'string')
        .map(item => item.trim())
        .filter(item => ['ja', 'ko', 'en', 'zh'].includes(item))
        .filter((item, index, array) => array.indexOf(item) === index);
    return langs.length > 0 ? langs : ['ja'];
}

function buildClipLangParam(value) {
    return normalizeClipLangs(value).join(',');
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

function buildHolodexHeaders(options = {}) {
    const headers = {};
    if (options.useUserApiKey) {
        const apiKey = localStorage.getItem('holodex_api_key');
        if (apiKey) {
            headers['X-APIKEY'] = apiKey;
        }
    }
    return headers;
}

function hasUserApiKey() {
    return Boolean(localStorage.getItem('holodex_api_key'));
}

// Helper to fetch data from the API (GET)
async function fetchFromApi(endpoint, params = {}, options = {}) {
    const url = new URL(API_BASE_URL + endpoint, window.location.origin);
    Object.keys(params).forEach(key => {
        const value = params[key];
        if (value === undefined || value === null) return;
        if (Array.isArray(value)) {
            value.forEach(item => url.searchParams.append(key, item));
            return;
        }
        url.searchParams.append(key, value);
    });

    const headers = buildHolodexHeaders(options);

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
 * @param {string} videoType - 'all', 'collab' 또는 'music' (선택, 기본값: 'all')
 */
async function getRecentVideos(channelId, offset = 0, searchQuery = '', channelName = '', collab = '', collabMode = 'or', hideUnarchived = false, filterDates = [], filterYears = null, filterMonths = null, videoType = 'all') {
    return await searchLocalDb(searchQuery, channelId, offset, collab, collabMode, hideUnarchived, filterDates, filterYears, filterMonths, videoType);
}

/**
 * Get Songs - Uses local Holodex songs DB
 */
async function getSongs(channelId, offset = 0, searchQuery = '', sort = 'recent', category = 'all', collab = '', collabMode = 'or') {
    const url = new URL(LOCAL_API_URL + '/songs', window.location.origin);
    url.searchParams.append('channel_id', channelId);
    url.searchParams.append('offset', offset);
    url.searchParams.append('limit', 32);
    url.searchParams.append('sort', sort);
    url.searchParams.append('category', category);
    if (searchQuery) {
        url.searchParams.append('q', searchQuery);
    }
    if (collab) {
        const collabStr = Array.isArray(collab) ? collab.join(',') : collab;
        if (collabStr) {
            url.searchParams.append('collab', collabStr);
            url.searchParams.append('collab_mode', collabMode);
        }
    }

    try {
        const response = await fetch(url);
        if (!response.ok) return { items: [], total: 0, summary: {} };
        return await response.json();
    } catch {
        return { items: [], total: 0, summary: {} };
    }
}

/**
 * Get song detail list - Uses local DB only
 */
async function getSongDetails(song, offset = 0, limit = 300) {
    const url = new URL(LOCAL_API_URL + '/song-details', window.location.origin);
    url.searchParams.append('offset', offset);
    url.searchParams.append('limit', limit);
    if (song?.song_title) {
        url.searchParams.append('title', song.song_title);
    }
    if (song?.original_artist) {
        url.searchParams.append('artist', song.original_artist);
    }
    if (song?.itunesid) {
        url.searchParams.append('itunesid', song.itunesid);
    }

    try {
        const response = await fetch(url);
        if (!response.ok) return { items: [], total: 0 };
        return await response.json();
    } catch {
        return { items: [], total: 0 };
    }
}

// Helper to send data to the API (POST)
async function postToApi(endpoint, body = {}, options = {}) {
    const url = new URL(API_BASE_URL + endpoint, window.location.origin);
    const headers = {
        'Content-Type': 'application/json',
        ...buildHolodexHeaders(options)
    };

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
 * @param {string|string[]} lang - 언어 필터 (ja, ko, en, zh)
 */
async function getClips(channelId, offset = 0, searchQuery = '', channelName = '', lang = ['ja']) {
    const langs = normalizeClipLangs(lang);
    const langParam = buildClipLangParam(langs);
    // 캐시 키 생성 및 캐시 확인
    const cacheKey = getClipCacheKey(channelId, offset, searchQuery, langs);
    const cached = getFromClipCache(cacheKey);
    if (cached) {
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

        body.lang = langs;

        const apiResult = await postToApi('/search/videoSearch', body, { useUserApiKey: true });

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

        params.lang = langParam;

        const clipResult = await fetchFromApi('/videos', params, { useUserApiKey: true });

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

const ALLOWED_CHANNEL_IDS = Object.freeze([
    'UCp6993wxpyDPHUpavwDFqgg',
    'UCDqI2jOz0weumE8s7paEk6g',
    'UC-hM6YJuNYVAmUWxeIr9FeA',
    'UC5CwaMl1eIgY8h02uZw7u8A',
    'UC0TXe_LYZ4scaW2XMyi5_kw',
    'UCdn5BQ06XqgXoAxIhbqw5Rg',
    'UCQ0UDLQCjY0rmuxCDE38FGg',
    'UCFTLzh12_nrtzqBPsTCqenA',
    'UC1CfXB_kRs3C_zaeTG3oGyg',
    'UC1opHUrw8rvnsadT_iGp7Cg',
    'UCXTpFs_3PqI41qX2d9tL2Rw',
    'UC7fk0CB07ly8oSl0aqKkqFg',
    'UC1suqwovbL1kzsoaZgFZLKg',
    'UCvzGlP9oQwU__Y0r9id_jnA',
    'UCp_5t9SrOQwXMU7iIjQfARg',
    'UCvaTdHTWBGv3MKj3KVqJVCw',
    'UChAnqc_AY5_I3Px5dig3X1Q',
    'UC1DCedRgGHBdm81E1llLhOQ',
    'UCvInZx9h3jC2JzsIzoOebWg',
    'UCdyqAaZDKHXg4Ahi7VENThQ',
    'UCCzUftO8KOVkV4wQG1vkUvg',
    'UCZlDXzGoo7d44bwdNObFacg',
    'UCqm3BQLlJfvkTsX_hvm0UmA',
    'UC1uv2Oq6kNxgATlCiez59hw',
    'UCa9Y57gfeY0Zro_noHRVrnw',
    'UCS9uQI_jC3DE0L4IpXyvr6w',
    'UCFKOVgVbGmX65RxO3EtH3iw',
    'UCAWSyEs_Io8MtpY3m_zqILA',
    'UCUKD_uaobj9jiqB_VXt71mA',
    'UCK9V2B22uJYu3N7eR_BT9QA',
    'UCENwRMx5Yh42zWpzURebzTw',
    'UC6eWCld0KwmyHFbAqK3V_Rw',
    'UCs9_O1tRPMQTHQ_N_L6FU2g',
    'UCIBY1ollUsauvVi4hW4cumw',
    'UC_vMYWcDjmfdpH6r4TTn1MQ',
    'UCWQtYtq9EOB4_I5P_3fh8lA',
    'UCtyWhCj3AqKh2dXctLkDtng',
    'UCdXAk5MpyLD8594lm_OvtGQ',
    'UC1iA6_NT4mtAcIII6ygrvCw',
    'UCMGfV7TVTmHhEErVJg1oHBQ',
    'UC9LSiN9hXI55svYEBrrK_tw',
    'UCuI_opAVX6qbxZY_a_AxFuQ',
    'UCjk2nKmHzgH5Xy_C5qYRd5A',
    'UCKMWFR6lAstLa7Vbf5dH7ig',
    'UCGzTVXqMQHa4AgJVJIVvtDQ',
    'UCL_qhgtOy0dy1Agp8vkySQg',
    'UCHsx4Hqa_1ORjQTh9TYDhww',
    'UCMwGHR0BTZuLsmjY_NT5Pwg',
    'UCoSrY_IQQVpmIRZ9Xf_y93g',
    'UCyl1z3jo3XHR1riLFKG5UAg',
    'UC8rcEBzJSleTkf__agPM20g',
    'UCO_aKKYxn4tvrqPjcTzZ6EQ',
    'UCmbs8T6MWqUHP1tIQvSgKrg',
    'UC3n5uGu18FoCy23ggWWp8tA',
    'UCgmPnx_EEeOrZSg5Tiw7ZRQ',
    'UCgnfPPb9JI3e9A4cXHnWbyg',
    'UC9p_lqQ0FEDz327Vgf5JwqA',
    'UC_sFNM0z0MWm9A6WlKPuMMg',
    'UCt9H_RpQzhxzlyBxFqrdHqA',
    'UCW5uhrG1eCBYditmhL0Ykjw',
    'UCl69AEx4MdqMZH7Jtsm7Tig',
    'UCDHABijvPBnJm7F_KlNME3w',
    'UCvN5h1ShZtc7nly3pezRayg',
    'UCOyYb1c43VlX9rc_lT6NKQw',
    'UCP0BspO_AMEe3aQqqpo89Dg',
    'UCAoy6rzhSf4ydcYjJw3WoVg',
    'UCYz_5n_uDuChHtLo7My1HnQ',
    'UC727SQYUvx5pDDGQpTICNWg',
    'UChgTyjG_pdNvxxhdsXfHQ5Q',
    'UCTvHWSfBZgtxE4sILOaurIQ',
    'UCZLZ8Jjx_RN2CXloOmgTHVg',
    'UCjLEmnpCNeisMxy134KPwWw',
    'UCl_gCybOJRIgOXw6Qb4qJzQ',
    'UCD8HOxPs4Xvsm8H0ZxXGiBw',
    'UCrV1Hf5r8P148idjoSfrGEQ',
    'UCLIpj4TmXviSTNE_U5WG_Ug',
    'UCt30jJgChL8qeT9VPadidSw',
    'UClS3cnIUM9yzsBPQzeyX_8Q'
]);

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

const ALLOWED_CHANNEL_ID_SET = new Set(ALLOWED_CHANNEL_IDS.map(normalizeChannelId));
const ALLOWED_INDIE_ID_SET = new Set(ALLOWED_INDIE_IDS.map(normalizeChannelId));
const SEARCH_NAME_MODULE_VERSION = '20260509-2';

function normalizeChannelId(value) {
    return String(value || '').replaceAll('-', '_');
}

function isAllowedSearchChannel(channel) {
    if (!channel?.id) return false;

    const channelId = normalizeChannelId(channel.id);
    return ALLOWED_CHANNEL_ID_SET.has(channelId) || ALLOWED_INDIE_ID_SET.has(channelId);
}

function mergeChannelIndexes(serverItems, staticItems) {
    const merged = new Map();
    [...serverItems, ...staticItems]
        .filter(isAllowedSearchChannel)
        .forEach(channel => {
            merged.set(normalizeChannelId(channel.id), channel);
        });
    return [...merged.values()];
}

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
let localChannelIndexCache = null;
let localizedSearchNamesCache = null;

async function fetchServerChannelIndex() {
    try {
        const response = await fetch('/api/channel-index', { cache: 'no-store' });
        if (response.ok) {
            const data = await response.json();
            return Array.isArray(data.items) ? data.items : [];
        }
    } catch (error) {
    }

    return [];
}

async function fetchStaticChannelIndex() {
    try {
        const response = await fetch('/channel-index.json', { cache: 'force-cache' });
        const data = response.ok ? await response.json() : [];
        return Array.isArray(data) ? data : [];
    } catch (error) {
    }

    return [];
}

async function getLocalChannelIndex() {
    if (localChannelIndexCache) return localChannelIndexCache;

    const [serverItems, staticItems] = await Promise.all([
        fetchServerChannelIndex(),
        fetchStaticChannelIndex()
    ]);

    localChannelIndexCache = mergeChannelIndexes(serverItems, staticItems);
    return localChannelIndexCache;
}

async function getLocalizedSearchNames() {
    if (localizedSearchNamesCache) return localizedSearchNamesCache;

    try {
        const module = await import(`./src/data/localizedNames.js?v=${SEARCH_NAME_MODULE_VERSION}`);
        localizedSearchNamesCache = new Map(
            Object.entries(module.TALENT_NAMES || {}).map(([id, names]) => {
                const aliases = Object.values(names).filter(Boolean);
                return [normalizeChannelId(id), aliases];
            })
        );
    } catch {
        localizedSearchNamesCache = new Map();
    }

    return localizedSearchNamesCache;
}

function uniqueSearchAliases(values) {
    return [...new Set(values.filter(Boolean).map(value => String(value).trim()).filter(Boolean))];
}

function getChannelSearchAliases(channel, koreanName, localizedNames) {
    const channelId = normalizeChannelId(channel.id);
    const localizedAliases = localizedNames.get(channelId) || [];
    return uniqueSearchAliases([
        channel.englishName,
        channel.name,
        channel.originalName,
        koreanName,
        ...localizedAliases
    ]);
}

function scoreLocalChannel(channel, query, exactMappedName, localizedNames) {
    const englishName = channel.englishName || channel.name || '';
    const koreanName = EN_TO_KR_NAME_MAP[englishName] || '';

    if (exactMappedName && englishName.toLowerCase() === exactMappedName.toLowerCase()) {
        return { score: 100, koreanName, englishName };
    }

    const aliases = getChannelSearchAliases(channel, koreanName, localizedNames);
    let score = Math.max(...aliases.map(alias => calculateMatchScore(alias, query)), 0);

    if (score === 0) {
        for (const [krName, enName] of Object.entries(FULL_NAME_MAP)) {
            if (krName.includes(query) && enName.toLowerCase() === englishName.toLowerCase()) {
                score = Math.max(score, calculateMatchScore(krName, query));
                break;
            }
        }
    }

    return { score, koreanName, englishName };
}

function normalizeLocalChannelResult(channel, koreanName, englishName) {
    return {
        id: channel.id,
        name: koreanName || channel.name || englishName,
        englishName,
        originalName: channel.name,
        icon: channel.icon || `/channel-icons/${encodeURIComponent(channel.id)}.png`,
        org: channel.org || 'Hololive',
        emoji: '',
        theme: {
            primary: '#6366f1',
            secondary: '#e0e7ff',
            accent: '#4f46e5'
        }
    };
}

async function searchLocalChannelIndex(query) {
    if (!query || query.trim().length < 2) return [];

    const trimmedQuery = query.trim();
    const exactMappedName = FULL_NAME_MAP[trimmedQuery];
    const [channels, localizedNames] = await Promise.all([
        getLocalChannelIndex(),
        getLocalizedSearchNames()
    ]);

    return channels
        .map(channel => {
            const result = scoreLocalChannel(channel, trimmedQuery, exactMappedName, localizedNames);
            return { channel, ...result };
        })
        .filter(result => result.score > 0)
        .sort((a, b) => b.score - a.score)
        .map(({ channel, koreanName, englishName }) =>
            normalizeLocalChannelResult(channel, koreanName, englishName)
        );
}

async function searchChannels(query) {
    return searchLocalChannelIndex(query);
}

// 전역 노출 (app.js에서 사용)
window.getChannelIndex = getLocalChannelIndex;
window.searchChannels = searchChannels;
window.getSongDetails = getSongDetails;

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

