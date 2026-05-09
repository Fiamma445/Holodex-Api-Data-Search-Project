/**
 *
 *
 *
 */

import {
    CHANNELS, DEFAULT_CHANNEL_ID, getDefaultChannelId, getChannelById,
    getMyChannels, saveMyChannels, addChannel, removeChannel,
    DEFAULT_CHANNELS
} from './src/data/channels.js?v=20260510-1';
import { getState, setState, INITIAL_STATE, getPersistedState } from './src/state/appState.js?v=20260510-1';
import { getStateFromHash, updateUrlHash, restoreStateFromHash } from './src/state/urlHash.js?v=20260510-1';
import { showToast } from './src/ui/toast.js?v=20260510-1';
import { showSyncOverlay, hideSyncOverlay, updateSyncOverlay } from './src/ui/syncOverlay.js?v=20260510-1';
import { createVideoCard } from './src/ui/videoCard.js?v=20260510-1';
import { createSongCard } from './src/ui/songCard.js?v=20260510-1';
import { renderChannelList, updateActiveChannel, applyChannelTheme } from './src/ui/channelList.js?v=20260510-1';
import { renderPagination, ITEMS_PER_PAGE } from './src/ui/pagination.js?v=20260510-1';
import { getChannelImageProxyUrl, getMemberPhotoUrl, getRemoteMemberPhotoUrl } from './src/data/memberPhotos.js?v=20260510-1';
import { applyLocale, getLocale, setLocale, t } from './src/data/i18n.js?v=20260510-4';
import { getLocalizedGenerationName, getLocalizedTalentName } from './src/data/localizedNames.js?v=20260510-1';

let refreshInterval = null;
let syncPollInterval = null;
const THEME_STORAGE_KEY = 'holo_search_theme';

let isAutoRefreshInFlight = false;
let visibilityHandler = null;

const requestSerials = {
    live: 0,
    archive: 0,
    clips: 0,
    songs: 0
};
let songDetailSerial = 0;

// === 珥덇린??===
function init() {
    checkApiKey();

    const restoredState = {
        ...restoreStateFromHash(INITIAL_STATE),
        ...getPersistedState()
    };
    setState(restoredState);

    // UI 珥덇린??
    renderChannelList(selectChannel);
    setupNavigation();
    setupSearch();
    setupCollabFilter();
    setupApiKeyModal();
    setupSongControls();
    setupSongDetailModal();
    setupArchiveTabs();
    setupThemeToggle();
    setupAppLanguageControls();

    const state = getState();
    const initialChannelId = state.currentChannelId || getDefaultChannelId();
    selectChannel(initialChannelId, { preservePage: true });

    if (state.currentView !== 'home') {
        switchView(state.currentView);
    }

    restoreArchiveTabUI(state.videoType || 'all');

    startAutoRefresh();

    setupLangFilter();

    setupVisibilityHandler();

    setupChannelSettings();
}

function checkApiKey() {
    getSyncStatus().then(status => {
        if (status.isSyncing) {
            showSyncOverlay();
            startSyncPolling(true);
        }
    });
}

function hasUserApiKey() {
    return Boolean(localStorage.getItem('holodex_api_key'));
}

function isClipsViewActive() {
    const clipsView = document.getElementById('clips-view');
    const isClipsVisible = clipsView && clipsView.style.display !== 'none';
    return getState().currentView === 'clips' && Boolean(isClipsVisible);
}

function setupApiKeyModal() {
    const modal = document.getElementById('api-key-modal');
    const input = document.getElementById('api-key-input');
    const saveBtn = document.getElementById('save-api-key-btn');
    const settingsBtn = document.getElementById('settings-btn');
    const channelSettingsModal = document.getElementById('channel-settings-modal');
    let returnToSettingsAfterSave = false;

    const closeApiKeyModal = () => {
        if (!modal) return;
        modal.classList.remove('show');
        const shouldReturnToSettings = returnToSettingsAfterSave;
        returnToSettingsAfterSave = false;
        if (shouldReturnToSettings && channelSettingsModal) {
            channelSettingsModal.style.display = 'flex';
            channelSettingsModal.dispatchEvent(new CustomEvent('open'));
        }
    };

    const closeApiKeyModalFromBackdrop = (event) => {
        if (event.target !== modal) return;
        if (event.type === 'contextmenu') event.preventDefault();
        closeApiKeyModal();
    };

    const openApiKeyModal = (options = {}) => {
        const force = options.force === true;
        if (!force && !isClipsViewActive()) return false;
        if (!modal) return false;
        returnToSettingsAfterSave = options.returnToSettings === true;
        if (returnToSettingsAfterSave && channelSettingsModal) {
            channelSettingsModal.style.display = 'none';
        }
        if (input) input.value = localStorage.getItem('holodex_api_key') || '';
        modal.classList.add('show');
        setTimeout(() => input?.focus(), 0);
        return true;
    };

    window.openApiKeyModal = openApiKeyModal;

    if (saveBtn) {
        saveBtn.addEventListener('click', () => {
            const key = input.value.trim();
            if (key) {
                localStorage.setItem('holodex_api_key', key);
                window.dispatchEvent(new CustomEvent('api-key-updated'));
                closeApiKeyModal();

                const myChannels = getMyChannels();
                if (myChannels.length === 0) {
                    saveMyChannels([...DEFAULT_CHANNELS]);
                }
            } else {
                alert('API Key를 입력해주세요.');
            }
        });
    }

    if (settingsBtn) {
        settingsBtn.addEventListener('click', () => {
            if (channelSettingsModal) {
                channelSettingsModal.style.display = 'flex';
                channelSettingsModal.dispatchEvent(new CustomEvent('open'));
            }
        });
    }

    if (modal) {
        modal.addEventListener('click', closeApiKeyModalFromBackdrop);
        modal.addEventListener('contextmenu', closeApiKeyModalFromBackdrop);
    }
}

async function startQuickSync() {
    const apiKey = localStorage.getItem('holodex_api_key') || '';
    if (!apiKey) {
        window.openApiKeyModal?.({ force: true, returnToSettings: true });
        return;
    }

    showSyncOverlay();
    setState({ isSyncing: true });

    const myChannels = getMyChannels();
    const channelList = myChannels.map(ch => ({
        id: ch.id,
        name: ch.name
    }));

    try {
        const res = await fetch('/api/sync', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                fullSync: false,
                apiKey,
                channels: channelList
            })
        });

        if (res.ok) {
            startSyncPolling(true);
        } else if (res.status === 409) {
            startSyncPolling(true);
        } else {
            hideSyncOverlay();
            setState({ isSyncing: false });
            alert('동기화를 시작하지 못했습니다. API 키와 서버 설정을 확인해주세요.');
        }
    } catch {
        hideSyncOverlay();
        setState({ isSyncing: false });
        alert('동기화 시작 중 오류가 발생했습니다.');
    }
}

function clearSyncPolling() {
    if (syncPollInterval) {
        clearInterval(syncPollInterval);
        syncPollInterval = null;
    }
    setState({ isSyncing: false });
}

function startSyncPolling(isInitialSync = false) {
    if (syncPollInterval) return;

    let isFirstCheck = true;

    const checkStatus = async () => {
        const status = await getSyncStatus();
        const searchInput = document.getElementById('search-input');
        const searchBtn = document.getElementById('search-btn');
        const state = getState();
        const wasSyncing = state.isSyncing;
        setState({ isSyncing: status.isSyncing });

        if (status.isSyncing) {
            if (isInitialSync) {
                updateSyncOverlay(status);
            }

            if (searchInput) {
                searchInput.disabled = true;
                searchInput.placeholder = `동기화 중... (${status.syncedChannels}/${status.totalChannels})`;
            }
            if (searchBtn) {
                searchBtn.disabled = true;
                searchBtn.style.opacity = '0.5';
            }
        } else {
            if (wasSyncing || (isFirstCheck && isInitialSync)) {
                if (isInitialSync) {
                    updateSyncOverlay({
                        syncedChannels: status.totalChannels,
                        totalChannels: status.totalChannels,
                        currentChannel: '완료!',
                        totalVideos: status.totalVideos || 0
                    });

                    setTimeout(() => {
                        hideSyncOverlay();
                        if (wasSyncing) {
                            alert('동기화 완료! ' + (status.totalVideos || 0).toLocaleString() + '개의 영상을 다운로드했습니다');
                            location.reload();
                        } else if (isFirstCheck) {
                            showToast("동기화 완료", "이미 모든 데이터가 최신 상태입니다", "image/fubuki.jpg");
                        }
                    }, 500);
                } else if (wasSyncing) {
                    showToast("동기화 완료", "모든 히스토리가 다운로드되었습니다", "image/fubuki.jpg");
                }
            }

            clearSyncPolling();

            if (searchInput) {
                searchInput.disabled = false;
                searchInput.placeholder = "검색어를 입력하세요...";
            }
            if (searchBtn) {
                searchBtn.disabled = false;
                searchBtn.style.opacity = '1';
            }
        }

        isFirstCheck = false;
    };

    checkStatus();
    syncPollInterval = setInterval(checkStatus, 1000);
}

function getInitialTheme() {
    try {
        return localStorage.getItem(THEME_STORAGE_KEY) === 'dark' ? 'dark' : 'light';
    } catch {
        return 'light';
    }
}

function applyTheme(theme) {
    const normalizedTheme = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.dataset.theme = normalizedTheme;

    const toggle = document.getElementById('theme-toggle');
    if (toggle) {
        const isDark = normalizedTheme === 'dark';
        toggle.textContent = isDark ? 'Light' : 'Dark';
        toggle.setAttribute('aria-pressed', String(isDark));
        toggle.setAttribute('aria-label', isDark ? '라이트 모드로 전환' : '다크 모드로 전환');
    }
}

function setupThemeToggle() {
    applyTheme(getInitialTheme());

    const toggle = document.getElementById('theme-toggle');
    if (!toggle) return;

    toggle.addEventListener('click', () => {
        const nextTheme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
        try {
            localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
        } catch {
        }
        applyTheme(nextTheme);
    });
}

function setupNavigation() {
    const navButtons = document.querySelectorAll('.main-nav a');
    navButtons.forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            const targetView = btn.dataset.view;
            switchView(targetView);
        });
    });
}

function switchView(viewName) {
    const previousView = getState().currentView;
    const isViewChange = previousView !== viewName;
    if (isViewChange) {
        resetActiveFilters({ resetSearch: true, resetArchiveType: true });
    }

    setState({ currentView: viewName });

    document.querySelectorAll('.view-section').forEach(section => {
        section.style.display = 'none';
    });

    document.querySelectorAll('.main-nav a').forEach(btn => {
        btn.classList.remove('active');
    });

    const targetSection = document.getElementById(`${viewName}-view`);
    if (targetSection) {
        targetSection.style.display = 'block';
    }

    const activeBtn = document.querySelector(`.main-nav a[data-view="${viewName}"]`);
    if (activeBtn) {
        activeBtn.classList.add('active');
    }

    const unarchivedToggle = document.querySelector('.unarchived-toggle');
    const filterBtn = document.getElementById('filter-btn');
    const songSummary = document.getElementById('song-sidebar-summary');
    const isFilterableView = viewName === 'archive' || viewName === 'songs';

    if (viewName === 'archive') {
        if (unarchivedToggle) unarchivedToggle.style.display = 'flex';
    } else {
        if (unarchivedToggle) unarchivedToggle.style.display = 'none';
    }

    if (isFilterableView) {
        if (filterBtn) filterBtn.style.display = 'block';
        updateFilterPanelMode(viewName);
    } else {
        if (filterBtn) filterBtn.style.display = 'none';
        resetAllFilters();
    }
    if (songSummary) {
        songSummary.hidden = viewName !== 'songs';
    }


    loadViewData(viewName);

    const state = getState();
    updateUrlHash(state);
}

function resetFilterControls() {
    const unarchivedCheckbox = document.getElementById('hide-unarchived-checkbox');
    const unarchivedLabel = unarchivedCheckbox?.closest('.unarchived-toggle');
    if (unarchivedCheckbox) unarchivedCheckbox.checked = false;
    unarchivedLabel?.classList.remove('active');

    const collabCheckboxes = document.querySelectorAll('#collab-generation-list input[type="checkbox"]');
    collabCheckboxes.forEach(cb => {
        cb.checked = false;
        cb.closest('.member-item')?.classList.remove('checked');
    });

    const modeSelect = document.getElementById('collab-filter-mode');
    if (modeSelect) modeSelect.value = 'or';
    updateFilterButtonState([]);

    const yearBtns = document.querySelectorAll('.year-btn');
    yearBtns.forEach(btn => btn.classList.remove('selected'));

    const monthBtns = document.querySelectorAll('.month-btn');
    monthBtns.forEach(btn => btn.classList.remove('selected'));

    selectedDates = [];
    clearQuickDateSelection();
    if (datePickerInstance) {
        datePickerInstance.clear();
    }
    updateSelectedDatesDisplay();

    const filterPanel = document.getElementById('search-filter-panel');
    if (filterPanel) {
        filterPanel.classList.remove('show');
        filterPanel.style.display = 'none';
    }
}

function resetArchiveTabControls() {
    const archiveTabs = document.querySelectorAll('.archive-tab');
    archiveTabs.forEach(tab => {
        tab.classList.toggle('active', tab.dataset.type === 'all');
    });

    const sectionHeader = document.querySelector('#archive-view .section-header h3');
    if (sectionHeader) {
        sectionHeader.textContent = ARCHIVE_TAB_TITLES.all;
    }
}

function resetActiveFilters(options = {}) {
    const { resetSearch = false, resetArchiveType = false } = options;
    if (resetSearch) {
        const searchInput = document.getElementById('search-input');
        if (searchInput) searchInput.value = '';
    }

    resetFilterControls();

    const nextState = {
        collabFilter: '',
        collabMode: 'or',
        hideUnarchived: false,
        filterDates: [],
        filterYears: null,
        filterMonths: null,
        archivePage: 1,
        clipsPage: 1,
        songsPage: 1,
        songSort: 'recent',
        songCategory: 'all',
        clipLangs: ['ja']
    };

    if (resetSearch) nextState.currentSearchQuery = '';
    if (resetArchiveType) {
        nextState.videoType = 'all';
        resetArchiveTabControls();
    }

    setState(nextState);

    const sortSelect = document.getElementById('song-sort-select');
    if (sortSelect) sortSelect.value = 'recent';
    updateSongCategoryTabs('all');
    updateClipLanguageOptions(['ja']);
}

function resetAllFilters() {
    resetActiveFilters({ resetSearch: true, resetArchiveType: true });
}

function updateFilterPanelMode(viewName) {
    const panel = document.getElementById('search-filter-panel');
    const collabTab = document.querySelector('.filter-tab[data-tab="collab"]');
    const dateTab = document.querySelector('.filter-tab[data-tab="date"]');
    const collabContent = document.getElementById('collab-filter-tab');
    const dateContent = document.getElementById('date-filter-tab');
    const isSongView = viewName === 'songs';

    panel?.classList.toggle('member-only-filter', isSongView);
    if (dateTab) dateTab.hidden = isSongView;
    if (collabTab) collabTab.textContent = isSongView ? t('filter.member') : t('filter.collab');

    if (isSongView) {
        collabTab?.classList.add('active');
        dateTab?.classList.remove('active');
        collabContent?.classList.add('active');
        dateContent?.classList.remove('active');
    }
}

// === 寃??===
function normalizeCollabFilterMembers(value) {
    if (Array.isArray(value)) return value.filter(Boolean);
    if (typeof value === 'string' && value.trim()) {
        return value.split(',').map(item => item.trim()).filter(Boolean);
    }
    return [];
}

function updateFilterButtonState(selectedMembers) {
    const filterBtn = document.getElementById('filter-btn');
    if (!filterBtn) return;

    if (selectedMembers.length > 0) {
        filterBtn.classList.add('active');
        filterBtn.textContent = t('sidebar.filterCount', { count: selectedMembers.length });
        return;
    }

    filterBtn.classList.remove('active');
    filterBtn.textContent = t('sidebar.filter');
}

