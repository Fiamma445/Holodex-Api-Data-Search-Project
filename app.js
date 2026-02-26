/**
 * HoloProject - 메인 애플리케이션
 * @description VTuber 방송 아카이브 뷰어
 * @version 2.0.0 (리팩토링 버전)
 */

// === 모듈 임포트 ===
import {
    CHANNELS, DEFAULT_CHANNEL_ID, getDefaultChannelId, getChannelById,
    getMyChannels, saveMyChannels, addChannel, removeChannel,
    DEFAULT_CHANNELS, MAX_CHANNELS
} from './src/data/channels.js';
import { getState, setState, INITIAL_STATE } from './src/state/appState.js';
import { getStateFromHash, updateUrlHash, restoreStateFromHash } from './src/state/urlHash.js';
import { showToast, requestNotificationPermission } from './src/ui/toast.js';
import { showSyncOverlay, hideSyncOverlay, updateSyncOverlay } from './src/ui/syncOverlay.js';
import { createVideoCard } from './src/ui/videoCard.js';
import { renderChannelList, updateActiveChannel, applyChannelTheme } from './src/ui/channelList.js';
import { renderPagination, ITEMS_PER_PAGE } from './src/ui/pagination.js';

// === 인터벌 참조 (메모리 누수 방지) ===
let refreshInterval = null;
let syncPollInterval = null;
let pollingInterval = null;
let knownStreamIds = new Set();

// === 폴링 보호 플래그 ===
let isAutoRefreshInFlight = false;
let isLivePollingInFlight = false;
let visibilityHandler = null;

// === 요청 중복/역전 방지 ===
const requestSerials = {
    live: 0,
    archive: 0,
    clips: 0
};

// === 초기화 ===
function init() {
    // API Key 확인
    checkApiKey();

    // URL 해시에서 상태 복원
    const restoredState = restoreStateFromHash(INITIAL_STATE);
    setState(restoredState);

    // UI 초기화
    renderChannelList(selectChannel);
    setupNavigation();
    setupSearch();
    setupCollabFilter();  // 콜라보 필터 셋업
    setupApiKeyModal();
    setupArchiveTabs();  // 아카이브/노래 탭 셋업

    // 채널 정보 사전 로드 (배치)
    prefetchChannelInfo();

    // 초기 채널 선택 (내 탤런트 목록의 첫 번째) - 페이지 유지 (URL hash에서 복원됨)
    const state = getState();
    const initialChannelId = state.currentChannelId || getDefaultChannelId();
    selectChannel(initialChannelId, { preservePage: true });

    // 복원된 뷰로 전환
    if (state.currentView !== 'home') {
        switchView(state.currentView);
    }

    // 노래 탭 UI 복원 (videoType이 music이면)
    if (state.videoType === 'music') {
        restoreArchiveTabUI('music');
    }

    // 자동 새로고침 시작
    startAutoRefresh();

    // 알림 권한 요청
    requestNotificationPermission();

    // 언어 필터 설정
    setupLangFilter();

    // 라이브 폴링 시작
    startLivePolling();

    // 탭 가시성 변경 핸들러 설정
    setupVisibilityHandler();

    // 탤런트 설정 모달 초기화
    setupChannelSettings();
}

// === 채널 정보 사전 로드 (콜라보 필터 멤버 포함) ===
async function prefetchChannelInfo() {
    // API Key 없으면 스킵
    const apiKey = localStorage.getItem('holodex_api_key');
    if (!apiKey) return;

    // CHANNELS + 콜라보 필터 모든 멤버 ID 합치기
    const channelIds = CHANNELS.map(c => c.id);
    const collabMemberIds = getAllMemberChannelIds ? getAllMemberChannelIds() : [];
    const allChannelIds = [...new Set([...channelIds, ...collabMemberIds])];

    console.log('📦 Prefetching channel info for', allChannelIds.length, 'channels');

    try {
        const channels = await getChannelsInfo(allChannelIds);
        if (channels && channels.length > 0) {
            channels.forEach(info => {
                // 로컬 스토리지 캐시에 저장
                const cacheKey = `channel_info_${info.id}`;
                const cacheDuration = 24 * 60 * 60 * 1000; // 24시간
                localStorage.setItem(cacheKey, JSON.stringify({
                    data: info,
                    expiry: Date.now() + cacheDuration
                }));
            });

            console.log('✅ Prefetched', channels.length, 'channel infos to localStorage');

            // 현재 채널 정보 새로고침
            const state = getState();
            if (state.currentChannelId) {
                loadChannelInfo(state.currentChannelId);
            }
        }
    } catch (e) {
        console.warn('⚠️ Prefetch failed:', e);
        // 사전 로드 실패 시 무시 (나중에 개별 로드)
    }
}

// === API Key 관리 ===
function checkApiKey() {
    const apiKey = localStorage.getItem('holodex_api_key');
    if (!apiKey) {
        document.getElementById('api-key-modal').classList.add('show');
    } else {
        // 동기화 상태 확인
        getSyncStatus().then(status => {
            if (status.isSyncing) {
                showSyncOverlay();
                startSyncPolling(true);
            }
        });
    }
}

function setupApiKeyModal() {
    const modal = document.getElementById('api-key-modal');
    const input = document.getElementById('api-key-input');
    const saveBtn = document.getElementById('save-api-key-btn');
    const settingsBtn = document.getElementById('settings-btn');
    const channelSettingsModal = document.getElementById('channel-settings-modal');

    // API 키 저장 버튼 → 저장 후 탤런트 모달로 이동
    if (saveBtn) {
        saveBtn.addEventListener('click', () => {
            const key = input.value.trim();
            if (key) {
                localStorage.setItem('holodex_api_key', key);
                modal.classList.remove('show');

                // 기본 채널이 없으면 자동 초기화
                const myChannels = getMyChannels();
                if (myChannels.length === 0) {
                    saveMyChannels([...DEFAULT_CHANNELS]);
                }

                // 탤런트 모달 열기
                if (channelSettingsModal) {
                    channelSettingsModal.style.display = 'flex';
                    channelSettingsModal.dispatchEvent(new CustomEvent('open'));
                }
            } else {
                alert('API Key를 입력해주세요.');
            }
        });
    }

    // 설정 버튼 → API 키 있으면 탤런트 모달, 없으면 API 모달
    if (settingsBtn) {
        settingsBtn.addEventListener('click', () => {
            const currentKey = localStorage.getItem('holodex_api_key');

            if (currentKey) {
                // API 키 있으면 탤런트 관리 모달 열기
                if (channelSettingsModal) {
                    channelSettingsModal.style.display = 'flex';
                }
            } else {
                // API 키 없으면 API 입력 모달 열기
                input.value = '';
                modal.classList.add('show');
            }
        });
    }

    // 모달 외부 클릭 시 닫기 (API 키 있을 때만)
    if (modal) {
        modal.addEventListener('click', (e) => {
            if (e.target === modal && localStorage.getItem('holodex_api_key')) {
                modal.classList.remove('show');
            }
        });
    }
}

async function startFullSync(apiKey) {
    showSyncOverlay();
    setState({ isSyncing: true });

    // 현재 사용자가 선택한 채널 목록 가져오기 (ID + 이름)
    const myChannels = getMyChannels();
    const channelList = myChannels.map(ch => ({
        id: ch.id,
        name: ch.name
    }));

    try {
        const res = await fetch('/api/sync', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-APIKEY': apiKey
            },
            body: JSON.stringify({
                apiKey,
                fullSync: true,
                channels: channelList  // ID + 이름 전달
            })
        });

        if (res.ok) {
            startSyncPolling(true);
        } else {
            alert('동기화 시작에 실패했습니다.');
            hideSyncOverlay();
        }
    } catch {
        alert('동기화 시작 중 오류가 발생했습니다.');
        hideSyncOverlay();
    }
}

// === 동기화 폴링 ===
function clearSyncPolling() {
    if (syncPollInterval) {
        clearInterval(syncPollInterval);
        syncPollInterval = null;
    }
    setState({ isSyncing: false });
}

function startSyncPolling(isInitialSync = false) {
    if (syncPollInterval) return; // 이미 폴링 중

    let isFirstCheck = true;

    const checkStatus = async () => {
        const status = await getSyncStatus();
        const searchInput = document.getElementById('search-input');
        const searchBtn = document.getElementById('search-btn');
        const state = getState();
        const wasSyncing = state.isSyncing;
        setState({ isSyncing: status.isSyncing });

        if (status.isSyncing) {
            // 오버레이 업데이트
            if (isInitialSync) {
                updateSyncOverlay(status);
            }

            // 검색 비활성화
            if (searchInput) {
                searchInput.disabled = true;
                searchInput.placeholder = `동기화 중... (${status.syncedChannels}/${status.totalChannels})`;
            }
            if (searchBtn) {
                searchBtn.disabled = true;
                searchBtn.style.opacity = '0.5';
            }
        } else {
            // 동기화 완료 또는 처음부터 동기화 중 아님
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
                            alert(`동기화 완료! ${(status.totalVideos || 0).toLocaleString()}개의 영상이 다운로드되었습니다.`);
                            location.reload();
                        } else if (isFirstCheck) {
                            showToast("동기화 완료", "이미 모든 데이터가 최신 상태입니다.", "image/fubuki.jpg");
                        }
                    }, 500);
                } else if (wasSyncing) {
                    showToast("동기화 완료", "모든 히스토리가 다운로드되었습니다.", "image/fubuki.jpg");
                }
            }

            // 동기화 중이 아니면 폴링 즉시 중단
            clearSyncPolling();

            // 검색 활성화
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

// === 네비게이션 ===
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
    setState({ currentView: viewName });

    // 모든 뷰 숨기기
    document.querySelectorAll('.view-section').forEach(section => {
        section.style.display = 'none';
    });

    // 네비게이션 버튼 활성 상태 제거
    document.querySelectorAll('.main-nav a').forEach(btn => {
        btn.classList.remove('active');
    });

    // 대상 뷰 표시
    const targetSection = document.getElementById(`${viewName}-view`);
    if (targetSection) {
        targetSection.style.display = 'block';
    }

    // 활성 버튼 표시
    const activeBtn = document.querySelector(`.main-nav a[data-view="${viewName}"]`);
    if (activeBtn) {
        activeBtn.classList.add('active');
    }

    // 아카이브 탭에서만 표시할 요소들 (설정 버튼 제외)
    const unarchivedToggle = document.querySelector('.unarchived-toggle');
    const filterBtn = document.getElementById('filter-btn');

    if (viewName === 'archive') {
        if (unarchivedToggle) unarchivedToggle.style.display = 'flex';
        if (filterBtn) filterBtn.style.display = 'block';
    } else {
        if (unarchivedToggle) unarchivedToggle.style.display = 'none';
        if (filterBtn) filterBtn.style.display = 'none';
        // 아카이브 탭이 아닐 때 필터 초기화
        resetAllFilters();
    }

    // 아카이브 뷰에서는 동기화 폴링 불필요 (초기 동기화 시에만 필요)

    // 뷰 데이터 로드
    loadViewData(viewName);

    // URL 해시 업데이트
    const state = getState();
    updateUrlHash(state);
}

