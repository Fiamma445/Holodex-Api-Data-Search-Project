/**
 * 토스트 알림 컴포넌트
 * @description 인앱 토스트 및 브라우저 알림 표시
 */

/**
 * 토스트 알림 표시
 * @param {string} title - 알림 제목
 * @param {string} message - 알림 메시지
 * @param {string} iconUrl - 아이콘 URL (기본값: 미코)
 */
export function showToast(title, message, iconUrl = 'image/miko.jpg') {
    // 1. 인앱 토스트 표시
    const container = document.getElementById('toast-container');
    if (container) {
        const toast = document.createElement('div');
        toast.className = 'toast';

        const iconHtml = iconUrl
            ? `<img src="${iconUrl}" class="toast-img" style="width:24px;height:24px;border-radius:50%;margin-right:8px;">`
            : '<span class="toast-icon">🔴</span>';

        toast.innerHTML = `
            ${iconHtml}
            <div class="toast-content">
                <span class="toast-title">${title}</span>
                <span class="toast-message">${message}</span>
            </div>
        `;

        container.appendChild(toast);

        // 5초 후 자동 제거
        setTimeout(() => {
            toast.classList.add('hide');
            toast.addEventListener('animationend', () => {
                toast.remove();
            });
        }, 5000);
    }

    // 2. 브라우저 알림 표시
    if ("Notification" in window && Notification.permission === "granted") {
        new Notification(title, {
            body: message,
            icon: iconUrl
        });
    }
}

/**
 * 알림 권한 요청
 * @returns {Promise<boolean>} 권한 부여 여부
 */
export async function requestNotificationPermission() {
    if (!("Notification" in window)) {
        return false;
    }

    if (Notification.permission === "granted") {
        return true;
    }

    if (Notification.permission !== "denied") {
        const permission = await Notification.requestPermission();
        return permission === "granted";
    }

    return false;
}
