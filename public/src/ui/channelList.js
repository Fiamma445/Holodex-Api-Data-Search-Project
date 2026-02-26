/**
 * 채널 리스트 컴포넌트
 * @description 사이드바 채널 목록 렌더링
 */

import { CHANNELS, getMyChannels } from '../data/channels.js';

/**
 * 채널 리스트 렌더링
 * @param {Function} onChannelSelect - 채널 선택 시 콜백
 */
export function renderChannelList(onChannelSelect) {
    const list = document.getElementById('channel-list');
    if (!list) {
        return;
    }

    list.innerHTML = '';

    // 커스텀 채널 목록 사용
    const myChannels = getMyChannels();

    myChannels.forEach(channel => {
        const li = document.createElement('li');
        const a = document.createElement('a');
        a.href = '#';
        a.className = 'channel-link';
        a.dataset.id = channel.id;

        // 아이콘 URL (없으면 첫 글자로 대체)
        const iconUrl = channel.icon || `https://via.placeholder.com/40?text=${channel.name.charAt(0)}`;

        a.innerHTML = `
            <img src="${iconUrl}" alt="${channel.name}" class="nav-icon" onerror="this.src='image/miko.jpg'">
            <span class="nav-name">${channel.name}</span>
        `;

        a.addEventListener('click', (e) => {
            e.preventDefault();
            onChannelSelect(channel.id);
        });

        li.appendChild(a);
        list.appendChild(li);
    });
}

/**
 * 채널 활성 상태 업데이트
 * @param {string} channelId - 활성화할 채널 ID
 */
export function updateActiveChannel(channelId) {
    document.querySelectorAll('.channel-link').forEach(link => {
        link.classList.remove('active');
        if (link.dataset.id === channelId) {
            link.classList.add('active');
        }
    });
}

/**
 * 채널 테마 적용
 * @param {string} channelId - 채널 ID
 */
export function applyChannelTheme(channelId) {
    // 기본 채널 목록 + 커스텀 채널 목록에서 찾기
    let channel = CHANNELS.find(c => c.id === channelId);
    if (!channel) {
        channel = getMyChannels().find(c => c.id === channelId);
    }

    if (channel && channel.theme) {
        document.documentElement.style.setProperty('--primary-color', channel.theme.primary);
        document.documentElement.style.setProperty('--secondary-color', channel.theme.secondary);
        document.documentElement.style.setProperty('--accent-color', channel.theme.accent);
        // 배경색도 채널 테마에 맞게 적용 (secondary 기반)
        document.documentElement.style.setProperty('--bg-color', channel.theme.secondary);
    }
}