// === 필터 초기화 함수 ===
function resetAllFilters() {
    // 검색어 초기화
    const searchInput = document.getElementById('search-input');
    if (searchInput) searchInput.value = '';

    // 언아카이브 체크박스 초기화
    const unarchivedCheckbox = document.getElementById('hide-unarchived-checkbox');
    if (unarchivedCheckbox) unarchivedCheckbox.checked = false;

    // 콜라보 필터 초기화
    const collabCheckboxes = document.querySelectorAll('#collab-generation-list input[type="checkbox"]');
    collabCheckboxes.forEach(cb => cb.checked = false);

    // 날짜 필터 초기화
    const yearBtns = document.querySelectorAll('.year-btn');
    yearBtns.forEach(btn => btn.classList.remove('selected'));

    const monthBtns = document.querySelectorAll('.month-btn');
    monthBtns.forEach(btn => btn.classList.remove('selected'));

    // 필터 패널 닫기
    const filterPanel = document.getElementById('search-filter-panel');
    if (filterPanel) filterPanel.style.display = 'none';

    // 상태 초기화
    setState({
        currentSearchQuery: '',
        collabFilter: '',
        collabMode: 'or',
        hideUnarchived: false,
        filterDates: [],
        filterYears: [],
        filterMonths: [],
        videoType: 'all'
    });

    // 아카이브 탭 UI 초기화
    const archiveTabs = document.querySelectorAll('.archive-tab');
    archiveTabs.forEach(tab => {
        tab.classList.toggle('active', tab.dataset.type === 'all');
    });
}

// === 검색 ===
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

// === 🔽 콜라보 필터 ===
// localStorage 기반 아이콘 캐시
const ICON_CACHE_KEY = 'holodex_member_icons';
const ICON_CACHE_EXPIRY = 7 * 24 * 60 * 60 * 1000; // 7일

// localStorage에서 아이콘 캐시 로드
function loadIconCache() {
    try {
        const cached = localStorage.getItem(ICON_CACHE_KEY);
        if (cached) {
            const { data, expiry } = JSON.parse(cached);
            if (Date.now() < expiry) {
                console.log('📦 Loaded icon cache from localStorage:', Object.keys(data).length, 'channels');
                return data;
            }
        }
    } catch (e) {
        console.warn('⚠️ Failed to load icon cache:', e);
    }
    return {};
}

// localStorage에 아이콘 캐시 저장
function saveIconCache(cache) {
    try {
        localStorage.setItem(ICON_CACHE_KEY, JSON.stringify({
            data: cache,
            expiry: Date.now() + ICON_CACHE_EXPIRY
        }));
        console.log('💾 Saved icon cache to localStorage:', Object.keys(cache).length, 'channels');
    } catch (e) {
        console.warn('⚠️ Failed to save icon cache:', e);
    }
}

// 전역 채널 아이콘 캐시 (localStorage에서 초기화)
let memberIconCache = loadIconCache();

// 멤버 아이콘 정보 가져오기 (Holodex API)
async function fetchMemberIcons(channelIds) {
    try {
        // 이미 캐시된 ID는 제외
        const uncachedIds = channelIds.filter(id => !memberIconCache[id]);
        if (uncachedIds.length === 0) return;

        console.log('📸 Fetching member icons for', uncachedIds.length, 'channels');

        // Holodex API - 채널 정보 가져오기 (최대 50개씩)
        const batchSize = 50;
        for (let i = 0; i < uncachedIds.length; i += batchSize) {
            const batch = uncachedIds.slice(i, i + batchSize);
            const channelInfos = await getChannelsInfo(batch);

            if (channelInfos && Array.isArray(channelInfos)) {
                channelInfos.forEach(ch => {
                    if (ch.id && ch.photo) {
                        memberIconCache[ch.id] = ch.photo;
                    }
                });
            }
        }

        console.log('✅ Member icon cache updated:', Object.keys(memberIconCache).length, 'channels');

        // localStorage에 저장 (영구 캐시)
        saveIconCache(memberIconCache);
    } catch (error) {
        console.error('❌ Failed to fetch member icons:', error);
    }
}

// === 검색 필터 (콜라보 + 날짜) ===
let datePickerInstance = null; // Flatpickr 인스턴스
let selectedDates = []; // 선택된 날짜 배열

function setupCollabFilter() {
    const filterBtn = document.getElementById('filter-btn');
    const filterPanel = document.getElementById('search-filter-panel');
    const generationList = document.getElementById('collab-generation-list');
    const applyBtn = document.getElementById('apply-filter-btn');
    const resetBtn = document.getElementById('clear-filter-btn');

    if (!filterBtn || !filterPanel || !generationList) return;

    // 초기 렌더링 (콜라보 멤버 리스트)
    renderGenerationList(generationList);

    // 필터 버튼 클릭 → 패널 토글
    filterBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const isOpen = filterPanel.classList.contains('show');
        filterPanel.classList.toggle('show');

        // 패널 열릴 때 Flatpickr 초기화 (한 번만)
        if (!isOpen) {
            filterPanel.style.display = 'block';
            setTimeout(() => filterPanel.classList.add('show'), 10);
            initDatePicker();
        }
    });

    // 패널 외부 클릭 시 닫기
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

    // 탭 전환 로직
    setupFilterTabs();

    // 콜라보 필터 적용 버튼
    if (applyBtn) {
        applyBtn.addEventListener('click', () => {
            const selectedMembers = getSelectedCollabMembers();
            const modeSelect = document.getElementById('collab-filter-mode');
            const mode = modeSelect ? modeSelect.value : 'or';
            applyCollabFilter(selectedMembers, mode);
            filterPanel.classList.remove('show');
        });
    }

    // 콜라보 필터 초기화 버튼
    if (resetBtn) {
        resetBtn.addEventListener('click', () => {
            clearAllCheckboxes(generationList);
            applyCollabFilter([]);
            filterPanel.classList.remove('show');
        });
    }

    // 날짜 필터 버튼 이벤트
    setupDateFilterButtons();

    // 언아카이브 숨기기 체크박스 설정
    setupHideUnarchivedCheckbox();
}

// 탭 전환 로직
function setupFilterTabs() {
    const tabs = document.querySelectorAll('.filter-tab');
    const tabContents = document.querySelectorAll('.filter-tab-content');

    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            const targetTab = tab.dataset.tab;

            // 탭 활성화 상태 업데이트
            tabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');

            // 탭 콘텐츠 표시/숨김
            tabContents.forEach(content => {
                if (content.id === `${targetTab}-filter-tab`) {
                    content.classList.add('active');
                } else {
                    content.classList.remove('active');
                }
            });

            // 날짜 탭으로 전환 시 Flatpickr 및 빠른 선택 UI 초기화
            if (targetTab === 'date') {
                initDatePicker();
                initQuickDateSelector();
            }
        });
    });
}

// Flatpickr 달력 초기화
function initDatePicker() {
    const container = document.getElementById('date-picker-container');
    if (!container || datePickerInstance) return;

    // Flatpickr 글로벌 객체 확인
    if (typeof flatpickr === 'undefined') {
        console.error('Flatpickr가 로드되지 않았습니다');
        return;
    }

    // Flatpickr 인라인 모드로 초기화
    datePickerInstance = flatpickr(container, {
        inline: true,
        mode: 'multiple',
        dateFormat: 'Y-m-d',
        locale: 'ko',
        defaultDate: selectedDates,
        onChange: (dates) => {
            // 선택된 날짜 저장
            selectedDates = dates.map(d => formatDate(d));
            updateSelectedDatesDisplay();

            // 달력에서 직접 날짜 변경 시 년/월 빠른 선택 버튼 해제
            // (프로그래밍 방식이 아닌 사용자 클릭인 경우에만)
            if (!isQuickSelectUpdating) {
                clearQuickDateSelection();
            }
        }
    });
}

// 날짜 포맷팅 (YYYY-MM-DD)
function formatDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

// 선택된 날짜 표시 업데이트
function updateSelectedDatesDisplay() {
    const container = document.getElementById('selected-dates-list');
    if (!container) return;

    if (selectedDates.length === 0) {
        container.innerHTML = '<span class="no-dates">날짜를 선택하세요</span>';
        return;
    }

    // 날짜 태그 생성
    container.innerHTML = selectedDates
        .sort()
        .map(date => {
            // YYYY-MM-DD → M/D 형식으로 표시
            const [year, month, day] = date.split('-');
            const displayDate = `${parseInt(month)}/${parseInt(day)}`;
            return `<span class="date-tag" data-date="${date}">${displayDate}<span class="remove-date" title="제거">✕</span></span>`;
        })
        .join('');

    // 제거 버튼 이벤트
    container.querySelectorAll('.remove-date').forEach(btn => {
        btn.addEventListener('click', (e) => {
            // 이벤트 버블링 방지 - 외부 클릭으로 오판되어 패널 닫히는 것 방지
            e.stopPropagation();

            const tag = e.target.closest('.date-tag');
            const dateToRemove = tag.dataset.date;

            // 배열에서 제거
            selectedDates = selectedDates.filter(d => d !== dateToRemove);

            // Flatpickr 업데이트
            if (datePickerInstance) {
                datePickerInstance.setDate(selectedDates, false);
            }

            // 표시 업데이트
            updateSelectedDatesDisplay();
        });
    });
}

// 날짜 필터 버튼 이벤트
function setupDateFilterButtons() {
    const applyBtn = document.getElementById('apply-date-btn');
    const clearBtn = document.getElementById('clear-date-btn');

    if (applyBtn) {
        applyBtn.addEventListener('click', () => {
            // 년/월 빠른 선택 필터 적용
            applyQuickDateFilter();
            // 개별 날짜 필터 적용
            applyDateFilter(selectedDates);
            const filterPanel = document.getElementById('search-filter-panel');
            if (filterPanel) filterPanel.classList.remove('show');
        });
    }

    if (clearBtn) {
        clearBtn.addEventListener('click', () => {
            // 날짜 초기화
            selectedDates = [];
            if (datePickerInstance) {
                datePickerInstance.clear();
            }
            updateSelectedDatesDisplay();

            // 년/월 선택 상태 초기화
            clearQuickDateSelection();
            // 상태도 함께 초기화
            setState({
                filterYears: null,
                filterMonths: null
            });

            // 필터 적용 (전체 표시)
            applyDateFilter([]);
        });
    }
}

