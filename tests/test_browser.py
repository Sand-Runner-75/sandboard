"""Browser checks of the built site: keyboard journey, progress shapes, states,
tabs, the access lifecycle, copy, layouts and themes, result-file links and the
read-only request boundary (tests/browser/workspace.check.js).

They need Node.js and Playwright with its Chromium. Without them the checks are
skipped, as on CI; set SANDBOARD_PLAYWRIGHT to the playwright module's folder
when it is not found on its own."""
import json
import os
import shutil
import subprocess
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, ".."))


def find_playwright():
    if os.environ.get("SANDBOARD_PLAYWRIGHT"):
        return os.environ["SANDBOARD_PLAYWRIGHT"]
    npm, node = shutil.which("npm"), shutil.which("node")
    if not (npm and node):
        return None
    try:
        top = subprocess.run([npm, "root", "-g"], capture_output=True, text=True, timeout=30).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return None
    module = os.path.join(top, "playwright")
    return module if os.path.isdir(module) else None


PLAYWRIGHT = find_playwright()


@unittest.skipUnless(PLAYWRIGHT, "Node.js and Playwright are needed for the browser checks")
class BrowserTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import sys
        sys.path.insert(0, os.path.join(ROOT, "scripts"))
        import build
        cls.tmp = tempfile.TemporaryDirectory()
        out = os.path.join(cls.tmp.name, "dist")
        assert build.build(out) == []
        done = subprocess.run(["node", os.path.join(HERE, "browser", "workspace.check.js"), PLAYWRIGHT, out],
                              capture_output=True, text=True, timeout=600, cwd=ROOT)
        cls.r = json.loads(done.stdout or "{}")
        assert "crashed" not in cls.r, cls.r.get("crashed", "") + done.stderr[-2000:]

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_no_page_errors_dialogs_or_other_hosts(self):
        self.assertEqual(self.r["errors"], [])
        self.assertEqual(self.r["dialogs"], 0, "untrusted text never runs")
        self.assertEqual({req.split(" ")[1].split("/")[2] for req in self.r["requests"]}, {"api.github.com"})
        self.assertTrue(all(req.startswith("GET ") for req in self.r["requests"]))

    def test_keyboard_only_journey(self):
        k = self.r["keys"]
        self.assertEqual(k["first"]["tag"], "A")  # the skip link is the first Tab stop
        self.assertEqual(k["afterSkip"]["id"], "main")
        self.assertEqual(k["search"]["id"], "q")
        self.assertEqual(k["rows"], ["DT202"])
        self.assertEqual((k["onRow"]["role"], k["onRow"]["key"]), ("option", "DT202"))
        self.assertIn("Trace each feature to a check", k["panel"])
        self.assertEqual(k["rowFocus"]["key"], "DT202", "focus stays on the row while details load")
        self.assertEqual(k["tab"]["role"], "tab")
        self.assertTrue(k["tab"]["key"].endswith("|task|DT202"))
        self.assertIn("Read from example-org/demo-plan @", k["tabPanel"])
        self.assertEqual(k["viewTab"]["id"], "tab-view")
        self.assertEqual(k["tabsAfterClose"], 1)
        self.assertTrue(k["help"] and k["helpClosed"])
        self.assertEqual(k["treeStart"]["role"], "treeitem")
        self.assertEqual(k["treeNext"]["role"], "treeitem")
        self.assertNotEqual(k["treeStart"]["key"], k["treeNext"]["key"])
        self.assertTrue(k["gotoOpen"])
        self.assertEqual(k["gotoWent"], "Second Project: tasks")
        self.assertEqual(set(k["outlines"]), {"3px"})

    def test_filters_stages_and_phases_never_change_supplied_figures(self):
        p = self.r["progress"]
        self.assertIn("14%", p["whole"])
        self.assertIn("Not verified: 3 rows still to be estimated", p["whole"])
        self.assertIn("23 hof 27 h estimated", p["whole"])
        for key in ("wholeWithStage", "wholeAfterPhase", "wholeAfterNoMatch", "wholeAfterStatus"):
            self.assertEqual(p[key], p["whole"], key)
        self.assertEqual(p["noMatch"], "no-match")
        self.assertEqual(p["doneRows"], ["DT101", "DT102", "DT104"])
        self.assertEqual(p["phaseRows"], ["DT201", "DT201.1", "DT202", "DT203"])

    def test_a_phase_with_no_rows_never_looks_done(self):
        phases = dict(self.r["progress"]["phases"])
        for pid in ("P3", "P7"):
            self.assertIn("No active work", phases[pid])
            self.assertNotIn("%", phases[pid])
        self.assertIn("44%verified", phases["P1"])
        self.assertIn("0%not verified", phases["P2"])

    def test_a_stage_shows_only_its_phases_and_its_own_figures(self):
        p = self.r["progress"]
        self.assertEqual(p["stagePhases"], ["P1", "P2"])
        self.assertIn("Stage 1: Prepare30%", p["stageCards"])
        self.assertIn("Scope gate Approval not supplied", p["stageCards"])
        self.assertTrue(p["stageInTree"])

    def test_unavailable_stale_denied_and_kit_states(self):
        p = self.r["progress"]
        self.assertEqual((p["second"]["states"], p["second"]["phases"], p["second"]["ring"]), (["stale"], 0, 1))
        self.assertIn("plan/tasks.md changed since the result was made", p["second"]["body"])
        self.assertNotIn("25%", p["second"]["body"], "stale figures are never shown")
        self.assertEqual((p["notes"]["states"], p["notes"]["phases"]), (["unavailable"], 0))
        self.assertIn("No code repository assigned", p["notes"]["body"])
        self.assertEqual(p["kit"]["states"], ["unavailable"])
        self.assertIn("Reusable kit, not a live project", p["kit"]["body"])
        self.assertEqual(p["locked"]["states"], ["denied"])
        self.assertNotIn("%", p["locked"]["body"])
        self.assertIn("Code only, no plan", p["tools"]["body"])
        self.assertIn("No access", p["lockedTasks"])
        self.assertEqual(p["gotoOnLocked"], ["No place matches"])
        self.assertTrue(any("Invalid rowline 10: has 4 cells" in r and "this row is broken" in r for r in p["kitRows"]))
        self.assertTrue(any("Invalid rowline 11: repeated ID" in r for r in p["kitRows"]))

    def test_owner_approval_needs_the_producers_record(self):
        p = self.r["progress"]
        self.assertIn("Owner approval: not recorded. Done in the table is not owner approval.", p["doneNotApproved"])
        self.assertIn("Links appear here once the owner approves the result files.", p["doneNotApproved"])
        self.assertIn("Owner approval: recorded (PR #3)", p["approved"])
        self.assertIn("GitHub gave no web address", p["approved"])
        self.assertEqual(p["demoLinks"], [])

    def test_result_files_link_at_the_pinned_commit_in_a_new_tab(self):
        v = self.r["private"]
        web = "https://github.example.invalid/acme/garden-plan/blob/" + v["commit"] + "/"
        expected = [[web + "notes/XQ101-result.md", "_blank", "noopener noreferrer"], [web + "plan/tasks.md", "_blank", "noopener noreferrer"]]
        self.assertEqual(v["panelLinks"], expected)
        self.assertEqual([x[:3] for x in v["rowLinks"]], expected)
        self.assertEqual({x[3] for x in v["rowLinks"]}, {-1}, "row links are pointer shortcuts with no Tab stop")
        self.assertEqual(v["otherRowLinks"], 0)
        self.assertIn("Invalid link ../../outside.md", v["panel"])
        self.assertIn("Owner approval: recorded (PR #4)", v["panel"])

    def test_private_reads_are_get_only_with_the_token_only_to_the_api(self):
        v = self.r["private"]
        self.assertEqual(set(v["methods"]), {"GET"})
        self.assertEqual(set(v["auth"]), {True})
        self.assertEqual(v["hosts"], ["api.github.com"])
        self.assertEqual(v["tokenField"], "")
        self.assertEqual(v["storage"], 0)
        self.assertEqual(v["locked"], ["denied"])

    def test_a_plan_denied_on_refresh_takes_its_tabs_and_tasks_with_it(self):
        v = self.r["private"]
        self.assertEqual(v["tabsBeforeDenial"], 2)
        self.assertEqual(v["tabsAfterDenial"], 1)
        self.assertIn("No access", v["tasksAfterDenial"])
        self.assertNotIn("XQ101", v["tasksAfterDenial"])

    def test_tabs_keep_their_source_and_project(self):
        life = self.r["lifecycle"]
        self.assertTrue(life["tabKey"].startswith("demo|example-org/demo-plan|"))
        self.assertTrue(life["tabKey"].endswith("|task|DT201"))
        self.assertIn("Read from example-org/demo-plan @", life["tabSource"])
        self.assertEqual(life["tabsInSecond"], ["ViewTasks"], "another project's tabs are not in the page")
        self.assertEqual(life["tabsBack"], ["ViewOverview", "TaskDT201"])

    def test_access_loss_clears_every_surface(self):
        life, v = self.r["lifecycle"], self.r["private"]
        self.assertTrue(life["gotoWasOpen"])
        for text in (life["afterForget"], life["afterBack"], v["afterRevoke"]):
            for marker in ("Demo Project", "DT1", "DT2", "example-org", "acme", "XQ1", "Garden", "%", "Task "):
                self.assertNotIn(marker, text)
            self.assertIn("Nothing loaded.", text)
        self.assertFalse(life["gotoOpen"])
        self.assertTrue(life["gotoDisabled"])
        self.assertEqual(life["gotoItems"], 0)
        self.assertIn("No access: the token is invalid, expired or revoked.", v["afterRevoke"])

    def test_untrusted_text_is_shown_as_text(self):
        p = self.r["progress"]
        self.assertIn('<script>alert("never runs")</script>', p["hostile"])
        self.assertEqual((p["scripts"], p["imgs"]), (8, 0))
        self.assertEqual(p["writeControls"], [])

    def test_copy_is_exactly_the_shown_text_and_a_refusal_is_reported(self):
        c = self.r["copy"]
        self.assertEqual(c["copied"], c["shown"])
        self.assertEqual(c["status"], "Copied. Nothing was sent anywhere.")
        self.assertIn("nothing was copied", c["refused"])
        self.assertEqual(c["selected"].strip(), c["shown"].strip())

    def test_layouts_and_themes(self):
        lay = self.r["layout"]
        for width in (320, 390, 860, 1280):
            for theme, bg in (("light", "rgb(243, 245, 248)"), ("dark", "rgb(15, 20, 26)")):
                r = lay[f"{width}{theme}"]
                self.assertEqual((r["overview"], r["tasks"]), (0, 0), f"{width} {theme}: no sideways scroll")
                self.assertEqual(r["bg"], bg)
                self.assertEqual(r["menuShown"], width <= 860)
        self.assertEqual(lay["switched"], ["light", "rgb(243, 245, 248)"])

    def test_framed_page_refuses_to_show(self):
        self.assertEqual(self.r["framed"], {"state": "This page cannot be shown inside another site.", "shell": "hidden"})


if __name__ == "__main__":
    unittest.main()