function restoreCollabCheckboxes(selectedMembers) {
    const selectedSet = new Set(normalizeCollabFilterMembers(selectedMembers));
    document.querySelectorAll('#collab-generation-list input[type="checkbox"]').forEach(checkbox => {
        const item = checkbox.closest('.member-item');
        const keys = [checkbox.value, checkbox.dataset.member, item?.dataset.member].filter(Boolean);
        checkbox.checked = keys.some(key => selectedSet.has(key));
        checkbox.closest('.member-item')?.classList.toggle('checked', checkbox.checked);
    });
}

function updateMonthButtonsUI() {
    const container = document.getElementById('month-selector');
    if (!container) return;

    container.querySelectorAll('.month-btn').forEach(btn => {
        const month = parseInt(btn.dataset.month, 10);
        btn.classList.toggle('selected', selectedQuickMonths.includes(month));
    });
}

function restoreFilterUiFromState() {
    const state = getState();
    const searchInput = document.getElementById('search-input');
    if (searchInput) {
        searchInput.value = state.currentSearchQuery || '';
    }

    const selectedMembers = normalizeCollabFilterMembers(state.collabFilter);
    restoreCollabCheckboxes(selectedMembers);
    updateFilterButtonState(selectedMembers);

    const modeSelect = document.getElementById('collab-filter-mode');
    if (modeSelect) {
        modeSelect.value = state.collabMode === 'and' ? 'and' : 'or';
    }

    const unarchivedCheckbox = document.getElementById('hide-unarchived-checkbox');
    const unarchivedLabel = unarchivedCheckbox?.closest('.unarchived-toggle');
    if (unarchivedCheckbox) {
        unarchivedCheckbox.checked = Boolean(state.hideUnarchived);
        unarchivedLabel?.classList.toggle('active', Boolean(state.hideUnarchived));
    }

    selectedDates = Array.isArray(state.filterDates) ? [...state.filterDates] : [];
    selectedQuickYears = Array.isArray(state.filterYears) ? [...state.filterYears] : [];
    selectedQuickMonths = Array.isArray(state.filterMonths) ? [...state.filterMonths] : [];
    if (selectedQuickYears.length > 0) {
        quickSelectBaseYear = Math.min(...selectedQuickYears);
    }
    renderYearButtons();
    updateYearButtonsUI();
    updateMonthButtonsUI();
    if (datePickerInstance) {
        datePickerInstance.setDate(selectedDates, false);
    }
    updateSelectedDatesDisplay();

    const sortSelect = document.getElementById('song-sort-select');
    if (sortSelect) {
        sortSelect.value = state.songSort || 'recent';
    }
    updateSongCategoryTabs(state.songCategory || 'all');

    updateClipLanguageOptions(state.clipLangs || ['ja']);
    restoreArchiveTabUI(state.videoType || 'all');
}

function setupSearch() {
    const searchBtn = document.getElementById('search-btn');
    const searchInput = document.getElementById('search-input');

    if (searchBtn) {
        searchBtn.addEventListener('click', () => {
            const query = searchInput ? searchInput.value.trim() : '';
            performSearch(query);
        });
    }

    if (searchInput) {
        searchInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                const query = searchInput.value.trim();
                performSearch(query);
            }
        });
    }
}

const ICON_CACHE_KEY = 'holodex_member_icons';
const ICON_CACHE_EXPIRY = 7 * 24 * 60 * 60 * 1000; // 7??

function loadIconCache() {
    try {
        const cached = localStorage.getItem(ICON_CACHE_KEY);
        if (cached) {
            const { data, expiry } = JSON.parse(cached);
            if (Date.now() < expiry) {
                return data;
            }
        }
    } catch (e) {
        console.warn('Failed to load icon cache:', e);
    }
    return {};
}

let memberIconCache = loadIconCache();

let datePickerInstance = null;
let selectedDates = [];

function setupCollabFilter() {
    const filterBtn = document.getElementById('filter-btn');
    const filterPanel = document.getElementById('search-filter-panel');
    const generationList = document.getElementById('collab-generation-list');
    const applyBtn = document.getElementById('apply-filter-btn');
    const resetBtn = document.getElementById('clear-filter-btn');

    if (!filterBtn || !filterPanel || !generationList) return;

    renderGenerationList(generationList);

    filterBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const isOpen = filterPanel.classList.contains('show');
        filterPanel.classList.toggle('show');

        if (!isOpen) {
            filterPanel.style.display = 'block';
            setTimeout(() => filterPanel.classList.add('show'), 10);
            if (getState().currentView !== 'songs') {
                initDatePicker();
            }
        }
    });

    document.addEventListener('click', (e) => {
        if (!filterPanel.contains(e.target) && e.target !== filterBtn) {
            filterPanel.classList.remove('show');
            setTimeout(() => {
                if (!filterPanel.classList.contains('show')) {
                    filterPanel.style.display = 'none';
                }
            }, 300);
        }
    });

    setupFilterTabs();

    if (applyBtn) {
        applyBtn.addEventListener('click', () => {
            const selectedMembers = getSelectedCollabMembers();
            const modeSelect = document.getElementById('collab-filter-mode');
            const mode = modeSelect ? modeSelect.value : 'or';
            applyCollabFilter(selectedMembers, mode);
            filterPanel.classList.remove('show');
        });
    }

    if (resetBtn) {
        resetBtn.addEventListener('click', () => {
            clearAllCheckboxes(generationList);
            applyCollabFilter([]);
            filterPanel.classList.remove('show');
        });
    }

    setupDateFilterButtons();

    setupHideUnarchivedCheckbox();
}

function setupFilterTabs() {
    const tabs = document.querySelectorAll('.filter-tab');
    const tabContents = document.querySelectorAll('.filter-tab-content');

    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            const targetTab = tab.dataset.tab;

            tabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');

            tabContents.forEach(content => {
                if (content.id === `${targetTab}-filter-tab`) {
                    content.classList.add('active');
                } else {
                    content.classList.remove('active');
                }
            });

            if (targetTab === 'date') {
                initDatePicker();
                initQuickDateSelector();
            }
        });
    });
}

// Flatpickr ?щ젰 珥덇린??
function initDatePicker() {
    const container = document.getElementById('date-picker-container');
    if (!container || datePickerInstance) return;

    if (typeof flatpickr === 'undefined') {
        console.error('Flatpickr is not loaded');
        return;
    }

    datePickerInstance = flatpickr(container, {
        inline: true,
        mode: 'multiple',
        dateFormat: 'Y-m-d',
        locale: 'ko',
        defaultDate: selectedDates,
        onChange: (dates) => {
            selectedDates = dates.map(d => formatDate(d));
            updateSelectedDatesDisplay();

            if (!isQuickSelectUpdating) {
                clearQuickDateSelection();
            }
        }
    });
}

function formatDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function updateSelectedDatesDisplay() {
    const container = document.getElementById('selected-dates-list');
    if (!container) return;

    if (selectedDates.length === 0) {
        container.innerHTML = '<span class="no-dates">날짜를 선택하세요</span>';
        return;
    }

    container.innerHTML = selectedDates
        .sort()
        .map(date => {
            const [year, month, day] = date.split('-');
            const displayDate = `${parseInt(month)}/${parseInt(day)}`;
        return `<span class="date-tag" data-date="${date}">${displayDate}<span class="remove-date" title="제거">&times;</span></span>`;
        })
        .join('');

    container.querySelectorAll('.remove-date').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();

            const tag = e.target.closest('.date-tag');
            const dateToRemove = tag.dataset.date;

            selectedDates = selectedDates.filter(d => d !== dateToRemove);

            if (datePickerInstance) {
                datePickerInstance.setDate(selectedDates, false);
            }

            updateSelectedDatesDisplay();
        });
    });
}

function setupDateFilterButtons() {
    const applyBtn = document.getElementById('apply-date-btn');
    const clearBtn = document.getElementById('clear-date-btn');

    if (applyBtn) {
        applyBtn.addEventListener('click', () => {
            applyQuickDateFilter();
            applyDateFilter(selectedDates);
            const filterPanel = document.getElementById('search-filter-panel');
            if (filterPanel) filterPanel.classList.remove('show');
        });
    }

    if (clearBtn) {
        clearBtn.addEventListener('click', () => {
            selectedDates = [];
            if (datePickerInstance) {
                datePickerInstance.clear();
            }
            updateSelectedDatesDisplay();

            clearQuickDateSelection();
            setState({
                filterYears: null,
                filterMonths: null
            });

            applyDateFilter([]);
        });
    }
}

// ========================================
// ========================================

let quickSelectBaseYear = new Date().getFullYear() - 1;
let selectedQuickYears = [];
let selectedQuickMonths = [];
let isQuickSelectUpdating = false;

function initQuickDateSelector() {
    renderYearButtons();
    setupYearNavigation();
    setupMonthButtons();
}

function renderYearButtons() {
    const container = document.getElementById('year-buttons');
    if (!container) return;

    container.innerHTML = '';
    for (let i = 0; i < 3; i++) {
        const year = quickSelectBaseYear + i;
        const btn = document.createElement('button');
        btn.className = 'year-btn';
        btn.dataset.year = year;
        btn.textContent = year;
        if (selectedQuickYears.includes(year)) {
            btn.classList.add('selected');
        }

        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const clickedYear = parseInt(btn.dataset.year);

            const index = selectedQuickYears.indexOf(clickedYear);
            if (index > -1) {
                selectedQuickYears = selectedQuickYears.filter(y => y !== clickedYear);
                btn.classList.remove('selected');

                if (selectedQuickYears.length === 0) {
                    selectedQuickMonths = [];
                    clearMonthSelection();
                }
            } else {
                selectedQuickYears = [...selectedQuickYears, clickedYear];
                btn.classList.add('selected');

                if (datePickerInstance) {
                    datePickerInstance.jumpToDate(new Date(clickedYear, 0, 1));
                }
            }

            syncCalendarWithQuickSelect();
        });

        container.appendChild(btn);
    }
}

function setupYearNavigation() {
    const prevBtn = document.getElementById('prev-year-btn');
    const nextBtn = document.getElementById('next-year-btn');

    if (prevBtn) {
        prevBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            quickSelectBaseYear -= 1;
            renderYearButtons();
        });
    }

    if (nextBtn) {
        nextBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            quickSelectBaseYear += 1;
            renderYearButtons();
        });
    }
}

function setupYearButtons() {
    const container = document.getElementById('year-buttons');
    if (!container) return;

    container.querySelectorAll('.year-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const year = parseInt(btn.dataset.year);

            const index = selectedQuickYears.indexOf(year);
            if (index > -1) {
                selectedQuickYears = selectedQuickYears.filter(y => y !== year);
                btn.classList.remove('selected');
            } else {
                selectedQuickYears = [...selectedQuickYears, year];
                btn.classList.add('selected');
            }
        });
    });
}

function setupMonthButtons() {
    const container = document.getElementById('month-selector');
    if (!container) return;

    container.querySelectorAll('.month-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();

            if (selectedQuickYears.length === 0) {
                btn.classList.add('shake');
                setTimeout(() => btn.classList.remove('shake'), 300);
                return;
            }

            const month = parseInt(btn.dataset.month);

            const index = selectedQuickMonths.indexOf(month);
            if (index > -1) {
                selectedQuickMonths = selectedQuickMonths.filter(m => m !== month);
                btn.classList.remove('selected');
            } else {
                selectedQuickMonths = [...selectedQuickMonths, month];
                btn.classList.add('selected');

                if (datePickerInstance && selectedQuickYears.length > 0) {
                    const firstYear = Math.min(...selectedQuickYears);
                    datePickerInstance.jumpToDate(new Date(firstYear, month - 1, 1));
                }
            }

            syncCalendarWithQuickSelect();
        });
    });
}

function updateYearButtonsUI() {
    const container = document.getElementById('year-buttons');
    if (!container) return;

    container.querySelectorAll('.year-btn').forEach(btn => {
        const year = parseInt(btn.dataset.year);
        if (selectedQuickYears.includes(year)) {
            btn.classList.add('selected');
        } else {
            btn.classList.remove('selected');
        }
    });
}

function clearMonthSelection() {
    const container = document.getElementById('month-selector');
    if (!container) return;
    container.querySelectorAll('.month-btn').forEach(b => b.classList.remove('selected'));
}

function clearQuickDateSelection() {
    selectedQuickYears = [];
    selectedQuickMonths = [];
    const yearContainer = document.getElementById('year-buttons');
    if (yearContainer) {
        yearContainer.querySelectorAll('.year-btn').forEach(b => b.classList.remove('selected'));
    }
    clearMonthSelection();
}

function syncCalendarWithQuickSelect() {
    if (!datePickerInstance) return;
    if (selectedQuickYears.length === 0) {
        isQuickSelectUpdating = true;
        datePickerInstance.clear();
        selectedDates = [];
        updateSelectedDatesDisplay();
        isQuickSelectUpdating = false;
        return;
    }

    const allDates = [];
    const years = selectedQuickYears;
    const months = selectedQuickMonths.length > 0 ? selectedQuickMonths : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

    years.forEach(year => {
        months.forEach(month => {
            const lastDay = new Date(year, month, 0).getDate();
            for (let day = 1; day <= lastDay; day++) {
                allDates.push(new Date(year, month - 1, day));
            }
        });
    });

    isQuickSelectUpdating = true;
    datePickerInstance.setDate(allDates, false);
    selectedDates = allDates.map(d => formatDate(d));
    updateSelectedDatesDisplay();
    isQuickSelectUpdating = false;
}

function applyQuickDateFilter() {
    setState({
        filterYears: selectedQuickYears.length > 0 ? [...selectedQuickYears] : null,
        filterMonths: selectedQuickMonths.length > 0 ? [...selectedQuickMonths] : null
    });

    const state = getState();
    if (state.currentView === 'archive' || state.currentView === 'home') {
        loadArchives(state.currentChannelId, 1);
    }
}

function applyDateFilter(dates) {
    setState({
        filterDates: dates,
        archivePage: 1
    });

    const state = getState();
    if (state.currentView === 'archive' || state.currentView === 'home') {
        loadArchives(state.currentChannelId, 1);
    }
}

function setupHideUnarchivedCheckbox() {
    const checkbox = document.getElementById('hide-unarchived-checkbox');
    const label = checkbox?.closest('.unarchived-toggle');
    if (!checkbox || !label) return;


    checkbox.addEventListener('change', () => {
        const newValue = checkbox.checked;

        setState({ hideUnarchived: newValue, archivePage: 1 });

        if (newValue) {
            label.classList.add('active');
        } else {
            label.classList.remove('active');
        }

        const currentState = getState();
        if (currentState.currentView === 'archive' || currentState.currentView === 'home') {
            loadArchives(currentState.currentChannelId, 1);
        }
    });
}

