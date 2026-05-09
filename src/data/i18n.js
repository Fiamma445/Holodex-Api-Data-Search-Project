const LOCALE_STORAGE_KEY = 'holo_search_locale';
const DEFAULT_LOCALE = 'ko';

const SUPPORTED_LOCALES = Object.freeze([
    { code: 'ko', labelKey: 'language.ko', htmlLang: 'ko' },
    { code: 'ja', labelKey: 'language.ja', htmlLang: 'ja' },
    { code: 'en', labelKey: 'language.en', htmlLang: 'en' }
]);

const MESSAGES = Object.freeze({
    ko: {
        'nav.home': '홈',
        'nav.live': '라이브 & 예정',
        'nav.archive': '아카이브',
        'nav.songs': '노래',
        'nav.clips': '키리누키',
        'nav.stats': '통계',
        'search.placeholder': '검색어를 입력하세요...',
        'sidebar.hideUnarchived': '언아카이브',
        'sidebar.filter': '검색 필터',
        'sidebar.settings': '설정',
        'sidebar.filterCount': '검색 필터 ({count}명)',
        'filter.member': '멤버',
        'filter.collab': '콜라보',
        'songDb.title': '노래 DB',
        'songDb.segments': '곡 구간',
        'songDb.videos': '영상',
        'songDb.latest': '최근 갱신',
        'footer.holodexBased': '기반',
        'footer.fanSite': '비공식 팬 사이트',
        'apiModal.title': 'Holodex API Key 필요',
        'apiModal.body': '키리누키 검색을 사용하려면 API 키가 필요합니다',
        'apiModal.guideSuffix': '에서 키를 발급받으세요 (사용자 설정 → API Key)',
        'apiModal.inputPlaceholder': 'API Key를 입력하세요',
        'apiModal.save': '저장',
        'settings.title': '탤런트 관리',
        'settings.languageTitle': '표시 언어',
        'settings.channelSearch': '채널 검색',
        'settings.channelPlaceholder': '채널명 입력 (2글자 이상)',
        'settings.search': '검색',
        'settings.searching': '검색 중...',
        'settings.noResults': '검색 결과가 없습니다',
        'settings.add': '추가',
        'settings.added': '추가됨',
        'settings.remove': '삭제',
        'settings.myTalents': '내 탤런트',
        'settings.syncStart': '동기화 시작',
        'settings.syncHint': '탤런트 목록 변경은 바로 화면에 반영됩니다. 새 데이터는 서버에서 주기적으로 자동 갱신됩니다',
        'settings.resetDefault': '기본값으로 초기화',
        'settings.deleteApiKey': 'API 키 삭제',
        'settings.enterApiKey': 'API 키 입력',
        'language.ko': '한국어',
        'language.ja': '日本語',
        'language.en': 'English',
        'clips.title': '키리누키',
        'clips.languageFilter': '키리누키 언어 필터',
        'clips.loading': '클립 로딩 중...',
        'clips.noClips': '클립이 없습니다',
        'clips.loadFailed': '클립을 불러오지 못했습니다',
        'clipLang.ja': '日本語',
        'clipLang.ko': '한국어',
        'clipLang.en': 'English',
        'clipLang.zh': '中文'
    },
    ja: {
        'nav.home': 'ホーム',
        'nav.live': 'ライブ・予定',
        'nav.archive': 'アーカイブ',
        'nav.songs': '歌',
        'nav.clips': '切り抜き',
        'nav.stats': '統計',
        'search.placeholder': '検索語を入力...',
        'sidebar.hideUnarchived': '非公開を含めない',
        'sidebar.filter': '検索フィルター',
        'sidebar.settings': '設定',
        'sidebar.filterCount': '検索フィルター ({count}名)',
        'filter.member': 'メンバー',
        'filter.collab': 'コラボ',
        'songDb.title': '歌 DB',
        'songDb.segments': '歌唱区間',
        'songDb.videos': '動画',
        'songDb.latest': '最終更新',
        'footer.holodexBased': 'ベース',
        'footer.fanSite': '非公式ファンサイト',
        'apiModal.title': 'Holodex API Key が必要',
        'apiModal.body': '切り抜き検索を使うには API Key が必要です',
        'apiModal.guideSuffix': 'でキーを発行してください（ユーザー設定 → API Key）',
        'apiModal.inputPlaceholder': 'API Key を入力',
        'apiModal.save': '保存',
        'settings.title': 'タレント管理',
        'settings.languageTitle': '表示言語',
        'settings.channelSearch': 'チャンネル検索',
        'settings.channelPlaceholder': 'チャンネル名を入力（2文字以上）',
        'settings.search': '検索',
        'settings.searching': '検索中...',
        'settings.noResults': '検索結果がありません',
        'settings.add': '追加',
        'settings.added': '追加済み',
        'settings.remove': '削除',
        'settings.myTalents': 'マイタレント',
        'settings.syncStart': '同期開始',
        'settings.syncHint': 'タレント一覧の変更は画面にすぐ反映されます。新しいデータはサーバーで定期的に自動更新されます',
        'settings.resetDefault': '初期値に戻す',
        'settings.deleteApiKey': 'API Key を削除',
        'settings.enterApiKey': 'API Key を入力',
        'language.ko': '한국어',
        'language.ja': '日本語',
        'language.en': 'English',
        'clips.title': '切り抜き',
        'clips.languageFilter': '切り抜き言語フィルター',
        'clips.loading': '切り抜き読み込み中...',
        'clips.noClips': '切り抜きがありません',
        'clips.loadFailed': '切り抜きを読み込めませんでした',
        'clipLang.ja': '日本語',
        'clipLang.ko': '한국어',
        'clipLang.en': 'English',
        'clipLang.zh': '中文'
    },
    en: {
        'nav.home': 'Home',
        'nav.live': 'Live & Upcoming',
        'nav.archive': 'Archive',
        'nav.songs': 'Songs',
        'nav.clips': 'Clips',
        'nav.stats': 'Stats',
        'search.placeholder': 'Enter a search term...',
        'sidebar.hideUnarchived': 'Unarchived',
        'sidebar.filter': 'Search Filter',
        'sidebar.settings': 'Settings',
        'sidebar.filterCount': 'Search Filter ({count})',
        'filter.member': 'Members',
        'filter.collab': 'Collab',
        'songDb.title': 'Song DB',
        'songDb.segments': 'Song Segments',
        'songDb.videos': 'Videos',
        'songDb.latest': 'Latest Update',
        'footer.holodexBased': 'based',
        'footer.fanSite': 'Unofficial fan site',
        'apiModal.title': 'Holodex API Key Required',
        'apiModal.body': 'An API key is required for clip search',
        'apiModal.guideSuffix': 'to issue a key (User Settings → API Key)',
        'apiModal.inputPlaceholder': 'Enter API Key',
        'apiModal.save': 'Save',
        'settings.title': 'Talent Management',
        'settings.languageTitle': 'Display Language',
        'settings.channelSearch': 'Channel Search',
        'settings.channelPlaceholder': 'Channel name (2+ characters)',
        'settings.search': 'Search',
        'settings.searching': 'Searching...',
        'settings.noResults': 'No results found',
        'settings.add': 'Add',
        'settings.added': 'Added',
        'settings.remove': 'Remove',
        'settings.myTalents': 'My Talents',
        'settings.syncStart': 'Start Sync',
        'settings.syncHint': 'Talent list changes appear immediately. New data refreshes periodically on the server',
        'settings.resetDefault': 'Reset to defaults',
        'settings.deleteApiKey': 'Delete API Key',
        'settings.enterApiKey': 'Enter API Key',
        'language.ko': '한국어',
        'language.ja': '日本語',
        'language.en': 'English',
        'clips.title': 'Clips',
        'clips.languageFilter': 'Clip language filter',
        'clips.loading': 'Loading clips...',
        'clips.noClips': 'No clips found',
        'clips.loadFailed': 'Failed to load clips',
        'clipLang.ja': '日本語',
        'clipLang.ko': '한국어',
        'clipLang.en': 'English',
        'clipLang.zh': '中文'
    }
});