// ========================================
// 년/월 빠른 선택 기능 (다중 선택 지원)
// ========================================

// 현재 표시 중인 년도 범위의 시작 년도
let quickSelectBaseYear = new Date().getFullYear() - 1;
// 선택된 년도들 (다중 선택 - 배열)
let selectedQuickYears = [];
// 선택된 월들 (다중 선택 - 배열)
let selectedQuickMonths = [];
// 프로그래밍 방식으로 달력 업데이트 중인지 플래그
let isQuickSelectUpdating = false;

// 년/월 빠른 선택 UI 초기화
function initQuickDateSelector() {
    renderYearButtons();  // 내부에서 setupYearButtons 호출함
    setupYearNavigation();
    setupMonthButtons();
}

// 년도 버튼 렌더링 (3개 표시)
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
        // 다중 선택: 배열에 포함되어 있으면 selected
        if (selectedQuickYears.includes(year)) {
            btn.classList.add('selected');
        }

        // 각 버튼에 직접 이벤트 등록 (createElement로 만들어서 중복 없음)
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const clickedYear = parseInt(btn.dataset.year);

            // 토글 로직
            const index = selectedQuickYears.indexOf(clickedYear);
            if (index > -1) {
                // 선택 해제
                selectedQuickYears = selectedQuickYears.filter(y => y !== clickedYear);
                btn.classList.remove('selected');

                // 년도가 모두 해제되면 월 선택도 초기화
                if (selectedQuickYears.length === 0) {
                    selectedQuickMonths = [];
                    clearMonthSelection();
                }
            } else {
                // 선택 추가
                selectedQuickYears = [...selectedQuickYears, clickedYear];
                btn.classList.add('selected');

                // 달력을 해당 년도의 1월로 이동
                if (datePickerInstance) {
                    datePickerInstance.jumpToDate(new Date(clickedYear, 0, 1));
                }
            }

            // 달력에 선택된 년/월의 모든 날짜 반영
            syncCalendarWithQuickSelect();
        });

        container.appendChild(btn);
    }
}

// 년도 네비게이션 (◀ ▶) 설정
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

// 년도 버튼 이벤트 설정 (다중 선택 토글)
function setupYearButtons() {
    const container = document.getElementById('year-buttons');
    if (!container) return;

    container.querySelectorAll('.year-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const year = parseInt(btn.dataset.year);

            // 토글 로직: 이미 선택되어 있으면 제거, 없으면 추가
            const index = selectedQuickYears.indexOf(year);
            if (index > -1) {
                // 선택 해제
                selectedQuickYears = selectedQuickYears.filter(y => y !== year);
                btn.classList.remove('selected');
            } else {
                // 선택 추가
                selectedQuickYears = [...selectedQuickYears, year];
                btn.classList.add('selected');
            }
            // 즉시 API 호출하지 않음 - 적용 버튼 클릭 시 적용
        });
    });
}

// 월 버튼 이벤트 설정 (다중 선택 토글)
function setupMonthButtons() {
    const container = document.getElementById('month-selector');
    if (!container) return;

    container.querySelectorAll('.month-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();

            // 년도가 선택되지 않았으면 월 선택 불가
            if (selectedQuickYears.length === 0) {
                // 간단한 시각적 피드백 (버튼 흔들림)
                btn.classList.add('shake');
                setTimeout(() => btn.classList.remove('shake'), 300);
                return;
            }

            const month = parseInt(btn.dataset.month);

            // 토글 로직: 이미 선택되어 있으면 제거, 없으면 추가
            const index = selectedQuickMonths.indexOf(month);
            if (index > -1) {
                // 선택 해제
                selectedQuickMonths = selectedQuickMonths.filter(m => m !== month);
                btn.classList.remove('selected');
            } else {
                // 선택 추가
                selectedQuickMonths = [...selectedQuickMonths, month];
                btn.classList.add('selected');

                // 달력을 해당 년/월로 이동 (선택된 첫 번째 년도 기준)
                if (datePickerInstance && selectedQuickYears.length > 0) {
                    const firstYear = Math.min(...selectedQuickYears);
                    datePickerInstance.jumpToDate(new Date(firstYear, month - 1, 1));
                }
            }

            // 달력에 선택된 년/월의 모든 날짜 반영
            syncCalendarWithQuickSelect();
            // 즉시 API 호출하지 않음 - 적용 버튼 클릭 시 적용
        });
    });
}

// 년도 버튼 UI 업데이트
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

// 월 선택 UI 초기화
function clearMonthSelection() {
    const container = document.getElementById('month-selector');
    if (!container) return;
    container.querySelectorAll('.month-btn').forEach(b => b.classList.remove('selected'));
}

// 빠른 선택 상태 전체 초기화
function clearQuickDateSelection() {
    selectedQuickYears = [];
    selectedQuickMonths = [];
    const yearContainer = document.getElementById('year-buttons');
    if (yearContainer) {
        yearContainer.querySelectorAll('.year-btn').forEach(b => b.classList.remove('selected'));
    }
    clearMonthSelection();
}

// 년/월 빠른 선택에 따라 달력에 날짜 자동 선택
function syncCalendarWithQuickSelect() {
    if (!datePickerInstance) return;
    if (selectedQuickYears.length === 0) {
        // 년도 없으면 달력 초기화
        isQuickSelectUpdating = true;
        datePickerInstance.clear();
        selectedDates = [];
        updateSelectedDatesDisplay();
        isQuickSelectUpdating = false;
        return;
    }

    // 선택된 년/월 조합의 모든 날짜 생성
    const allDates = [];
    const years = selectedQuickYears;
    const months = selectedQuickMonths.length > 0 ? selectedQuickMonths : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

    years.forEach(year => {
        months.forEach(month => {
            // 해당 월의 마지막 날짜 계산
            const lastDay = new Date(year, month, 0).getDate();
            for (let day = 1; day <= lastDay; day++) {
                allDates.push(new Date(year, month - 1, day));
            }
        });
    });

    // 달력에 날짜 설정 (onChange 트리거 방지)
    isQuickSelectUpdating = true;
    datePickerInstance.setDate(allDates, false);
    selectedDates = allDates.map(d => formatDate(d));
    updateSelectedDatesDisplay();
    isQuickSelectUpdating = false;
}

// 빠른 날짜 필터 적용 (적용 버튼에서 호출)
function applyQuickDateFilter() {
    // 검색 상태 업데이트 - 배열로 저장
    setState({
        filterYears: selectedQuickYears.length > 0 ? [...selectedQuickYears] : null,
        filterMonths: selectedQuickMonths.length > 0 ? [...selectedQuickMonths] : null
    });

    // 아카이브 새로고침
    const state = getState();
    if (state.currentView === 'archive' || state.currentView === 'home') {
        loadArchives(state.currentChannelId, 1);
    }
}

// 날짜 필터 적용
function applyDateFilter(dates) {
    // 상태 업데이트 (1페이지로 이동)
    setState({
        filterDates: dates,
        archivePage: 1
    });

    // 아카이브 새로고침
    const state = getState();
    if (state.currentView === 'archive' || state.currentView === 'home') {
        loadArchives(state.currentChannelId, 1);
    }
}

// 언아카이브 숨기기 체크박스 설정
function setupHideUnarchivedCheckbox() {
    const checkbox = document.getElementById('hide-unarchived-checkbox');
    const label = checkbox?.closest('.unarchived-toggle');
    if (!checkbox || !label) return;

    // 초기 상태는 체크 해제 (localStorage 사용 안 함 - 새로고침/채널변경 시 리셋)

    checkbox.addEventListener('change', () => {
        const newValue = checkbox.checked;

        // 상태 업데이트 (1페이지로 이동)
        setState({ hideUnarchived: newValue, archivePage: 1 });

        // UI 업데이트
        if (newValue) {
            label.classList.add('active');
        } else {
            label.classList.remove('active');
        }

        // 아카이브 새로고침 (1페이지)
        const currentState = getState();
        if (currentState.currentView === 'archive' || currentState.currentView === 'home') {
            loadArchives(currentState.currentChannelId, 1);
        }
    });
}

