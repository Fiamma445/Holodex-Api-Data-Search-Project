import { getLocale } from './i18n.js?v=20260510-1';

const DEFAULT_LOCALE = 'ko';

const TALENT_NAMES = Object.freeze({
    UCp6993wxpyDPHUpavwDFqgg: { ko: '토키노 소라', ja: 'ときのそら', en: 'Tokino Sora' },
    UCDqI2jOz0weumE8s7paEk6g: { ko: '로보코 씨', ja: 'ロボ子さん', en: 'Robocosan' },
    'UC-hM6YJuNYVAmUWxeIr9FeA': { ko: '사쿠라 미코', ja: 'さくらみこ', en: 'Sakura Miko' },
    UC5CwaMl1eIgY8h02uZw7u8A: { ko: '호시마치 스이세이', ja: '星街すいせい', en: 'Hoshimachi Suisei' },
    UC0TXe_LYZ4scaW2XMyi5_kw: { ko: 'AZKi', ja: 'AZKi', en: 'AZKi' },
    UCdn5BQ06XqgXoAxIhbqw5Rg: { ko: '시라카미 후부키', ja: '白上フブキ', en: 'Shirakami Fubuki' },
    UCQ0UDLQCjY0rmuxCDE38FGg: { ko: '나츠이로 마츠리', ja: '夏色まつり', en: 'Natsuiro Matsuri' },
    UCFTLzh12_nrtzqBPsTCqenA: { ko: '아키 로젠탈', ja: 'アキ・ローゼンタール', en: 'Aki Rosenthal' },
    UC1CfXB_kRs3C_zaeTG3oGyg: { ko: '아카이 하아토', ja: '赤井はあと', en: 'Akai Haato' },
    UC1opHUrw8rvnsadT_iGp7Cg: { ko: '미나토 아쿠아', ja: '湊あくあ', en: 'Minato Aqua' },
    UCXTpFs_3PqI41qX2d9tL2Rw: { ko: '무라사키 시온', ja: '紫咲シオン', en: 'Murasaki Shion' },
    UC7fk0CB07ly8oSl0aqKkqFg: { ko: '나키리 아야메', ja: '百鬼あやめ', en: 'Nakiri Ayame' },
    UC1suqwovbL1kzsoaZgFZLKg: { ko: '유즈키 초코', ja: '癒月ちょこ', en: 'Yuzuki Choco' },
    UCvzGlP9oQwU__Y0r9id_jnA: { ko: '오오조라 스바루', ja: '大空スバル', en: 'Oozora Subaru' },
    UCp_5t9SrOQwXMU7iIjQfARg: { ko: '오오카미 미오', ja: '大神ミオ', en: 'Ookami Mio' },
    UCvaTdHTWBGv3MKj3KVqJVCw: { ko: '네코마타 오카유', ja: '猫又おかゆ', en: 'Nekomata Okayu' },
    UChAnqc_AY5_I3Px5dig3X1Q: { ko: '이누가미 코로네', ja: '戌神ころね', en: 'Inugami Korone' },
    UC1DCedRgGHBdm81E1llLhOQ: { ko: '우사다 페코라', ja: '兎田ぺこら', en: 'Usada Pekora' },
    UCvInZx9h3jC2JzsIzoOebWg: { ko: '시라누이 후레아', ja: '不知火フレア', en: 'Shiranui Flare' },
    UCdyqAaZDKHXg4Ahi7VENThQ: { ko: '시로가네 노엘', ja: '白銀ノエル', en: 'Shirogane Noel' },
    UCCzUftO8KOVkV4wQG1vkUvg: { ko: '호쇼 마린', ja: '宝鐘マリン', en: 'Houshou Marine' },
    UCZlDXzGoo7d44bwdNObFacg: { ko: '아마네 카나타', ja: '天音かなた', en: 'Amane Kanata' },
    UCqm3BQLlJfvkTsX_hvm0UmA: { ko: '츠노마키 와타메', ja: '角巻わため', en: 'Tsunomaki Watame' },
    UC1uv2Oq6kNxgATlCiez59hw: { ko: '토코야미 토와', ja: '常闇トワ', en: 'Tokoyami Towa' },
    UCa9Y57gfeY0Zro_noHRVrnw: { ko: '히메모리 루나', ja: '姫森ルーナ', en: 'Himemori Luna' },
    UCS9uQI_jC3DE0L4IpXyvr6w: { ko: '키류 코코', ja: '桐生ココ', en: 'Kiryu Coco' },
    UCFKOVgVbGmX65RxO3EtH3iw: { ko: '유키하나 라미', ja: '雪花ラミィ', en: 'Yukihana Lamy' },
    UCAWSyEs_Io8MtpY3m_zqILA: { ko: '모모스즈 네네', ja: '桃鈴ねね', en: 'Momosuzu Nene' },
    UCUKD_uaobj9jiqB_VXt71mA: { ko: '시시로 보탄', ja: '獅白ぼたん', en: 'Shishiro Botan' },
    UCK9V2B22uJYu3N7eR_BT9QA: { ko: '오마루 폴카', ja: '尾丸ポルカ', en: 'Omaru Polka' },
    UCENwRMx5Yh42zWpzURebzTw: { ko: '라플라스 다크니스', ja: 'ラプラス・ダークネス', en: 'La+ Darknesss' },
    UC6eWCld0KwmyHFbAqK3V_Rw: { ko: '하쿠이 코요리', ja: '博衣こより', en: 'Hakui Koyori' },
    UCs9_O1tRPMQTHQ_N_L6FU2g: { ko: '타카네 루이', ja: '鷹嶺ルイ', en: 'Takane Lui' },
    UCIBY1ollUsauvVi4hW4cumw: { ko: '사카마타 클로에', ja: '沙花叉クロヱ', en: 'Sakamata Chloe' },
    UC_vMYWcDjmfdpH6r4TTn1MQ: { ko: '카자마 이로하', ja: '風真いろは', en: 'Kazama Iroha' },
    UCWQtYtq9EOB4_I5P_3fh8lA: { ko: '오토노세 카나데', ja: '音乃瀬奏', en: 'Otonose Kanade' },
    UCtyWhCj3AqKh2dXctLkDtng: { ko: '이치조 리리카', ja: '一条莉々華', en: 'Ichijou Ririka' },
    UCdXAk5MpyLD8594lm_OvtGQ: { ko: '주후테이 라덴', ja: '儒烏風亭らでん', en: 'Juufuutei Raden' },
    UC1iA6_NT4mtAcIII6ygrvCw: { ko: '토도로키 하지메', ja: '轟はじめ', en: 'Todoroki Hajime' },
    UCMGfV7TVTmHhEErVJg1oHBQ: { ko: '히오도시 아오', ja: '火威青', en: 'Hiodoshi Ao' },
    UC9LSiN9hXI55svYEBrrK_tw: { ko: '이사키 리오나', ja: '響咲リオナ', en: 'Isaki Riona' },
    UCuI_opAVX6qbxZY_a_AxFuQ: { ko: '코가네이 니코', ja: '虎金妃笑虎', en: 'Koganei Niko' },
    UCjk2nKmHzgH5Xy_C5qYRd5A: { ko: '미즈미야 스우', ja: '水宮枢', en: 'Mizumiya Su' },
    UCKMWFR6lAstLa7Vbf5dH7ig: { ko: '린도 치하야', ja: '輪堂千速', en: 'Rindo Chihaya' },
    UCGzTVXqMQHa4AgJVJIVvtDQ: { ko: '키키라라 비비', ja: '綺々羅々ヴィヴィ', en: 'Kikirara Vivi' },
    UCL_qhgtOy0dy1Agp8vkySQg: { ko: '모리 칼리오페', ja: '森カリオペ', en: 'Mori Calliope' },
    UCHsx4Hqa_1ORjQTh9TYDhww: { ko: '타카나시 키아라', ja: '小鳥遊キアラ', en: 'Takanashi Kiara' },
    UCMwGHR0BTZuLsmjY_NT5Pwg: { ko: '니노마에 이나니스', ja: '一伊那尓栖', en: "Ninomae Ina'nis" },
    UCoSrY_IQQVpmIRZ9Xf_y93g: { ko: '가우르 구라', ja: 'がうる・ぐら', en: 'Gawr Gura' },
    UCyl1z3jo3XHR1riLFKG5UAg: { ko: '왓슨 아멜리아', ja: 'ワトソン・アメリア', en: 'Watson Amelia' },
    UC8rcEBzJSleTkf__agPM20g: { ko: '아이리스', ja: 'IRyS', en: 'IRyS' },
    UCO_aKKYxn4tvrqPjcTzZ6EQ: { ko: '세레스 파우나', ja: 'セレス・ファウナ', en: 'Ceres Fauna' },
    UCmbs8T6MWqUHP1tIQvSgKrg: { ko: '오로 크로니', ja: 'オーロ・クロニー', en: 'Ouro Kronii' },
    UC3n5uGu18FoCy23ggWWp8tA: { ko: '나나시 무메이', ja: '七詩ムメイ', en: 'Nanashi Mumei' },
    UCgmPnx_EEeOrZSg5Tiw7ZRQ: { ko: '하코스 벨즈', ja: 'ハコス・ベールズ', en: 'Hakos Baelz' },
    UCgnfPPb9JI3e9A4cXHnWbyg: { ko: '시오리 노벨라', ja: 'シオリ・ノヴェラ', en: 'Shiori Novella' },
    UC9p_lqQ0FEDz327Vgf5JwqA: { ko: '코세키 비쥬', ja: '古石ビジュー', en: 'Koseki Bijou' },
    UC_sFNM0z0MWm9A6WlKPuMMg: { ko: '네리사 레이븐크로프트', ja: 'ネリッサ・レイヴンクロフト', en: 'Nerissa Ravencroft' },
    UCt9H_RpQzhxzlyBxFqrdHqA: { ko: '후와모코', ja: 'フワモコ', en: 'FUWAMOCO' },
    UCW5uhrG1eCBYditmhL0Ykjw: { ko: '엘리자베스 로즈 블러드플레임', ja: 'エリザベス・ローズ・ブラッドフレイム', en: 'Elizabeth Rose Bloodflame' },
    UCl69AEx4MdqMZH7Jtsm7Tig: { ko: '라오라 판테라', ja: 'ラオーラ・パンテーラ', en: 'Raora Panthera' },
    UCDHABijvPBnJm7F_KlNME3w: { ko: '지지 무린', ja: 'ジジ・ムリン', en: 'Gigi Murin' },
    UCvN5h1ShZtc7nly3pezRayg: { ko: '세실리아 이머그린', ja: 'セシリア・イマーグリーン', en: 'Cecilia Immergreen' },
    UCOyYb1c43VlX9rc_lT6NKQw: { ko: '아윤다 리스', ja: 'アユンダ・リス', en: 'Ayunda Risu' },
    UCP0BspO_AMEe3aQqqpo89Dg: { ko: '무나 호시노바', ja: 'ムーナ・ホシノヴァ', en: 'Moona Hoshinova' },
    UCAoy6rzhSf4ydcYjJw3WoVg: { ko: '아이러니 이오피프틴', ja: 'アイラニ・イオフィフティーン', en: 'Airani Iofifteen' },
    UCYz_5n_uDuChHtLo7My1HnQ: { ko: '쿠레이지 올리', ja: 'クレイジー・オリー', en: 'Kureiji Ollie' },
    UC727SQYUvx5pDDGQpTICNWg: { ko: '아냐 멜피사', ja: 'アーニャ・メルフィッサ', en: 'Anya Melfissa' },
    UChgTyjG_pdNvxxhdsXfHQ5Q: { ko: '파볼리아 레이네', ja: 'パヴォリア・レイネ', en: 'Pavolia Reine' },
    UCTvHWSfBZgtxE4sILOaurIQ: { ko: '베스티아 제타', ja: 'ベスティア・ゼータ', en: 'Vestia Zeta' },
    UCZLZ8Jjx_RN2CXloOmgTHVg: { ko: '카엘라 코발스키아', ja: 'カエラ・コヴァルスキア', en: 'Kaela Kovalskia' },
    UCjLEmnpCNeisMxy134KPwWw: { ko: '코보 카나에루', ja: 'こぼ・かなえる', en: 'Kobo Kanaeru' },
    UCl_gCybOJRIgOXw6Qb4qJzQ: { ko: '우루하 루시아', ja: '潤羽るしあ', en: 'Uruha Rushia' },
    UCD8HOxPs4Xvsm8H0ZxXGiBw: { ko: '요조라 멜', ja: '夜空メル', en: 'Yozora Mel' },
    UCrV1Hf5r8P148idjoSfrGEQ: { ko: '유우키 사쿠나', ja: '結城さくな', en: 'Yuuki Sakuna' },
    UCLIpj4TmXviSTNE_U5WG_Ug: { ko: '쿠라게우 로아', ja: '海月雲ろあ', en: 'Kurageu Roa' },
    UCt30jJgChL8qeT9VPadidSw: { ko: '시구레 우이', ja: 'しぐれうい', en: 'Shigure Ui' },
    UClS3cnIUM9yzsBPQzeyX_8Q: { ko: '아마가이 루카', ja: '雨海ルカ', en: 'Amagai Ruka' }
});