const MEMBER_PHOTOS = {
    // 0湲곗깮
    'UCp6993wxpyDPHUpavwDFqgg': 'https://yt3.ggpht.com/ytc/AIdro_kT9PiLS8BWANuBdGG_-GHsNZxFqmF0YjMnzK55jISdca4=s800-c-k-c0x00ffffff-no-rj', // Tokino Sora
    'UCDqI2jOz0weumE8s7paEk6g': 'https://yt3.ggpht.com/H8pRHxQm4-FjRl9XUFn9UQbJhVcj5PIvwDW6o7ZlBTRj2bgVP5xonQEl36H-O6NHaWmbP1zaxg=s800-c-k-c0x00ffffff-no-rj', // Roboco
    'UC-hM6YJuNYVAmUWxeIr9FeA': 'https://yt3.ggpht.com/b8EKl_i-e2dinoparyhUJEaRhInlSWwm-dZX0oIq-x1mUvQga530G_PIdutlSNkGKEAyX9aaBQ=s800-c-k-c0x00ffffff-no-rj', // Sakura Miko
    'UC5CwaMl1eIgY8h02uZw7u8A': 'https://yt3.ggpht.com/ytc/AIdro_kLDBK5ksSvk5-XJ6S8e0kWfjy7mVl3jyUkgDeMQ7rlCpU=s800-c-k-c0x00ffffff-no-rj', // Suisei
    'UC0TXe_LYZ4scaW2XMyi5_kw': 'https://yt3.ggpht.com/tRZGMhn8vSvYE0_15SjaE_3dTH5JTZzjdnb5gs1StecT1tKn1gQ2tVkRfi_n42Q5fYz13ewdayo=s800-c-k-c0x00ffffff-no-rj', // AZKi
    // 1湲곗깮
    'UCdn5BQ06XqgXoAxIhbqw5Rg': 'https://yt3.ggpht.com/ytc/AIdro_mGXEeXXCCPh-sl2jKYbYpLBuCsjEGDgJaL5RQziYhyugQ=s800-c-k-c0x00ffffff-no-rj', // Fubuki
    'UCQ0UDLQCjY0rmuxCDE38FGg': 'https://yt3.ggpht.com/LZBvU0s_S-xi7fHmeab_iA8ztfGimxzisUBMODGKaIEx3r3R-tIDReiX3SlmbH2showigElJ=s800-c-k-c0x00ffffff-no-rj', // Matsuri
    'UCFTLzh12_nrtzqBPsTCqenA': 'https://yt3.ggpht.com/0Nx9jWdjiUrkizCVCDZg_MasdF6b85DAsQATmAkNC2A8b3Y89vXlnSDZ_v1fM_X4w3088sJnmA=s800-c-k-c0x00ffffff-no-rj', // Aki
    'UC1CfXB_kRs3C-zaeTG3oGyg': 'https://yt3.ggpht.com/jxI6FmNKDpYKXB0puyLhB5gq4JgWFvRT9Rr2C_d3hFT1q0SSOHh3QIUfvSxfTHupTXFnleqI=s800-c-k-c0x00ffffff-no-rj', // Haato
    // 2湲곗깮
    'UC1opHUrw8rvnsadT-iGp7Cg': 'https://yt3.ggpht.com/ytc/AIdro_kaZLtKaya9TSJr3M4lpzV95R2rWdQtGk67fwedroUfSnE=s800-c-k-c0x00ffffff-no-rj', // Aqua
    'UCXTpFs_3PqI41qX2d9tL2Rw': 'https://yt3.ggpht.com/K91NQLuy_JMQ65n-Opf0Q2FZBO3yOURnMRusO7o5DTjaJ1QVtP-ANN4lehK57X4KXpcI2MiRig=s800-c-k-c0x00ffffff-no-rj', // Shion
    'UC7fk0CB07ly8oSl0aqKkqFg': 'https://yt3.ggpht.com/3CeLWGYb6cLUywTJzNt-UpITviNxeGNvtjhIqbV-AIybCqCoFw9onWtg91bjwpqvfEP9mfqIR4Q=s800-c-k-c0x00ffffff-no-rj', // Ayame
    'UC1suqwovbL1kzsoaZgFZLKg': 'https://yt3.ggpht.com/gv-5tmPSiFipkP01atgnCS6WwdxzUxfermmqGw_UhuDNtRFmbdb2NALcL6rR0LxaM5JX9JhE9g=s800-c-k-c0x00ffffff-no-rj', // Choco
    'UCvzGlP9oQwU--Y0r9id_jnA': 'https://yt3.ggpht.com/ytc/AIdro_k5mjdt1wcbaYCXKwmDpVXmSGtOc-LH3WjIyUHVC4soP28=s800-c-k-c0x00ffffff-no-rj', // Subaru
    // 寃뚯씠癒몄쫰
    'UCp-5t9SrOQwXMU7iIjQfARg': 'https://yt3.ggpht.com/JV8VdQFA7eZk5H1cRxHyIdLKQ5wD6EBywjxLzrne2EpY9LSiVgtapvh0iQA6plVNxdIKNxK0NRU=s800-c-k-c0x00ffffff-no-rj', // Mio
    'UCvaTdHTWBGv3MKj3KVqJVCw': 'https://yt3.ggpht.com/oD8ISaA35737mg-lt5mYSfOIXmjCeHYcSFFpTQn4AVMkqiyzrMle_THvX6NdfSxbjUO6fQ6_wg=s800-c-k-c0x00ffffff-no-rj', // Okayu
    'UChAnqc_AY5_I3Px5dig3X1Q': 'https://yt3.ggpht.com/ytc/AIdro_nrS6tFctvjyWv1mKzKBIetHJBfpqwHOpvRFc3KU2P_5yc=s800-c-k-c0x00ffffff-no-rj', // Korone
    // 3湲곗깮
    'UC1DCedRgGHBdm81E1llLhOQ': 'https://yt3.ggpht.com/B-5Iau5CJVDiUOeCvCzHiwdkUijqoi2n0tNwfgIv_yDAvMbLHS4vq1IvK2RxL8y69BxTwmPhow=s800-c-k-c0x00ffffff-no-rj', // Pekora
    'UCvInZx9h3jC2JzsIzoOebWg': 'https://yt3.ggpht.com/XGJE8dQHKGyKma2oLZM-oZxF2c5OnQsjQx68tTowiPfh7gI2cHhP8REzXC7exvw2ri5QxFxEA-4=s800-c-k-c0x00ffffff-no-rj', // Flare
    'UCdyqAaZDKHXg4Ahi7VENThQ': 'https://yt3.ggpht.com/ytc/AIdro_kIKJPVEqJLs9FNMgdti5WWHtc1t0MwihOlW-ZK90nGUdk=s800-c-k-c0x00ffffff-no-rj', // Noel
    'UCCzUftO8KOVkV4wQG1vkUvg': 'https://yt3.ggpht.com/RnFYoR_VkEZZ4OGRJz2cPXem1iRqMNzcGVp5LIxTRqhDu4vqckc83DBrVi2uwxiCPWEmmH6vSJk=s800-c-k-c0x00ffffff-no-rj', // Marine
    // 4湲곗깮
    'UCZlDXzGoo7d44bwdNObFacg': 'https://yt3.ggpht.com/KjtzUgvj7v4socyPBkwZVlRJC9YU7Seka_a2lYf-LuBgc_YXXknzaR--5rbtYR46Q-JAWcR-=s800-c-k-c0x00ffffff-no-rj', // Kanata
    'UCqm3BQLlJfvkTsX_hvm0UmA': 'https://yt3.ggpht.com/XJYar8ZAQ59ce0nFlf-Dl6V16Dwznu5xfh3XnMW_JE-nCVLHLiRTS-x1gB_eR4_CJY3KDfKxsVo=s800-c-k-c0x00ffffff-no-rj', // Watame
    'UC1uv2Oq6kNxgATlCiez59hw': 'https://yt3.ggpht.com/kF39-I4IfZJOWuGiciawwB-v4M_X9u6_-jxCvAiYSHSRuUS-LdpeWWRHO7c4Pk8sXROBaPl9iMQ=s800-c-k-c0x00ffffff-no-rj', // Towa
    'UCa9Y57gfeY0Zro_noHRVrnw': 'https://yt3.ggpht.com/05zupy7ai3DW0mEmY3tSgkb4CGjHadAXG0bs_PSzg09l0_5MInPrG4Bh-ZRlAWcPncOe9cnQkQ=s800-c-k-c0x00ffffff-no-rj', // Luna
    'UCS9uQI-jC3DE0L4IpXyvr6w': 'https://yt3.ggpht.com/ytc/AMLnZu8xM8iFAtHMoKUPqKh-0NT7QL6zU06fEgwkIB0D0A=s800-c-k-c0x00ffffff-no-rj', // Coco
    // 5湲곗깮
    'UCFKOVgVbGmX65RxO3EtH3iw': 'https://yt3.ggpht.com/ytc/AIdro_nHPsjV8KMncrIzZh7NPGaG8xzAgzN8Vf9YAj12dRN7sCc=s800-c-k-c0x00ffffff-no-rj', // Lamy
    'UCAWSyEs_Io8MtpY3m-zqILA': 'https://yt3.ggpht.com/yQDRxiMIkbHsn7e4s6BCIBCNb3WmiV1myrpo6Lq2-dfCmAn1N47y12mhZg0NOfQMWQMYW4Qm=s800-c-k-c0x00ffffff-no-rj', // Nene
    'UCUKD-uaobj9jiqB-VXt71mA': 'https://yt3.ggpht.com/WSOgf5zOOFKQN8pQB8VL8R6OSO0j81oGQSSzN22m8mts4VWZSPHDou7II8Lk4JA3OlQL-Iuu=s800-c-k-c0x00ffffff-no-rj', // Botan
    'UCK9V2B22uJYu3N7eR_BT9QA': 'https://yt3.ggpht.com/42QEdu1EEbblI1N1nLIghEHb38jSbUCLBbSKBcjRf9_uPwN77Md5_iTXsCDkFU480_QEfTHJnQ=s800-c-k-c0x00ffffff-no-rj', // Polka
    // holoX
    'UCENwRMx5Yh42zWpzURebzTw': 'https://yt3.ggpht.com/6Y5lj4DhikLBo0UqIZ1dT3-D3aYXVPbxUgNTyYiyE_Se8AVxkGAn05D3oc1y3whpzDu-CzEQ=s800-c-k-c0x00ffffff-no-rj', // La+
    'UC6eWCld0KwmyHFbAqK3V-Rw': 'https://yt3.ggpht.com/2PoZqbHNPXXxjPRgtAuDGY_p6use0QRNk2rN0oXPeE9NtrQGuTuD1psw6sCFDGy8fO_3JwjQPxw=s800-c-k-c0x00ffffff-no-rj', // Koyori
    'UCs9_O1tRPMQTHQ-N_L6FU2g': 'https://yt3.ggpht.com/hoR2TgfGwUZ4mbNY07Ygu88wPLY0JcArmFKZDTwaPOtJmK78gdIg3dmp87NZM8SRBCpxlv02hg=s800-c-k-c0x00ffffff-no-rj', // Lui
    'UCIBY1ollUsauvVi4hW4cumw': 'https://yt3.ggpht.com/laCUmozlesp2wZd9k_DCDG_AYgQRGJm0yiL5pigqWAJE1TzYaOXQ6VcfEGacl8L-gpgR07I7HA=s800-c-k-c0x00ffffff-no-rj', // Chloe
    'UC_vMYWcDjmfdpH6r4TTn1MQ': 'https://yt3.ggpht.com/gq-oA6rRB25b8hLDHhsLqcU1ZSmuuEtIDQabDoaZV1NS-rwAzOit4RdQHz5Afh3mN4FwYnPIPg=s800-c-k-c0x00ffffff-no-rj', // Iroha
    // ReGLOSS
    'UCWQtYtq9EOB4-I5P-3fh8lA': 'https://yt3.ggpht.com/3Naw3X40CVtAsDMP8SFCPIpsfVjP2iUID4oAF8PJgA1ob4akPZ_SQC3LlWAya_kE2INeaLtHUQ=s800-c-k-c0x00ffffff-no-rj', // Kanade
    'UCtyWhCj3AqKh2dXctLkDtng': 'https://yt3.ggpht.com/JhTtQGtkAfXG5XwH3Adzu9Kl8DBTRElKxHFvWop0Z6J2ndAEJfXfDaU1mLUaBsiAjW_RnXBkOQ=s800-c-k-c0x00ffffff-no-rj', // Ririka
    'UCdXAk5MpyLD8594lm_OvtGQ': 'https://yt3.ggpht.com/I3u3NWX2xNjmhVDFm7K8oLn1vZKgzZyyZ2X4_ADINsyLLXv-a2VKLXHO_uHYCKXgVSJdkazjbw=s800-c-k-c0x00ffffff-no-rj', // Raden
    'UC1iA6_NT4mtAcIII6ygrvCw': 'https://yt3.ggpht.com/6vJDLc-py0cRcuDAgukgsE0SXbuia7AupgIuofdQCAidvdT_fcoy0ib6ssKI7rQO_iZO0Tb40Q=s800-c-k-c0x00ffffff-no-rj', // Hajime
    'UCMGfV7TVTmHhEErVJg1oHBQ': 'https://yt3.ggpht.com/nVC4JesCnpLsaI14cM-c3PSecCq9MvnSiLk4V-MuLrY_OL9UYRXnXFUUUy-bCn4iub7j4V0ZOA=s800-c-k-c0x00ffffff-no-rj', // Ao
    // FLOW GLOW
    'UC9LSiN9hXI55svYEBrrK-tw': 'https://yt3.ggpht.com/Nd6K_cman-Bdkl_pv4_3UNpijyb7t5RXjhsso5IreKu0pwigFrc2f5KIM9aGrciqYeHZoJwVUDE=s800-c-k-c0x00ffffff-no-rj', // Riona
    'UCuI_opAVX6qbxZY-a-AxFuQ': 'https://yt3.ggpht.com/bEDo7y7rywqDZpSqS7StN3vxPg4YPEfh_faAf2CENKsk4L9SgrsU0UeClvH-nsPq1i5xNFM89Q=s800-c-k-c0x00ffffff-no-rj', // Niko
    'UCjk2nKmHzgH5Xy-C5qYRd5A': 'https://yt3.ggpht.com/iATADgRHFUjwjw_IBRN_G_MN4zsQ6UEHHibOroZhTKQuxj6So1oFIm4EthlZF_Iv73UnkGm4ZuY=s800-c-k-c0x00ffffff-no-rj', // Su
    'UCKMWFR6lAstLa7Vbf5dH7ig': 'https://yt3.ggpht.com/VW2sZveoSaP-ZrCVPqNdM57LyRWIaTAVpSeWjcWScm3v1lqHqgNL2_bKZSX1jvuKBDehi0fFPQ=s800-c-k-c0x00ffffff-no-rj', // Chihaya
    'UCGzTVXqMQHa4AgJVJIVvtDQ': 'https://yt3.ggpht.com/1gNTfXSUE6ua7RJw0F-zV9kzFiSfQG4F2Nuj4_zUFfbDEXfbZUxki8kmOfZagS9n4EdxAZ9_-A=s800-c-k-c0x00ffffff-no-rj', // Vivi
    // EN Myth
    'UCL_qhgtOy0dy1Agp8vkySQg': 'https://yt3.ggpht.com/ZZuzZBS3JHrZz49K3ApCYQo1NQLhN3ApfW0R9hAaIfCLMfx5YTL51bOgJv0zk6Ikdngmmn0G=s800-c-k-c0x00ffffff-no-rj', // Calli
    'UCHsx4Hqa-1ORjQTh9TYDhww': 'https://yt3.ggpht.com/vnzn_RiKneABPPnp1-0SO4IAZQRXqVsL5RNDQYGR9GhT-Flm47vM4UJeyGfn4U_gteKqJMBwNA=s800-c-k-c0x00ffffff-no-rj', // Kiara
    'UCMwGHR0BTZuLsmjY_NT5Pwg': 'https://yt3.ggpht.com/hJ45UDEa_rKtqxjNcIcYYJ_3eBvl9Jj2H-gXHBwNDwKOcSvDLjSwgOVbU9tEbUQmpGnyGwQFLQ=s800-c-k-c0x00ffffff-no-rj', // Ina
    'UCoSrY_IQQVpmIRZ9Xf-y93g': 'https://yt3.ggpht.com/6BCfAqi9yIpZbHLbw9BAWySvB3XZf9r8jFqudO5nSOsHoGzLhlKrm1M1uuMCRabi_pXGDzl7=s800-c-k-c0x00ffffff-no-rj', // Gura
    'UCyl1z3jo3XHR1riLFKG5UAg': 'https://yt3.ggpht.com/WrANARkFwg4mlLa7SonZpwhS9_wiepSBhVGH90pIaXQsKCoBNiu3zyWVqW3nfBlbLTgOiOFO=s800-c-k-c0x00ffffff-no-rj', // Ame
    // EN Promise
    'UC8rcEBzJSleTkf_-agPM20g': 'https://yt3.ggpht.com/zztv3u0fMtIbGu5nLjKPTwR_8-U0nSq80kmWW0xBpc42tA6dFHlDb_TG3VjSPLNFBuAIZtaFrw=s800-c-k-c0x00ffffff-no-rj', // IRyS
    'UCO_aKKYxn4tvrqPjcTzZ6EQ': 'https://yt3.googleusercontent.com/TxZ0xm54BKwYJGEoMPda7gK5iPu7Eh0CxLPM4EU9blg4m6ATy5d8NtwBVSOOZFbRdB67PtUf=s800-c-k-c0x00ffffff-no-rj', // Fauna
    'UCmbs8T6MWqUHP1tIQvSgKrg': 'https://yt3.ggpht.com/XxF6c2VtpdbRdLcldz5jp05FQY_JTfOXeVd8osfAZsxODIanpt0ymcn_6nitwydHNGek46cfZ04=s800-c-k-c0x00ffffff-no-rj', // Kronii
    'UC3n5uGu18FoCy23ggWWp8tA': 'https://yt3.ggpht.com/ufO7pGRu0vUfA2FLPz7yN517i8wOYxAdcxB9nSTKKfiKhjec0ulSmwWmRA00KqVpOTIesgXhMA=s800-c-k-c0x00ffffff-no-rj', // Mumei
    'UCgmPnx-EEeOrZSg5Tiw7ZRQ': 'https://yt3.ggpht.com/sFBVGkudEnu_MCH23nJdS2oTnOzd9M7e6Mgki5JBhbj4PnjWGgG2hNmW2Vozw5rr8-K0s-DpaPs=s800-c-k-c0x00ffffff-no-rj', // Bae
    // EN Advent
    'UCgnfPPb9JI3e9A4cXHnWbyg': 'https://yt3.ggpht.com/q23ZTL-eIurUV4sMNtq5pJpFXWKI7dr-XuScFGVtSiDhTR_jrs4v1BpsWX1WP51sP4jjlmA=s800-c-k-c0x00ffffff-no-rj', // Shiori
    'UC9p_lqQ0FEDz327Vgf5JwqA': 'https://yt3.ggpht.com/Wk5Mbh-5z_dbHTp7Hyz7OSd70Cz4GknlZOqiI2J_sIsnbm_YjWN2vb39XyrXBYj-uiMsOi-95w=s800-c-k-c0x00ffffff-no-rj', // Bijou
    'UC_sFNM0z0MWm9A6WlKPuMMg': 'https://yt3.ggpht.com/V1Ow-KEzUUTOpE6dp3oQzxRAH1t-zwkfnlG8lGG6TbJ5SLPyfNXCSH3xAGVmaDEZfNA4xe4kJQ=s800-c-k-c0x00ffffff-no-rj', // Nerissa
    'UCt9H_RpQzhxzlyBxFqrdHqA': 'https://yt3.ggpht.com/eC6k63zvyZma-t4NwtxhKXaP7smdQuXM6KA9r8i-ZLxnfSh5ngfAPibEAwtbFy4QEGnt_lY6lA=s800-c-k-c0x00ffffff-no-rj', // FUWAMOCO
    // EN Justice
    'UCW5uhrG1eCBYditmhL0Ykjw': 'https://yt3.ggpht.com/1aoKeoCGzuD7XK2U8nUIHfpynIOLecHxF7Adh09XshlrL9kne2uKGOllFcoA2iXBVVe51_V6E48=s800-c-k-c0x00ffffff-no-rj', // ERB
    'UCl69AEx4MdqMZH7Jtsm7Tig': 'https://yt3.ggpht.com/HKYI1ENbRIVyDgLVtpxOKyLAOEdOHWH__-JQu6Kj2dq0S9U-wTccKoZT0-4DBd21O0Cpo6NnlA=s800-c-k-c0x00ffffff-no-rj', // Raora
    'UCDHABijvPBnJm7F-KlNME3w': 'https://yt3.ggpht.com/VTrjE6XoUY0QRq9VgwPIADiUA1S2FYPvJ7qRpUpgix8JLiU-mjKwEtADjS35w9C21Yarxk9kKA=s800-c-k-c0x00ffffff-no-rj', // Gigi
    'UCvN5h1ShZtc7nly3pezRayg': 'https://yt3.ggpht.com/sSuJylnDA4Si69bKWVzwUhrOhgIkBCzGE6DHgDyHCJux8TKi7WU8GyKaKZHEN0a3QG7s2yJ399g=s800-c-k-c0x00ffffff-no-rj', // Cecilia
    // ID Gen 1
    'UCOyYb1c43VlX9rc_lT6NKQw': 'https://yt3.ggpht.com/8dYniYG0Fm49TBxwOW39wDzM25P3aAU7r-wecNaOz5a3I1t8dsYbS5OPZXFeHYQpmVRrY9KrSg=s800-c-k-c0x00ffffff-no-rj', // Risu
    'UCP0BspO_AMEe3aQqqpo89Dg': 'https://yt3.ggpht.com/ArbwGFqxm01MKe6qhEnAqIQCro0MUSyI8BVIu-7Ijr3OBw5z86Y1348DTTDFDstWD-uwpIO3=s800-c-k-c0x00ffffff-no-rj', // Moona
    'UCAoy6rzhSf4ydcYjJw3WoVg': 'https://yt3.ggpht.com/ghhBoD-8O908tlUkF45A49D5jbEOkzYR7dgxweO-sOdtlOvE21BLtVSpn6w4sapj4YEtAVoc=s800-c-k-c0x00ffffff-no-rj', // Iofi
    // ID Gen 2
    'UCYz_5n-uDuChHtLo7My1HnQ': 'https://yt3.ggpht.com/fCQ1LUhWHfIGkCLeZl2BG_uQhQ6IqxJ3AJJxFbG6uEpLJ1hlJ2JOoBG7FJiAREeDeEVtwJoZKA=s800-c-k-c0x00ffffff-no-rj', // Ollie
    'UC727SQYUvx5pDDGQpTICNWg': 'https://yt3.ggpht.com/I1hkzp7Vty4M-KkSccRORE32t4cFq2HI2uAB1t4BPlwej6_XJ4eRlpy7NNZ9x4JBnqlkOnGz=s800-c-k-c0x00ffffff-no-rj', // Anya
    'UChgTyjG-pdNvxxhdsXfHQ5Q': 'https://yt3.ggpht.com/gV1Zr_UQCBsmfyqaJhgj46qud_7HkvdqDNobqz-GSY7cQ4GNSltNxAyc1Y1-9HXXvSoORbzc=s800-c-k-c0x00ffffff-no-rj', // Reine
    // ID Gen 3
    'UCTvHWSfBZgtxE4sILOaurIQ': 'https://yt3.ggpht.com/0pxwGbJZbeMVkF9wGW4FNE2vJERPo0zUkzSEFWj6IHio-uiLWMSJKdjhkqwRkWwDHNu0dXiynw=s800-c-k-c0x00ffffff-no-rj', // Zeta
    'UCZLZ8Jjx_RN2CXloOmgTHVg': 'https://yt3.ggpht.com/2jGAglj5aTcUWO7WRNfq54KV3ipKblUzxI6fAKSjAfMw6J9Qqb6NbzbJA2i0t4cKgUR7SPdWC_w=s800-c-k-c0x00ffffff-no-rj', // Kaela
    'UCjLEmnpCNeisMxy134KPwWw': 'https://yt3.ggpht.com/XRCP2PC-lvvielp04Eq8KyBzgd3_bFc_DNfptN5s-ftd1v6SadGuMChY6Jm3elaqaK7xwE1B=s800-c-k-c0x00ffffff-no-rj', // Kobo
    // 媛쒖씤??
    'UCrV1Hf5r8P148idjoSfrGEQ': 'https://yt3.ggpht.com/CAO0J4GC4_G8VxiyulWcZZ3b44l27EFl-vSOER7ucwAL5IJIRxVk4XSQdhWn3PLXD-rQ-QVj=s800-c-k-c0x00ffffff-no-rj', // Sakuna
    'UCLIpj4TmXviSTNE_U5WG_Ug': 'https://yt3.ggpht.com/YF6d4zXLWFR6VjPpF01N8w0Wq-MfwMz6MZTDQbOF2TeSSMT4bwtIf2xGs8DfoufreyVcro4N7Bo=s800-c-k-c0x00ffffff-no-rj', // Roa
    'UCt30jJgChL8qeT9VPadidSw': 'https://yt3.ggpht.com/ytc/AIdro_m6xQ9ez0I8lnwswHqAns9ZRPsaCCutfzu6eUbM7pwzqsA=s800-c-k-c0x00ffffff-no-rj', // Shigure Ui
    'UClS3cnIUM9yzsBPQzeyX_8Q': 'https://yt3.ggpht.com/E_GIFETWLQYVBMYBzSfwr6VqmJRALcKYvruQcC5jyI9KqRszN9YaPWlT-C3PobxtTUplYNvrCg=s800-c-k-c0x00ffffff-no-rj', // Amagai Ruka
    'UCl_gCybOJRIgOXw6Qb4qJzQ': 'https://yt3.ggpht.com/ytc/AMLnZu9cOjR_bgBuDzX45gUUMHCDo1HLLiecGY-Y1yPCDg=s800-c-k-c0x00ffffff-no-rj', // Rushia
    'UCD8HOxPs4Xvsm8H0ZxXGiBw': '/image/mel.jpg',
};