// === 멤버 photo URL 하드코딩 (Holodex API에서 추출) ===
const MEMBER_PHOTOS = {
    // 0기생
    'UCp6993wxpyDPHUpavwDFqgg': 'https://yt3.ggpht.com/ytc/AIdro_kT9PiLS8BWANuBdGG_-GHsNZxFqmF0YjMnzK55jISdca4=s800-c-k-c0x00ffffff-no-rj', // Tokino Sora
    'UCDqI2jOz0weumE8s7paEk6g': 'https://yt3.ggpht.com/H8pRHxQm4-FjRl9XUFn9UQbJhVcj5PIvwDW6o7ZlBTRj2bgVP5xonQEl36H-O6NHaWmbP1zaxg=s800-c-k-c0x00ffffff-no-rj', // Roboco
    'UC-hM6YJuNYVAmUWxeIr9FeA': 'https://yt3.ggpht.com/b8EKl_i-e2dinoparyhUJEaRhInlSWwm-dZX0oIq-x1mUvQga530G_PIdutlSNkGKEAyX9aaBQ=s800-c-k-c0x00ffffff-no-rj', // Sakura Miko
    'UC5CwaMl1eIgY8h02uZw7u8A': 'https://yt3.ggpht.com/ytc/AIdro_kLDBK5ksSvk5-XJ6S8e0kWfjy7mVl3jyUkgDeMQ7rlCpU=s800-c-k-c0x00ffffff-no-rj', // Suisei
    'UC0TXe_LYZ4scaW2XMyi5_kw': 'https://yt3.ggpht.com/tRZGMhn8vSvYE0_15SjaE_3dTH5JTZzjdnb5gs1StecT1tKn1gQ2tVkRfi_n42Q5fYz13ewdayo=s800-c-k-c0x00ffffff-no-rj', // AZKi
    // 1기생
    'UCdn5BQ06XqgXoAxIhbqw5Rg': 'https://yt3.ggpht.com/ytc/AIdro_mGXEeXXCCPh-sl2jKYbYpLBuCsjEGDgJaL5RQziYhyugQ=s800-c-k-c0x00ffffff-no-rj', // Fubuki
    'UCQ0UDLQCjY0rmuxCDE38FGg': 'https://yt3.ggpht.com/LZBvU0s_S-xi7fHmeab_iA8ztfGimxzisUBMODGKaIEx3r3R-tIDReiX3SlmbH2showigElJ=s800-c-k-c0x00ffffff-no-rj', // Matsuri
    'UCFTLzh12_nrtzqBPsTCqenA': 'https://yt3.ggpht.com/0Nx9jWdjiUrkizCVCDZg_MasdF6b85DAsQATmAkNC2A8b3Y89vXlnSDZ_v1fM_X4w3088sJnmA=s800-c-k-c0x00ffffff-no-rj', // Aki
    'UC1CfXB_kRs3C-zaeTG3oGyg': 'https://yt3.ggpht.com/jxI6FmNKDpYKXB0puyLhB5gq4JgWFvRT9Rr2C_d3hFT1q0SSOHh3QIUfvSxfTHupTXFnleqI=s800-c-k-c0x00ffffff-no-rj', // Haato
    // 2기생
    'UC1opHUrw8rvnsadT-iGp7Cg': 'https://yt3.ggpht.com/ytc/AIdro_kaZLtKaya9TSJr3M4lpzV95R2rWdQtGk67fwedroUfSnE=s800-c-k-c0x00ffffff-no-rj', // Aqua
    'UCXTpFs_3PqI41qX2d9tL2Rw': 'https://yt3.ggpht.com/K91NQLuy_JMQ65n-Opf0Q2FZBO3yOURnMRusO7o5DTjaJ1QVtP-ANN4lehK57X4KXpcI2MiRig=s800-c-k-c0x00ffffff-no-rj', // Shion
    'UC7fk0CB07ly8oSl0aqKkqFg': 'https://yt3.ggpht.com/3CeLWGYb6cLUywTJzNt-UpITviNxeGNvtjhIqbV-AIybCqCoFw9onWtg91bjwpqvfEP9mfqIR4Q=s800-c-k-c0x00ffffff-no-rj', // Ayame
    'UC1suqwovbL1kzsoaZgFZLKg': 'https://yt3.ggpht.com/gv-5tmPSiFipkP01atgnCS6WwdxzUxfermmqGw_UhuDNtRFmbdb2NALcL6rR0LxaM5JX9JhE9g=s800-c-k-c0x00ffffff-no-rj', // Choco
    'UCvzGlP9oQwU--Y0r9id_jnA': 'https://yt3.ggpht.com/ytc/AIdro_k5mjdt1wcbaYCXKwmDpVXmSGtOc-LH3WjIyUHVC4soP28=s800-c-k-c0x00ffffff-no-rj', // Subaru
    // 게이머즈
    'UCp-5t9SrOQwXMU7iIjQfARg': 'https://yt3.ggpht.com/JV8VdQFA7eZk5H1cRxHyIdLKQ5wD6EBywjxLzrne2EpY9LSiVgtapvh0iQA6plVNxdIKNxK0NRU=s800-c-k-c0x00ffffff-no-rj', // Mio
    'UCvaTdHTWBGv3MKj3KVqJVCw': 'https://yt3.ggpht.com/oD8ISaA35737mg-lt5mYSfOIXmjCeHYcSFFpTQn4AVMkqiyzrMle_THvX6NdfSxbjUO6fQ6_wg=s800-c-k-c0x00ffffff-no-rj', // Okayu
    'UChAnqc_AY5_I3Px5dig3X1Q': 'https://yt3.ggpht.com/ytc/AIdro_nrS6tFctvjyWv1mKzKBIetHJBfpqwHOpvRFc3KU2P_5yc=s800-c-k-c0x00ffffff-no-rj', // Korone
    // 3기생
    'UC1DCedRgGHBdm81E1llLhOQ': 'https://yt3.ggpht.com/B-5Iau5CJVDiUOeCvCzHiwdkUijqoi2n0tNwfgIv_yDAvMbLHS4vq1IvK2RxL8y69BxTwmPhow=s800-c-k-c0x00ffffff-no-rj', // Pekora
    'UCvInZx9h3jC2JzsIzoOebWg': 'https://yt3.ggpht.com/XGJE8dQHKGyKma2oLZM-oZxF2c5OnQsjQx68tTowiPfh7gI2cHhP8REzXC7exvw2ri5QxFxEA-4=s800-c-k-c0x00ffffff-no-rj', // Flare
    'UCdyqAaZDKHXg4Ahi7VENThQ': 'https://yt3.ggpht.com/ytc/AIdro_kIKJPVEqJLs9FNMgdti5WWHtc1t0MwihOlW-ZK90nGUdk=s800-c-k-c0x00ffffff-no-rj', // Noel
    'UCCzUftO8KOVkV4wQG1vkUvg': 'https://yt3.ggpht.com/RnFYoR_VkEZZ4OGRJz2cPXem1iRqMNzcGVp5LIxTRqhDu4vqckc83DBrVi2uwxiCPWEmmH6vSJk=s800-c-k-c0x00ffffff-no-rj', // Marine
    // 4기생
    'UCZlDXzGoo7d44bwdNObFacg': 'https://yt3.ggpht.com/KjtzUgvj7v4socyPBkwZVlRJC9YU7Seka_a2lYf-LuBgc_YXXknzaR--5rbtYR46Q-JAWcR-=s800-c-k-c0x00ffffff-no-rj', // Kanata
    'UCqm3BQLlJfvkTsX_hvm0UmA': 'https://yt3.ggpht.com/XJYar8ZAQ59ce0nFlf-Dl6V16Dwznu5xfh3XnMW_JE-nCVLHLiRTS-x1gB_eR4_CJY3KDfKxsVo=s800-c-k-c0x00ffffff-no-rj', // Watame
    'UC1uv2Oq6kNxgATlCiez59hw': 'https://yt3.ggpht.com/kF39-I4IfZJOWuGiciawwB-v4M_X9u6_-jxCvAiYSHSRuUS-LdpeWWRHO7c4Pk8sXROBaPl9iMQ=s800-c-k-c0x00ffffff-no-rj', // Towa
    'UCa9Y57gfeY0Zro_noHRVrnw': 'https://yt3.ggpht.com/05zupy7ai3DW0mEmY3tSgkb4CGjHadAXG0bs_PSzg09l0_5MInPrG4Bh-ZRlAWcPncOe9cnQkQ=s800-c-k-c0x00ffffff-no-rj', // Luna
    'UCS9uQI-jC3DE0L4IpXyvr6w': 'https://yt3.ggpht.com/ytc/AMLnZu8xM8iFAtHMoKUPqKh-0NT7QL6zU06fEgwkIB0D0A=s800-c-k-c0x00ffffff-no-rj', // Coco
    // 5기생
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
    // 개인세
    'UCrV1Hf5r8P148idjoSfrGEQ': 'https://yt3.ggpht.com/CAO0J4GC4_G8VxiyulWcZZ3b44l27EFl-vSOER7ucwAL5IJIRxVk4XSQdhWn3PLXD-rQ-QVj=s800-c-k-c0x00ffffff-no-rj', // Sakuna
    'UCLIpj4TmXviSTNE_U5WG_Ug': 'https://yt3.ggpht.com/YF6d4zXLWFR6VjPpF01N8w0Wq-MfwMz6MZTDQbOF2TeSSMT4bwtIf2xGs8DfoufreyVcro4N7Bo=s800-c-k-c0x00ffffff-no-rj', // Roa
    'UCt30jJgChL8qeT9VPadidSw': 'https://yt3.ggpht.com/ytc/AIdro_m6xQ9ez0I8lnwswHqAns9ZRPsaCCutfzu6eUbM7pwzqsA=s800-c-k-c0x00ffffff-no-rj', // Shigure Ui
    'UClS3cnIUM9yzsBPQzeyX_8Q': 'https://yt3.ggpht.com/E_GIFETWLQYVBMYBzSfwr6VqmJRALcKYvruQcC5jyI9KqRszN9YaPWlT-C3PobxtTUplYNvrCg=s800-c-k-c0x00ffffff-no-rj', // Amagai Ruka
    // 계약해지
    'UCl_gCybOJRIgOXw6Qb4qJzQ': 'https://yt3.ggpht.com/ytc/AMLnZu9cOjR_bgBuDzX45gUUMHCDo1HLLiecGY-Y1yPCDg=s800-c-k-c0x00ffffff-no-rj', // Rushia
    'UCD8HOxPs4Xvsm8H0ZxXGiBw': '/image/mel.jpg', // Mel (로컬 이미지 - YouTube URL 만료)
};