const GENERATION_NAMES = Object.freeze({
    gen0: { ko: '0기생', ja: '0期生', en: 'Gen 0' },
    gen1: { ko: '1기생', ja: '1期生', en: 'Gen 1' },
    gen2: { ko: '2기생', ja: '2期生', en: 'Gen 2' },
    gamers: { ko: '게이머즈', ja: 'ゲーマーズ', en: 'Gamers' },
    gen3: { ko: '3기생', ja: '3期生', en: 'Gen 3' },
    gen4: { ko: '4기생', ja: '4期生', en: 'Gen 4' },
    gen5: { ko: '5기생', ja: '5期生', en: 'Gen 5' },
    holox: { ko: 'holoX', ja: 'holoX', en: 'holoX' },
    regloss: { ko: 'ReGLOSS', ja: 'ReGLOSS', en: 'ReGLOSS' },
    flowglow: { ko: 'FLOW GLOW', ja: 'FLOW GLOW', en: 'FLOW GLOW' },
    myth: { ko: 'EN Myth', ja: 'EN Myth', en: 'EN Myth' },
    promise: { ko: 'EN Promise', ja: 'EN Promise', en: 'EN Promise' },
    advent: { ko: 'EN Advent', ja: 'EN Advent', en: 'EN Advent' },
    justice: { ko: 'EN Justice', ja: 'EN Justice', en: 'EN Justice' },
    id1: { ko: 'ID 1기생', ja: 'ID 1期生', en: 'ID Gen 1' },
    id2: { ko: 'ID 2기생', ja: 'ID 2期生', en: 'ID Gen 2' },
    id3: { ko: 'ID 3기생', ja: 'ID 3期生', en: 'ID Gen 3' },
    'db-index': { ko: 'DB 채널', ja: 'DB チャンネル', en: 'DB Channels' },
    terminated: { ko: '계약해지', ja: '卒業・契約終了', en: 'Alumni' }
});

