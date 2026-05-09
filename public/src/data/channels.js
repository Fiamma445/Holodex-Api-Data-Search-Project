/**
 * 채널 데이터 정의
 * @description 지원하는 VTuber 채널 목록 및 테마 설정
 */

import { getLocalChannelIconUrl } from './memberPhotos.js?v=20260510-1';
import { TALENT_NAMES } from './localizedNames.js?v=20260510-1';

// 채널 목록 (CHANNELS)
export const CHANNELS = [
    {
        name: "미나토 아쿠아",
        id: "UC1opHUrw8rvnsadT-iGp7Cg",
        twitter: "",
        icon: "image/aqua.jpg",
        englishName: "Minato Aqua",
        emoji: "",
        theme: {
            primary: "#ea698b",
            secondary: "#fce1e8",
            accent: "#d55d92"
        }
    },
    {
        name: "유우키 사쿠나",
        id: "UCrV1Hf5r8P148idjoSfrGEQ",
        twitter: "",
        englishName: "Yuuki Sakuna",
        icon: "image/sakuna.jpg",
        emoji: "",
        theme: {
            primary: "#ff9eb5",
            secondary: "#fff0f5",
            accent: "#ff5e89"
        }
    },
    {
        name: "우사다 페코라",
        id: "UC1DCedRgGHBdm81E1llLhOQ",
        twitter: "",
        icon: "image/pekora.jpg",
        englishName: "Usada Pekora",
        emoji: "",
        theme: {
            primary: "#89c2f5",
            secondary: "#e6f2ff",
            accent: "#4a90e2"
        }
    },
    {
        name: "사쿠라 미코",
        id: "UC-hM6YJuNYVAmUWxeIr9FeA",
        twitter: "@sakuramiko35",
        icon: "image/miko.jpg",
        englishName: "Sakura Miko",
        emoji: "",
        theme: {
            primary: "#ff9eb5",
            secondary: "#fff5f8",
            accent: "#ff5e89"
        }
    },
    {
        name: "아마네 카나타",
        id: "UCZlDXzGoo7d44bwdNObFacg",
        twitter: "",
        icon: "image/kanata.jpg",
        englishName: "Amane Kanata",
        emoji: "",
        theme: {
            primary: "#8ecae6",
            secondary: "#f0f8ff",
            accent: "#219ebc"
        }
    },
    {
        name: "시라카미 후부키",
        id: "UCdn5BQ06XqgXoAxIhbqw5Rg",
        twitter: "",
        icon: "image/fubuki.jpg",
        englishName: "Shirakami Fubuki",
        emoji: "",
        theme: {
            primary: "#69c2c6",
            secondary: "#e0f7fa",
            accent: "#00acc1"
        }
    },
    {
        name: "AZKi",
        id: "UC0TXe_LYZ4scaW2XMyi5_kw",
        twitter: "",
        icon: "image/azki.jpg",
        englishName: "AZKi",
        emoji: "",
        theme: {
            primary: "#d81159",
            secondary: "#fce4ec",
            accent: "#ad1457"
        }
    },
    {
        name: "쿠라게우 로아",
        id: "UCLIpj4TmXviSTNE_U5WG_Ug",
        twitter: "",
        icon: "image/roa.jpg",
        englishName: "Kurageu Roa",
        emoji: "",
        theme: {
            primary: "#6a4c93",
            secondary: "#ede7f6",
            accent: "#512da8"
        }
    },
    {
        name: "나키리 아야메",
        id: "UC7fk0CB07ly8oSl0aqKkqFg",
        twitter: "",
        icon: "image/nakiri.jpg",
        englishName: "Nakiri Ayame",
        emoji: "",
        theme: {
            primary: "#ff0202",
            secondary: "#ffebee",
            accent: "#ff0062"
        }
    },
    {
        name: "무라사키 시온",
        id: "UCXTpFs_3PqI41qX2d9tL2Rw",
        twitter: "",
        icon: "image/kuso.jpg",
        englishName: "Murasaki Shion",
        emoji: "",
        theme: {
            primary: "#6a4c93",
            secondary: "#e8e0f0",
            accent: "#512da8"
        }
    },
    {
        name: "호시마치 스이세이",
        id: "UC5CwaMl1eIgY8h02uZw7u8A",
        twitter: "",
        icon: "image/suisei.jpg",
        englishName: "Hoshimachi Suisei",
        emoji: "",
        theme: {
            primary: "#1900ff",
            secondary: "#e3f2fd",
            accent: "#006eff"
        }
    }
];

