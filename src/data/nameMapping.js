/**
 * 채널 이름 매핑 (다국어 지원)
 * @description 영문 이름 → 한글/일본어 이름 매핑
 */

// 영문 이름 → 한글 이름 매핑
export const EN_TO_KR_NAME_MAP = {
    // === 0기생 ===
    'Tokino Sora': '토키노 소라',
    'Roboco': '로보코 씨',
    'Sakura Miko': '사쿠라 미코',
    'Hoshimachi Suisei': '호시마치 스이세이',
    'AZKi': 'AZKi',

    // === 1기생 ===
    'Shirakami Fubuki': '시라카미 후부키',
    'Natsuiro Matsuri': '나츠이로 마츠리',
    'Aki Rosenthal': '아키 로젠탈',
    'Akai Haato': '아카이 하아토',

    // === 2기생 ===
    'Minato Aqua': '미나토 아쿠아',
    'Murasaki Shion': '무라사키 시온',
    'Nakiri Ayame': '나키리 아야메',
    'Yuzuki Choco': '유즈키 초코',
    'Oozora Subaru': '오오조라 스바루',

    // === 게이머즈 ===
    'Shirakami Fubuki': '시라카미 후부키',
    'Ookami Mio': '오오카미 미오',
    'Nekomata Okayu': '네코마타 오카유',
    'Inugami Korone': '이누가미 코로네',

    // === 3기생 (홀로 판타지) ===
    'Usada Pekora': '우사다 페코라',
    'Shiranui Flare': '시라누이 후레아',
    'Shirogane Noel': '시로가네 노엘',
    'Houshou Marine': '호쇼 마린',

    // === 4기생 ===
    'Amane Kanata': '아마네 카나타',
    'Kiryu Coco': '키류 코코',
    'Tsunomaki Watame': '츠노마키 와타메',
    'Tokoyami Towa': '토코야미 토와',
    'Himemori Luna': '히메모리 루나',

    // === 5기생 (홀로 파이브) ===
    'Yukihana Lamy': '유키하나 라미',
    'Momosuzu Nene': '모모스즈 네네',
    'Shishiro Botan': '시시로 보탄',
    'Omaru Polka': '오마루 폴카',

    // === 비밀결사 holoX ===
    'La+ Darknesss': '라프라스 다크네스',
    'Laplus Darknesss': '라프라스 다크네스',
    'Takane Lui': '타카네 루이',
    'Hakui Koyori': '하쿠이 코요리',
    'Sakamata Chloe': '사카마타 클로에',
    'Kazama Iroha': '카자마 이로하',

    // === ReGLOSS (DEV_IS 1기) ===
    'Otonose Kanade': '오토노세 카나데',
    'Ichijou Ririka': '이치죠 리리카',
    'Juufuutei Raden': '주우후테이 라덴',
    'Todoroki Hajime': '토도로키 하지메',
    'Hiodoshi Ao': '히오도시 아오',

    // === FLOW GLOW (DEV_IS 2기) ===
    'Isaki Riona': '이사키 리오나',
    'Koganei Niko': '코가네이 니코',
    'Mizumiya Su': '미즈미야 스우',
    'Rindo Chihaya': '린도 치하야',
    'Kikirara Vivi': '키키라라 비비',

    // === 개인세 ===
    'Shigure Ui': '시구레 우이',
    'Amagai Ruka': '아마가이 루카',
    'Yuuki Sakuna': '유우키 사쿠나',
    'Kurageu Roa': '쿠라게우 로아',

    // === 계약해지 ===
    'Yozora Mel': '요조라 멜',
    'Uruha Rushia': '우루하 루시아',

    // === hololive EN ===
    // Myth
    'Mori Calliope': '모리 칼리오페',
    'Takanashi Kiara': '타카나시 키아라',
    'Ninomae Ina\'nis': '니노마에 이나니스',
    'Gawr Gura': '가우르 구라',
    'Watson Amelia': '왓슨 아멜리아',
    // Council/Promise
    'IRyS': 'IRyS',
    'Ceres Fauna': '세레스 파우나',
    'Ouro Kronii': '오로 크로니',
    'Nanashi Mumei': '나나시 무메이',
    'Hakos Baelz': '하코스 벨즈',
    // Advent
    'Shiori Novella': '시오리 노벨라',
    'Koseki Bijou': '코세키 비쥬',
    'Nerissa Ravencroft': '네리사 레이븐크로프트',
    'FUWAMOCO': '후와와 & 모코코 어비스가드',
    'Fuwawa & Mococo Abyssgard': '후와와 & 모코코 어비스가드',
    // Justice
    'Elizabeth Rose Bloodflame': '엘리자베스 로즈 블러드프레임',
    'Gigi Murin': '지지 무린',
    'Cecilia Immergreen': '세실리아 이머그린',
    'Raora Panthera': '라오라 판테라',

    // === hololive ID ===
    // Gen 1
    'Ayunda Risu': '아윤다 리스',
    'Moona Hoshinova': '무나 호시노바',
    'Airani Iofifteen': '아이라니 이오피프틴',
    // Gen 2
    'Kureiji Ollie': '쿠레이지 올리',
    'Anya Melfissa': '아냐 멜피사',
    'Pavolia Reine': '파볼리아 레이네',
    // Gen 3
    'Vestia Zeta': '베스티아 제타',
    'Kaela Kovalskia': '카엘라 코발스키아',
    'Kobo Kanaeru': '코보 카나에루'
};

