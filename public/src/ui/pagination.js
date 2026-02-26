/**
 * 페이지네이션 컴포넌트
 * @description 아카이브/클립 목록 페이지네이션
 */

import { getState, setState } from '../state/appState.js';
import { updateUrlHash } from '../state/urlHash.js';

// 페이지당 아이템 수
const ITEMS_PER_PAGE = 32;

/**
 * 페이지네이션 렌더링
 * @param {string} type - 타입 ('archive' 또는 'clips')
 * @param {number} currentPage - 현재 페이지
 * @param {number} totalItems - 전체 아이템 수
 * @param {Function} onPageChange - 페이지 변경 콜백 (page, type) => void
 */
export function renderPagination(type, currentPage, totalItems, onPageChange) {
    const containerId = `${type}-pagination`;
    const container = document.getElementById(containerId);
    if (!container) return;

    container.innerHTML = '';
    const totalPages = Math.ceil(totalItems / ITEMS_PER_PAGE);

    if (totalPages <= 1) return;

    // 버튼 생성 헬퍼
    const createButton = (page, text, isActive = false, isDisabled = false) => {
        const btn = document.createElement('button');
        btn.textContent = text;
        btn.className = `page-btn ${isActive ? 'active' : ''}`;
        btn.disabled = isDisabled;

        if (!isDisabled) {
            btn.onclick = () => {
                onPageChange(page, type);
                // 뷰 상단으로 스크롤
                const view = document.getElementById(`${type}-view`);
                if (view) {
                    view.scrollIntoView({ behavior: 'smooth' });
                }
            };
        }
        return btn;
    };

    // 이전 버튼
    container.appendChild(createButton(currentPage - 1, '<', false, currentPage === 1));

    // 페이지 번호 버튼 로직 (최대 10개 표시, 스마트 센터링)
    const maxVisible = 10;
    let startPage, endPage;

    if (totalPages <= maxVisible) {
        startPage = 1;
        endPage = totalPages;
    } else {
        const half = Math.floor(maxVisible / 2);
        startPage = currentPage - half;
        endPage = currentPage + half - 1;

        if (startPage < 1) {
            startPage = 1;
            endPage = maxVisible;
        } else if (endPage > totalPages) {
            endPage = totalPages;
            startPage = totalPages - maxVisible + 1;
        }
    }

    // 첫 페이지 + 생략 부호
    if (startPage > 1) {
        container.appendChild(createButton(1, '1'));
        if (startPage > 2) {
            const ellipsis = document.createElement('span');
            ellipsis.textContent = '...';
            ellipsis.className = 'pagination-ellipsis';
            container.appendChild(ellipsis);
        }
    }

    // 범위 버튼
    for (let i = startPage; i <= endPage; i++) {
        container.appendChild(createButton(i, String(i), i === currentPage));
    }

    // 마지막 페이지 + 생략 부호
    if (endPage < totalPages) {
        if (endPage < totalPages - 1) {
            const ellipsis = document.createElement('span');
            ellipsis.textContent = '...';
            ellipsis.className = 'pagination-ellipsis';
            container.appendChild(ellipsis);
        }
        container.appendChild(createButton(totalPages, String(totalPages)));
    }

    // 다음 버튼
    container.appendChild(createButton(currentPage + 1, '>', false, currentPage === totalPages));

    // 직접 입력
    const inputGroup = document.createElement('div');
    inputGroup.className = 'pagination-input-group';

    const input = document.createElement('input');
    input.type = 'number';
    input.min = 1;
    input.max = totalPages;
    input.placeholder = 'Page';
    input.className = 'page-input';

    const goBtn = document.createElement('button');
    goBtn.textContent = '이동';
    goBtn.className = 'page-go-btn';

    goBtn.onclick = () => {
        const page = parseInt(input.value);
        if (page >= 1 && page <= totalPages) {
            onPageChange(page, type);
            const view = document.getElementById(`${type}-view`);
            if (view) {
                view.scrollIntoView({ behavior: 'smooth' });
            }
        } else {
            alert(`1에서 ${totalPages} 사이의 페이지를 입력해주세요.`);
        }
    };

    // Enter 키 지원
    input.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') goBtn.click();
    });

    inputGroup.appendChild(input);
    inputGroup.appendChild(goBtn);
    container.appendChild(inputGroup);
}

export { ITEMS_PER_PAGE };
