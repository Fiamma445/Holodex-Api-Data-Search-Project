/**
 * 앱 전역 상태 관리
 * @description 불변성 패턴으로 상태 관리
 */

// 초기 상태 (불변)
const INITIAL_STATE = Object.freeze({
    archivePage: 1,
    clipsPage: 1,
    clipLang: 'all',  // 키리누키 언어 필터 (all, ja, ko, en, zh)
    collabFilter: '',  // 콜라보 멤버 필터
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
    videoType: 'all'  // 비디오 타입 필터 ('all' 또는 'music')
});

// 현재 상태 (getter/setter로 접근)
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
    return getState();
}

/**
 * 상태 초기화
 * @returns {Object} 초기 상태
 */
export function resetState() {
    _state = { ...INITIAL_STATE };
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