// 한글 → 영문 역매핑 (검색용)
export const KR_TO_EN_NAME_MAP = {
    // === 0기생 ===
    '소라': 'sora',
    '로보코': 'roboco',
    '미코': 'miko',
    '스이세이': 'suisei',
    '아즈키': 'azki',

    // === 1기생 ===
    '멜': 'mel',
    '후부키': 'fubuki',
    '마츠리': 'matsuri',
    '아키로제': 'aki',
    '하아토': 'haato',

    // === 2기생 ===
    '아쿠아': 'aqua',
    '시온': 'shion',
    '아야메': 'ayame',
    '초코': 'choco',
    '스바루': 'subaru',

    // === 게이머즈 ===
    '오카유': 'okayu',
    '코로네': 'korone',
    '미오': 'mio',

    // === 3기생 ===
    '페코라': 'pekora',
    '후레아': 'flare',
    '노엘': 'noel',
    '마린': 'marine',

    // === 4기생 ===
    '카나타': 'kanata',
    '와타메': 'watame',
    '토와': 'towa',
    '루나': 'luna',
    '코코': 'coco',

    // === 5기생 ===
    '라미': 'lamy',
    '네네': 'nene',
    '보탄': 'botan',
    '폴카': 'polka',

    // === holoX ===
    '라플라스': 'laplus',
    '코요리': 'koyori',
    '루이': 'lui',
    '클로에': 'chloe',
    '이로하': 'iroha',

    // === ReGLOSS ===
    '카나데': 'kanade',
    '리리카': 'ririka',
    '라덴': 'raden',
    '하지메': 'hajime',
    '아오': 'ao',

    // === FLOW GLOW ===
    '리오나': 'riona',
    '니코': 'niko',
    '스우': 'su',
    '치하야': 'chihaya',
    '비비': 'vivi',

    // === 개인세 ===
    '사쿠나': 'sakuna',
    '로아': 'roa',
    '우이': 'Shigure Ui',
    '루카': 'ruka',

    // === 계약해지 ===
    '루시아': 'rushia',

    // === hololive EN ===
    '칼리오페': 'calliope',
    '키아라': 'kiara',
    '이나니스': 'ina',
    '구라': 'gura',
    '아멜리아': 'amelia',
    '아이리스': 'irys',
    '파우나': 'fauna',
    '크로니': 'kronii',
    '무메이': 'mumei',
    '벨즈': 'baelz',
    '베일즈': 'baelz',
    '노벨라': 'novella',
    '비쥬': 'bijou',
    '레이븐크로프트': 'nerissa',
    '후와모코': 'fuwamoco',
    '후와와': 'fuwamoco',
    '모코코': 'fuwamoco',
    '후와와 & 모코코': 'fuwamoco',
    '엘리자베스': 'elizabeth',
    '지지': 'gigi',
    '세실리아': 'cecilia',
    '라오라': 'raora',

    // === hololive ID ===
    '리스': 'risu',
    '무나': 'moona',
    '이오피': 'iofi',
    '올리': 'ollie',
    '아냐': 'anya',
    '레이네': 'reine',
    '제타': 'zeta',
    '카엘라': 'kaela',
    '코보': 'kobo'
};

/**
 * 영문 이름을 한글로 변환
 * @param {string} englishName - 영문 이름
 * @returns {string} - 한글 이름 (없으면 원본 반환)
 */
export function toKoreanName(englishName) {
    return EN_TO_KR_NAME_MAP[englishName] || englishName;
}

/**
 * 한글 검색어를 영문으로 변환
 * @param {string} koreanQuery - 한글 검색어
 * @returns {string} - 영문 검색어 (없으면 원본 반환)
 */
export function toEnglishQuery(koreanQuery) {
    return KR_TO_EN_NAME_MAP[koreanQuery] || koreanQuery;
}

// window 전역 노출 (api.js에서 사용)
if (typeof window !== 'undefined') {
    window.EN_TO_KR_NAME_MAP = EN_TO_KR_NAME_MAP;
    window.KR_TO_EN_NAME_MAP = KR_TO_EN_NAME_MAP;
    window.toKoreanName = toKoreanName;
    window.toEnglishQuery = toEnglishQuery;
}
