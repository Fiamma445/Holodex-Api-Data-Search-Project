from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parent


class ClipLanguageQueryTest(unittest.TestCase):
    def test_clip_list_language_filter_uses_comma_separated_query_param(self):
        api_js = (ROOT / "public" / "api.js").read_text(encoding="utf-8")

        self.assertIn("function buildClipLangParam(value)", api_js)
        self.assertIn("params.lang = langParam;", api_js)

    def test_clip_search_language_filter_keeps_holodex_array_body(self):
        api_js = (ROOT / "public" / "api.js").read_text(encoding="utf-8")

        self.assertIn("body.lang = langs;", api_js)


if __name__ == "__main__":
    unittest.main()
