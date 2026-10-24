"""The synthetic demo repositories (fixtures/demo): the demo plan's stored
progress matches its files at their exact bytes, and the second plan's is out
of date on purpose, so the demo shows both a current and a stale result."""
import hashlib
import json
import os
import unittest

FILES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "fixtures", "demo", "files")


def blob(path):
    with open(path, "rb") as f:
        data = f.read()
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()


def progress(repo):
    with open(os.path.join(FILES, repo, "plan", "progress.json"), encoding="utf-8") as f:
        return json.load(f)


class DemoTest(unittest.TestCase):
    def test_demo_plan_progress_matches_its_files(self):
        doc = progress("demo-plan")
        for item in [doc["producer"], doc["inputs"]["table"], doc["inputs"]["record"]]:
            self.assertEqual(item["blob_sha"], blob(os.path.join(FILES, "demo-plan", item["path"])), item["path"])

    def test_second_plan_progress_is_out_of_date_on_purpose(self):
        doc = progress("second-plan")
        self.assertNotEqual(doc["inputs"]["table"]["blob_sha"], blob(os.path.join(FILES, "second-plan", "plan", "tasks.md")))
        self.assertEqual(doc["producer"]["blob_sha"], blob(os.path.join(FILES, "second-plan", "tools", "progress.py")))

    def test_stage_figures_are_not_sums_the_view_could_make(self):
        # The demo's stage and phase figures are stored producer output; the view shows them as given.
        doc = progress("demo-plan")
        phases = {p["id"] for p in doc["phases"]}
        self.assertEqual(sorted(p for s in doc["stages"] for p in s["phases"]), sorted(phases))


if __name__ == "__main__":
    unittest.main()
