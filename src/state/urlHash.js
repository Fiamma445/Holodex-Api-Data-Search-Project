/**
 * URL 해시 상태 관리
 * @description 브라우저 히스토리 없이 URL 해시로 앱 상태 저장/복원
 */

import { CHANNELS, DEFAULT_CHANNEL_ID } from '../data/channels.js';

// 유효한 뷰 목록
const VALID_VIEWS = ['home', 'live', 'archive', 'clips'];
// 유효한 비디오 타입 목록
const VALID_VIDEO_TYPES = ['all', 'music'];

/**
 * URL 해시에서 상태 파싱
 * @returns {Object} 파싱된 상태 { channel, view, page }
 */
export function getStateFromHash() {
    const hash = window.location.hash.slice(1); // '#' 제거
    const params = new URLSearchParams(hash);

    return {
        channel: params.get('channel'),
        view: params.get('view'),
        page: parseInt(params.get('page')) || 1,
        videoType: params.get('videoType')
    };
}

/**
 * URL 해시 업데이트 (히스토리에 추가하지 않음)
 * @param {Object} state - 현재 앱 상태
 */
export function updateUrlHash(state) {
    const { currentChannelId, currentView, archivePage, clipsPage, videoType } = state;
    const page = currentView === 'archive' ? archivePage :
        (currentView === 'clips' ? clipsPage : 1);

    // 노래 탭일 때만 videoType 파라미터 추가
    const videoTypeParam = (currentView === 'archive' && videoType && videoType !== 'all')
        ? `&videoType=${videoType}` : '';
    const hash = `channel=${currentChannelId}&view=${currentView}&page=${page}${videoTypeParam}`;
    history.replaceState(null, '', '#' + hash);
}

/**
 * URL 해시에서 초기 상태 복원
 * @param {Object} defaultState - 기본 상태
 * @returns {Object} 복원된 상태
 */
export function restoreStateFromHash(defaultState) {
    const savedState = getStateFromHash();
    const restoredState = { ...defaultState };

    // 채널 복원
    if (savedState.channel && CHANNELS.some(c => c.id === savedState.channel)) {
        restoredState.currentChannelId = savedState.channel;
    }

    // 뷰 복원
    if (savedState.view && VALID_VIEWS.includes(savedState.view)) {
        restoredState.currentView = savedState.view;
    }

    // 페이지 복원
    if (savedState.page > 0) {
        if (restoredState.currentView === 'archive') {
            restoredState.archivePage = savedState.page;
        }
        if (restoredState.currentView === 'clips') {
            restoredState.clipsPage = savedState.page;
        }
    }

    // 비디오 타입 복원 (노래 탭)
    if (savedState.videoType && VALID_VIDEO_TYPES.includes(savedState.videoType)) {
        restoredState.videoType = savedState.videoType;
    }

    return restoredState;
}