function canUseStorage() {
    return typeof window !== 'undefined' && Boolean(window.localStorage);
}

function normalizeLocale(locale) {
    return SUPPORTED_LOCALES.some(item => item.code === locale) ? locale : DEFAULT_LOCALE;
}

export function getLocale() {
    if (!canUseStorage()) return DEFAULT_LOCALE;
    return normalizeLocale(window.localStorage.getItem(LOCALE_STORAGE_KEY));
}

export function setLocale(locale) {
    const normalized = normalizeLocale(locale);
    if (canUseStorage()) {
        window.localStorage.setItem(LOCALE_STORAGE_KEY, normalized);
    }
    return normalized;
}

export function t(key, replacements = {}) {
    const locale = getLocale();
    const message = MESSAGES[locale]?.[key] || MESSAGES[DEFAULT_LOCALE][key] || key;
    return Object.entries(replacements).reduce((text, [name, value]) => {
        return text.replaceAll(`{${name}}`, String(value));
    }, message);
}

export function applyLocale(locale = getLocale()) {
    const normalized = normalizeLocale(locale);
    const meta = SUPPORTED_LOCALES.find(item => item.code === normalized);
    document.documentElement.lang = meta?.htmlLang || DEFAULT_LOCALE;

    document.querySelectorAll('[data-i18n]').forEach(element => {
        element.textContent = t(element.dataset.i18n);
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(element => {
        element.setAttribute('placeholder', t(element.dataset.i18nPlaceholder));
    });
    document.querySelectorAll('[data-i18n-title]').forEach(element => {
        element.setAttribute('title', t(element.dataset.i18nTitle));
    });
    document.querySelectorAll('[data-i18n-aria-label]').forEach(element => {
        element.setAttribute('aria-label', t(element.dataset.i18nAriaLabel));
    });
}

export { DEFAULT_LOCALE, SUPPORTED_LOCALES };