const normalizeId = value => String(value || '').replaceAll('-', '_');

const TALENT_NAMES_BY_ID = Object.freeze(
    Object.fromEntries(
        Object.entries(TALENT_NAMES).map(([id, names]) => [normalizeId(id), names])
    )
);

const TALENT_ALIASES = Object.freeze(
    Object.entries(TALENT_NAMES).reduce((aliases, [id, names]) => {
        Object.values(names).forEach(name => {
            aliases[name.toLowerCase()] = id;
        });
        return aliases;
    }, {})
);

function getNamesById(id) {
    if (!id) return null;
    return TALENT_NAMES[id] || TALENT_NAMES_BY_ID[normalizeId(id)] || null;
}

function resolveNames(target) {
    if (!target) return null;
    if (typeof target === 'string') {
        return getNamesById(target) || getNamesById(TALENT_ALIASES[target.toLowerCase()]);
    }

    return getNamesById(target.id || target.channel_id || target.channelId || target.mention_id)
        || target.localizedNames
        || null;
}

function fallbackName(target) {
    if (!target) return '';
    if (typeof target === 'string') return target;
    return target.name || target.englishName || target.english_name || target.originalName || target.id || '';
}

function pickLocalizedName(names, locale) {
    if (!names) return '';
    return names[locale] || names[DEFAULT_LOCALE] || names.en || '';
}

export function getLocalizedTalentName(target, locale = getLocale()) {
    return pickLocalizedName(resolveNames(target), locale) || fallbackName(target);
}

export function getLocalizedGenerationName(id, fallback = '', locale = getLocale()) {
    return pickLocalizedName(GENERATION_NAMES[id], locale) || fallback || id;
}

export { TALENT_NAMES };
