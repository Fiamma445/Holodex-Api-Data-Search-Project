/**
 * 노래 구간 카드 컴포넌트
 * @description Holodex songs 데이터를 검색 가능한 카드로 표시한다.
 */

function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function formatSongTime(seconds) {
    if (seconds === null || seconds === undefined || Number.isNaN(Number(seconds))) {
        return '--:--';
    }
    const total = Number(seconds);
    const minutes = Math.floor(total / 60);
    const rest = total % 60;
    return `${minutes}:${String(rest).padStart(2, '0')}`;
}

function formatSongDate(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value.slice(0, 10);
    return date.toLocaleDateString('ko-KR', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    });
}

function buildSongUrl(song) {
    const start = Number(song.start_sec || 0);
    const suffix = start > 0 ? `&t=${start}s` : '';
    return `https://www.youtube.com/watch?v=${encodeURIComponent(song.video_id)}${suffix}`;
}

function buildThumbnail(videoId) {
    if (!videoId) return '';
    return `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/mqdefault.jpg`;
}

function canShowDetailButton(song) {
    return song?.category === 'original' || song?.category === 'unit_guest';
}

export function createSongCard(song, options = {}) {
    const card = document.createElement('article');
    card.className = 'song-card';
    const showDetails = options.showDetails !== false && canShowDetailButton(song);

    const thumbnail = buildThumbnail(song.video_id);
    const artist = song.original_artist || '원곡자 미상';
    const date = formatSongDate(song.available_at);
    const start = formatSongTime(song.start_sec);
    const end = song.end_sec === null || song.end_sec === undefined ? '' : ` - ${formatSongTime(song.end_sec)}`;

    card.innerHTML = `
        <a class="song-thumb" href="${buildSongUrl(song)}" target="_blank" rel="noopener noreferrer">
            ${thumbnail ? `<img src="${escapeHtml(thumbnail)}" alt="" loading="lazy" decoding="async">` : ''}
            <span>${start}${end}</span>
        </a>
        <div class="song-body">
            <div class="song-kicker">${escapeHtml(artist)}</div>
            <h4>${escapeHtml(song.song_title)}</h4>
            <p>${escapeHtml(song.video_title || '')}</p>
            <div class="song-meta">
                <span>${escapeHtml(song.channel_name || '')}</span>
                <span>${escapeHtml(date)}</span>
            </div>
        </div>
        <div class="song-actions">
            <a class="song-action-primary" href="${buildSongUrl(song)}" target="_blank" rel="noopener noreferrer">재생</a>
            ${showDetails ? '<button class="song-action-secondary" type="button">상세보기</button>' : ''}
        </div>
    `;

    card.querySelector('.song-thumb img')?.addEventListener('error', event => {
        event.currentTarget.remove();
    });

    card.querySelector('.song-action-secondary')?.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        card.dispatchEvent(new CustomEvent('song-detail-request', {
            bubbles: true,
            detail: { song }
        }));
    });

    return card;
}
