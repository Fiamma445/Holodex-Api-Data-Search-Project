import asyncio
import os
import unittest
from types import SimpleNamespace
from urllib.parse import parse_qs, urlparse

import server


class VideoSyncLogicTest(unittest.TestCase):
    def test_incremental_upload_sync_stops_when_page_has_no_new_videos(self):
        self.assertTrue(server.should_stop_video_sync("channel_id", False, 0))

    def test_incremental_mention_sync_stops_when_page_has_no_new_videos(self):
        self.assertTrue(server.should_stop_video_sync("mentioned_channel_id", False, 0))

    def test_full_sync_keeps_scanning_for_every_filter(self):
        self.assertFalse(server.should_stop_video_sync("channel_id", True, 0))
        self.assertFalse(server.should_stop_video_sync("mentioned_channel_id", True, 0))

    def test_video_sync_url_requests_oldest_pages_in_stable_desc_order(self):
        url = server.build_video_sync_url("mentioned_channel_id", "channel-1", 1300)
        parsed = urlparse(url)
        params = parse_qs(parsed.query)

        self.assertEqual("https", parsed.scheme)
        self.assertEqual("holodex.net", parsed.netloc)
        self.assertEqual("/api/v2/videos", parsed.path)
        self.assertEqual(["channel-1"], params["mentioned_channel_id"])
        self.assertEqual(["1300"], params["offset"])
        self.assertEqual(["available_at"], params["sort"])
        self.assertEqual(["desc"], params["order"])
        self.assertEqual(["mentions,songs"], params["include"])

    def test_live_proxy_uses_server_api_key_without_user_key(self):
        class FakeResponse:
            status_code = 200
            content = b"[]"

            def json(self):
                return []

        class FakeHttpClient:
            def __init__(self):
                self.calls = []

            async def get(self, url, headers=None):
                self.calls.append({"url": url, "headers": headers or {}})
                return FakeResponse()

        old_client = server.http_client
        old_key = os.environ.get("HOLODEX_API_KEY")
        fake_client = FakeHttpClient()
        server.http_client = fake_client
        server.cache.clear()
        os.environ["HOLODEX_API_KEY"] = "server-key"

        try:
            request = SimpleNamespace(
                method="GET",
                url=SimpleNamespace(path="/api/v2/live", query="channel_id=test-channel"),
                headers={}
            )
            response = asyncio.run(server.proxy_holodex("live", request))
        finally:
            server.http_client = old_client
            server.cache.clear()
            if old_key is None:
                os.environ.pop("HOLODEX_API_KEY", None)
            else:
                os.environ["HOLODEX_API_KEY"] = old_key

        self.assertEqual(200, response.status_code)
        self.assertEqual("server-key", fake_client.calls[0]["headers"]["X-APIKEY"])


if __name__ == "__main__":
    unittest.main()
