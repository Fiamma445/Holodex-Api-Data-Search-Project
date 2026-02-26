/**
 * 비디오 카드 컴포넌트
 * @description 비디오 썸네일 카드 생성
 */

import {
    formatTopicId,
    formatDuration,
    formatElapsedTime,
    formatCountdown,
    formatNumber,
    formatRelativeTime,
    formatScheduledTime
} from '../utils/formatters.js';

const failedThumbnailIds = new Set();

function getPrimaryThumbnailUrl(videoId) {
    return `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
}

function getFallbackThumbnailUrl(videoId) {
    return `https://i.ytimg.com/vi/${videoId}/default.jpg`;
}

function getThumbnailUrl(videoId) {
    return failedThumbnailIds.has(videoId)
        ? getFallbackThumbnailUrl(videoId)
        : getPrimaryThumbnailUrl(videoId);
}

function attachThumbnailFallback(card) {
    const img = card.querySelector('img[data-video-id]');
    if (!img) return;

    img.addEventListener('error', () => {
        const videoId = img.dataset.videoId;
        if (!videoId) return;

        const fallback = getFallbackThumbnailUrl(videoId);
        if (img.src === fallback) return;

        failedThumbnailIds.add(videoId);
        img.src = fallback;
    });
}

/**
 * 비디오 카드 DOM 요소 생성
 * @param {Object} video - 비디오 데이터
 * @param {number} index - 카드 인덱스 (첫 줄 판단용)
 * @returns {HTMLElement} 비디오 카드 요소
 */
export function createVideoCard(video, index = 0) {
    const card = document.createElement('a');
    card.href = `https://www.youtube.com/watch?v=${video.id}`;
    // 첫 줄(0~3번 인덱스)에는 first-row 클래스 추가
    card.className = index < 4 ? 'video-card first-row' : 'video-card';
    card.target = '_blank';
    card.rel = 'noopener noreferrer';  // D-13: 보안 속성 추가

    // 상태 배지
    const statusBadge = createStatusBadge(video.status);

    // 토픽 배지
    const topicBadge = video.topic_id
        ? `<span class="topic-badge">${formatTopicId(video.topic_id)}</span>`
        : '';

    // 재생 시간 배지
    const durationBadge = (video.duration && video.status !== 'upcoming')
        ? `<span class="duration-badge">${formatDuration(video.duration)}</span>`
        : '';

    // 라이브 정보 (시청자 수, 경과 시간)
    const liveInfo = createLiveInfo(video);

    // 카운트다운 (예정 방송)
    const countdownInfo = (video.status === 'upcoming' && video.start_scheduled)
        ? `<div class="countdown-info">🕐 ${formatCountdown(video.start_scheduled)}</div>`
        : '';

    const timeLabel = video.status === 'upcoming' ? '예정' : '방송';
    // 라이브 중이면 '라이브 중' 표시, 아니면 상대 시간 표시
    const relativeTime = video.status === 'live'
        ? '라이브 중'
        : formatRelativeTime(video.start_scheduled || video.available_at);
    // Holodex 스타일 절대 날짜/시간 (예: 2026.01.31. 오후 12:00)
    const scheduledTime = formatScheduledTime(video.start_scheduled || video.available_at);
    const thumbnailUrl = getThumbnailUrl(video.id);

    // 콜라보 멤버 아이콘 (호버 시 표시)
    const collabMembers = createCollabMembers(video.mentions);

    card.innerHTML = `
        <div class="thumbnail-wrapper">
            <img src="${thumbnailUrl}" alt="${escapeHtml(video.title)}" loading="lazy" decoding="async" data-video-id="${video.id}">
            ${statusBadge}
            ${durationBadge}
            ${collabMembers}
        </div>
        <div class="video-info">
            ${topicBadge}
            <h4 class="video-title" title="${escapeHtml(video.title)}">${escapeHtml(video.title)}</h4>
            ${liveInfo}
            ${countdownInfo}
            <div class="video-meta">
                <span class="scheduled-date">${scheduledTime}</span>
                <span class="relative-time">(${video.status === 'live' ? '🔴 ' : ''}${relativeTime})</span>
            </div>
        </div>
    `;

    attachThumbnailFallback(card);

    return card;
}

/**
 * 상태 배지 HTML 생성
 * @param {string} status - 비디오 상태
 * @returns {string} HTML 문자열
 */
function createStatusBadge(status) {
    if (status === 'live') {
        return '<span class="status-badge status-live">🔴 LIVE</span>';
    }
    if (status === 'upcoming') {
        return '<span class="status-badge status-upcoming">⏰ 예정</span>';
    }
    return '';
}

/**
 * 라이브 정보 HTML 생성
 * @param {Object} video - 비디오 데이터
 * @returns {string} HTML 문자열
 */
function createLiveInfo(video) {
    if (video.status !== 'live') return '';

    const viewers = video.live_viewers ? formatNumber(video.live_viewers) : '-';
    const elapsed = video.start_actual ? formatElapsedTime(video.start_actual) : '';

    return `
        <div class="live-info">
            <span class="viewers">👀 ${viewers}</span>
            ${elapsed ? `<span class="elapsed">⏱️ ${elapsed}</span>` : ''}
        </div>
    `;
}

/**
 * HTML 이스케이프 (XSS 방지)
 * @param {string} text - 원본 텍스트
 * @returns {string} 이스케이프된 텍스트
 */
function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/**
 * 콜라보 멤버 아이콘 HTML 생성
 * @param {Array} mentions - 콜라보 멤버 배열
 * @returns {string} HTML 문자열
 */
function createCollabMembers(mentions) {
    if (!mentions || mentions.length === 0) return '';

    console.log(`📍 Creating collab icons: ${mentions.length} members`);

    // 모든 멤버 표시 - div로 생성하고 background-image 사용
    const memberIcons = mentions.map((member, idx) => {
        const photo = member.photo || '';
        const name = member.name || member.english_name || '멤버';
        // div + background-image 방식으로 변경
        return `<div class="collab-icon" 
            style="background-image: url('${photo}')" 
            title="${escapeHtml(name)}"
            data-idx="${idx}"></div>`;
    }).join('');

    return `
        <div class="collab-members" data-count="${mentions.length}">
            <div class="collab-icons">
                ${memberIcons}
            </div>
        </div>
    `;
}
