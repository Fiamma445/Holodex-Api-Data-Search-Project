/**
 * 앱 전역 상태 관리
 * @description 불변성 패턴으로 상태 관리
 */

// 초기 상태 (불변)
const INITIAL_STATE = Object.freeze({
    archivePage: 1,
    clipsPage: 1,
    songsPage: 1,
    songSort: 'recent',
    songCategory: 'all',
    clipLangs: ['ja'],  // 키리누키 언어 필터 (ja, ko, en, zh)
    collabFilter: '',  // 콜라보 멤버 필터
    collabMode: 'or',
    currentSearchQuery: '',
    itemsPerPage: 32,
    currentChannelId: null,  // 동적으로 내 탤런트 첫 번째 선택
    currentView: 'home',
    hasTriggeredFullSync: false,
    isSyncing: false,
    hideUnarchived: false,  // 언아카이브 영상 숨기기
    filterDates: [],  // 날짜 필터 (YYYY-MM-DD 형식 배열)
    filterYears: null,  // 년도 필터 배열 (빠른 선택, 다중 가능)
    filterMonths: null,  // 월 필터 배열 (빠른 선택, 다중 가능)
    videoType: 'all'  // 비디오 타입 필터 ('all', 'collab', 'music')
});

// 현재 상태 (getter/setter로 접근)
const PERSISTED_STATE_KEY = 'holo_search_filter_state';
const VALID_VIDEO_TYPES = new Set(['all', 'collab', 'music']);
const VALID_SONG_SORTS = new Set(['recent', 'title', 'artist']);
const VALID_SONG_CATEGORIES = new Set(['all', 'original', 'unit_guest', 'cover']);
const VALID_CLIP_LANGS = new Set(['ja', 'ko', 'en', 'zh']);

function canUseStorage() {
    return typeof window !== 'undefined' && Boolean(window.localStorage);
}

function normalizeStringArray(value) {
    if (!Array.isArray(value)) return [];
    return value.filter(item => typeof item === 'string' && item.trim()).map(item => item.trim());
}

function normalizeNumberArray(value, min = -Infinity, max = Infinity) {
    if (!Array.isArray(value)) return null;
    const numbers = value
        .map(item => Number(item))
        .filter(item => Number.isInteger(item) && item >= min && item <= max);
    return numbers.length > 0 ? [...new Set(numbers)] : null;
}

function normalizeClipLangs(value) {
    const values = Array.isArray(value) ? value : [value];
    const normalized = values
        .filter(item => typeof item === 'string' && VALID_CLIP_LANGS.has(item))
        .filter((item, index, array) => array.indexOf(item) === index);
    return normalized.length > 0 ? normalized : ['ja'];
}

function pickPersistedState(state) {
    return {
        currentSearchQuery: typeof state.currentSearchQuery === 'string' ? state.currentSearchQuery : '',
        collabFilter: normalizeStringArray(state.collabFilter),
        collabMode: state.collabMode === 'and' ? 'and' : 'or',
        hideUnarchived: Boolean(state.hideUnarchived),
        filterDates: normalizeStringArray(state.filterDates),
        filterYears: normalizeNumberArray(state.filterYears),
        filterMonths: normalizeNumberArray(state.filterMonths, 1, 12),
        videoType: VALID_VIDEO_TYPES.has(state.videoType) ? state.videoType : 'all',
        songSort: VALID_SONG_SORTS.has(state.songSort) ? state.songSort : 'recent',
        songCategory: VALID_SONG_CATEGORIES.has(state.songCategory) ? state.songCategory : 'all',
        clipLangs: normalizeClipLangs(state.clipLangs || state.clipLang)
    };
}

export function getPersistedState() {
    if (!canUseStorage()) return {};

    try {
        const raw = window.localStorage.getItem(PERSISTED_STATE_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return {};
        return pickPersistedState(parsed);
    } catch {
        return {};
    }
}

function savePersistedState(state) {
    if (!canUseStorage()) return;

    try {
        window.localStorage.setItem(PERSISTED_STATE_KEY, JSON.stringify(pickPersistedState(state)));
    } catch {
        // 저장소를 사용할 수 없어도 현재 화면 상태는 유지한다
    }
}

let _state = { ...INITIAL_STATE };

/**
 * 현재 상태 가져오기 (복사본 반환)
 * @returns {Object} 현재 상태의 복사본
 */
export function getState() {
    return { ..._state };
}

/**
 * 상태 업데이트 (불변성 유지)
 * @param {Object} updates - 업데이트할 필드들
 * @returns {Object} 새 상태
 */
export function setState(updates) {
    if (!updates || typeof updates !== 'object') return getState();

    const keys = Object.keys(updates);
    let changed = false;
    for (const key of keys) {
        if (!Object.is(_state[key], updates[key])) {
            changed = true;
            break;
        }
    }
    if (!changed) return getState();

    _state = { ..._state, ...updates };
    savePersistedState(_state);
    return getState();
}

/**
 * 상태 초기화
 * @returns {Object} 초기 상태
 */
export function resetState() {
    _state = { ...INITIAL_STATE };
    savePersistedState(_state);
    return getState();
}

/**
 * 특정 필드만 가져오기
 * @param {string} key - 상태 키
 * @returns {any} 해당 값
 */
export function getStateValue(key) {
    return _state[key];
}

// 초기 상태 export (읽기 전용)
export { INITIAL_STATE };