function getAllMemberChannelIds() {
    const generations = [
        {
            id: 'gen0', name: '0湲곗깮', members: [
                { name: 'Tokino Sora', id: 'UCp6993wxpyDPHUpavwDFqgg' },
                { name: 'Roboco', id: 'UCDqI2jOz0weumE8s7paEk6g' },
                { name: 'Sakura Miko', id: 'UC-hM6YJuNYVAmUWxeIr9FeA' },
                { name: 'Hoshimachi Suisei', id: 'UC5CwaMl1eIgY8h02uZw7u8A' },
                { name: 'AZKi', id: 'UC0TXe_LYZ4scaW2XMyi5_kw' }
            ]
        },
        {
            id: 'gen1', name: '1湲곗깮', members: [
                { name: 'Shirakami Fubuki', id: 'UCdn5BQ06XqgXoAxIhbqw5Rg' },
                { name: 'Natsuiro Matsuri', id: 'UCQ0UDLQCjY0rmuxCDE38FGg' },
                { name: 'Aki Rosenthal', id: 'UCFTLzh12_nrtzqBPsTCqenA' },
                { name: 'Akai Haato', id: 'UC1CfXB_kRs3C-zaeTG3oGyg' }
            ]
        },
        {
            id: 'gen2', name: '2湲곗깮', members: [
                { name: 'Minato Aqua', id: 'UC1opHUrw8rvnsadT-iGp7Cg' },
                { name: 'Murasaki Shion', id: 'UCXTpFs_3PqI41qX2d9tL2Rw' },
                { name: 'Nakiri Ayame', id: 'UC7fk0CB07ly8oSl0aqKkqFg' },
                { name: 'Yuzuki Choco', id: 'UC1suqwovbL1kzsoaZgFZLKg' },
                { name: 'Oozora Subaru', id: 'UCvzGlP9oQwU--Y0r9id_jnA' }
            ]
        },
        {
            id: 'gamers', name: '寃뚯씠癒몄쫰', members: [
                { name: 'Ookami Mio', id: 'UCp-5t9SrOQwXMU7iIjQfARg' },
                { name: 'Nekomata Okayu', id: 'UCvaTdHTWBGv3MKj3KVqJVCw' },
                { name: 'Inugami Korone', id: 'UChAnqc_AY5_I3Px5dig3X1Q' }
            ]
        },
        {
            id: 'gen3', name: '3湲곗깮', members: [
                { name: 'Usada Pekora', id: 'UC1DCedRgGHBdm81E1llLhOQ' },
                { name: 'Shiranui Flare', id: 'UCvInZx9h3jC2JzsIzoOebWg' },
                { name: 'Shirogane Noel', id: 'UCdyqAaZDKHXg4Ahi7VENThQ' },
                { name: 'Houshou Marine', id: 'UCCzUftO8KOVkV4wQG1vkUvg' }
            ]
        },
        {
            id: 'gen4', name: '4湲곗깮', members: [
                { name: 'Amane Kanata', id: 'UCZlDXzGoo7d44bwdNObFacg' },
                { name: 'Tsunomaki Watame', id: 'UCqm3BQLlJfvkTsX_hvm0UmA' },
                { name: 'Tokoyami Towa', id: 'UC1uv2Oq6kNxgATlCiez59hw' },
                { name: 'Himemori Luna', id: 'UCa9Y57gfeY0Zro_noHRVrnw' }
            ]
        },
        {
            id: 'gen5', name: '5湲곗깮', members: [
                { name: 'Yukihana Lamy', id: 'UCFKOVgVbGmX65RxO3EtH3iw' },
                { name: 'Momosuzu Nene', id: 'UCAWSyEs_Io8MtpY3m-zqILA' },
                { name: 'Shishiro Botan', id: 'UCUKD-uaobj9jiqB-VXt71mA' },
                { name: 'Omaru Polka', id: 'UCK9V2B22uJYu3N7eR_BT9QA' }
            ]
        },
        {
            id: 'holox', name: 'holoX', members: [
                { name: 'La+ Darknesss', id: 'UCENwRMx5Yh42zWpzURebzTw' },
                { name: 'Hakui Koyori', id: 'UC6eWCld0KwmyHFbAqK3V-Rw' },
                { name: 'Takane Lui', id: 'UCs9_O1tRPMQTHQ-N_L6FU2g' },
                { name: 'Sakamata Chloe', id: 'UCIBY1ollUsauvVi4hW4cumw' },
                { name: 'Kazama Iroha', id: 'UC_vMYWcDjmfdpH6r4TTn1MQ' }
            ]
        },
        {
            id: 'regloss', name: 'ReGLOSS', members: [
                { name: 'Otonose Kanade', id: 'UCWQtYtq9EOB4-I5P-3fh8lA' },
                { name: 'Ichijou Ririka', id: 'UCtyWhCj3AqKh2dXctLkDtng' },
                { name: 'Juufuutei Raden', id: 'UCdXAk5MpyLD8594lm_OvtGQ' },
                { name: 'Todoroki Hajime', id: 'UC1iA6_NT4mtAcIII6ygrvCw' },
                { name: 'Hiodoshi Ao', id: 'UCMGfV7TVTmHhEErVJg1oHBQ' }
            ]
        },
        {
            id: 'flowglow', name: 'FLOW GLOW', members: [
                { name: 'Isaki Riona', id: 'UC9LSiN9hXI55svYEBrrK-tw' },
                { name: 'Koganei Niko', id: 'UCuI_opAVX6qbxZY-a-AxFuQ' },
                { name: 'Mizumiya Su', id: 'UCjk2nKmHzgH5Xy-C5qYRd5A' },
                { name: 'Rindo Chihaya', id: 'UCKMWFR6lAstLa7Vbf5dH7ig' },
                { name: 'Kikirara Vivi', id: 'UCGzTVXqMQHa4AgJVJIVvtDQ' }
            ]
        },
        // === Hololive EN ===
        {
            id: 'myth', name: 'EN Myth', members: [
                { name: 'Mori Calliope', id: 'UCL_qhgtOy0dy1Agp8vkySQg' },
                { name: 'Takanashi Kiara', id: 'UCHsx4Hqa-1ORjQTh9TYDhww' },
                { name: 'Ninomae Ina\'nis', id: 'UCMwGHR0BTZuLsmjY_NT5Pwg' },
                { name: 'Gawr Gura', id: 'UCoSrY_IQQVpmIRZ9Xf-y93g' },
                { name: 'Watson Amelia', id: 'UCyl1z3jo3XHR1riLFKG5UAg' }
            ]
        },
        {
            id: 'promise', name: 'EN Promise', members: [
                { name: 'IRyS', id: 'UC8rcEBzJSleTkf_-agPM20g' },
                { name: 'Ceres Fauna', id: 'UCO_aKKYxn4tvrqPjcTzZ6EQ' },
                { name: 'Ouro Kronii', id: 'UCmbs8T6MWqUHP1tIQvSgKrg' },
                { name: 'Nanashi Mumei', id: 'UC3n5uGu18FoCy23ggWWp8tA' },
                { name: 'Hakos Baelz', id: 'UCgmPnx-EEeOrZSg5Tiw7ZRQ' }
            ]
        },
        {
            id: 'advent', name: 'EN Advent', members: [
                { name: 'Shiori Novella', id: 'UCgnfPPb9JI3e9A4cXHnWbyg' },
                { name: 'Koseki Bijou', id: 'UC9p_lqQ0FEDz327Vgf5JwqA' },
                { name: 'Nerissa Ravencroft', id: 'UC_sFNM0z0MWm9A6WlKPuMMg' },
                { name: 'FUWAMOCO', id: 'UCt9H_RpQzhxzlyBxFqrdHqA' }
            ]
        },
        {
            id: 'justice', name: 'EN Justice', members: [
                { name: 'Elizabeth Rose Bloodflame', id: 'UCW5uhrG1eCBYditmhL0Ykjw' },
                { name: 'Raora Panthera', id: 'UCl69AEx4MdqMZH7Jtsm7Tig' },
                { name: 'Gigi Murin', id: 'UCDHABijvPBnJm7F-KlNME3w' },
                { name: 'Cecilia Immergreen', id: 'UCvN5h1ShZtc7nly3pezRayg' }
            ]
        },
        // === Hololive ID ===
        {
            id: 'id1', name: 'ID Gen 1', members: [
                { name: 'Ayunda Risu', id: 'UCOyYb1c43VlX9rc_lT6NKQw' },
                { name: 'Moona Hoshinova', id: 'UCP0BspO_AMEe3aQqqpo89Dg' },
                { name: 'Airani Iofifteen', id: 'UCAoy6rzhSf4ydcYjJw3WoVg' }
            ]
        },
        {
            id: 'id2', name: 'ID Gen 2', members: [
                { name: 'Kureiji Ollie', id: 'UCYz_5n-uDuChHtLo7My1HnQ' },
                { name: 'Anya Melfissa', id: 'UC727SQYUvx5pDDGQpTICNWg' },
                { name: 'Pavolia Reine', id: 'UChgTyjG-pdNvxxhdsXfHQ5Q' }
            ]
        },
        {
            id: 'id3', name: 'ID Gen 3', members: [
                { name: 'Vestia Zeta', id: 'UCTvHWSfBZgtxE4sILOaurIQ' },
                { name: 'Kaela Kovalskia', id: 'UCZLZ8Jjx_RN2CXloOmgTHVg' },
                { name: 'Kobo Kanaeru', id: 'UCjLEmnpCNeisMxy134KPwWw' }
            ]
        }
    ];

    const allIds = [];
    generations.forEach(gen => {
        gen.members.forEach(member => {
            if (member.id) allIds.push(member.id);
        });
    });
    return allIds;
}

