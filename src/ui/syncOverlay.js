/**
 * 동기화 오버레이 UI
 * @description 초기 동기화 진행 상태 표시
 */

/**
 * 동기화 오버레이 표시
 */
export function showSyncOverlay() {
    const overlay = document.getElementById('sync-overlay');
    if (overlay) {
        overlay.style.display = 'flex';
    }
}

/**
 * 동기화 오버레이 숨기기
 */
export function hideSyncOverlay() {
    const overlay = document.getElementById('sync-overlay');
    if (overlay) {
        overlay.style.display = 'none';
    }
}

/**
 * 동기화 오버레이 업데이트
 * @param {Object} status - 동기화 상태 객체
 */
export function updateSyncOverlay(status) {
    const progressFill = document.getElementById('sync-progress-fill');
    const progressCircle = document.getElementById('sync-progress-circle');
    const progressText = document.getElementById('sync-progress-text');
    const statusText = document.getElementById('sync-status-text');
    const channelNameEl = document.getElementById('sync-current-channel');
    const videoCountEl = document.getElementById('sync-video-count');
    const cancelBtn = document.getElementById('sync-cancel-btn');

    const synced = status.syncedChannels || 0;
    const total = status.totalChannels || 11;
    const currentChannel = status.currentChannel || '준비 중...';
    const totalVideos = status.totalVideos || 0;
    const percentage = total > 0 ? Math.round((synced / total) * 100) : 0;

    // SVG 원형 진행 바 업데이트
    if (progressCircle) {
        // 원형 둘레: 2 * π * r = 2 * 3.14159 * 45 ≈ 283
        const circumference = 283;
        const offset = circumference - (circumference * percentage / 100);
        progressCircle.style.strokeDashoffset = offset;
    }

    // 원형 진행 바 중앙 텍스트
    if (progressText) {
        progressText.textContent = `${percentage}%`;
    }

    // 가로 진행률 바 (기존 유지)
    if (progressFill && total > 0) {
        progressFill.style.width = `${percentage}%`;
    }

    // 상태 텍스트 (퍼센트 + 채널 수)
    if (statusText) {
        statusText.textContent = `${percentage}% 완료 (${synced}/${total} 채널)`;
    }

    // 현재 채널명 → 진행 중 표시로 변경
    if (channelNameEl) {
        channelNameEl.textContent = synced < total ? '🔄 동기화 진행 중...' : '✅ 동기화 완료!';
    }

    // 다운로드 영상 수
    if (videoCountEl) {
        videoCountEl.textContent = `📥 ${totalVideos.toLocaleString()}개 영상 다운로드`;
    }

    // 취소 버튼 이벤트 (한 번만 등록)
    if (cancelBtn && !cancelBtn.hasAttribute('data-listener')) {
        cancelBtn.setAttribute('data-listener', 'true');
        cancelBtn.addEventListener('click', async () => {
            if (confirm('동기화를 취소하시겠습니까?')) {
                try {
                    await fetch('/api/sync/cancel', { method: 'POST' });
                    cancelBtn.textContent = '취소 중...';
                    cancelBtn.disabled = true;
                } catch (e) {
                    // 취소 요청 실패 시 무시
                }
            }
        });
    }
}
