from pathlib import Path
import unittest


ROOT = Path(__file__).parent


class TalentSettingsCopyTest(unittest.TestCase):
    def test_public_settings_modal_has_no_manual_sync_button(self):
        html = (ROOT / "public" / "index.html").read_text(encoding="utf-8")

        self.assertNotIn('id="start-sync-btn"', html)
        self.assertNotIn("탤런트 변경 후 동기화해야 검색/통계에 반영됩니다", html)
        self.assertIn("탤런트 목록 변경은 바로 화면에 반영됩니다", html)

    def test_i18n_copy_matches_server_auto_refresh_flow(self):
        i18n = (ROOT / "public" / "src" / "data" / "i18n.js").read_text(encoding="utf-8")

        self.assertNotIn("Sync after changing talents to update search and stats", i18n)
        self.assertIn("New data refreshes periodically on the server", i18n)
        self.assertIn("새 데이터는 서버에서 주기적으로 자동 갱신됩니다", i18n)

    def test_api_key_modal_copy_is_only_for_clip_search(self):
        html = (ROOT / "public" / "index.html").read_text(encoding="utf-8")
        i18n = (ROOT / "public" / "src" / "data" / "i18n.js").read_text(encoding="utf-8")

        self.assertNotIn("키리누키/동기화", html)
        self.assertIn("키리누키 검색을 사용하려면 API 키가 필요합니다", html)
        self.assertIn("An API key is required for clip search", i18n)


if __name__ == "__main__":
    unittest.main()