// 모든 멤버의 채널 ID 수집
function getAllMemberChannelIds() {
    const generations = [
        {
            id: 'gen0', name: '0기생', members: [
                { name: 'Tokino Sora', id: 'UCp6993wxpyDPHUpavwDFqgg' },
                { name: 'Roboco', id: 'UCDqI2jOz0weumE8s7paEk6g' },
                { name: 'Sakura Miko', id: 'UC-hM6YJuNYVAmUWxeIr9FeA' },
                { name: 'Hoshimachi Suisei', id: 'UC5CwaMl1eIgY8h02uZw7u8A' },
                { name: 'AZKi', id: 'UC0TXe_LYZ4scaW2XMyi5_kw' }
            ]
        },
        {
            id: 'gen1', name: '1기생', members: [
                { name: 'Shirakami Fubuki', id: 'UCdn5BQ06XqgXoAxIhbqw5Rg' },
                { name: 'Natsuiro Matsuri', id: 'UCQ0UDLQCjY0rmuxCDE38FGg' },
                { name: 'Aki Rosenthal', id: 'UCFTLzh12_nrtzqBPsTCqenA' },
                { name: 'Akai Haato', id: 'UC1CfXB_kRs3C-zaeTG3oGyg' }
            ]
        },
        {
            id: 'gen2', name: '2기생', members: [
                { name: 'Minato Aqua', id: 'UC1opHUrw8rvnsadT-iGp7Cg' },
                { name: 'Murasaki Shion', id: 'UCXTpFs_3PqI41qX2d9tL2Rw' },
                { name: 'Nakiri Ayame', id: 'UC7fk0CB07ly8oSl0aqKkqFg' },
                { name: 'Yuzuki Choco', id: 'UC1suqwovbL1kzsoaZgFZLKg' },
                { name: 'Oozora Subaru', id: 'UCvzGlP9oQwU--Y0r9id_jnA' }
            ]
        },
        {
            id: 'gamers', name: '게이머즈', members: [
                { name: 'Ookami Mio', id: 'UCp-5t9SrOQwXMU7iIjQfARg' },
                { name: 'Nekomata Okayu', id: 'UCvaTdHTWBGv3MKj3KVqJVCw' },
                { name: 'Inugami Korone', id: 'UChAnqc_AY5_I3Px5dig3X1Q' }
            ]
        },
        {
            id: 'gen3', name: '3기생', members: [
                { name: 'Usada Pekora', id: 'UC1DCedRgGHBdm81E1llLhOQ' },
                { name: 'Shiranui Flare', id: 'UCvInZx9h3jC2JzsIzoOebWg' },
                { name: 'Shirogane Noel', id: 'UCdyqAaZDKHXg4Ahi7VENThQ' },
                { name: 'Houshou Marine', id: 'UCCzUftO8KOVkV4wQG1vkUvg' }
            ]
        },
        {
            id: 'gen4', name: '4기생', members: [
                { name: 'Amane Kanata', id: 'UCZlDXzGoo7d44bwdNObFacg' },
                { name: 'Tsunomaki Watame', id: 'UCqm3BQLlJfvkTsX_hvm0UmA' },
                { name: 'Tokoyami Towa', id: 'UC1uv2Oq6kNxgATlCiez59hw' },
                { name: 'Himemori Luna', id: 'UCa9Y57gfeY0Zro_noHRVrnw' }
            ]
        },
        {
            id: 'gen5', name: '5기생', members: [
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

// 기수별 체크박스 리스트 렌더링 (아이콘 포함)
function renderGenerationList(container) {
    // 기수 데이터 - 채널 ID 포함
    const generations = [
        {
            id: 'gen0', name: '0기생', members: [
                { name: 'Tokino Sora', id: 'UCp6993wxpyDPHUpavwDFqgg' },
                { name: 'Roboco', id: 'UCDqI2jOz0weumE8s7paEk6g' },
                { name: 'Sakura Miko', id: 'UC-hM6YJuNYVAmUWxeIr9FeA' },
                { name: 'Hoshimachi Suisei', id: 'UC5CwaMl1eIgY8h02uZw7u8A' },
                { name: 'AZKi', id: 'UC0TXe_LYZ4scaW2XMyi5_kw' }
            ]
        },
        {
            id: 'gen1', name: '1기생', members: [
                { name: 'Shirakami Fubuki', id: 'UCdn5BQ06XqgXoAxIhbqw5Rg' },
                { name: 'Natsuiro Matsuri', id: 'UCQ0UDLQCjY0rmuxCDE38FGg' },
                { name: 'Aki Rosenthal', id: 'UCFTLzh12_nrtzqBPsTCqenA' },
                { name: 'Akai Haato', id: 'UC1CfXB_kRs3C-zaeTG3oGyg' }
            ]
        },
        {
            id: 'gen2', name: '2기생', members: [
                { name: 'Minato Aqua', id: 'UC1opHUrw8rvnsadT-iGp7Cg' },
                { name: 'Murasaki Shion', id: 'UCXTpFs_3PqI41qX2d9tL2Rw' },
                { name: 'Nakiri Ayame', id: 'UC7fk0CB07ly8oSl0aqKkqFg' },
                { name: 'Yuzuki Choco', id: 'UC1suqwovbL1kzsoaZgFZLKg' },
                { name: 'Oozora Subaru', id: 'UCvzGlP9oQwU--Y0r9id_jnA' }
            ]
        },
        {
            id: 'gamers', name: '게이머즈', members: [
                { name: 'Ookami Mio', id: 'UCp-5t9SrOQwXMU7iIjQfARg' },
                { name: 'Nekomata Okayu', id: 'UCvaTdHTWBGv3MKj3KVqJVCw' },
                { name: 'Inugami Korone', id: 'UChAnqc_AY5_I3Px5dig3X1Q' }
            ]
        },
        {
            id: 'gen3', name: '3기생', members: [
                { name: 'Usada Pekora', id: 'UC1DCedRgGHBdm81E1llLhOQ' },
                { name: 'Shiranui Flare', id: 'UCvInZx9h3jC2JzsIzoOebWg' },
                { name: 'Shirogane Noel', id: 'UCdyqAaZDKHXg4Ahi7VENThQ' },
                { name: 'Houshou Marine', id: 'UCCzUftO8KOVkV4wQG1vkUvg' }
            ]
        },
        {
            id: 'gen4', name: '4기생', members: [
                { name: 'Amane Kanata', id: 'UCZlDXzGoo7d44bwdNObFacg' },
                { name: 'Tsunomaki Watame', id: 'UCqm3BQLlJfvkTsX_hvm0UmA' },
                { name: 'Tokoyami Towa', id: 'UC1uv2Oq6kNxgATlCiez59hw' },
                { name: 'Himemori Luna', id: 'UCa9Y57gfeY0Zro_noHRVrnw' },
                { name: 'Kiryu Coco', id: 'UCS9uQI-jC3DE0L4IpXyvr6w' }
            ]
        },
        {
            id: 'gen5', name: '5기생', members: [
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
        // === 계약해지 ===
        {
            id: 'terminated', name: '계약해지', members: [
                { name: 'Uruha Rushia', id: 'UCl_gCybOJRIgOXw6Qb4qJzQ' },
                { name: 'Yozora Mel', id: 'UCD8HOxPs4Xvsm8H0ZxXGiBw' }
            ]
        }
    ];

    // 영어 → 한글 변환
    const toKorean = window.toKoreanName || ((name) => name);

    // 채널 아이콘 URL 생성 (MEMBER_PHOTOS 하드코딩 → 로컬 CHANNELS → placeholder)
    const getIconUrl = (channelId) => {
        // 1순위: MEMBER_PHOTOS 하드코딩에서 가져오기 (가장 확실)
        if (MEMBER_PHOTOS[channelId]) {
            return MEMBER_PHOTOS[channelId];
        }
        // 2순위: 로컬 CHANNELS에서 찾기
        const localChannel = getChannelById(channelId);
        if (localChannel && localChannel.icon) {
            return localChannel.icon;
        }
        // 3순위: placeholder 반환 (절대 네트워크 요청 안 함)
        return null;
    };

    container.innerHTML = generations.map(gen => `
        <div class="generation-section" data-gen-id="${gen.id}">
            <div class="generation-header" onclick="toggleGeneration('${gen.id}')">
                <span class="toggle-icon">▼</span>
                <span>${gen.name}</span>
            </div>
            <div class="members-grid" id="members-${gen.id}">
                ${gen.members.map(member => `
                    <div class="member-item" data-member="${member.name}" data-value="${member.name}">
                        <input type="checkbox" value="${member.name}" style="display:none;">
                        <img class="member-icon" src="${getIconUrl(member.id) || `data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='48' height='48'><rect width='48' height='48' fill='%23ff69b4'/><text x='50%' y='55%' font-size='20' text-anchor='middle' fill='white'>${member.name.charAt(0)}</text></svg>`}" alt="${member.name}" onerror="this.onerror=null; this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%2248%22 height=%2248%22><rect width=%2248%22 height=%2248%22 fill=%22%23ff69b4%22/><text x=%2250%%22 y=%2255%%22 font-size=%2220%22 text-anchor=%22middle%22 fill=%22white%22>${member.name.charAt(0)}</text></svg>'">
                        <span class="member-name">${toKorean(member.name)}</span>
                    </div>
                `).join('')}
            </div>
        </div>
    `).join('');

    // 멤버 클릭 시 선택 토글
    container.querySelectorAll('.member-item').forEach(item => {
        item.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const checkbox = item.querySelector('input[type="checkbox"]');
            checkbox.checked = !checkbox.checked;
            item.classList.toggle('checked', checkbox.checked);
        });
    });
}

// 기수 접기/펼치기 토글 (전역 함수)
window.toggleGeneration = function (genId) {
    const header = document.querySelector(`[data-gen-id="${genId}"] .generation-header`);
    const membersGrid = document.getElementById(`members-${genId}`);
    if (header && membersGrid) {
        header.classList.toggle('collapsed');
        membersGrid.classList.toggle('hidden');
    }
};

// 선택된 멤버 목록 가져오기
function getSelectedCollabMembers() {
    const checkboxes = document.querySelectorAll('#collab-generation-list input[type="checkbox"]:checked');
    return Array.from(checkboxes).map(cb => cb.value);
}

// 모든 체크박스 초기화
function clearAllCheckboxes(container) {
    container.querySelectorAll('input[type="checkbox"]').forEach(cb => {
        cb.checked = false;
        cb.closest('.member-item')?.classList.remove('checked');
    });
}

// 콜라보 필터 적용 (다중 멤버 + OR/AND 모드 지원)
// options: { skipReload: boolean } - true면 페이지 리셋/아카이브 새로고침 안 함
function applyCollabFilter(selectedMembers, mode = 'or', options = {}) {
    const { skipReload = false } = options;
    const filterBtn = document.getElementById('filter-btn');

    // 상태 업데이트 (skipReload가 true면 페이지 리셋 안 함)
    const newState = { collabFilter: selectedMembers, collabMode: mode };
    if (!skipReload) {
        newState.archivePage = 1;
    }
    setState(newState);

    // 버튼 활성화 상태 표시
    if (filterBtn) {
        if (selectedMembers && selectedMembers.length > 0) {
            filterBtn.classList.add('active');
            filterBtn.textContent = `검색 필터 (${selectedMembers.length}명)`;
        } else {
            filterBtn.classList.remove('active');
            filterBtn.textContent = '검색 필터';
        }
    }

    // 아카이브 새로고침 (skipReload가 true면 건너뜀)
    if (!skipReload) {
        const state = getState();
        if (state.currentView === 'archive' || state.currentView === 'home') {
            loadArchives(state.currentChannelId, 1);
        }
    }

}

function performSearch(query) {
    setState({
        currentSearchQuery: query,
        archivePage: 1,
        clipsPage: 1
    });

    const state = getState();
    loadViewData(state.currentView);
}

// === 채널 선택 ===
// options: { preservePage: boolean } - true면 페이지 리셋 안 함 (새로고침 시 사용)
function selectChannel(channelId, options = {}) {
    const { preservePage = false } = options;

    // preservePage가 true면 현재 페이지 유지, 아니면 1로 리셋
    const newState = {
        currentChannelId: channelId,
        currentSearchQuery: ''
    };

    if (!preservePage) {
        newState.archivePage = 1;
        newState.clipsPage = 1;
    }

    setState(newState);

    // 사이드바 활성 상태 업데이트
    updateActiveChannel(channelId);

    // 테마 적용
    applyChannelTheme(channelId);

    // 로고 이모지 변경
    updateLogoEmoji(channelId);

    // 검색 입력 초기화
    const searchInput = document.getElementById('search-input');
    if (searchInput) searchInput.value = '';

    // 콜라보 필터 초기화 (preservePage가 true면 새로고침 건너뜀)
    const generationList = document.querySelector('.collab-generation-list');
    if (generationList) {
        clearAllCheckboxes(generationList);
    }
    applyCollabFilter([], 'or', { skipReload: preservePage });

    // 언아카이브 필터 초기화
    const unarchivedCheckbox = document.getElementById('hide-unarchived-checkbox');
    const unarchivedLabel = unarchivedCheckbox?.closest('.unarchived-toggle');
    if (unarchivedCheckbox) {
        unarchivedCheckbox.checked = false;
        unarchivedLabel?.classList.remove('active');
        setState({ hideUnarchived: false });
    }

    // 날짜 필터 초기화 (빠른 선택 + 개별 날짜)
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

    // 채널 정보 로드
    loadChannelInfo(channelId);

    // 현재 뷰 데이터 로드
    const state = getState();
    loadViewData(state.currentView);

    // URL 해시 업데이트
    updateUrlHash(state);
}

// 로고 이모지 및 헤더 타이틀 변경
function updateLogoEmoji(channelId) {
    const logoIcon = document.getElementById('logo-icon');
    const headerTitle = document.getElementById('header-title');

    // CHANNELS 배열 또는 내 채널 목록에서 채널 정보 찾기
    let channel = getChannelById(channelId);
    if (!channel) {
        const myChannels = getMyChannels();
        channel = myChannels.find(ch => ch.id === channelId);
    }

    // 이모지 있으면 표시, 없으면 숨김
    if (logoIcon) {
        if (channel && channel.emoji) {
            logoIcon.textContent = channel.emoji;
            logoIcon.style.display = 'inline';
        } else {
            logoIcon.textContent = '';
            logoIcon.style.display = 'none';
        }
    }

    // 헤더 타이틀 변경 (영문 이름 첫 단어 또는 한글 이름)
    if (headerTitle && channel) {
        // 영문 이름에서 이름 부분 추출 (성 제외)
        const englishName = channel.englishName || channel.name;
        const nameParts = englishName.split(' ');
        const firstName = nameParts.length > 1 ? nameParts[1] : nameParts[0];
        headerTitle.textContent = firstName || channel.name;
    }
}

// === 언어 필터 설정 ===
function setupLangFilter() {
    const langSelect = document.getElementById('clip-lang-select');
    if (!langSelect) return;

    // 초기값 설정
    const state = getState();
    langSelect.value = state.clipLang;

    // 변경 이벤트
    langSelect.addEventListener('change', (e) => {
        const newLang = e.target.value;
        setState({ clipLang: newLang, clipsPage: 1 });

        // 현재 클립 뷰면 다시 로드
        const currentState = getState();
        if (currentState.currentView === 'clips') {
            loadClips(currentState.currentChannelId, 1);
        }
    });
}

// === 탤런트 설정 모달 ===
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
    const startSyncBtn = document.getElementById('start-sync-btn');
    const deleteApiKeyBtn = document.getElementById('delete-api-key-btn');

    if (!modal) return;

    // 모달 열릴 때 채널 목록 다시 렌더링
    modal.addEventListener('open', () => {
        renderMyChannels();
    });

    // 내 채널 목록 렌더링
    function renderMyChannels() {
        const channels = getMyChannels();
        myChannelCount.textContent = channels.length;

        myChannelsList.innerHTML = channels.map(ch => `
            <li class="my-channel-item" data-id="${ch.id}">
                <img src="${ch.icon || 'image/miko.jpg'}" alt="${ch.name}" onerror="this.src='image/miko.jpg'">
                <span class="channel-name">${ch.name}</span>
                <button class="remove-btn" data-id="${ch.id}">삭제</button>
            </li>
        `).join('');

        // 삭제 버튼 이벤트
        myChannelsList.querySelectorAll('.remove-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const channelId = btn.dataset.id;
                const result = removeChannel(channelId);
                // 에러시만 토스트 표시
                if (!result.success) {
                    showToast('❌', result.message);
                }
                renderMyChannels();
                refreshSidebar();
            });
        });
    }

    // 사이드바 새로고침
    function refreshSidebar() {
        renderChannelList(selectChannel);
        const state = getState();
        updateActiveChannel(state.currentChannelId);
    }

    // 검색 결과 렌더링
    function renderSearchResults(channels) {
        if (channels.length === 0) {
            searchResults.innerHTML = '<div class="no-results">검색 결과가 없습니다</div>';
        } else {
            const myChannelIds = getMyChannels().map(ch => ch.id);
            searchResults.innerHTML = channels.map(ch => {
                const isAdded = myChannelIds.includes(ch.id);
                return `
                    <div class="channel-result-item" data-id="${ch.id}">
                        <img src="${ch.icon || 'image/miko.jpg'}" alt="${ch.name}" onerror="this.src='image/miko.jpg'">
                        <div class="channel-result-info">
                            <div class="channel-result-name">${ch.name}</div>
                            <div class="channel-result-org">${ch.org || 'Indie'}</div>
                        </div>
                        <button class="add-btn" data-channel="${encodeURIComponent(JSON.stringify(ch))}" ${isAdded ? 'disabled' : ''}>
                            ${isAdded ? '추가됨' : '추가'}
                        </button>
                    </div>
                `;
            }).join('');
        }
        searchResults.classList.add('active');

        // 추가 버튼 이벤트
        searchResults.querySelectorAll('.add-btn:not([disabled])').forEach(btn => {
            btn.addEventListener('click', () => {
                const channel = JSON.parse(decodeURIComponent(btn.dataset.channel));
                const result = addChannel(channel);
                // 에러시만 토스트 표시
                if (!result.success) {
                    showToast('❌', result.message);
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

    // 모달 열기
    settingsBtn.addEventListener('click', () => {
        modal.style.display = 'flex';
        renderMyChannels();
        searchResults.innerHTML = '';
        searchResults.classList.remove('active');
        searchInput.value = '';
    });

    // 모달 닫기 (외부 클릭 불가)
    closeBtn.addEventListener('click', () => {
        modal.style.display = 'none';
    });

    // ESC 키로 모달 닫기
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && modal.style.display === 'flex') {
            modal.style.display = 'none';
        }
    });

    // 검색
    searchBtn.addEventListener('click', async () => {
        const query = searchInput.value.trim();
        if (query.length < 2) {
            showToast('⚠️', '2글자 이상 입력하세요');
            return;
        }

        searchBtn.disabled = true;
        searchBtn.textContent = '검색 중...';

        try {
            const results = await searchChannels(query);
            renderSearchResults(results);
        } catch (e) {
            showToast('❌', '검색 실패');
        } finally {
            searchBtn.disabled = false;
            searchBtn.textContent = '검색';
        }
    });

    // 엔터 키 검색
    searchInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            searchBtn.click();
        }
    });

    // 초기화 버튼
    resetBtn.addEventListener('click', () => {
        if (confirm('기본 탤런트 목록으로 초기화하시겠습니까?')) {
            saveMyChannels([...DEFAULT_CHANNELS]);
            renderMyChannels();
            refreshSidebar();
            showToast('✅', '기본값으로 초기화되었습니다');
        }
    });

    // 동기화 시작 버튼
    if (startSyncBtn) {
        startSyncBtn.addEventListener('click', () => {
            const apiKey = localStorage.getItem('holodex_api_key');
            if (!apiKey) {
                showToast('❌', 'API 키가 없습니다');
                return;
            }
            modal.style.display = 'none';
            startFullSync(apiKey);
        });
    }

    // API 키 삭제 버튼 (D-07: /api/reset 호출 제거 - 보안상 DB 초기화 API 미노출)
    if (deleteApiKeyBtn) {
        deleteApiKeyBtn.addEventListener('click', async () => {
            if (confirm('API Key를 삭제하시겠습니까?\n\n(동기화된 영상 데이터는 서버에 유지됩니다)')) {
                localStorage.removeItem('holodex_api_key');
                showToast('🗑️', 'API Key가 삭제되었습니다');
                location.reload();
            }
        });
    }
}