function renderGenerationList(container) {
    const generations = [
        {
            id: 'gen0', name: '0湲곗깮', members: [
                { name: 'Tokino Sora', id: 'UCp6993wxpyDPHUpavwDFqgg' },
                { name: 'Roboco', id: 'UCDqI2jOz0weumE8s7paEk6g' },
                { name: 'Sakura Miko', id: 'UC-hM6YJuNYVAmUWxeIr9FeA' },
                { name: 'Hoshimachi Suisei', id: 'UC5CwaMl1eIgY8h02uZw7u8A' },
                { name: 'AZKi', id: 'UC0TXe_LYZ4scaW2XMyi5_kw' }
            ]
        },
        {
            id: 'gen1', name: '1湲곗깮', members: [
                { name: 'Shirakami Fubuki', id: 'UCdn5BQ06XqgXoAxIhbqw5Rg' },
                { name: 'Natsuiro Matsuri', id: 'UCQ0UDLQCjY0rmuxCDE38FGg' },
                { name: 'Aki Rosenthal', id: 'UCFTLzh12_nrtzqBPsTCqenA' },
                { name: 'Akai Haato', id: 'UC1CfXB_kRs3C-zaeTG3oGyg' }
            ]
        },
        {
            id: 'gen2', name: '2湲곗깮', members: [
                { name: 'Minato Aqua', id: 'UC1opHUrw8rvnsadT-iGp7Cg' },
                { name: 'Murasaki Shion', id: 'UCXTpFs_3PqI41qX2d9tL2Rw' },
                { name: 'Nakiri Ayame', id: 'UC7fk0CB07ly8oSl0aqKkqFg' },
                { name: 'Yuzuki Choco', id: 'UC1suqwovbL1kzsoaZgFZLKg' },
                { name: 'Oozora Subaru', id: 'UCvzGlP9oQwU--Y0r9id_jnA' }
            ]
        },
        {
            id: 'gamers', name: '寃뚯씠癒몄쫰', members: [
                { name: 'Ookami Mio', id: 'UCp-5t9SrOQwXMU7iIjQfARg' },
                { name: 'Nekomata Okayu', id: 'UCvaTdHTWBGv3MKj3KVqJVCw' },
                { name: 'Inugami Korone', id: 'UChAnqc_AY5_I3Px5dig3X1Q' }
            ]
        },
        {
            id: 'gen3', name: '3湲곗깮', members: [
                { name: 'Usada Pekora', id: 'UC1DCedRgGHBdm81E1llLhOQ' },
                { name: 'Shiranui Flare', id: 'UCvInZx9h3jC2JzsIzoOebWg' },
                { name: 'Shirogane Noel', id: 'UCdyqAaZDKHXg4Ahi7VENThQ' },
                { name: 'Houshou Marine', id: 'UCCzUftO8KOVkV4wQG1vkUvg' }
            ]
        },
        {
            id: 'gen4', name: '4湲곗깮', members: [
                { name: 'Amane Kanata', id: 'UCZlDXzGoo7d44bwdNObFacg' },
                { name: 'Tsunomaki Watame', id: 'UCqm3BQLlJfvkTsX_hvm0UmA' },
                { name: 'Tokoyami Towa', id: 'UC1uv2Oq6kNxgATlCiez59hw' },
                { name: 'Himemori Luna', id: 'UCa9Y57gfeY0Zro_noHRVrnw' },
                { name: 'Kiryu Coco', id: 'UCS9uQI-jC3DE0L4IpXyvr6w' }
            ]
        },
        {
            id: 'gen5', name: '5湲곗깮', members: [
                { name: 'Yukihana Lamy', id: 'UCFKOVgVbGmX65RxO3EtH3iw' },
                { name: 'Momosuzu Nene', id: 'UCAWSyEs_Io8MtpY3m-zqILA' },
                { name: 'Shishiro Botan', id: 'UCUKD-uaobj9jiqB-VXt71mA' },
                { name: 'Omaru Polka', id: 'UCK9V2B22uJYu3N7eR_BT9QA' }
            ]
        },
        {
            id: 'holox', name: 'holoX', members: [
                { name: 'La+ Darknesss', id: 'UCENwRMx5Yh42zWpzURebzTw' },
                { name: 'Hakui Koyori', id: 'UC6eWCld0KwmyHFbAqK3V-Rw' },
                { name: 'Takane Lui', id: 'UCs9_O1tRPMQTHQ-N_L6FU2g' },
                { name: 'Sakamata Chloe', id: 'UCIBY1ollUsauvVi4hW4cumw' },
                { name: 'Kazama Iroha', id: 'UC_vMYWcDjmfdpH6r4TTn1MQ' }
            ]
        },
        {
            id: 'regloss', name: 'ReGLOSS', members: [
                { name: 'Otonose Kanade', id: 'UCWQtYtq9EOB4-I5P-3fh8lA' },
                { name: 'Ichijou Ririka', id: 'UCtyWhCj3AqKh2dXctLkDtng' },
                { name: 'Juufuutei Raden', id: 'UCdXAk5MpyLD8594lm_OvtGQ' },
                { name: 'Todoroki Hajime', id: 'UC1iA6_NT4mtAcIII6ygrvCw' },
                { name: 'Hiodoshi Ao', id: 'UCMGfV7TVTmHhEErVJg1oHBQ' }
            ]
        },
        {
            id: 'flowglow', name: 'FLOW GLOW', members: [
                { name: 'Isaki Riona', id: 'UC9LSiN9hXI55svYEBrrK-tw' },
                { name: 'Koganei Niko', id: 'UCuI_opAVX6qbxZY-a-AxFuQ' },
                { name: 'Mizumiya Su', id: 'UCjk2nKmHzgH5Xy-C5qYRd5A' },
                { name: 'Rindo Chihaya', id: 'UCKMWFR6lAstLa7Vbf5dH7ig' },
                { name: 'Kikirara Vivi', id: 'UCGzTVXqMQHa4AgJVJIVvtDQ' }
            ]
        },
        // === Hololive EN ===
        {
            id: 'myth', name: 'EN Myth', members: [
                { name: 'Mori Calliope', id: 'UCL_qhgtOy0dy1Agp8vkySQg' },
                { name: 'Takanashi Kiara', id: 'UCHsx4Hqa-1ORjQTh9TYDhww' },
                { name: 'Ninomae Ina\'nis', id: 'UCMwGHR0BTZuLsmjY_NT5Pwg' },
                { name: 'Gawr Gura', id: 'UCoSrY_IQQVpmIRZ9Xf-y93g' },
                { name: 'Watson Amelia', id: 'UCyl1z3jo3XHR1riLFKG5UAg' }
            ]
        },
        {
            id: 'promise', name: 'EN Promise', members: [
                { name: 'IRyS', id: 'UC8rcEBzJSleTkf_-agPM20g' },
                { name: 'Ceres Fauna', id: 'UCO_aKKYxn4tvrqPjcTzZ6EQ' },
                { name: 'Ouro Kronii', id: 'UCmbs8T6MWqUHP1tIQvSgKrg' },
                { name: 'Nanashi Mumei', id: 'UC3n5uGu18FoCy23ggWWp8tA' },
                { name: 'Hakos Baelz', id: 'UCgmPnx-EEeOrZSg5Tiw7ZRQ' }
            ]
        },
        {
            id: 'advent', name: 'EN Advent', members: [
                { name: 'Shiori Novella', id: 'UCgnfPPb9JI3e9A4cXHnWbyg' },
                { name: 'Koseki Bijou', id: 'UC9p_lqQ0FEDz327Vgf5JwqA' },
                { name: 'Nerissa Ravencroft', id: 'UC_sFNM0z0MWm9A6WlKPuMMg' },
                { name: 'FUWAMOCO', id: 'UCt9H_RpQzhxzlyBxFqrdHqA' }
            ]
        },
        {
            id: 'justice', name: 'EN Justice', members: [
                { name: 'Elizabeth Rose Bloodflame', id: 'UCW5uhrG1eCBYditmhL0Ykjw' },
                { name: 'Raora Panthera', id: 'UCl69AEx4MdqMZH7Jtsm7Tig' },
                { name: 'Gigi Murin', id: 'UCDHABijvPBnJm7F-KlNME3w' },
                { name: 'Cecilia Immergreen', id: 'UCvN5h1ShZtc7nly3pezRayg' }
            ]
        },
        // === Hololive ID ===
        {
            id: 'id1', name: 'ID Gen 1', members: [
                { name: 'Ayunda Risu', id: 'UCOyYb1c43VlX9rc_lT6NKQw' },
                { name: 'Moona Hoshinova', id: 'UCP0BspO_AMEe3aQqqpo89Dg' },
                { name: 'Airani Iofifteen', id: 'UCAoy6rzhSf4ydcYjJw3WoVg' }
            ]
        },
        {
            id: 'id2', name: 'ID Gen 2', members: [
                { name: 'Kureiji Ollie', id: 'UCYz_5n-uDuChHtLo7My1HnQ' },
                { name: 'Anya Melfissa', id: 'UC727SQYUvx5pDDGQpTICNWg' },
                { name: 'Pavolia Reine', id: 'UChgTyjG-pdNvxxhdsXfHQ5Q' }
            ]
        },
        {
            id: 'id3', name: 'ID Gen 3', members: [
                { name: 'Vestia Zeta', id: 'UCTvHWSfBZgtxE4sILOaurIQ' },
                { name: 'Kaela Kovalskia', id: 'UCZLZ8Jjx_RN2CXloOmgTHVg' },
                { name: 'Kobo Kanaeru', id: 'UCjLEmnpCNeisMxy134KPwWw' }
            ]
        },
        {
            id: 'terminated', name: '계약해지', members: [
                { name: 'Uruha Rushia', id: 'UCl_gCybOJRIgOXw6Qb4qJzQ' },
                { name: 'Yozora Mel', id: 'UCD8HOxPs4Xvsm8H0ZxXGiBw' }
            ]
        }
    ];

    const getIconUrls = (channelId) => {
        const localChannel = getChannelById(channelId);
        const channel = localChannel || { id: channelId };
        const primary = getMemberPhotoUrl(channel);
        const proxyFallback = getChannelImageProxyUrl(channelId);
        const cachedIcon = memberIconCache[channelId];
        if (cachedIcon) return { primary, fallback: cachedIcon };

        return { primary, fallback: getRemoteMemberPhotoUrl(channel) || proxyFallback };
    };

    const knownIds = new Set(
        generations.flatMap(gen => gen.members.map(member => member.id).filter(Boolean))
    );

    const renderMember = member => {
        const channelId = member.id || member.channel_id || '';
        if (!channelId) return '';

        const canonicalName = member.name || member.englishName || member.originalName || channelId;
        const displayName = getLocalizedTalentName(member);
        const iconUrls = getIconUrls(channelId);
        const fallback = iconUrls.fallback || member.photo || member.icon;

        return `
                        <div class="member-item" data-member="${escapeHtml(canonicalName)}" data-value="${escapeHtml(channelId)}">
                            <input type="checkbox" value="${escapeHtml(channelId)}" data-member="${escapeHtml(canonicalName)}" style="display:none;">
                            <img class="member-icon" src="${escapeHtml(iconUrls.primary)}" data-fallback="${escapeHtml(fallback)}" alt="${escapeHtml(displayName)}" loading="lazy" decoding="async">
                            <span class="member-name">${escapeHtml(displayName)}</span>
                        </div>
                    `;
    };

    container.innerHTML = generations.map(gen => `
        <div class="generation-section" data-gen-id="${gen.id}">
            <div class="generation-header" onclick="toggleGeneration('${gen.id}')">
                <span class="toggle-icon">▾</span>
                <span>${escapeHtml(getLocalizedGenerationName(gen.id, gen.name))}</span>
            </div>
            <div class="members-grid" id="members-${gen.id}">
                ${gen.members.map(renderMember).join('')}
            </div>
        </div>
    `).join('');

    if (!container.dataset.memberEventsBound) {
        container.dataset.memberEventsBound = 'true';

        container.addEventListener('click', (e) => {
            const item = e.target.closest('.member-item');
            if (!item || !container.contains(item)) return;
            e.preventDefault();
            e.stopPropagation();
            const checkbox = item.querySelector('input[type="checkbox"]');
            if (!checkbox) return;
            checkbox.checked = !checkbox.checked;
            item.classList.toggle('checked', checkbox.checked);
        });

        container.addEventListener('error', (e) => {
            const img = e.target;
            if (!img.classList?.contains('member-icon')) return;
            const fallback = img.dataset.fallback || '';
            if (fallback && img.src !== new URL(fallback, window.location.origin).href) {
                img.dataset.fallback = '';
                img.src = fallback;
                return;
            }
            img.remove();
        }, true);
    }

    (async () => {
        if (typeof window.getChannelIndex !== 'function') return;

        try {
            const channels = await window.getChannelIndex();
            const indexedMembers = channels
                .filter(channel => channel.id && !knownIds.has(channel.id))
                .sort((a, b) => (b.count || 0) - (a.count || 0));

            if (indexedMembers.length === 0 || document.getElementById('members-db-index')) return;

            const section = document.createElement('div');
            section.className = 'generation-section';
            section.dataset.genId = 'db-index';
            section.innerHTML = `
                <div class="generation-header" onclick="toggleGeneration('db-index')">
                    <span class="toggle-icon">▾</span>
                    <span>${escapeHtml(getLocalizedGenerationName('db-index', 'DB 채널'))}</span>
                </div>
                <div class="members-grid" id="members-db-index">
                    ${indexedMembers.map(renderMember).join('')}
                </div>
            `;
            container.appendChild(section);
            restoreCollabCheckboxes(getState().collabFilter);
        } catch (error) {
            console.warn('Failed to append channel index filter:', error);
        }
    })();
}

