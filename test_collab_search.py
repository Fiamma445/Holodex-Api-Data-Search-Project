import os
import tempfile
import unittest

import database


def video(video_id, channel_id, mentions=None):
    return {
        "id": video_id,
        "title": video_id,
        "channel": {"id": channel_id, "name": channel_id},
        "available_at": f"2024-01-0{len(video_id) % 9 + 1}T00:00:00Z",
        "published_at": f"2024-01-0{len(video_id) % 9 + 1}T00:00:00Z",
        "duration": 120,
        "status": "past",
        "type": "stream",
        "topic_id": "talk",
        "mentions": mentions or [],
    }


class CollabSearchTest(unittest.TestCase):
    def setUp(self):
        self.old_db_path = database.DB_PATH
        handle = tempfile.NamedTemporaryFile(delete=False, suffix=".db")
        handle.close()
        self.temp_db_path = handle.name
        database.DB_PATH = self.temp_db_path
        database.init_db()

    def tearDown(self):
        database.DB_PATH = self.old_db_path
        os.remove(self.temp_db_path)

    def test_collab_tab_includes_own_collabs_and_external_mentions_only(self):
        selected_id = "selected-channel"
        other_id = "other-channel"

        database.insert_video(video("own-solo", selected_id))
        database.insert_video(video("own-collab", selected_id, [{"id": other_id, "name": "Other"}]))
        database.insert_video(video("external-mention", other_id, [{"id": selected_id, "name": "Selected"}]))
        database.insert_video(video("external-no-mention", other_id, [{"id": "third", "name": "Third"}]))

        results = database.search_videos(None, selected_id, video_type="collab")
        ids = {item["id"] for item in results}

        self.assertEqual({"own-collab", "external-mention"}, ids)
        self.assertEqual(2, database.count_videos(None, selected_id, video_type="collab"))

    def test_archive_tab_still_stays_on_selected_channel(self):
        selected_id = "selected-channel"
        other_id = "other-channel"

        database.insert_video(video("own-solo", selected_id))
        database.insert_video(video("external-mention", other_id, [{"id": selected_id, "name": "Selected"}]))

        results = database.search_videos(None, selected_id, video_type="all")
        ids = {item["id"] for item in results}

        self.assertEqual({"own-solo"}, ids)

    def test_collab_filter_matches_mentions_and_external_host_channel(self):
        selected_id = "selected-channel"
        other_id = "other-channel"
        host_id = "host-channel"

        database.insert_video(video("own-collab", selected_id, [{"id": other_id, "name": "Other"}]))
        database.insert_video(video("external-host", host_id, [{"id": selected_id, "name": "Selected"}]))
        database.insert_video(video("external-other", other_id, [{"id": selected_id, "name": "Selected"}]))

        mention_results = database.search_videos(None, selected_id, collab_member=other_id, video_type="collab")
        mention_ids = {item["id"] for item in mention_results}
        self.assertEqual({"own-collab", "external-other"}, mention_ids)

        host_results = database.search_videos(None, selected_id, collab_member=host_id, video_type="collab")
        host_ids = {item["id"] for item in host_results}
        self.assertEqual({"external-host"}, host_ids)


if __name__ == "__main__":
    unittest.main()