// === 뷰 데이터 로드 ===
function loadViewData(view) {
    const state = getState();
    if (!state.currentChannelId) return;

    switch (view) {
        case 'home':
            // loadChannelInfo에서 이미 로드됨
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
        case 'stats':
            loadStats(state.currentChannelId);
            break;
    }
}

// === 페이지 변경 핸들러 ===
function handlePageChange(page, type) {
    const state = getState();

    if (type === 'archive') {
        setState({ archivePage: page });
        loadArchives(state.currentChannelId, page);
    } else {
        setState({ clipsPage: page });
        loadClips(state.currentChannelId, page);
    }

    updateUrlHash(getState());
}

// === 라이브 스트림 로드 ===
async function loadLiveStreams(channelId) {
    // 요청 중복/역전 방지
    const serial = ++requestSerials.live;

    const container = document.getElementById('live-container');
    container.innerHTML = '<div class="loading-spinner">Loading streams...</div>';

    try {
        const streams = await getLiveStreams(channelId);

        // 늦게 도착한 응답 무시
        if (serial !== requestSerials.live) return;

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
        container.innerHTML = '<p class="error-text">Failed to load streams.</p>';
    }
}
// === 아카이브/노래 탭 셋업 ===
function setupArchiveTabs() {
    const tabContainer = document.getElementById('archive-tabs');
    if (!tabContainer) return;

    tabContainer.addEventListener('click', (e) => {
        const tab = e.target.closest('.archive-tab');
        if (!tab) return;

        const type = tab.dataset.type;
        const state = getState();

        // 이미 활성 탭이면 무시
        if (state.videoType === type) return;

        // 탭 UI 업데이트
        tabContainer.querySelectorAll('.archive-tab').forEach(t => {
            t.classList.toggle('active', t === tab);
        });

        // 섹션 제목 업데이트
        const sectionHeader = document.querySelector('#archive-view .section-header h3');
        if (sectionHeader) {
            sectionHeader.innerHTML = type === 'music'
                ? '<span class="icon">🎵</span> 노래'
                : '<span class="icon">📚</span> 아카이브';
        }

        // 상태 업데이트 + 페이지 리셋 + 재로드
        setState({ videoType: type, archivePage: 1 });
        updateUrlHash(getState());
        loadArchives(state.currentChannelId, 1);
    });
}

// 아카이브 탭 UI 복원 (새로고침 시)
function restoreArchiveTabUI(type) {
    const tabContainer = document.getElementById('archive-tabs');
    if (!tabContainer) return;

    // 탭 active 상태 업데이트
    tabContainer.querySelectorAll('.archive-tab').forEach(t => {
        t.classList.toggle('active', t.dataset.type === type);
    });

    // 섹션 타이틀 업데이트
    const sectionHeader = document.querySelector('#archive-view .section-header h3');
    if (sectionHeader) {
        sectionHeader.innerHTML = type === 'music'
            ? '<span class="icon">🎵</span> 노래'
            : '<span class="icon">📚</span> 아카이브';
    }
}