window.toggleGeneration = function (genId) {
    const header = document.querySelector(`[data-gen-id="${genId}"] .generation-header`);
    const membersGrid = document.getElementById(`members-${genId}`);
    if (header && membersGrid) {
        header.classList.toggle('collapsed');
        membersGrid.classList.toggle('hidden');
    }
};

function getSelectedCollabMembers() {
    const checkboxes = document.querySelectorAll('#collab-generation-list input[type="checkbox"]:checked');
    return Array.from(checkboxes).map(cb => cb.value);
}

function clearAllCheckboxes(container) {
    container.querySelectorAll('input[type="checkbox"]').forEach(cb => {
        cb.checked = false;
        cb.closest('.member-item')?.classList.remove('checked');
    });
}

function applyCollabFilter(selectedMembers, mode = 'or', options = {}) {
    const { skipReload = false } = options;
    const filterBtn = document.getElementById('filter-btn');
    const normalizedMembers = normalizeCollabFilterMembers(selectedMembers);

    const newState = { collabFilter: normalizedMembers, collabMode: mode };
    if (!skipReload) {
        newState.archivePage = 1;
        newState.songsPage = 1;
    }
    setState(newState);

    if (filterBtn) {
        if (selectedMembers && selectedMembers.length > 0) {
            filterBtn.classList.add('active');
            filterBtn.textContent = `검색 필터 (${selectedMembers.length}명)`;
        } else {
            filterBtn.classList.remove('active');
            filterBtn.textContent = '검색 필터';
        }
    }

    if (!skipReload) {
        const state = getState();
        if (state.currentView === 'archive' || state.currentView === 'home') {
            loadArchives(state.currentChannelId, 1);
        } else if (state.currentView === 'songs') {
            loadSongs(state.currentChannelId, 1);
        }
    }

}

function performSearch(query) {
    setState({
        currentSearchQuery: query,
        archivePage: 1,
        clipsPage: 1,
        songsPage: 1
    });

    const state = getState();
    loadViewData(state.currentView);
}

function selectChannel(channelId, options = {}) {
    const { preservePage = false, preserveFilters = preservePage } = options;

    const newState = { currentChannelId: channelId };
    if (!preserveFilters) {
        newState.currentSearchQuery = '';
    }

    if (!preservePage) {
        newState.archivePage = 1;
        newState.clipsPage = 1;
        newState.songsPage = 1;
    }

    setState(newState);

    updateActiveChannel(channelId);

    applyChannelTheme(channelId);

    updateLogoEmoji(channelId);

    if (preserveFilters) {
        restoreFilterUiFromState();
    } else {
    const searchInput = document.getElementById('search-input');
    if (searchInput) searchInput.value = '';

    const generationList = document.querySelector('.collab-generation-list');
    if (generationList) {
        clearAllCheckboxes(generationList);
    }
    applyCollabFilter([], 'or', { skipReload: preservePage });

    const unarchivedCheckbox = document.getElementById('hide-unarchived-checkbox');
    const unarchivedLabel = unarchivedCheckbox?.closest('.unarchived-toggle');
    if (unarchivedCheckbox) {
        unarchivedCheckbox.checked = false;
        unarchivedLabel?.classList.remove('active');
        setState({ hideUnarchived: false });
    }

    clearQuickDateSelection();
    selectedDates = [];
    if (datePickerInstance) {
        datePickerInstance.clear();
    }
    updateSelectedDatesDisplay();
    setState({
        filterDates: [],
        filterYears: null,
        filterMonths: null
    });

    }

    loadChannelInfo(channelId);
    updateProfileLiveBadge([]);

    const state = getState();
    loadViewData(state.currentView);

    updateUrlHash(state);
}

function updateLogoEmoji(channelId) {
    const logoIcon = document.getElementById('logo-icon');
    const headerTitle = document.getElementById('header-title');

    let channel = getChannelById(channelId);
    if (!channel) {
        const myChannels = getMyChannels();
        channel = myChannels.find(ch => ch.id === channelId);
    }

    if (logoIcon) {
        logoIcon.textContent = '';
        logoIcon.style.display = 'none';
    }

    if (headerTitle && channel) {
        const localizedName = getLocalizedTalentName(channel);
        const englishName = channel.englishName || localizedName;
        const nameParts = englishName.split(' ');
        const shortName = getLocale() === 'en' && nameParts.length > 1 ? nameParts[1] : localizedName;
        headerTitle.textContent = shortName || localizedName;
    }
}

function setupAppLanguageControls() {
    const locale = getLocale();
    applyLocale(locale);
    document.querySelectorAll('input[name="app-language"]').forEach(input => {
        input.checked = input.value === locale;
        input.closest('.app-language-option')?.classList.toggle('checked', input.checked);
        input.addEventListener('change', () => {
            if (!input.checked) return;
            const nextLocale = setLocale(input.value);
            applyLocale(nextLocale);
            document.querySelectorAll('input[name="app-language"]').forEach(option => {
                option.closest('.app-language-option')?.classList.toggle('checked', option.checked);
            });
            refreshLocalizedTalentLabels();
            updateFilterButtonState(normalizeCollabFilterMembers(getState().collabFilter));
            window.dispatchEvent(new CustomEvent('locale-updated'));
        });
    });
}

function refreshLocalizedTalentLabels() {
    const state = getState();
    renderChannelList(selectChannel);
    updateActiveChannel(state.currentChannelId);
    if (state.currentChannelId) {
        updateLogoEmoji(state.currentChannelId);
        loadChannelInfo(state.currentChannelId);
    }

    const generationList = document.getElementById('collab-generation-list');
    if (generationList) {
        renderGenerationList(generationList);
        restoreCollabCheckboxes(state.collabFilter);
    }
}

function updateClipLanguageOptions(langs) {
    const selected = new Set(Array.isArray(langs) && langs.length > 0 ? langs : ['ja']);
    document.querySelectorAll('input[name="clip-language"]').forEach(input => {
        input.checked = selected.has(input.value);
        input.closest('.clip-language-option')?.classList.toggle('checked', input.checked);
    });
}

function getSelectedClipLanguages() {
    return [...document.querySelectorAll('input[name="clip-language"]:checked')]
        .map(input => input.value)
        .filter(value => ['ja', 'ko', 'en', 'zh'].includes(value));
}

function setupLangFilter() {
    const filter = document.getElementById('clip-language-filter');
    if (!filter) return;

    updateClipLanguageOptions(getState().clipLangs || ['ja']);

    filter.addEventListener('change', (event) => {
        const input = event.target;
        if (!(input instanceof HTMLInputElement) || input.name !== 'clip-language') return;

        let selectedLangs = getSelectedClipLanguages();
        if (selectedLangs.length === 0) {
            input.checked = true;
            selectedLangs = [input.value];
        }

        updateClipLanguageOptions(selectedLangs);
        setState({ clipLangs: selectedLangs, clipsPage: 1 });

        const currentState = getState();
        if (currentState.currentView === 'clips') {
            loadClips(currentState.currentChannelId, 1);
        }
    });
}

function setupChannelSettings() {
    const settingsBtn = document.getElementById('settings-btn');
    const modal = document.getElementById('channel-settings-modal');
    const closeBtn = document.getElementById('close-channel-settings');
    const searchInput = document.getElementById('channel-search-input');
    const searchBtn = document.getElementById('channel-search-btn');
    const searchResults = document.getElementById('channel-search-results');
    const myChannelsList = document.getElementById('my-channels-list');
    const myChannelCount = document.getElementById('my-channel-count');
    const resetBtn = document.getElementById('reset-channels-btn');
    const deleteApiKeyBtn = document.getElementById('delete-api-key-btn');
    let lastChannelSearchResults = [];

    if (!modal) return;

    function updateApiKeyButton() {
        if (!deleteApiKeyBtn) return;
        const hasKey = hasUserApiKey();
        deleteApiKeyBtn.textContent = hasKey ? t('settings.deleteApiKey') : t('settings.enterApiKey');
        deleteApiKeyBtn.classList.toggle('danger', hasKey);
    }

    window.addEventListener('api-key-updated', updateApiKeyButton);
    window.addEventListener('locale-updated', () => {
        updateApiKeyButton();
        if (modal.style.display === 'flex') {
            renderMyChannels();
            if (lastChannelSearchResults.length > 0) {
                renderSearchResults(lastChannelSearchResults);
            }
        }
    });

    modal.addEventListener('open', () => {
        updateApiKeyButton();
        renderMyChannels();
    });

    function closeChannelSettingsModal() {
        modal.style.display = 'none';
    }

    function closeChannelSettingsFromBackdrop(event) {
        if (event.target !== modal) return;
        if (event.type === 'contextmenu') event.preventDefault();
        closeChannelSettingsModal();
    }

    function renderMyChannels() {
        const channels = getMyChannels();
        myChannelCount.textContent = channels.length;

        myChannelsList.innerHTML = channels.map(ch => {
            const displayName = getLocalizedTalentName(ch);
            return `
            <li class="my-channel-item" data-id="${escapeHtml(ch.id)}">
                ${renderChannelIcon(ch)}
                <span class="channel-name">${escapeHtml(displayName)}</span>
                <button class="remove-btn" data-id="${escapeHtml(ch.id)}">${escapeHtml(t('settings.remove'))}</button>
            </li>
        `;
        }).join('');
        attachChannelIconFallbacks(myChannelsList);

        myChannelsList.querySelectorAll('.remove-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const channelId = btn.dataset.id;
                const result = removeChannel(channelId);
                if (!result.success) {
                    showToast('오류', result.message);
                }
                renderMyChannels();
                refreshSidebar();
            });
        });
    }

    function refreshSidebar() {
        renderChannelList(selectChannel);
        const state = getState();
        updateActiveChannel(state.currentChannelId);
    }

    function renderChannelIcon(channel) {
        const iconUrl = getMemberPhotoUrl(channel) || channel.icon || getRemoteMemberPhotoUrl(channel);
        const fallback = getRemoteMemberPhotoUrl(channel) || channel.icon || '';
        const displayName = getLocalizedTalentName(channel);
        if (!iconUrl) return '';

        return `<img src="${escapeHtml(iconUrl)}" data-fallback="${escapeHtml(fallback)}" alt="${escapeHtml(displayName)}">`;
    }

    function attachChannelIconFallbacks(root) {
        root.querySelectorAll('img[data-fallback]').forEach(img => {
            img.addEventListener('error', () => {
                const fallback = img.dataset.fallback || '';
                if (fallback && img.src !== new URL(fallback, window.location.origin).href) {
                    img.dataset.fallback = '';
                    img.src = fallback;
                    return;
                }
                img.remove();
            });
        });
    }

    function renderSearchResults(channels) {
        if (channels.length === 0) {
            lastChannelSearchResults = [];
            searchResults.innerHTML = `<div class="no-results">${escapeHtml(t('settings.noResults'))}</div>`;
        } else {
            lastChannelSearchResults = [...channels];
            const myChannelIds = getMyChannels().map(ch => ch.id);
            searchResults.innerHTML = channels.map(ch => {
                const isAdded = myChannelIds.includes(ch.id);
                const displayName = getLocalizedTalentName(ch);
                return `
                    <div class="channel-result-item" data-id="${escapeHtml(ch.id)}">
                        ${renderChannelIcon(ch)}
                        <div class="channel-result-info">
                            <div class="channel-result-name">${escapeHtml(displayName)}</div>
                            <div class="channel-result-org">${escapeHtml(ch.org || 'Indie')}</div>
                        </div>
                        <button class="add-btn" data-channel="${encodeURIComponent(JSON.stringify(ch))}" ${isAdded ? 'disabled' : ''}>
                            ${isAdded ? escapeHtml(t('settings.added')) : escapeHtml(t('settings.add'))}
                        </button>
                    </div>
                `;
            }).join('');
        }
        searchResults.classList.add('active');
        attachChannelIconFallbacks(searchResults);

        searchResults.querySelectorAll('.add-btn:not([disabled])').forEach(btn => {
            btn.addEventListener('click', () => {
                const channel = JSON.parse(decodeURIComponent(btn.dataset.channel));
                const result = addChannel(channel);
                if (!result.success) {
                    showToast('오류', result.message);
                }
                if (result.success) {
                    renderMyChannels();
                    renderSearchResults([...searchResults.querySelectorAll('.add-btn')].map(b =>
                        JSON.parse(decodeURIComponent(b.dataset.channel))
                    ));
                    refreshSidebar();
                }
            });
        });
    }

    settingsBtn.addEventListener('click', () => {
        modal.style.display = 'flex';
        updateApiKeyButton();
        renderMyChannels();
        searchResults.innerHTML = '';
        searchResults.classList.remove('active');
        searchInput.value = '';
        modal.dispatchEvent(new CustomEvent('open'));
    });

    closeBtn.addEventListener('click', () => {
        closeChannelSettingsModal();
    });

    modal.addEventListener('click', closeChannelSettingsFromBackdrop);
    modal.addEventListener('contextmenu', closeChannelSettingsFromBackdrop);

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && modal.style.display === 'flex') {
            closeChannelSettingsModal();
        }
    });

    // 寃??
    searchBtn.addEventListener('click', async () => {
        const query = searchInput.value.trim();
        if (query.length < 2) {
            showToast('확인 필요', '2글자 이상 입력하세요');
            return;
        }

        searchBtn.disabled = true;
        searchBtn.textContent = t('settings.searching');

        try {
            const results = await searchChannels(query);
            renderSearchResults(results);
        } catch (e) {
            showToast('오류', '검색 실패');
        } finally {
            searchBtn.disabled = false;
            searchBtn.textContent = t('settings.search');
        }
    });

    searchInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            searchBtn.click();
        }
    });

    resetBtn.addEventListener('click', () => {
        if (confirm('기본 탤런트 목록으로 초기화하시겠습니까?')) {
            saveMyChannels([...DEFAULT_CHANNELS]);
            renderMyChannels();
            refreshSidebar();
            showToast('완료', '기본값으로 초기화되었습니다');
        }
    });

    if (deleteApiKeyBtn) {
        deleteApiKeyBtn.addEventListener('click', async () => {
            const hasKey = hasUserApiKey();
            if (!hasKey) {
                window.openApiKeyModal?.({ force: true, returnToSettings: true });
                return;
            }

            if (confirm('API Key를 삭제하시겠습니까?\n\n동기화된 영상 데이터는 서버에 유지됩니다')) {
                localStorage.removeItem('holodex_api_key');
                window.dispatchEvent(new CustomEvent('api-key-updated'));
                updateApiKeyButton();
                showToast('삭제 완료', 'API Key가 삭제되었습니다');
            }
        });
    }
}

function loadViewData(view) {
    const state = getState();
    if (!state.currentChannelId) return;

    switch (view) {
        case 'home':
            break;
        case 'live':
            loadLiveStreams(state.currentChannelId);
            break;
        case 'archive':
            loadArchives(state.currentChannelId, state.archivePage);
            break;
        case 'clips':
            loadClips(state.currentChannelId, state.clipsPage);
            break;
        case 'songs':
            loadSongs(state.currentChannelId, state.songsPage || 1);
            break;
        case 'stats':
            loadStats(state.currentChannelId);
            break;
    }
}

function handlePageChange(page, type) {
    const state = getState();

    if (type === 'archive') {
        setState({ archivePage: page });
        loadArchives(state.currentChannelId, page);
    } else if (type === 'clips') {
        setState({ clipsPage: page });
        loadClips(state.currentChannelId, page);
    } else if (type === 'songs') {
        setState({ songsPage: page });
        loadSongs(state.currentChannelId, page);
    }

    updateUrlHash(getState());
}

