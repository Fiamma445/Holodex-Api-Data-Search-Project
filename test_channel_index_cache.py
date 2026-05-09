import unittest

import database


class ChannelIndexCacheTest(unittest.TestCase):
    def setUp(self):
        database.clear_channel_index_cache()

    def tearDown(self):
        database.clear_channel_index_cache()

    def test_channel_index_cache_reuses_same_db_signature(self):
        calls = []
        old_build = database.build_channel_index
        old_signature = database.get_db_signature

        def fake_build_channel_index():
            calls.append("build")
            return [{"id": "UC-test", "name": "Test Channel"}]

        database.build_channel_index = fake_build_channel_index
        database.get_db_signature = lambda: (1, 100)

        try:
            first = database.get_channel_index()
            first[0]["name"] = "Mutated Outside Cache"
            second = database.get_channel_index()
        finally:
            database.build_channel_index = old_build
            database.get_db_signature = old_signature

        self.assertEqual(["build"], calls)
        self.assertEqual("Test Channel", second[0]["name"])

    def test_channel_index_cache_invalidates_when_db_signature_changes(self):
        calls = []
        current_signature = [1, 100]
        old_build = database.build_channel_index
        old_signature = database.get_db_signature

        def fake_build_channel_index():
            calls.append("build")
            return [{"id": "UC-test", "name": f"Build {len(calls)}"}]

        database.build_channel_index = fake_build_channel_index
        database.get_db_signature = lambda: tuple(current_signature)

        try:
            first = database.get_channel_index()
            current_signature[1] = 101
            second = database.get_channel_index()
        finally:
            database.build_channel_index = old_build
            database.get_db_signature = old_signature

        self.assertEqual(["build", "build"], calls)
        self.assertEqual("Build 1", first[0]["name"])
        self.assertEqual("Build 2", second[0]["name"])


if __name__ == "__main__":
    unittest.main()
