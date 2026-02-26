/**
 * 포맷팅 유틸리티
 * @description 시간, 숫자, 날짜 등 포맷팅 함수 모음
 */

// 방송 토픽 ID → 한국어 라벨 매핑
const TOPIC_MAP = {
    'Original_Song': '🎵 오리지널 곡',
    'Singing': '🎤 노래',
    'Music': '🎵 음악',
    'Gaming': '🎮 게임',
    'Minecraft': '⛏️ 마인크래프트',
    'Apex': '🎯 에이펙스',
    'Valorant': '🔫 발로란트',
    'Chatting': '💬 잡담',
    'Talk': '💬 토크',
    'Membersonly': '🔒 멤버십',
    'Birthday': '🎂 생일',
    'Anniversary': '🎉 기념일',
    'Collab': '👥 콜라보',
    'Drawing': '🎨 그림',
    'ASMR': '🎧 ASMR',
    'Karaoke': '🎤 노래방',
    'Watchalong': '📺 동시시청',
    'Superchat_Reading': '💰 슈퍼챗',
    'Cooking': '🍳 요리',
    'Handcam': '✋ 핸드캠',
    'Graduation': '🎓 졸업',
    '3D': '🎬 3D',
    'New_Outfit': '👗 신의상'
};

/**
 * 토픽 ID를 한국어 라벨로 변환
 * @param {string} topicId - 토픽 ID
 * @returns {string} 한국어 라벨
 */
export function formatTopicId(topicId) {
    return TOPIC_MAP[topicId] || `🏷️ ${topicId.replace(/_/g, ' ')}`;
}

/**
 * 초를 시간:분 형식으로 변환
 * @param {number} seconds - 초
 * @returns {string} 포맷된 문자열 (예: "1h 23m")
 */
export function formatDuration(seconds) {
    if (!seconds) return '';
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);

    if (hours > 0) {
        return `${hours}h ${minutes}m`;
    }
    return `${minutes}m`;
}

/**
 * 방송 시작 시간부터 경과 시간 계산
 * @param {string} startActual - 시작 시간 (ISO 문자열)
 * @returns {string} 경과 시간 (예: "1시간 23분 경과")
 */
export function formatElapsedTime(startActual) {
    if (!startActual) return '';
    const start = new Date(startActual);
    const now = new Date();
    const diffMs = now - start;
    const diffMin = Math.floor(diffMs / 60000);
    const diffHour = Math.floor(diffMin / 60);

    if (diffHour > 0) {
        return `${diffHour}시간 ${diffMin % 60}분 경과`;
    }
    return `${diffMin}분 경과`;
}

/**
 * 예정 방송까지 남은 시간 계산
 * @param {string} startScheduled - 예정 시간 (ISO 문자열)
 * @returns {string} 카운트다운 (예: "2시간 30분 후")
 */
export function formatCountdown(startScheduled) {
    if (!startScheduled) return '';
    const start = new Date(startScheduled);
    const now = new Date();
    const diffMs = start - now;

    if (diffMs <= 0) return '곧 시작!';

    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHour = Math.floor(diffMin / 60);
    const diffDay = Math.floor(diffHour / 24);

    if (diffDay > 0) {
        return `${diffDay}일 ${diffHour % 24}시간 후`;
    }
    if (diffHour > 0) {
        return `${diffHour}시간 ${diffMin % 60}분 후`;
    }
    return `${diffMin}분 후`;
}

/**
 * 숫자를 축약 형식으로 변환
 * @param {number} num - 숫자
 * @returns {string} 축약 숫자 (예: "1.2K")
 */
export function formatNumber(num) {
    if (!num) return '-';
    return new Intl.NumberFormat('en-US', {
        notation: "compact",
        compactDisplay: "short"
    }).format(num);
}

/**
 * 날짜 문자열을 짧은 형식으로 변환
 * @param {string} dateString - ISO 날짜 문자열
 * @returns {string} 포맷된 날짜
 */
export function formatDate(dateString) {
    const date = new Date(dateString);
    return date.toLocaleDateString([], {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}

/**
 * 상대 시간 표시 (예: "2 hours ago")
 * @param {string} dateString - ISO 날짜 문자열
 * @returns {string} 상대 시간
 */
export function formatRelativeTime(dateString) {
    if (!dateString) return 'Unknown';

    const date = new Date(dateString);
    if (isNaN(date.getTime())) return 'Unknown';

    const now = new Date();
    const diffMs = date - now;
    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHour = Math.floor(diffMin / 60);
    const diffDay = Math.floor(diffHour / 24);

    const rtf = new Intl.RelativeTimeFormat('ko', { numeric: 'auto' });

    try {
        if (Math.abs(diffDay) > 0) return rtf.format(diffDay, 'day');
        if (Math.abs(diffHour) > 0) return rtf.format(diffHour, 'hour');
        if (Math.abs(diffMin) > 0) return rtf.format(diffMin, 'minute');
        return rtf.format(diffSec, 'second');
    } catch {
        return 'Unknown';
    }
}

/**
 * 절대 날짜/시간 표시 (Holodex 스타일)
 * @param {string} dateString - ISO 날짜 문자열
 * @returns {string} 포맷된 날짜 (예: "2026.01.31. 오후 12:00")
 */
export function formatScheduledTime(dateString) {
    if (!dateString) return '';

    const date = new Date(dateString);
    if (isNaN(date.getTime())) return '';

    // 년.월.일 형식
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');

    // 시간 (오전/오후 형식)
    const hours = date.getHours();
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const period = hours >= 12 ? '오후' : '오전';
    const displayHour = hours % 12 || 12;

    return `${year}.${month}.${day}. (${period} ${displayHour}:${minutes})`;
}