function updateProfileLiveBadge(streams) {
    const badge = document.getElementById('profile-live-badge');
    if (!badge) return;

    const isLive = Array.isArray(streams) && streams.some(stream => stream.status === 'live');
    badge.classList.toggle('show', isLive);
}

async function loadLiveStreams(channelId) {
    const serial = ++requestSerials.live;

    const container = document.getElementById('live-container');
    container.innerHTML = '<div class="loading-spinner">Loading streams...</div>';

    try {
        const streams = await getLiveStreams(channelId);

        if (serial !== requestSerials.live) return;
        updateProfileLiveBadge(streams);

        container.innerHTML = '';

        if (streams.length === 0) {
            container.innerHTML = '<p class="empty-text">라이브 중이거나 예정된 방송이 없습니다.</p>';
            return;
        }

        streams.forEach((video, index) => {
            const card = createVideoCard(video, index);
            container.appendChild(card);
        });
    } catch {
        if (serial !== requestSerials.live) return;
        updateProfileLiveBadge([]);
        container.innerHTML = '<p class="error-text">Failed to load streams.</p>';
    }
}
const ARCHIVE_TAB_TITLES = {
    all: '아카이브',
    collab: '콜라보',
    music: '노래'
};

function setupArchiveTabs() {
    const tabContainer = document.getElementById('archive-tabs');
    if (!tabContainer) return;

    tabContainer.addEventListener('click', (e) => {
        const tab = e.target.closest('.archive-tab');
        if (!tab) return;

        const type = tab.dataset.type;
        const state = getState();

        if (state.videoType === type) return;

        tabContainer.querySelectorAll('.archive-tab').forEach(t => {
            t.classList.toggle('active', t === tab);
        });

        const sectionHeader = document.querySelector('#archive-view .section-header h3');
        if (sectionHeader) {
            sectionHeader.textContent = ARCHIVE_TAB_TITLES[type] || ARCHIVE_TAB_TITLES.all;
        }

        resetActiveFilters({ resetSearch: true });

        setState({ videoType: type, archivePage: 1 });
        updateUrlHash(getState());
        loadArchives(state.currentChannelId, 1);
    });
}

function restoreArchiveTabUI(type) {
    const tabContainer = document.getElementById('archive-tabs');
    if (!tabContainer) return;

    tabContainer.querySelectorAll('.archive-tab').forEach(t => {
        t.classList.toggle('active', t.dataset.type === type);
    });

    const sectionHeader = document.querySelector('#archive-view .section-header h3');
    if (sectionHeader) {
        sectionHeader.textContent = ARCHIVE_TAB_TITLES[type] || ARCHIVE_TAB_TITLES.all;
    }
}

function setupSongControls() {
    const sortSelect = document.getElementById('song-sort-select');
    const categoryTabs = document.getElementById('song-category-tabs');

    sortSelect?.addEventListener('change', () => {
        setState({
            songSort: sortSelect.value,
            songsPage: 1
        });
        const state = getState();
        if (state.currentView === 'songs') {
            loadSongs(state.currentChannelId, 1);
        }
    });

    categoryTabs?.addEventListener('click', event => {
        const tab = event.target.closest('.song-category-tab');
        if (!tab) return;

        const category = tab.dataset.category || 'all';
        setState({
            songCategory: category,
            songsPage: 1
        });
        updateSongCategoryTabs(category);
        const state = getState();
        if (state.currentView === 'songs') {
            loadSongs(state.currentChannelId, 1);
        }
    });
}

function setupSongDetailModal() {
    const modal = document.getElementById('song-detail-modal');
    const closeBtn = document.getElementById('close-song-detail');
    if (!modal) return;

    const close = () => closeSongDetailModal();
    closeBtn?.addEventListener('click', close);
    modal.addEventListener('click', event => {
        if (event.target === modal) close();
    });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && modal.classList.contains('show')) close();
    });
    document.addEventListener('song-detail-request', event => {
        openSongDetailModal(event.detail?.song);
    });
}

function closeSongDetailModal() {
    const modal = document.getElementById('song-detail-modal');
    if (!modal) return;
    modal.classList.remove('show');
    modal.setAttribute('aria-hidden', 'true');
}

function setSongDetailLoading(song) {
    const titleEl = document.getElementById('song-detail-title');
    const subtitleEl = document.getElementById('song-detail-subtitle');
    const countEl = document.getElementById('song-detail-count');
    const listEl = document.getElementById('song-detail-list');

    if (titleEl) titleEl.textContent = song?.song_title || '노래 상세';
    if (subtitleEl) subtitleEl.textContent = song?.original_artist || '';
    if (countEl) countEl.textContent = '';
    if (listEl) listEl.innerHTML = '<div class="loading-spinner">노래 기록을 불러오는 중...</div>';
}

async function openSongDetailModal(song) {
    if (!song) return;

    const modal = document.getElementById('song-detail-modal');
    const listEl = document.getElementById('song-detail-list');
    const countEl = document.getElementById('song-detail-count');
    if (!modal || !listEl) return;

    const serial = ++songDetailSerial;
    setSongDetailLoading(song);
    modal.classList.add('show');
    modal.setAttribute('aria-hidden', 'false');

    try {
        const loader = window.getSongDetails;
        if (typeof loader !== 'function') {
            throw new Error('Song detail API is not available');
        }
        const result = await loader(song);
        if (serial !== songDetailSerial) return;

        const items = result.items || [];
        if (countEl) {
            countEl.textContent = `${result.total || items.length}개 기록`;
        }
        listEl.innerHTML = '';

        if (items.length === 0) {
            listEl.innerHTML = '<p class="empty-text">같은 곡 기록이 없습니다.</p>';
            return;
        }

        items.forEach(item => {
            listEl.appendChild(createSongCard(item, { showDetails: false }));
        });
    } catch (error) {
        if (serial !== songDetailSerial) return;
        listEl.innerHTML = `<p class="error-text">상세 정보를 불러오지 못했습니다. ${escapeHtml(error?.message || 'Unknown error')}</p>`;
    }
}

function renderSongSummary(summary = {}) {
    const totalEl = document.getElementById('song-total-count');
    const videoEl = document.getElementById('song-video-count');
    const latestEl = document.getElementById('song-latest-date');

    if (totalEl) totalEl.textContent = String(summary.totalSongs || 0);
    if (videoEl) videoEl.textContent = String(summary.totalVideos || 0);
    if (latestEl) latestEl.textContent = summary.latestAt ? summary.latestAt.slice(0, 10) : '-';
    updateSongCategoryTabs(getState().songCategory || 'all', summary.categoryCounts || {});
}

function updateSongCategoryTabs(category, counts = {}) {
    document.querySelectorAll('.song-category-tab').forEach(tab => {
        const isActive = tab.dataset.category === category;
        tab.classList.toggle('active', isActive);
        const countEl = tab.querySelector('[data-song-count]');
        if (countEl) {
            countEl.textContent = String(counts[tab.dataset.category] || 0);
        }
    });
}

function renderSongEmpty(container, state) {
    const message = state.currentSearchQuery
        ? '검색 결과가 없습니다.'
        : '노래 데이터가 아직 없습니다. 서버 자동 갱신 후 다시 확인해주세요.';
    container.innerHTML = `<p class="empty-text">${message}</p>`;
}

async function loadSongs(channelId, page) {
    const serial = ++requestSerials.songs;
    const container = document.getElementById('songs-container');
    if (!container) return;

    const pagination = document.getElementById('songs-pagination');
    if (pagination) pagination.innerHTML = '';
    container.innerHTML = '<div class="loading-spinner">Loading songs...</div>';

    try {
        const state = getState();
        const offset = (page - 1) * ITEMS_PER_PAGE;
        const sort = state.songSort || 'recent';
        const category = state.songCategory || 'all';
        updateSongCategoryTabs(category);
        const result = await getSongs(channelId, offset, state.currentSearchQuery, sort, category, state.collabFilter, state.collabMode || 'or');
        if (serial !== requestSerials.songs) return;

        const songs = result.items || [];
        const totalSongs = result.total || 0;
        renderSongSummary(result.summary || {});

        const maxPage = Math.max(1, Math.ceil(totalSongs / ITEMS_PER_PAGE));
        if (page > maxPage && totalSongs > 0) {
            setState({ songsPage: maxPage });
            return loadSongs(channelId, maxPage);
        }

        container.innerHTML = '';
        if (songs.length === 0) {
            renderSongEmpty(container, state);
            return;
        }

        songs.forEach(song => {
            container.appendChild(createSongCard(song));
        });
        renderPagination('songs', page, totalSongs, handlePageChange);
    } catch (error) {
        if (serial !== requestSerials.songs) return;
        container.innerHTML = `<p class="error-text">Failed to load songs: ${escapeHtml(error?.message || 'Unknown error')}</p>`;
    }
}

async function loadArchives(channelId, page) {
    const serial = ++requestSerials.archive;

    const container = document.getElementById('archive-container');
    container.innerHTML = '<div class="loading-spinner">Loading archives...</div>';

    try {
        const state = getState();
        const offset = (page - 1) * ITEMS_PER_PAGE;
        const channel = getChannelById(channelId);
        const channelName = channel ? (channel.englishName || channel.name) : '';

        let result = await getRecentVideos(channelId, offset, state.currentSearchQuery, channelName, state.collabFilter, state.collabMode || 'or', state.hideUnarchived || false, state.filterDates || [], state.filterYears, state.filterMonths, state.videoType || 'all');


        if (!result) {
            throw new Error('API returned null response');
        }

        const videos = result.items || [];
        const totalVideos = result.total || 0;

        const maxPage = Math.max(1, Math.ceil(totalVideos / ITEMS_PER_PAGE));
        if (page > maxPage && totalVideos > 0) {
            setState({ archivePage: maxPage });
            return loadArchives(channelId, maxPage);
        }

        if (serial !== requestSerials.archive) return;

        container.innerHTML = '';

        if (!videos || videos.length === 0) {
            if (state.isSyncing) {
                container.innerHTML = `
                    <div class="sync-status">
                        <p>데이터를 불러오는 중입니다...</p>
                        <p class="sub-text">로컬 DB에서 아카이브를 불러오고 있습니다.</p>
                    </div>
                `;
            } else {
                container.innerHTML = '<p class="empty-text">검색 결과가 없습니다.</p>';
            }
            return;
        }

        videos.forEach((video, index) => {
            const card = createVideoCard(video, index, {
                currentChannelId: channelId,
                showHostChannel: state.videoType === 'collab'
            });
            container.appendChild(card);
        });

        renderPagination('archive', page, totalVideos || 1000, handlePageChange);
    } catch (error) {
        if (serial !== requestSerials.archive) return;
        container.innerHTML = `<p class="error-text">Failed to load archives: ${escapeHtml(error?.message || 'Unknown error')}</p>`;
    }
}

async function loadClips(channelId, page) {
    const serial = ++requestSerials.clips;

    const container = document.getElementById('clips-container');
    container.innerHTML = `<p class="loading-text">${escapeHtml(t('clips.loading'))}</p>`;

    try {
        const state = getState();
        if (!hasUserApiKey()) {
            if (serial !== requestSerials.clips) return;
            container.innerHTML = `<p class="empty-text">${escapeHtml(t('apiModal.body'))}</p>`;
            window.openApiKeyModal?.();
            return;
        }

        const offset = (page - 1) * ITEMS_PER_PAGE;
        const channel = getChannelById(channelId);
        const channelName = channel ? (channel.englishName || channel.name) : '';

        const result = await getClips(channelId, offset, state.currentSearchQuery, channelName, state.clipLangs);

        if (!result) {
            throw new Error('Failed to fetch clips');
        }

        const clips = result.items || [];
        const totalClips = result.total || 0;

        if (serial !== requestSerials.clips) return;

        container.innerHTML = '';

        if (clips.length === 0) {
            container.innerHTML = `<p class="empty-text">${escapeHtml(t('clips.noClips'))}</p>`;
            return;
        }

        clips.forEach((video, index) => {
            const card = createVideoCard(video, index);
            container.appendChild(card);
        });

        renderPagination('clips', page, totalClips || 500, handlePageChange);
    } catch (error) {
        if (serial !== requestSerials.clips) return;
        container.innerHTML = `<p class="error-text">${escapeHtml(t('clips.loadFailed'))}: ${escapeHtml(error?.message || 'Unknown error')}</p>`;
    }
}

let yearlyChartInstance = null;
let monthlyChartInstance = null;
let yearlyMembershipChartInstance = null;
let membershipChartInstance = null;
let yearlyCollabChartInstance = null;

async function loadStats(channelId) {
    const container = document.querySelector('.stats-container');
    if (!container) return;

    container.innerHTML = '<div class="loading-spinner">통계 로딩 중...</div>';

    try {
        const [yearlyRes, yearlyMembershipRes, collabRes, topicRes] = await Promise.all([
            window.getYearlyStats(channelId),
            window.getYearlyMembershipStats(channelId),
            window.getCollabStats(channelId),
            window.getTopicStats(channelId)
        ]);

        container.innerHTML = `
            <div class="stats-card">
                <h4>연도별 방송 통계</h4>
                <canvas id="yearly-chart"></canvas>
            </div>
            <div class="stats-card">
                <div class="stats-card-header">
                    <h4>월별 방송 통계</h4>
                    <select id="monthly-year-select"></select>
                </div>
                <canvas id="monthly-chart"></canvas>
            </div>
            <div class="stats-card">
                <h4>연도별 멤버십 방송 통계</h4>
                <canvas id="yearly-membership-chart"></canvas>
            </div>
            <div class="stats-card">
                <div class="stats-card-header">
                    <h4>월별 멤버십 방송 통계</h4>
                    <select id="membership-year-select"></select>
                </div>
                <canvas id="membership-chart"></canvas>
            </div>
            <div class="stats-card">
                <h4>콜라보 횟수 (TOP 30)</h4>
                <div id="collab-stats-container" class="collab-stats"></div>
            </div>
            <div class="stats-card">
                <div class="stats-card-header">
                    <h4>연도별 콜라보 통계</h4>
                    <select id="yearly-collab-year-select"></select>
                </div>
                <div id="yearly-collab-stats-container" class="collab-stats"></div>
            </div>
            <div class="stats-card">
                <h4>콘텐츠 TOP 10</h4>
                <canvas id="topic-chart"></canvas>
            </div>
            <div class="stats-card">
                <div class="stats-card-header">
                    <h4>연도별 콘텐츠 TOP 10</h4>
                    <select id="yearly-topic-year-select"></select>
                </div>
                <canvas id="yearly-topic-chart"></canvas>
            </div>
        `;

        renderYearlyChart(yearlyRes.items || []);

        setupMonthlyYearSelect(channelId, yearlyRes.items || []);

        renderYearlyMembershipChart(yearlyMembershipRes.items || []);

        setupMembershipYearSelect(channelId, yearlyRes.items || []);

        renderCollabStats(collabRes.items || []);

        setupYearlyCollabSelect(channelId, yearlyRes.items || []);

        renderTopicStats(topicRes.items || []);

        setupYearlyTopicSelect(channelId, yearlyRes.items || []);

    } catch (error) {
        console.error('Stats load error:', error);
        container.innerHTML = '<p class="error-text">통계를 불러오는데 실패했습니다.</p>';
    }
}

function renderYearlyChart(data) {
    const ctx = document.getElementById('yearly-chart');
    if (!ctx) return;

    if (yearlyChartInstance) {
        yearlyChartInstance.destroy();
    }

    const labels = data.map(d => d.year);
    const values = data.map(d => d.count);

    yearlyChartInstance = new Chart(ctx, {
        type: 'bar',
        data: {
            labels,
            datasets: [{
                label: '방송 횟수',
                data: values,
                backgroundColor: 'rgba(99, 102, 241, 0.7)',
                borderColor: 'rgba(99, 102, 241, 1)',
                borderWidth: 1
            }]
        },
        options: {
            responsive: true,
            plugins: {
                legend: { display: false },
                datalabels: {
                    color: '#333',
                    anchor: 'center',
                    align: 'center',
                    font: { weight: 'bold', size: 11 }
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    ticks: { color: 'rgba(0,0,0,0.7)' },
                    grid: { color: 'rgba(0,0,0,0.1)' }
                },
                x: {
                    ticks: { color: 'rgba(0,0,0,0.7)' },
                    grid: { display: false }
                }
            }
        },
        plugins: [ChartDataLabels]
    });
}