// 기본 채널 ID (내 채널 목록의 첫 번째, 없으면 아쿠아)
export function getDefaultChannelId() {
    const myChannels = getMyChannels();
    if (myChannels.length > 0) {
        return myChannels[0].id;
    }
    return "UC1opHUrw8rvnsadT-iGp7Cg"; // 미나토 아쿠아 (폴백)
}

// 레거시 호환용 (하드코딩)
export const DEFAULT_CHANNEL_ID = "UC1opHUrw8rvnsadT-iGp7Cg";

// 채널 ID로 채널 정보 찾기
export function getChannelById(channelId) {
    const builtInChannel = CHANNELS.find(ch => ch.id === channelId);
    if (builtInChannel) return builtInChannel;

    try {
        return getMyChannels().find(ch => ch.id === channelId) || null;
    } catch {
        return null;
    }
}

// 모든 채널 ID 배열
export function getAllChannelIds() {
    return CHANNELS.map(ch => ch.id);
}

// === 탤런트 커스텀 기능 ===

// localStorage 키
const MY_CHANNELS_KEY = 'my_channels';
const ALLOWED_CHANNEL_IDS = new Set(
    Object.keys(TALENT_NAMES).map(id => id.replaceAll('-', '_'))
);

function normalizeChannelId(channelId) {
    return String(channelId || '').replaceAll('-', '_');
}

// 기본 채널 목록 (초기값)
export const DEFAULT_CHANNELS = CHANNELS.slice(0, 10).map(ch => ({
    id: ch.id,
    name: ch.name,
    englishName: ch.englishName,
    icon: getLocalChannelIconUrl(ch.id) || ch.icon,
    emoji: ch.emoji,
    theme: ch.theme,
    isDefault: true  // 기본 채널 표시
}));

// 내 채널 목록 가져오기
export function getMyChannels() {
    try {
        const saved = localStorage.getItem(MY_CHANNELS_KEY);
        if (saved) {
            const parsed = JSON.parse(saved);
            // 유효성 검사 후 반환
            if (Array.isArray(parsed) && parsed.length > 0) {
                return parsed;
            }
        }
    } catch (e) {
        console.error('채널 목록 로드 실패:', e);
    }
    // 기본값 반환
    return [...DEFAULT_CHANNELS];
}

// 내 채널 목록 저장
export function saveMyChannels(channels) {
    try {
        localStorage.setItem(MY_CHANNELS_KEY, JSON.stringify(channels));
        return true;
    } catch (e) {
        console.error('채널 목록 저장 실패:', e);
        return false;
    }
}

// 채널 추가
export function addChannel(channel) {
    const current = getMyChannels();

    if (!isAllowedChannel(channel)) {
        return { success: false, message: '허용되지 않은 채널입니다' };
    }

    // 이미 있는지 확인
    if (current.some(ch => ch.id === channel.id)) {
        return { success: false, message: '이미 추가된 채널입니다' };
    }

    // 채널 정보 정규화 (Holodex API의 photo → icon으로 변환)
    const normalizedChannel = {
        id: channel.id,
        name: channel.name || channel.english_name,
        englishName: channel.english_name || channel.englishName,
        icon: getLocalChannelIconUrl(channel.id) || channel.icon || channel.photo || '',
        org: channel.org,
        isDefault: false
    };

    const newChannels = [...current, normalizedChannel];
    saveMyChannels(newChannels);
    return { success: true, message: '채널이 추가되었습니다' };
}

// 채널 삭제
export function removeChannel(channelId) {
    const current = getMyChannels();
    const filtered = current.filter(ch => ch.id !== channelId);

    // 최소 1개는 유지
    if (filtered.length === 0) {
        return { success: false, message: '최소 1개 채널은 유지해야 합니다' };
    }

    saveMyChannels(filtered);
    return { success: true, message: '채널이 삭제되었습니다' };
}

// 채널이 우리가 관리하는 탤런트인지 확인
export function isAllowedChannel(channel) {
    return ALLOWED_CHANNEL_IDS.has(normalizeChannelId(channel?.id));
}

// 내 채널 ID 배열만 가져오기
export function getMyChannelIds() {
    return getMyChannels().map(ch => ch.id);
}