// === 아카이브 로드 ===
async function loadArchives(channelId, page) {
    // 요청 중복/역전 방지
    const serial = ++requestSerials.archive;

    const container = document.getElementById('archive-container');
    container.innerHTML = '<div class="loading-spinner">Loading archives...</div>';

    try {
        const state = getState();
        const offset = (page - 1) * ITEMS_PER_PAGE;
        const channel = getChannelById(channelId);
        const channelName = channel ? (channel.englishName || channel.name) : '';

        let result = await getRecentVideos(channelId, offset, state.currentSearchQuery, channelName, state.collabFilter, state.collabMode || 'or', state.hideUnarchived || false, state.filterDates || [], state.filterYears, state.filterMonths, state.videoType || 'all');

        // 로컬 DB만 사용 - API 폴백 제거 (Holodex API 호출 최소화)

        if (!result) {
            throw new Error('API returned null response');
        }

        const videos = result.items || [];
        const totalVideos = result.total || 0;

        // 현재 페이지가 총 페이지 수를 초과하면 마지막 유효 페이지로 이동
        const maxPage = Math.max(1, Math.ceil(totalVideos / ITEMS_PER_PAGE));
        if (page > maxPage && totalVideos > 0) {
            setState({ archivePage: maxPage });
            return loadArchives(channelId, maxPage);
        }

        // 늦게 도착한 응답 무시
        if (serial !== requestSerials.archive) return;

        container.innerHTML = '';

        if (!videos || videos.length === 0) {
            if (state.isSyncing) {
                container.innerHTML = `
                    <div class="sync-status">
                        <p>⏳ 데이터를 불러오는 중입니다...</p>
                        <p class="sub-text">API에서 최신 아카이브를 가져오고 있습니다.</p>
                    </div>
                `;
            } else {
                container.innerHTML = '<p class="empty-text">검색 결과가 없습니다.</p>';
            }
            return;
        }

        videos.forEach((video, index) => {
            const card = createVideoCard(video, index);
            container.appendChild(card);
        });

        renderPagination('archive', page, totalVideos || 1000, handlePageChange);
    } catch (error) {
        if (serial !== requestSerials.archive) return;
        container.innerHTML = `<p class="error-text">Failed to load archives: ${error.message}</p>`;
    }
}

// === 클립 로드 ===
async function loadClips(channelId, page) {
    // 요청 중복/역전 방지
    const serial = ++requestSerials.clips;

    const container = document.getElementById('clips-container');
    container.innerHTML = '<p class="loading-text">Loading clips...</p>';

    try {
        const state = getState();
        const offset = (page - 1) * ITEMS_PER_PAGE;
        const channel = getChannelById(channelId);
        const channelName = channel ? (channel.englishName || channel.name) : '';

        // 언어 필터 포함하여 클립 로드
        const result = await getClips(channelId, offset, state.currentSearchQuery, channelName, state.clipLang);

        if (!result) {
            throw new Error('Failed to fetch clips');
        }

        const clips = result.items || [];
        const totalClips = result.total || 0;

        // 늦게 도착한 응답 무시
        if (serial !== requestSerials.clips) return;

        container.innerHTML = '';

        if (clips.length === 0) {
            container.innerHTML = '<p class="empty-text">클립이 없습니다.</p>';
            return;
        }

        clips.forEach((video, index) => {
            const card = createVideoCard(video, index);
            container.appendChild(card);
        });

        renderPagination('clips', page, totalClips || 500, handlePageChange);
    } catch (error) {
        if (serial !== requestSerials.clips) return;
        container.innerHTML = `<p class="error-text">Failed to load clips: ${error.message}</p>`;
    }
}

// === 차트 인스턴스 (재사용을 위해 전역 관리) ===
let yearlyChartInstance = null;
let monthlyChartInstance = null;
let yearlyMembershipChartInstance = null;
let membershipChartInstance = null;
let yearlyCollabChartInstance = null;