function renderMonthlyChart(data) {
    const ctx = document.getElementById('monthly-chart');
    if (!ctx) return;

    if (monthlyChartInstance) {
        monthlyChartInstance.destroy();
    }

    const labels = data.map(d => String(d.month) + '월');
    const values = data.map(d => d.count);

    monthlyChartInstance = new Chart(ctx, {
        type: 'line',
        data: {
            labels,
            datasets: [{
                label: '방송 횟수',
                data: values,
                borderColor: 'rgba(59, 130, 246, 1)',
                backgroundColor: 'rgba(59, 130, 246, 0.2)',
                fill: true,
                tension: 0.3
            }]
        },
        options: {
            responsive: true,
            layout: {
                padding: { top: 25 }
            },
            plugins: {
                legend: { display: false },
                datalabels: {
                    color: '#333',
                    anchor: 'end',
                    align: 'top',
                    font: { weight: 'bold', size: 10 }
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    suggestedMax: Math.max(...values) * 1.15,  // 15% ?ъ쑀
                    ticks: { color: 'rgba(0,0,0,0.7)' },
                    grid: { color: 'rgba(0,0,0,0.1)' }
                },
                x: {
                    ticks: { color: 'rgba(0,0,0,0.7)' },
                    grid: { display: false }
                }
            }
        },
        plugins: [ChartDataLabels]
    });
}

function setupMonthlyYearSelect(channelId, yearlyData) {
    const select = document.getElementById('monthly-year-select');
    if (!select) return;

    const years = yearlyData.map(d => d.year).filter(y => y);
    if (years.length === 0) {
        select.innerHTML = '<option>데이터 없음</option>';
        return;
    }

    select.innerHTML = years
        .map(y => '<option value="' + String(y) + '">' + String(y) + '년</option>')
        .join('');

    select.value = years[years.length - 1];

    select.addEventListener('change', async () => {
        const year = select.value;
        const res = await window.getMonthlyStats(channelId, year);
        renderMonthlyChart(res.items || []);
    });

    // 珥덇린 濡쒕뱶
    (async () => {
        const res = await window.getMonthlyStats(channelId, select.value);
        renderMonthlyChart(res.items || []);
    })();
}

function renderYearlyMembershipChart(data) {
    const ctx = document.getElementById('yearly-membership-chart');
    if (!ctx) return;

    if (yearlyMembershipChartInstance) {
        yearlyMembershipChartInstance.destroy();
    }

    const labels = data.map(d => d.year);
    const values = data.map(d => d.count);

    yearlyMembershipChartInstance = new Chart(ctx, {
        type: 'bar',
        data: {
            labels,
            datasets: [{
                label: '멤버십 방송',
                data: values,
                backgroundColor: 'rgba(236, 72, 153, 0.7)',
                borderColor: 'rgba(236, 72, 153, 1)',
                borderWidth: 1
            }]
        },
        options: {
            responsive: true,
            plugins: {
                legend: { display: false },
                datalabels: {
                    color: '#333',
                    anchor: 'center',
                    align: 'center',
                    font: { weight: 'bold', size: 11 }
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    ticks: { color: 'rgba(0,0,0,0.7)' },
                    grid: { color: 'rgba(0,0,0,0.1)' }
                },
                x: {
                    ticks: { color: 'rgba(0,0,0,0.7)' },
                    grid: { display: false }
                }
            }
        },
        plugins: [ChartDataLabels]
    });
}

function setupMembershipYearSelect(channelId, yearlyData) {
    const select = document.getElementById('membership-year-select');
    if (!select) return;

    const years = yearlyData.map(d => d.year).filter(y => y);
    if (years.length === 0) {
        select.innerHTML = '<option>데이터 없음</option>';
        return;
    }

    select.innerHTML = years
        .map(y => '<option value="' + String(y) + '">' + String(y) + '년</option>')
        .join('');

    select.value = years[years.length - 1];

    select.addEventListener('change', async () => {
        const year = select.value;
        const res = await window.getMembershipStats(channelId, year);
        renderMembershipChart(res.items || []);
    });

    // 珥덇린 濡쒕뱶
    (async () => {
        const res = await window.getMembershipStats(channelId, select.value);
        renderMembershipChart(res.items || []);
    })();
}

function renderMembershipChart(data) {
    const ctx = document.getElementById('membership-chart');
    if (!ctx) return;

    if (membershipChartInstance) {
        membershipChartInstance.destroy();
    }

    const labels = data.map(d => String(d.month) + '월');
    const values = data.map(d => d.count);

    membershipChartInstance = new Chart(ctx, {
        type: 'line',
        data: {
            labels,
            datasets: [{
                label: '멤버십 방송',
                data: values,
                borderColor: 'rgba(236, 72, 153, 1)',
                backgroundColor: 'rgba(236, 72, 153, 0.2)',
                fill: true,
                tension: 0.3
            }]
        },
        options: {
            responsive: true,
            layout: {
                padding: { top: 25 }
            },
            plugins: {
                legend: { display: false },
                datalabels: {
                    color: '#333',
                    anchor: 'end',
                    align: 'top',
                    font: { weight: 'bold', size: 10 }
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    suggestedMax: Math.max(...values) * 1.15,  // 15% ?ъ쑀
                    ticks: { color: 'rgba(0,0,0,0.7)' },
                    grid: { color: 'rgba(0,0,0,0.1)' }
                },
                x: {
                    ticks: { color: 'rgba(0,0,0,0.7)' },
                    grid: { display: false }
                }
            }
        },
        plugins: [ChartDataLabels]
    });
}

function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function renderCollabAvatar(member) {
    const iconUrl = getMemberPhotoUrl(member);
    const fallback = getRemoteMemberPhotoUrl(member);
    const name = getLocalizedTalentName(member);
    if (!iconUrl) return '';

    return `<img src="${escapeHtml(iconUrl)}"
        data-fallback="${escapeHtml(fallback)}"
        alt="${escapeHtml(name)}"
        loading="lazy"
        decoding="async">`;
}

function removeBrokenCollabAvatars(container) {
    const useFallbackOrRemove = img => {
        const fallback = img.dataset.fallback || '';
        if (fallback && img.src !== new URL(fallback, window.location.origin).href) {
            img.dataset.fallback = '';
            img.src = fallback;
            return;
        }
        img.remove();
    };

    const removeBroken = img => {
        if (!img.complete || img.naturalWidth > 0) return;
        useFallbackOrRemove(img);
    };

    container.querySelectorAll('.collab-item img').forEach(img => {
        img.addEventListener('error', () => useFallbackOrRemove(img));
        removeBroken(img);
    });
}

function renderCollabStats(data) {
    const container = document.getElementById('collab-stats-container');
    if (!container) return;

    if (!data || data.length === 0) {
        container.innerHTML = '<p class="empty-text">콜라보 데이터가 없습니다.</p>';
        return;
    }

    container.innerHTML = data.map(member => {
        return `
            <div class="collab-item">
                ${renderCollabAvatar(member)}
                <div class="collab-info">
                    <span class="collab-name">${escapeHtml(getLocalizedTalentName(member))}</span>
                    <span class="collab-count">${escapeHtml(String(member.count))}회 콜라보</span>
                </div>
            </div>
        `;
    }).join('');
    removeBrokenCollabAvatars(container);
}

function setupYearlyCollabSelect(channelId, yearlyData) {
    const select = document.getElementById('yearly-collab-year-select');
    if (!select) return;

    const years = yearlyData.map(d => d.year).filter(y => y);
    if (years.length === 0) {
        select.innerHTML = '<option>데이터 없음</option>';
        return;
    }

    select.innerHTML = years
        .map(y => '<option value="' + String(y) + '">' + String(y) + '년</option>')
        .join('');

    select.value = years[years.length - 1];

    select.addEventListener('change', async () => {
        const year = select.value;
        const res = await window.getYearlyCollabStats(channelId, year);
        renderYearlyCollabStats(res.items || []);
    });

    // 珥덇린 濡쒕뱶
    (async () => {
        const res = await window.getYearlyCollabStats(channelId, select.value);
        renderYearlyCollabStats(res.items || []);
    })();
}

function renderYearlyCollabStats(data) {
    const container = document.getElementById('yearly-collab-stats-container');
    if (!container) return;

    if (!data || data.length === 0) {
        container.innerHTML = '<p class="empty-text">해당 연도의 콜라보 데이터가 없습니다.</p>';
        return;
    }

    container.innerHTML = data.map(member => {
        return `
            <div class="collab-item">
                ${renderCollabAvatar(member)}
                <div class="collab-info">
                    <span class="collab-name">${escapeHtml(getLocalizedTalentName(member))}</span>
                    <span class="collab-count">${escapeHtml(String(member.count))}회 콜라보</span>
                </div>
            </div>
        `;
    }).join('');
    removeBrokenCollabAvatars(container);
}

let topicChartInstance = null;
let yearlyTopicChartInstance = null;

function renderTopicStats(data) {
    const ctx = document.getElementById('topic-chart');
    if (!ctx) return;

    if (topicChartInstance) {
        topicChartInstance.destroy();
    }

    if (!data || data.length === 0) {
        return;
    }

    const labels = data.map(d => d.topic.replace(/_/g, ' '));
    const values = data.map(d => d.count);

    topicChartInstance = new Chart(ctx, {
        type: 'bar',
        data: {
            labels,
            datasets: [{
                label: '방송 횟수',
                data: values,
                backgroundColor: 'rgba(255, 94, 137, 0.7)',
                borderColor: 'rgba(255, 94, 137, 1)',
                borderWidth: 1,
                borderRadius: 4
            }]
        },
        options: {
            indexAxis: 'y',
            responsive: true,
            maintainAspectRatio: false,
            layout: {
                padding: { right: 50 }
            },
            plugins: {
                legend: { display: false },
                datalabels: {
                    anchor: 'end',
                    align: 'end',
                    formatter: (value) => value + '회',
                    color: '#666',
                    font: { weight: 'bold', size: 11 }
                }
            },
            scales: {
                x: {
                    beginAtZero: true,
                    suggestedMax: Math.max(...values) * 1.15,  // 15% ?ъ쑀
                    grid: { display: false }
                },
                y: {
                    grid: { display: false }
                }
            }
        },
        plugins: [ChartDataLabels]
    });

    ctx.parentElement.style.height = Math.max(300, data.length * 35) + 'px';
}

function setupYearlyTopicSelect(channelId, yearlyData) {
    const select = document.getElementById('yearly-topic-year-select');
    if (!select) return;

    const years = yearlyData.map(d => d.year).filter(y => y);
    if (years.length === 0) {
        select.innerHTML = '<option>데이터 없음</option>';
        return;
    }

    select.innerHTML = years.map(y => `<option value="${y}">${y}년</option>`).join('');

    select.value = years[years.length - 1];

    select.addEventListener('change', async () => {
        const year = select.value;
        const res = await window.getYearlyTopicStats(channelId, year);
        renderYearlyTopicStats(res.items || []);
    });

    // 珥덇린 濡쒕뱶
    (async () => {
        const res = await window.getYearlyTopicStats(channelId, select.value);
        renderYearlyTopicStats(res.items || []);
    })();
}

function renderYearlyTopicStats(data) {
    const ctx = document.getElementById('yearly-topic-chart');
    if (!ctx) return;

    if (yearlyTopicChartInstance) {
        yearlyTopicChartInstance.destroy();
    }

    if (!data || data.length === 0) {
        return;
    }

    const labels = data.map(d => d.topic.replace(/_/g, ' '));
    const values = data.map(d => d.count);

    yearlyTopicChartInstance = new Chart(ctx, {
        type: 'bar',
        data: {
            labels,
            datasets: [{
                label: '방송 횟수',
                data: values,
                backgroundColor: 'rgba(153, 102, 255, 0.7)',
                borderColor: 'rgba(153, 102, 255, 1)',
                borderWidth: 1,
                borderRadius: 4
            }]
        },
        options: {
            indexAxis: 'y',
            responsive: true,
            maintainAspectRatio: false,
            layout: {
                padding: { right: 50 }
            },
            plugins: {
                legend: { display: false },
                datalabels: {
                    anchor: 'end',
                    align: 'end',
                    formatter: (value) => value + '회',
                    color: '#666',
                    font: { weight: 'bold', size: 11 }
                }
            },
            scales: {
                x: {
                    beginAtZero: true,
                    suggestedMax: Math.max(...values) * 1.15,  // 15% ?ъ쑀
                    grid: { display: false }
                },
                y: {
                    grid: { display: false }
                }
            }
        },
        plugins: [ChartDataLabels]
    });

    ctx.parentElement.style.height = Math.max(300, data.length * 35) + 'px';
}

function loadChannelInfo(channelId) {
    const localChannel = getChannelById(channelId);
    if (localChannel) {
        renderLocalChannelProfile(localChannel);
        return;
    }

    renderLocalChannelProfile({ id: channelId, name: channelId, englishName: '', icon: '' });
}

function renderLocalChannelProfile(channel) {
    const nameEl = document.getElementById('channel-name');
    const descEl = document.getElementById('channel-desc');
    const iconEl = document.getElementById('channel-icon');
    const linkEl = document.getElementById('channel-link');
    const subCountEl = document.getElementById('sub-count');
    const videoCountEl = document.getElementById('video-count');

    if (nameEl) nameEl.textContent = getLocalizedTalentName(channel);
    if (descEl) descEl.textContent = channel.englishName || '';
    if (iconEl) {
        const primaryIcon = getMemberPhotoUrl(channel) || channel.icon || getRemoteMemberPhotoUrl(channel) || '';
        const fallbackIcon = getRemoteMemberPhotoUrl(channel);
        iconEl.src = primaryIcon;
        iconEl.dataset.fallback = fallbackIcon;
        iconEl.onerror = () => {
            const fallback = iconEl.dataset.fallback || '';
            if (fallback && iconEl.src !== new URL(fallback, window.location.origin).href) {
                iconEl.dataset.fallback = '';
                iconEl.src = fallback;
                return;
            }
            iconEl.removeAttribute('src');
        };
    }
    if (linkEl) linkEl.href = `https://www.youtube.com/channel/${channel.id}`;
    if (subCountEl) subCountEl.textContent = '-';
    if (videoCountEl) videoCountEl.textContent = '-';
}

function startAutoRefresh() {
    if (refreshInterval) clearInterval(refreshInterval);

    refreshInterval = setInterval(async () => {
        if (document.hidden) return;
        if (isAutoRefreshInFlight) return;
        const state = getState();
        if (state.currentView === 'live') {
            isAutoRefreshInFlight = true;
            try {
                await loadLiveStreams(state.currentChannelId);
            } finally {
                isAutoRefreshInFlight = false;
            }
        }
    }, 60000); // 1遺꾨쭏??
}

function setupVisibilityHandler() {
    if (visibilityHandler) return; // 以묐났 諛⑹?

    visibilityHandler = () => {
        if (document.hidden) {
            if (refreshInterval) {
                clearInterval(refreshInterval);
                refreshInterval = null;
            }
        } else {
            startAutoRefresh();
        }
    };

    document.addEventListener('visibilitychange', visibilityHandler);
}

window.addEventListener('beforeunload', () => {
    if (refreshInterval) clearInterval(refreshInterval);
    if (syncPollInterval) clearInterval(syncPollInterval);
    if (visibilityHandler) {
        document.removeEventListener('visibilitychange', visibilityHandler);
        visibilityHandler = null;
    }
});

document.addEventListener('DOMContentLoaded', () => {
    try {
        init();
    } catch (e) {
        document.body.innerHTML += `<div style="color:red; padding:20px;">치명적 오류: ${escapeHtml(e?.message || 'Unknown error')}</div>`;
    }
});