// === 통계 로드 ===
async function loadStats(channelId) {
    const container = document.querySelector('.stats-container');
    if (!container) return;

    // 로딩 표시
    container.innerHTML = '<div class="loading-spinner">통계 로딩 중...</div>';

    try {
        // 병렬로 데이터 로드
        const [yearlyRes, yearlyMembershipRes, collabRes, topicRes] = await Promise.all([
            window.getYearlyStats(channelId),
            window.getYearlyMembershipStats(channelId),
            window.getCollabStats(channelId),
            window.getTopicStats(channelId)
        ]);

        // 컨테이너 초기화 - 8개 섹션
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
                <h4>연도별 멤버십 한정 방송 통계</h4>
                <canvas id="yearly-membership-chart"></canvas>
            </div>
            <div class="stats-card">
                <div class="stats-card-header">
                    <h4>월별 멤버십 한정 방송 통계</h4>
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
                <h4>컨텐츠 TOP 10</h4>
                <canvas id="topic-chart"></canvas>
            </div>
            <div class="stats-card">
                <div class="stats-card-header">
                    <h4>연도별 컨텐츠 TOP 10</h4>
                    <select id="yearly-topic-year-select"></select>
                </div>
                <canvas id="yearly-topic-chart"></canvas>
            </div>
        `;

        // 년도별 차트 렌더링
        renderYearlyChart(yearlyRes.items || []);

        // 월별 연도 선택기 설정
        setupMonthlyYearSelect(channelId, yearlyRes.items || []);

        // 년도별 멤버십 차트 렌더링
        renderYearlyMembershipChart(yearlyMembershipRes.items || []);

        // 멤버십 연도 선택기 설정
        setupMembershipYearSelect(channelId, yearlyRes.items || []);

        // 콜라보 통계 렌더링
        renderCollabStats(collabRes.items || []);

        // 연도별 콜라보 선택기 설정
        setupYearlyCollabSelect(channelId, yearlyRes.items || []);

        // 컨텐츠(Topic) 통계 렌더링
        renderTopicStats(topicRes.items || []);

        // 연도별 컨텐츠 선택기 설정
        setupYearlyTopicSelect(channelId, yearlyRes.items || []);

    } catch (error) {
        console.error('Stats load error:', error);
        container.innerHTML = '<p class="error-text">통계를 불러오는데 실패했습니다.</p>';
    }
}

// === 년도별 차트 렌더링 ===
function renderYearlyChart(data) {
    const ctx = document.getElementById('yearly-chart');
    if (!ctx) return;

    // 기존 차트 파괴
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

// === 월별 방송 차트 렌더링 ===
function renderMonthlyChart(data) {
    const ctx = document.getElementById('monthly-chart');
    if (!ctx) return;

    // 기존 차트 파괴
    if (monthlyChartInstance) {
        monthlyChartInstance.destroy();
    }

    const labels = data.map(d => `${d.month}월`);
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
                padding: { top: 25 }  // 상단 라벨 여백
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
                    suggestedMax: Math.max(...values) * 1.15,  // 15% 여유
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

// === 월별 연도 선택기 설정 ===
function setupMonthlyYearSelect(channelId, yearlyData) {
    const select = document.getElementById('monthly-year-select');
    if (!select) return;

    // 연도 옵션 생성
    const years = yearlyData.map(d => d.year).filter(y => y);
    if (years.length === 0) {
        select.innerHTML = '<option>데이터 없음</option>';
        return;
    }

    select.innerHTML = years.map(y => `<option value="${y}">${y}년</option>`).join('');

    // 최신 연도 선택
    select.value = years[years.length - 1];

    // 변경 이벤트
    select.addEventListener('change', async () => {
        const year = select.value;
        const res = await window.getMonthlyStats(channelId, year);
        renderMonthlyChart(res.items || []);
    });

    // 초기 로드
    (async () => {
        const res = await window.getMonthlyStats(channelId, select.value);
        renderMonthlyChart(res.items || []);
    })();
}

// === 년도별 멤버십 차트 렌더링 ===
function renderYearlyMembershipChart(data) {
    const ctx = document.getElementById('yearly-membership-chart');
    if (!ctx) return;

    // 기존 차트 파괴
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

// === 멤버십 연도 선택기 설정 ===
function setupMembershipYearSelect(channelId, yearlyData) {
    const select = document.getElementById('membership-year-select');
    if (!select) return;

    // 연도 옵션 생성
    const years = yearlyData.map(d => d.year).filter(y => y);
    if (years.length === 0) {
        select.innerHTML = '<option>데이터 없음</option>';
        return;
    }

    select.innerHTML = years.map(y => `<option value="${y}">${y}년</option>`).join('');

    // 최신 연도 선택
    select.value = years[years.length - 1];

    // 변경 이벤트
    select.addEventListener('change', async () => {
        const year = select.value;
        const res = await window.getMembershipStats(channelId, year);
        renderMembershipChart(res.items || []);
    });

    // 초기 로드
    (async () => {
        const res = await window.getMembershipStats(channelId, select.value);
        renderMembershipChart(res.items || []);
    })();
}

// === 월별 멤버십 차트 렌더링 ===
function renderMembershipChart(data) {
    const ctx = document.getElementById('membership-chart');
    if (!ctx) return;

    // 기존 차트 파괴
    if (membershipChartInstance) {
        membershipChartInstance.destroy();
    }

    const labels = data.map(d => `${d.month}월`);
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
                padding: { top: 25 }  // 상단 라벨 여백
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
                    suggestedMax: Math.max(...values) * 1.15,  // 15% 여유
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

// === 콜라보 통계 렌더링 ===
function renderCollabStats(data) {
    const container = document.getElementById('collab-stats-container');
    if (!container) return;

    if (!data || data.length === 0) {
        container.innerHTML = '<p class="empty-text">콜라보 데이터가 없습니다.</p>';
        return;
    }

    container.innerHTML = data.map(member => {
        // 1순위: API에서 온 photo, 2순위: MEMBER_PHOTOS 폴백
        const iconUrl = member.photo || MEMBER_PHOTOS[member.id] || '';
        // 이미지가 있으면 표시, 없으면 텍스트만
        const imgHtml = iconUrl
            ? `<img src="${iconUrl}" alt="${member.name}">`
            : '';
        return `
            <div class="collab-item">
                ${imgHtml}
                <div class="collab-info">
                    <span class="collab-name">${member.name}</span>
                    <span class="collab-count">${member.count}회 콜라보</span>
                </div>
            </div>
        `;
    }).join('');
}

// === 연도별 콜라보 선택기 설정 ===
function setupYearlyCollabSelect(channelId, yearlyData) {
    const select = document.getElementById('yearly-collab-year-select');
    if (!select) return;

    // 연도 옵션 생성
    const years = yearlyData.map(d => d.year).filter(y => y);
    if (years.length === 0) {
        select.innerHTML = '<option>데이터 없음</option>';
        return;
    }

    select.innerHTML = years.map(y => `<option value="${y}">${y}년</option>`).join('');

    // 최신 연도 선택
    select.value = years[years.length - 1];

    // 변경 이벤트
    select.addEventListener('change', async () => {
        const year = select.value;
        const res = await window.getYearlyCollabStats(channelId, year);
        renderYearlyCollabStats(res.items || []);
    });

    // 초기 로드
    (async () => {
        const res = await window.getYearlyCollabStats(channelId, select.value);
        renderYearlyCollabStats(res.items || []);
    })();
}

// === 연도별 콜라보 통계 렌더링 ===
function renderYearlyCollabStats(data) {
    const container = document.getElementById('yearly-collab-stats-container');
    if (!container) return;

    if (!data || data.length === 0) {
        container.innerHTML = '<p class="empty-text">해당 연도의 콜라보 데이터가 없습니다.</p>';
        return;
    }

    container.innerHTML = data.map(member => {
        // 1순위: API에서 온 photo, 2순위: MEMBER_PHOTOS 폴백
        const iconUrl = member.photo || MEMBER_PHOTOS[member.id] || '';
        // 이미지가 있으면 표시, 없으면 텍스트만
        const imgHtml = iconUrl
            ? `<img src="${iconUrl}" alt="${member.name}">`
            : '';
        return `
            <div class="collab-item">
                ${imgHtml}
                <div class="collab-info">
                    <span class="collab-name">${member.name}</span>
                    <span class="collab-count">${member.count}회 콜라보</span>
                </div>
            </div>
        `;
    }).join('');
}

// Chart.js 인스턴스 저장용 변수
let topicChartInstance = null;
let yearlyTopicChartInstance = null;

// === 컨텐츠(Topic) 통계 렌더링 - 가로 막대그래프 ===
function renderTopicStats(data) {
    const ctx = document.getElementById('topic-chart');
    if (!ctx) return;

    // 기존 차트 파괴
    if (topicChartInstance) {
        topicChartInstance.destroy();
    }

    if (!data || data.length === 0) {
        return;
    }

    // 라벨과 값 준비 (언더스코어 → 공백)
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
            indexAxis: 'y',  // 가로 막대그래프
            responsive: true,
            maintainAspectRatio: false,
            layout: {
                padding: { right: 50 }  // 오른쪽 라벨 여백
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
                    suggestedMax: Math.max(...values) * 1.15,  // 15% 여유
                    grid: { display: false }
                },
                y: {
                    grid: { display: false }
                }
            }
        },
        plugins: [ChartDataLabels]
    });

    // 차트 높이 자동 조정
    ctx.parentElement.style.height = Math.max(300, data.length * 35) + 'px';
}

// === 연도별 컨텐츠 선택기 설정 ===
function setupYearlyTopicSelect(channelId, yearlyData) {
    const select = document.getElementById('yearly-topic-year-select');
    if (!select) return;

    // 연도 옵션 생성
    const years = yearlyData.map(d => d.year).filter(y => y);
    if (years.length === 0) {
        select.innerHTML = '<option>데이터 없음</option>';
        return;
    }

    select.innerHTML = years.map(y => `<option value="${y}">${y}년</option>`).join('');

    // 최신 연도 선택
    select.value = years[years.length - 1];

    // 변경 이벤트
    select.addEventListener('change', async () => {
        const year = select.value;
        const res = await window.getYearlyTopicStats(channelId, year);
        renderYearlyTopicStats(res.items || []);
    });

    // 초기 로드
    (async () => {
        const res = await window.getYearlyTopicStats(channelId, select.value);
        renderYearlyTopicStats(res.items || []);
    })();
}

// === 연도별 컨텐츠 통계 렌더링 - 가로 막대그래프 ===
function renderYearlyTopicStats(data) {
    const ctx = document.getElementById('yearly-topic-chart');
    if (!ctx) return;

    // 기존 차트 파괴
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
            indexAxis: 'y',  // 가로 막대그래프
            responsive: true,
            maintainAspectRatio: false,
            layout: {
                padding: { right: 50 }  // 오른쪽 라벨 여백
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
                    suggestedMax: Math.max(...values) * 1.15,  // 15% 여유
                    grid: { display: false }
                },
                y: {
                    grid: { display: false }
                }
            }
        },
        plugins: [ChartDataLabels]
    });

    // 차트 높이 자동 조정
    ctx.parentElement.style.height = Math.max(300, data.length * 35) + 'px';
}

// === 채널 정보 로드 ===
async function loadChannelInfo(channelId) {
    // 캐시 확인
    const cacheKey = `channel_info_${channelId}`;
    const cached = localStorage.getItem(cacheKey);

    if (cached) {
        const { data, expiry } = JSON.parse(cached);
        if (expiry > Date.now()) {
            renderChannelProfile(data);
            return;
        }
    }

    // 먼저 로컬 데이터로 기본 표시
    const localChannel = getChannelById(channelId);
    if (localChannel) {
        renderLocalChannelProfile(localChannel);
    }

    // API에서 로드 시도
    try {
        const info = await getChannelInfo(channelId);
        if (info) {
            // 캐시 저장
            localStorage.setItem(cacheKey, JSON.stringify({
                data: info,
                expiry: Date.now() + 24 * 60 * 60 * 1000
            }));
            renderChannelProfile(info);
        }
    } catch {
        // API 실패 시 로컬 데이터 유지 (이미 렌더링됨)
    }
}

// 로컬 채널 데이터로 기본 프로필 표시
function renderLocalChannelProfile(channel) {
    const nameEl = document.getElementById('channel-name');
    const descEl = document.getElementById('channel-desc');
    const iconEl = document.getElementById('channel-icon');
    const linkEl = document.getElementById('channel-link');
    const subCountEl = document.getElementById('sub-count');
    const videoCountEl = document.getElementById('video-count');

    if (nameEl) nameEl.textContent = channel.name;
    if (descEl) descEl.textContent = channel.englishName || '';
    if (iconEl) iconEl.src = channel.icon || '';
    if (linkEl) linkEl.href = `https://www.youtube.com/channel/${channel.id}`;
    if (subCountEl) subCountEl.textContent = '-';
    if (videoCountEl) videoCountEl.textContent = '-';
}

// API 데이터로 프로필 업데이트
function renderChannelProfile(info) {
    const nameEl = document.getElementById('channel-name');
    const descEl = document.getElementById('channel-desc');
    const iconEl = document.getElementById('channel-icon');
    const linkEl = document.getElementById('channel-link');
    const subCountEl = document.getElementById('sub-count');
    const videoCountEl = document.getElementById('video-count');

    // 로컬 채널 데이터로 아이콘 사용
    const localChannel = getChannelById(info.id);
    const icon = localChannel ? localChannel.icon : (info.photo || '');

    if (nameEl) nameEl.textContent = info.name || (localChannel ? localChannel.name : '');
    if (descEl) descEl.textContent = info.english_name || info.name || '';
    if (iconEl) iconEl.src = icon;
    if (linkEl) linkEl.href = `https://www.youtube.com/channel/${info.id}`;
    if (subCountEl) subCountEl.textContent = formatSubscriberCount(info.subscriber_count);
    if (videoCountEl) videoCountEl.textContent = info.video_count ? info.video_count.toLocaleString() : '-';
}

function formatSubscriberCount(count) {
    if (count >= 1000000) {
        return `${(count / 1000000).toFixed(1)}M`;
    }
    if (count >= 1000) {
        return `${(count / 1000).toFixed(0)}K`;
    }
    return count.toString();
}

// === 자동 새로고침 ===
function startAutoRefresh() {
    if (refreshInterval) clearInterval(refreshInterval);

    refreshInterval = setInterval(async () => {
        // 탭 비활성 시 스킵
        if (document.hidden) return;
        // 이미 실행 중이면 스킵
        if (isAutoRefreshInFlight) return;
        // 라이브 폴링 중이면 스킵 (중복 방지)
        if (isLivePollingInFlight) return;

        const state = getState();
        if (state.currentView === 'live') {
            isAutoRefreshInFlight = true;
            try {
                await loadLiveStreams(state.currentChannelId);
            } finally {
                isAutoRefreshInFlight = false;
            }
        }
    }, 60000); // 1분마다
}

// === 라이브 폴링 ===
function startLivePolling() {
    if (pollingInterval) clearInterval(pollingInterval);

    // 2분마다 전체 채널 라이브 확인
    pollingInterval = setInterval(async () => {
        // 탭 비활성 시 스킵
        if (document.hidden) return;
        // 이미 실행 중이면 스킵
        if (isLivePollingInFlight) return;

        isLivePollingInFlight = true;
        try {
            const channelIds = CHANNELS.map(c => c.id).join(',');
            const streams = await getLiveStreams(channelIds);

            if (streams && streams.length > 0) {
                streams.forEach(stream => {
                    if (stream.status === 'live' && !knownStreamIds.has(stream.id)) {
                        // 새 라이브 스트림 감지
                        knownStreamIds.add(stream.id);

                        const channelId = stream.channel ? stream.channel.id : null;
                        const channel = CHANNELS.find(c => c.id === channelId);
                        const icon = channel ? channel.icon : 'image/miko.jpg';

                        showToast("🔴 LIVE NOW!", stream.title, icon);
                    }
                });
            }
        } finally {
            isLivePollingInFlight = false;
        }
    }, 120000);
}

// === 탭 가시성 변경 핸들러 ===
function setupVisibilityHandler() {
    if (visibilityHandler) return; // 중복 방지

    visibilityHandler = () => {
        if (document.hidden) {
            // 탭 비활성 시 인터벌 정리
            if (refreshInterval) {
                clearInterval(refreshInterval);
                refreshInterval = null;
            }
            if (pollingInterval) {
                clearInterval(pollingInterval);
                pollingInterval = null;
            }
        } else {
            // 탭 활성화 시 폴링 재시작
            startAutoRefresh();
            startLivePolling();
        }
    };

    document.addEventListener('visibilitychange', visibilityHandler);
}

// === 메모리 누수 방지 ===
window.addEventListener('beforeunload', () => {
    if (refreshInterval) clearInterval(refreshInterval);
    if (syncPollInterval) clearInterval(syncPollInterval);
    if (pollingInterval) clearInterval(pollingInterval);
    if (visibilityHandler) {
        document.removeEventListener('visibilitychange', visibilityHandler);
        visibilityHandler = null;
    }
});

// === DOM Ready 시 초기화 ===
document.addEventListener('DOMContentLoaded', () => {
    try {
        init();
    } catch (e) {
        document.body.innerHTML += `<div style="color:red; padding:20px;">치명적 오류: ${e.message}</div>`;
    }
});