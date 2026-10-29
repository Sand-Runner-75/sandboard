"""Browser checks of the built site: keyboard journey, progress shapes, states,
tabs, the access lifecycle, copy, layouts and themes, result-file links and the
read-only request boundary (tests/browser/workspace.check.js).

They need Node.js and Playwright with its Chromium. Without them the checks are
skipped, except where SANDBOARD_REQUIRE_BROWSER is set (as on CI), where a
missing browser fails; set SANDBOARD_PLAYWRIGHT to the playwright module's
folder when it is not found on its own."""
import hashlib
import json
import re
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


class BrowserRequiredTest(unittest.TestCase):
    def test_browser_checks_run_where_required(self):
        if os.environ.get("SANDBOARD_REQUIRE_BROWSER"):
            self.assertTrue(PLAYWRIGHT and os.path.isdir(PLAYWRIGHT),
                            "SANDBOARD_REQUIRE_BROWSER is set but Playwright was not found")


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

    def test_the_overview_lists_every_task_beside_the_recent_activity(self):
        p = self.r["progress"]
        al, st = p["lowerAll"], p["lowerStage"]
        self.assertEqual(al["columns"], ["overview-tasks", "feed"])
        self.assertTrue(al["sideBySide"], "two columns: the tasks beside the recent activity")
        self.assertEqual(al["title"], "All tasks")
        self.assertEqual(al["count"], "15 tasks, 3 Done.")
        self.assertEqual(al["ids"][:3], ["DT101", "DT102", "DT103"])
        self.assertEqual(len(al["ids"]), 15)
        self.assertEqual(st["columns"], [], "a stage chip leaves the two-column overview")
        self.assertEqual(p["stageView"], {"tasks": 1, "stage": "S1"}, "a stage opens Tasks filtered to it")

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

    def test_a_tab_keeps_its_own_commits_brief_after_the_branch_moves(self):
        v = self.r["private"]
        self.assertEqual(v["tabBriefA"], "Synthetic brief for XQ101.\n")
        self.assertEqual(v["tabBriefAfterAdvance"], v["tabBriefA"], "the old tab neither changes nor stays on Loading")
        self.assertIn("Read from acme/garden-plan @ " + v["commit"][:7], v["tabSourceAfterAdvance"])
        self.assertEqual(v["briefB"], "Changed brief at the newer commit.\n")

    def test_a_repository_no_longer_mapped_takes_its_tabs_with_it(self):
        v = self.r["private"]
        self.assertEqual((v["tabsBeforeRemap"], v["tabsAfterRemap"]), (3, 1))
        self.assertNotIn("garden-plan", v["afterRemap"])
        self.assertEqual(v["remapBrief"], "Brief in the replacement repository.\n")
        self.assertIn("acme/replacement-plan", v["remapSource"])

    def test_check_runs_pass_only_on_an_explicit_success(self):
        line = next(l for l in self.r["private"]["checksAll"].splitlines() if "check runs:" in l)
        self.assertEqual(line, "6 check runs: 1 passing, 1 not passing, 1 running or queued, 1 neutral or skipped, "
                               "1 finished with no conclusion, 1 with a conclusion not known here")

    def test_a_huge_status_count_stays_a_few_elements_with_its_exact_number(self):
        big = self.r["private"]["bigPhase"]
        self.assertIn("1000000000 Not Started", big["label"])
        self.assertEqual(big["dots"], 2)

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

    def test_search_reads_nothing_and_task_content_counts_only_when_asked(self):
        sr = self.r["private"]["search"]
        self.assertEqual(sr["heading"], "Search")
        self.assertEqual(sr["pressedAtFirst"], "false", "Search inside tasks is off by default")
        self.assertEqual(sr["off"], [], "the brief's words do not find the task while the option is off")
        self.assertEqual(sr["on"], ["XQ101"])
        self.assertIn("brief", sr["excerpt"])
        self.assertIn("Synthetic brief for XQ101.", sr["excerpt"])
        self.assertEqual(sr["focus"]["id"], "s-inside")
        self.assertEqual(sr["offAgain"], [])
        self.assertEqual(sr["byId"], ["XQ101"])
        self.assertIn("acme/garden-plan @", sr["source"])
        self.assertIn("No file tree read yet", sr["coverage"])
        self.assertEqual(sr["requests"], 0, "searching makes no request")
        self.assertEqual(sr["opened"], "XQ101")

    def test_search_works_by_keyboard_fits_a_phone_and_is_dropped_with_access_or_a_refresh(self):
        ls = self.r["searchLife"]
        self.assertEqual(ls["heading"], "Search")
        self.assertEqual(ls["typedFocus"]["id"], "sq", "typing keeps focus in the search field")
        self.assertGreater(ls["results"], 0)
        self.assertEqual(ls["nextFocus"]["tag"], "BUTTON")
        self.assertLessEqual(ls["overflow"], 0)
        for text in (ls["afterForget"], ls["afterBack"]):
            self.assertNotIn("DT1", text)
            self.assertIn("Sign in to read your projects", text)
        self.assertEqual(ls["afterRefresh"], {"q": "", "inside": "false", "results": 0}, "a refresh drops the search")
        self.assertEqual(ls["again"], {"q": "", "inside": "false", "results": 0})

    def test_round_refresh_reads_only_the_open_project(self):
        o = self.r["refreshOne"]
        sha = lambda seed: hashlib.sha1(seed.encode()).hexdigest()
        self.assertEqual(o["button"]["glyph"], "\u21bb")
        self.assertIn("Refresh only Example Garden Planner", o["button"]["label"])
        self.assertNotEqual(o["button"]["round"], "0px")
        self.assertIn(sha("plan-main")[:7], o["before"])
        self.assertIn(sha("garden-plan-second")[:7], o["after"], "the moved plan branch is read again")
        self.assertTrue(o["urls"], "it read something")
        for u in o["urls"]:
            self.assertTrue(u.startswith("GET "), u)
            self.assertRegex(u, r"/repos/acme/garden(-plan)?([/?]|$)", "only the open project's repositories: " + u)
            self.assertNotIn("sandboard.workspaces.json", u, "not the workspace list")
            self.assertNotIn("/user/repos", u, "not the token's list")
        self.assertEqual(o["projects"], o["projectsBefore"], "the other projects stay")
        self.assertEqual(o["focusKept"], "refresh-one")
        self.assertEqual(o["otherReadAgain"], [], "another project's file reads are kept")
        self.assertEqual(o["whileReading"], "true", "off while it reads")
        self.assertIn(sha("garden-plan-fourth")[:7], o["afterRace"]["head"], "the full refresh wins")
        self.assertNotIn(sha("garden-plan-third")[:7], o["afterRace"]["head"], "the held older answer is dropped")
        self.assertNotEqual(o["navigated"]["after"], "refresh-one", "the focus is not taken back after moving on")
        self.assertEqual(o["navigated"]["after"], o["navigated"]["before"])
        self.assertIn("Sign in to read your projects", o["afterForget"])
        self.assertNotIn("Example Garden Planner", o["afterForget"])
        self.assertEqual(o["afterRace"]["disabled"], "false", "the held late answer changes nothing")
        self.assertIn("Refresh only Example Garden Planner", o["onRepo"] or "")

    def test_atlas_tab_draws_the_branch_graph_beside_the_dashboard(self):
        a = self.r["atlas"]
        self.assertEqual(a["tabs"], [["Progress", "true"], ["Atlas", "false"]], "the dashboard is shown first")
        self.assertEqual(a["dashboardFirst"], "tabs", "the dashboard below the main tabs is as it was")
        self.assertEqual(a["byKey"], ["major-atlas", "true", True], "Right moves to the Atlas and keeps the focus on its tab")
        self.assertEqual(a["repo"], "example-org/demo-app", "the open project's code repository is shown first")
        g = a["graph"]
        self.assertEqual(g["dots"], 8)
        self.assertEqual(g["colours"], ["#17a2a2", "#9b59c9", "#e5534b"], "main red, feature purple, another branch its own colour")
        self.assertEqual(g["labels"], ["PR #3", "PR #6", "main", "v0.1.0", "v0.2.0"])
        self.assertEqual(g["key"], [["main", "main"], ["PR #6", "feature/search"], ["PR #3", "list-data"]])
        self.assertIn("8 commits (whole history)", g["summary"])
        self.assertIn(g["links"], [[], ["_blank noopener noreferrer"]], "a dot links to its commit only in a new tab without the opener")
        self.assertFalse(g["html"], "the picture is drawn with picture elements only")
        z = a["zoom"]
        self.assertGreater(z["in"], z["start"])
        self.assertEqual(z["reset"], z["start"])
        self.assertGreater(z["key"], z["start"], "plus zooms in from the keyboard")
        self.assertGreater(z["kept"], z["start"], "the zoom stays when the page is drawn again")
        self.assertEqual(a["replay"]["during"], ["Stop", "true"])
        self.assertGreater(a["replay"]["hidden"], 0)
        self.assertEqual(a["replay"]["after"], 0, "the whole graph shows again at the end")
        self.assertIsNotNone(a["bubble"])
        self.assertRegex(a["bubble"], r"on main|on feature/search|on list-data")
        self.assertRegex(a["bubble"], r"files? changed|No files changed|could not be read")
        k = a["keys"]
        self.assertIsNotNone(k["first"]["sha"], "Tab from the graph reaches a commit")
        self.assertEqual(k["first"]["tabbable"], 1, "only one commit is in the Tab order")
        self.assertRegex(k["first"]["label"], r"on main|on feature/search|on list-data", "a focused commit is named by its details")
        self.assertRegex(k["first"]["tip"] or "", r"files? changed|No files changed|could not be read", "focus reads and shows the commit's files")
        self.assertLess(int(k["left"]["s"]), int(k["first"]["s"]), "Left moves to the commit before")
        self.assertEqual(k["left"]["tabbable"], 1)
        t = a["tree"]
        self.assertEqual(t["before"], [True, False], "the code tree reads and draws nothing before Play")
        self.assertIn("5 commits (whole history)", t["sub"])
        self.assertEqual(t["played"][:2], ["5/5", "Play"], "Play plays every commit, then stops")
        self.assertIn("Code tree at commit 5 of 5", t["played"][2])
        self.assertEqual(t["seek"], "2/5")
        self.assertEqual(t["speed"], ["false", "false", "true"])
        self.assertEqual(t["keys"][0], "true", "Space plays from the keyboard")
        self.assertLessEqual(int(t["keys"][1].split("/")[0]), 2, "Home went back to the start (it has just begun playing at 4×)")
        self.assertEqual((t["gif"]["src"], t["gif"]["head"], t["gif"]["name"]), ("data:image/gif;", "GIF89a", "demo-app-tree.gif"))
        self.assertIn("stays there after you sign out", t["gif"]["text"])
        self.assertEqual((t["png"]["src"], t["png"]["head"][1:4], t["png"]["name"]), ("data:image/png;", "PNG", "demo-app-tree.png"))
        self.assertEqual((t["graphGif"]["src"], t["graphGif"]["head"], t["graphGif"]["name"]), ("data:image/gif;", "GIF89a", "demo-app-history.gif"))
        self.assertTrue(t["graphClosed"])
        self.assertEqual(t["requests"], [], "saving sends nothing anywhere")
        f = t["files"]
        self.assertRegex(f["head"], r"^Commit 5 of 5: ", "the file list says which commit it is at")
        self.assertTrue(f["changed"] and all(re.match(r"^(added|changed|removed|renamed|copied): \S", x) for x in f["changed"]), f["changed"])
        self.assertRegex(t["allFiles"][0], r"^Every file in the tree now \(\d+\)$")
        self.assertEqual(len(t["allFiles"][1]), int(re.search(r"\((\d+)\)", t["allFiles"][0]).group(1)), "every file is listed by keyboard")
        g = t["graphFrames"]
        self.assertEqual((g["first"], g["second"], g["last"]), (1, 2, 8), "the graph GIF reveals one commit dot per frame, all 8 by the end")
        self.assertGreaterEqual(a["viewsBefore"], 1)
        self.assertEqual(a["viewsAfter"], 0, "Forget access disposes every code tree view")
        tf = a["fail"]["tree"]
        self.assertTrue(tf["retry"], tf)
        self.assertIn("1 commit's files could not be read", tf["sub"])
        tb = a["fail"]["treeAgain"]
        self.assertEqual((tb["gaps"], tb["retry"], tb["views"]), (None, False, 1), "Read again brings the files and the old view is let go")
        self.assertNotIn("could not be read", tb["sub"])
        self.assertEqual(a["lateGif"], [True, False, False, 0], "a GIF begun before leaving never shows up in the next session")
        self.assertEqual(a["treeReduced"], ["5/5", "false"], "with reduced motion, Play shows the finished tree still")
        rr = a["replayReduced"]
        self.assertRegex(rr["start"]["step"], r"^1/8 · ")
        self.assertEqual(rr["start"]["prev"], "true", "no commit before the first")
        self.assertLess(rr["next"]["hidden"], rr["start"]["hidden"], "Next shows the next commit's dot and lines")
        self.assertRegex(rr["next"]["step"], r"^2/8 · ")
        self.assertEqual(rr["still"], rr["next"], "nothing moves by itself")
        self.assertEqual((rr["third"]["step"][:3], rr["third"]["focus"]), ("3/8", "ag-next"), "Enter on Next goes on and keeps the focus there")
        self.assertEqual((rr["stopped"]["hidden"], rr["stopped"]["step"], rr["stopped"]["button"]), (0, None, "Replay history"))
        f = a["fail"]
        self.assertEqual(f["first"]["dots"], 0)
        self.assertIn("HTTP 429", f["first"]["text"], "a first commit page that failed says its error")
        self.assertTrue(f["first"]["retry"], "and offers Read again before any commit is drawn")
        self.assertEqual(f["commits"]["dots"], 1, "Read again reads the failed page and draws the graph")
        self.assertIn("Tags could not be read", f["commits"]["sum"], "unreadable tags are never counted as none")
        self.assertIn("the tags (HTTP 403)", f["commits"]["failed"])
        self.assertIn("the pull requests (HTTP 429)", f["commits"]["failed"])
        self.assertIn("0 tags", f["all"]["sum"])
        self.assertIsNone(f["all"]["failed"], "once everything is read, nothing is said to have failed")
        self.assertFalse(f["all"]["retry"])
        self.assertEqual(a["treePick"], ["true", "example-org/demo-plan"])
        self.assertEqual(a["overview"], ["true", False])
        self.assertTrue(any("branch graph (Atlas)" in x for x in a["goto"]), a["goto"])
        self.assertTrue(a["gotoShown"])
        self.assertLessEqual(a["phone"], 0, "no sideways page scroll on a phone")
        self.assertEqual(a["afterLeave"][0], 0)
        self.assertNotIn("demo-app", a["afterLeave"][1])
        self.assertEqual(a["again"], "true", "a new visit starts on the dashboard")

    def test_untrusted_text_is_shown_as_text(self):
        p = self.r["progress"]
        self.assertIn('<script>alert("never runs")</script>', p["hostile"])
        self.assertEqual((p["scripts"], p["imgs"]), (20, 0))
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
            for theme, bg in (("light", "rgb(248, 247, 244)"), ("dark", "rgb(25, 24, 22)")):
                r = lay[f"{width}{theme}"]
                self.assertEqual((r["overview"], r["tasks"]), (0, 0), f"{width} {theme}: no sideways scroll")
                self.assertEqual(r["bg"], bg)
                self.assertEqual(r["menuShown"], width <= 860)
        self.assertEqual(lay["switched"], ["light", "rgb(248, 247, 244)"])

    def test_targets_focus_and_roles(self):
        for width, a in self.r["a11y"].items():
            self.assertEqual(a["small"], [], f"{width}: controls under 24 px (WCAG 2.5.8)")
            self.assertEqual(a["hidden"], [], f"{width}: focus hidden under the top bar (WCAG 2.4.11)")
            self.assertEqual(a["roles"], ["tree", "treeitem", "listbox", "option", "tablist", "tab", "combobox", "dialog"])
            s = a["states"]
            self.assertTrue(s["expanded"] and s["pressed"])
            self.assertEqual((s["selectedOption"], s["selectedTab"], s["current"]), (1, 1, 1), width)
            self.assertEqual(s["unnamed"], [], f"{width}: controls without a name")

    def test_the_tree_arrow_closes_a_project_and_a_refresh_keeps_it_closed(self):
        f = self.r["firstUse"]
        self.assertTrue(f["startsClosed"] and set(f["startsClosed"]) == {"false"}, "every project starts collapsed")
        self.assertEqual(f["openKids"], ["v:demo:overview", "v:demo:tasks", "stages:demo", "repos:demo"])
        self.assertEqual(f["closed"], {"expanded": "false", "kids": []})
        self.assertEqual(f["closedAfterRefresh"], "false")
        self.assertEqual(f["reopened"], f["openKids"])

    def test_phases_sit_under_their_stage_or_the_project(self):
        f, v = self.r["firstUse"], self.r["private"]
        self.assertEqual(f["stagePhases"], ["ph:demo:P1", "ph:demo:P2"])
        self.assertEqual(f["phaseRows"], ["DT201", "DT201.1", "DT202", "DT203"])
        self.assertTrue(f["phaseCurrent"])
        self.assertEqual(v["phaseGroup"], ["ph:garden:P1", "ph:garden:P2"], "without stages, phases sit under the project")

    def test_a_stage_picked_in_the_tree_opens_its_tasks_not_the_overview(self):
        self.assertEqual(self.r["firstUse"]["treeStage"], {"tasks": 1, "lower": 0, "stage": "S1", "phase": "", "current": True})

    def test_clearing_a_navigated_phase_keeps_its_stage(self):
        f = self.r["firstUse"]
        self.assertEqual(f["phaseStage"], "S1", "a phase picked in the tree brings its stage")
        self.assertEqual(f["allInStage"], {"stage": "S1", "rows": f["stageRows"]})
        self.assertEqual(f["allInCardStage"], {"stage": "S1", "phases": ["", "P1", "P2"]}, "the same from a phase card")

    def test_related_tasks_in_a_tab_open_at_the_tabs_commit(self):
        v = self.r["relatedRevisions"]
        a, b = v["commits"]
        self.assertIn("XQ103 Gather samples Not Started", v["related"], "the tab keeps the list it was read with")
        self.assertEqual(v["changed"]["key"], "garden|acme/garden-plan|" + a + "|task|XQ101")
        self.assertEqual(v["changed"]["title"], "Sketch the layout Done", "a changed task opens as it was at the tab's commit")
        self.assertEqual(v["deleted"]["key"], "garden|acme/garden-plan|" + a + "|task|XQ103", "a task deleted later still opens")
        self.assertEqual(v["deleted"]["live"], "Opened task XQ103 as a tab.")
        self.assertEqual(v["neededBy"]["key"], "garden|acme/garden-plan|" + a + "|task|XQ102", "Needed by keeps the commit")
        self.assertEqual(v["step"]["key"], "garden|acme/garden-plan|" + a + "|task|XQ102.1", "Steps keep the commit")
        self.assertEqual(v["step"]["title"], "Mix swatches Not Started")
        self.assertEqual(v["current"], {"key": "garden|acme/garden-plan|" + b + "|task|XQ101", "title": "Sketch the layout again In Progress"},
                         "from the list, the task opens as it is now")

    def test_a_complete_review_cycle_keeps_each_kind_of_evidence_apart(self):
        v = self.r["cycle"]["complete"]
        self.assertEqual(v["sub"], "cycle")
        self.assertEqual(v["pulls"], ["example-org/demo-plan #3"], "a step's pull request (DT201.1) or an unrelated one is not listed")
        self.assertEqual(v["handoffs"], [["READY FOR REVIEW", "older", True], ["CHANGES REQUESTED", "older", True],
                                         ["READY FOR RECHECK", "head", False], ["REVIEW PASSED", "head", False]])
        self.assertIn("Merged 2026-01-10 10:00 UTC", v["text"])
        self.assertIn("1 other comment not in the handoff form", v["text"])
        self.assertIn("it is not the owner's approval", v["text"])
        self.assertEqual(v["owner"], "Owner decisionOwner approval: recorded (PR #3)")
        self.assertEqual(v["buttons"], ["Read again"], "nothing here sends, approves or merges")
        self.assertEqual(v["links"], [], "the demo has no web address, so nothing links out")

    def test_a_private_review_cycle_links_out_at_the_pull_request_and_reads_only(self):
        v = self.r["cycle"]["private"]
        web = "https://github.example.invalid/"
        self.assertEqual(v["links"], [[web + "acme/garden-plan/pull/9", "_blank", "noopener noreferrer"],
                                      [web + "acme/garden/pull/2", "_blank", "noopener noreferrer"]])
        self.assertEqual(v["handoffs"], [["REVIEW PASSED", "head", False]])
        self.assertIn("Owner approval: not supplied by this plan's progress output", v["owner"])
        self.assertEqual(sorted(set(v["reads"])), ["comments", "pulls"])
        self.assertEqual(set(v["methods"]), {"GET"})
        self.assertGreater(v["readsAfterAgain"], len(v["reads"]), "Read again reads the cycle again")

    def test_an_older_read_again_never_replaces_a_newer_cycle(self):
        for kind in ("data", "failure"):
            r = self.r["cycle"]["race"][kind]
            self.assertIn("XQ101: new answer", r["held"]["text"], kind)
            self.assertIn("XQ101: new answer", r["after"]["text"], kind)
            self.assertNotIn("old answer", r["after"]["text"], kind)
            self.assertEqual(r["after"]["notices"], [], kind)

    def test_a_capped_review_cycle_says_what_it_left_out(self):
        c = self.r["cycle"]["capped"]
        self.assertEqual(c["pulls"], ["acme/garden-plan #" + str(n) for n in range(20, 30)])
        self.assertEqual([n[0] for n in c["notices"]], ["partial"])
        self.assertIn("At most 10 pull requests are shown. Not shown or read: "
                      "1 more pull request naming XQ102 in acme/garden-plan, and 1 linked code pull request.", c["notices"][0][1])

    def test_disputed_moved_and_missing_review_cycles(self):
        c = self.r["cycle"]
        self.assertEqual(c["disputed"]["handoffs"][-1], ["OWNER DECISION", "head", False])
        self.assertIn("Owner approval: not recorded. A review, passing checks or a merge are not owner approval.", c["disputed"]["owner"])
        m = c["moved"]
        self.assertEqual(m["pulls"], ["example-org/demo-plan #5", "example-org/demo-app #2"])
        self.assertEqual(m["handoffs"][1], ["REVIEW PASSED", "older", False], "a review of an older head keeps that head")
        self.assertIn("Linked from the description of plan pull request #5.", m["text"])
        self.assertIn("3 check runs: 1 passing, 1 not passing, 1 running or queued", m["text"])
        self.assertIn("<script>alert('demo')</script> stays text.", m["text"])
        self.assertIn("Written: notes/DT201-brief.md", m["brief"])
        self.assertIn("No pull request in example-org/demo-plan names DT202 in its title (5 read).", c["missing"]["text"])
        self.assertEqual(c["missing"]["handoffs"], [])
        self.assertEqual(c["keyTo"]["id"], "sub-cycle")

    def test_expand_all_and_collapse_all(self):
        f = self.r["firstUse"]
        self.assertEqual(f["expandAll"], 0)
        self.assertGreater(f["itemsExpanded"], 40)
        self.assertEqual(f["itemsCollapsed"], ["a:home", "g:projects", "p:demo", "p:second", "p:notes", "p:kit", "p:locked", "p:tools", "g:account", "a:portfolio", "a:activity", "a:inbox", "a:search"])

    def test_the_stage_filter_keeps_its_phases_and_never_changes_figures(self):
        f, v = self.r["firstUse"], self.r["private"]
        self.assertEqual(f["stageRows"], ["DT101", "DT102", "DT103", "DT104", "DT201", "DT201.1", "DT202", "DT203"])
        self.assertEqual(f["stagePhaseOptions"], ["", "P1", "P2"])
        self.assertEqual(f["wholeAfter"], f["wholeBefore"])
        self.assertEqual(v["stageFilter"], 0, "no stage filter when the progress output has no stages")

    def test_the_list_is_full_width_until_a_task_opens_beside_it(self):
        f = self.r["firstUse"]
        self.assertEqual(f["listOnly"], [1, 100])
        self.assertGreaterEqual(f["withDetails"], 40)

    def test_a_finished_task_shows_its_results_first_and_folds_its_documents(self):
        v = self.r["private"]
        self.assertEqual(v["panelOrder"][:2], ["header", "results"])
        self.assertTrue(v["briefFolded"])
        web = "https://github.example.invalid/acme/garden-plan/blob/" + v["commit"] + "/"
        self.assertEqual(v["xrefLink"], [[web + "plan/xref/XQ101.md", "_blank", "noopener noreferrer"]])
        self.assertEqual(self.r["firstUse"]["notesLabel"], "Original plan notes")

    def test_prerequisites_show_their_status_and_open_as_tabs(self):
        f = self.r["firstUse"]
        self.assertEqual(f["needs"][:2], ["DT201 Agree the first feature list In Progress", "DT999 Not in this table"])
        self.assertTrue(f["openedTab"].endswith("|task|DT201"))
        self.assertIn("NeedsDT102 List similar tools Done", f["related"])
        self.assertIn("Needed byDT202 Trace each feature to a check Not StartedDT401", f["related"])
        self.assertIn("StepsDT201.1", f["related"])

    def test_a_task_tab_holds_every_column_in_sections(self):
        f = self.r["firstUse"]
        self.assertEqual(f["sections"], ["Details", "Brief", "Handover", "Results", "Review cycle", "Cross-references", "Related"])
        for part in ("Expected resultA list the owner accepts", "CheckDOC", "Est. h4 h", "Original plan notesDraft shared",
                     "ModeChat", "EffortHigh", "Owner approval: not recorded"):
            self.assertIn(part, f["details"])
        self.assertEqual((f["subKey"]["id"], f["subKey"]["outline"]), ("sub-brief", "3px"))
        self.assertIn("Brief: DT201 (synthetic)", f["briefInTab"])
        self.assertIn("notes/xref/DT201.md", f["crossref"])
        self.assertIn("Synthetic index of what relates to DT201", f["crossref"])

    def test_the_tab_bar_never_scrolls_up_and_down(self):
        self.assertEqual(self.r["firstUse"]["tabBar"], ["hidden", True])

    def test_explanation_bubbles_on_hover_and_focus_and_in_help(self):
        f = self.r["firstUse"]
        self.assertTrue(f["hoverSoon"], "a bubble waits a moment before it shows on hover")
        self.assertFalse(f["hoverTip"][0])
        self.assertIn("Dropped from the plan", f["hoverTip"][1])
        self.assertTrue(f["escHides"])
        self.assertEqual(f["detailsStillOpen"], 1, "the first Esc only hides the bubble")
        self.assertEqual(f["focusTip"], [False, "tip"])
        self.assertTrue(f["treeHover"], "the tree shows no bubble on hover")
        self.assertTrue(f["treeClick"], "the tree shows no bubble on click")
        self.assertEqual(f["treeKey"], [False, "treeitem"], "the keyboard still gets the tree's bubble")
        for word in ("Removed", "Verified", "To be estimated", "Original plan notes", "Cross-references"):
            self.assertIn(word, f["glossary"])

    def test_the_portfolio_lists_only_mapped_repositories_and_filters_change_nothing(self):
        ro = self.r["repos"]
        repos = [r[0] for r in ro["rows"]]
        self.assertEqual(len(repos), 9)
        self.assertNotIn("example-org/unlisted", repos, "a repository no workspace names never appears")
        self.assertIn(["example-org/locked-plan", "denied"], ro["rows"])
        self.assertIn("No access", ro["rowText"])
        self.assertEqual([r[0] for r in ro["forks"]], ["example-org/second-site"])
        self.assertEqual([r[0] for r in ro["go"]], ["example-org/tools"])
        self.assertEqual([r[0] for r in ro["locked"]], ["example-org/locked-app", "example-org/locked-plan"])
        self.assertEqual(ro["byStars"][:3], ["example-org/starter-kit", "example-org/tools", "example-org/demo-app"])
        self.assertEqual(ro["byStars"][-2:], ["example-org/locked-app", "example-org/locked-plan"], "unreadable repositories sort last")
        self.assertEqual(ro["groups"], ["demo", "second", "notes", "kit", "locked", "tools"])
        self.assertEqual(ro["pctBefore"], ro["pctAfter"], "repository views never change a progress figure")

    def test_activity_counts_say_what_they_cover_and_are_not_progress(self):
        a = self.r["repos"]["activity"]
        self.assertIn("demo-user", a["account"])
        self.assertIn("not progress", a["notice"])
        self.assertTrue(a["cards"][0].startswith("Repositories7read of 9 mapped"), a["cards"][0])
        self.assertIn("84over 7 repositories", a["cards"][3])
        self.assertEqual(a["charts"], ["Languages by number of repositories", "Languages by code bytes", "Repositories by year created",
                                       "Lifespans", "Stars and last push"])
        self.assertIn("example-org/second-site (No access)", a["missing"])
        self.assertEqual(a["dots"], 7)

    def test_the_activity_feed_links_to_its_origins_and_says_what_it_did_not_read(self):
        ro = self.r["repos"]
        self.assertEqual(set(ro["feed"]["kinds"]), {"commit", "opened", "merged", "closed", "handoff"})
        self.assertIn("not progress", ro["feed"]["text"])
        pr = ro["private"]
        self.assertEqual(pr["kinds"], ["handoff", "commit", "opened"])
        self.assertEqual(pr["links"][0], ["https://github.example.invalid/acme/garden/pull/2", "_blank", "noopener noreferrer"])
        self.assertTrue(pr["links"][1][0].startswith("https://github.example.invalid/acme/garden/commit/"))
        self.assertIn("acme/garden-plan: comments not available", pr["coverage"])
        self.assertEqual(pr["bold"], 0, "a commit title stays text")
        self.assertTrue(all(u.startswith("GET ") for u in pr["urls"]))
        self.assertFalse(any("unmapped" in u for u in pr["urls"]), "an unmapped repository is never read")
        self.assertFalse(any("/users/" in u or "/events" in u for u in pr["urls"]), "no account-wide read")
        self.assertEqual(set(u for u in pr["urls"] if "/user/repos" in u), {"GET https://api.github.com/user/repos?per_page=100&page=1"},
                         "the token's own list of repositories is read once a reading, a page at a time")

    def test_the_feed_follows_the_ref_the_project_reads_through_switches_and_refresh(self):
        refs = self.r["repos"]["refs"]
        main, release = "Add the layout <b>now</b>", "Release notes"
        for k in ("main", "mainAgain", "mainRefreshed"):
            self.assertIn(main, refs[k]["titles"], k)
            self.assertNotIn(release, refs[k]["titles"], k)
        for k in ("release", "releaseRefreshed"):
            self.assertIn(release, refs[k]["titles"], k)
            self.assertNotIn(main, refs[k]["titles"], k)
        urls = self.r["repos"]["private"]["urls"]
        self.assertEqual(len({u for u in urls if "/acme/garden/commits?sha=" in u}), 2, "each ref's commits are read at its own pin")

    def test_unknown_metadata_is_shown_as_not_given_and_counts_say_what_they_cover(self):
        ro = self.r["repos"]
        rows = {r[0]: r for r in ro["privateRows"]}
        self.assertEqual(rows["acme/garden-plan"][4], "None", "GitHub said there is no main language")
        self.assertEqual(rows["acme/garden"][4], "Not given by GitHub", "GitHub gave no language field")
        self.assertEqual(rows["acme/garden"][3], "Not given by GitHub")
        self.assertEqual(rows["acme/recipes"][2], "Not given by GitHub")
        for opt in ("r-vis:?", "r-lang:-", "r-lang:?", "r-type:?"):
            self.assertIn(opt, ro["privateOptions"])
        a = ro["privateActivity"]
        self.assertIn("over the 2 of 3 that give it; 1 not given by GitHub", a["cards"][1])
        self.assertIn("over the 2 of 3 that give it; 1 not given by GitHub", a["cards"][2])
        self.assertEqual(sorted(a["langs"]), ["Go", "No main language", "Not given by GitHub"])
        self.assertIn("Not given by GitHub", ro["recipes"]["visibility"], "unknown privacy is never shown as Public")
        self.assertNotIn("Public", ro["recipes"]["visibility"])

    def test_undatable_activity_is_disclosed_and_not_an_empty_feed(self):
        ro = self.r["repos"]
        self.assertEqual(ro["recipes"]["titles"], [])
        self.assertIn("Activity was read, but no event had a time", ro["recipes"]["empty"])
        self.assertIn("1 event was read with no readable time", ro["recipes"]["untimed"])
        self.assertIn("1 event was read with no readable time", ro["refs"]["release"]["untimed"])
        self.assertEqual(ro["refs"]["main"]["untimed"], "")

    def test_a_repository_page_keeps_hostile_metadata_as_text(self):
        app = self.r["repos"]["app"]
        self.assertIn("<img src=x onerror=alert(1)> stays text", app["text"])
        self.assertIn("javascript:alert(1)", app["text"])
        self.assertEqual(app["links"], [])
        self.assertEqual(app["imgs"], 0)

    def test_a_standalone_repository_has_no_plan_progress_not_zero(self):
        t = self.r["repos"]["tools"]
        self.assertIn("Plan progress: not available", t["noPlan"])
        self.assertIn("It is not 0%", t["noPlan"])
        self.assertEqual(t["langs"], ["Go", "Makefile"])
        self.assertEqual(t["feed"], ["commit", "commit"])

    def test_a_repository_opened_by_name_lasts_for_this_visit_only(self):
        o = self.r["repos"]["opened"]
        self.assertEqual(o["head"], "example-org/unlisted")
        self.assertEqual(o["tree"], ["p:~opened-1"])
        self.assertTrue(o["afterRefresh"])
        self.assertTrue(o["marked"])
        self.assertIn("owner/name", o["badName"])
        self.assertFalse(o["afterLeave"])

    def test_every_repository_the_token_reads_is_listed_and_marked_found(self):
        f = self.r["found"]
        ids = [x[0] for x in f["projects"]]
        self.assertEqual(ids, ["p:garden", "p:recipes", "p:~found-acme/found-code", "p:~found-acme/found-plan", "p:~found-beta/found-plan"],
                         "a listed repository is not repeated, whatever its case")
        labels = dict(f["projects"])
        self.assertEqual(labels["p:~found-acme/found-plan"], "acme/found-plan, found", "names that two owners share keep the owner")
        self.assertEqual(labels["p:~found-beta/found-plan"], "beta/found-plan, code only, found")
        self.assertEqual(labels["p:~found-acme/found-code"], "found-code, code only, found", "a found repository is named without its owner")
        self.assertEqual(f["planTasks"], ["XQ101", "XQ102", "XQ201"], "a found plan's tasks are read from its task table")
        self.assertIn("Found through the token", f["codeNoPlan"])
        self.assertIn("It is not 0%", f["codeNoPlan"])
        self.assertIn("Every repository the token can read is here", f["note"])
        rows = {r[0]: r[1] for r in f["rows"]}
        self.assertIn("found", rows["acme/found-code"])
        self.assertIn("found", rows["acme/found-plan"])
        self.assertEqual(f["deniedProjects"], ["p:garden", "p:recipes"], "a list that cannot be read adds nothing")
        self.assertIn("could not be read", f["denied"])
        self.assertEqual(f["emptyList"], ["p:~found-acme/found-code", "p:~found-acme/found-plan"], "an empty list is filled by what the token finds")
        self.assertTrue(f["emptyHead"])
        self.assertIn("the token finds no other repository", f["nothing"])
        for status, state in (("403", "denied"), ("500", "failed"), ("429", "rate-limited")):
            got = f["unread"][status]
            self.assertEqual(got[0], state, status)
            self.assertIn("could not be read (HTTP " + status + ")", got[1])
            self.assertNotIn("finds no other repository", got[1])
        self.assertEqual(f["moved"], ["p:~found-acme/found-code", "p:garden", "p:recipes", "p:~found-acme/found-plan"],
                         "a found repository can be moved for this visit")
        self.assertEqual(f["stored"], [["sandboard.projectOrder", '["garden","recipes"]']],
                         "no found repository's name is stored, only the listed projects' IDs")
        self.assertEqual(f["again"], ["p:garden", "p:recipes", "p:~found-acme/found-code", "p:~found-acme/found-plan"],
                         "signing in again puts the found repository back in its listed place")
        self.assertTrue(all(u.startswith("GET ") for u in f["urls"]))
        self.assertFalse(any("/users/" in u or "/events" in u or "/notifications" in u for u in f["urls"]))

    def test_only_the_owner_or_nothing_finds_the_one_plan_repository(self):
        d = self.r["discover"]
        self.assertEqual(d["owner"]["projects"][:2], ["p:garden", "p:recipes"], "the owner's one repository with the list is used")
        self.assertIsNone(d["owner"]["notice"])
        self.assertEqual(d["several"][0], "invalid")
        self.assertIn("more than one repository has it (acme/garden-plan, beta/second-plan)", d["several"][1])
        self.assertEqual(d["none"]["notice"][0], "no-plan", "a token with no workspace list still signs in, on its first found repository")
        self.assertEqual(d["none"]["projects"], ["p:~found-acme/garden", "p:~found-acme/garden-plan", "p:~found-acme/recipes", "p:~found-beta/second-plan"],
                         "every repository the token reads is shown, marked found")
        self.assertIn("No repository of nobody that the token reads has the workspace list", d["none"]["state"])
        self.assertIn("every repository the token reads is shown, marked found", d["none"]["state"])
        self.assertIn("only its owner, or nothing", d["bad"]["state"])
        self.assertTrue(d["bad"]["signedOut"])
        self.assertTrue(all(u.startswith("GET ") for u in d["urls"]))
        self.assertEqual(d["errors"], [])

    def test_a_search_that_is_not_complete_or_cannot_list_chooses_nothing(self):
        d = self.r["discover"]
        state, text = d["unchecked"]["notice"]
        self.assertEqual(state, "partial")
        self.assertIn("acme/garden-plan has it, but the search is not complete (these could not be checked: acme/locked)", text)
        self.assertIn("sign in with acme/garden-plan to use it", text)
        self.assertEqual(d["unchecked"]["projects"], [], "nothing is loaded from an incomplete search")
        for got, state in ((d["denied"], "denied"), (d["failed"], "failed")):
            self.assertEqual(got[0], state)
            self.assertIn("the token's list of repositories could not be read", got[1])
            self.assertIn("sign in with the plan repository as owner/repo", got[1])

    def test_refresh_searches_again_until_a_plan_repository_is_found(self):
        d = self.r["discover"]
        self.assertEqual(d["noneThenRefresh"]["state"], "Signed in. The token is in this page's memory only.",
                         "the note that no list was found goes once a refresh finds one")
        for key in ("noneThenRefresh", "failedThenRefresh", "refreshWhilelisting", "refreshWhilechecking"):
            self.assertEqual(d[key]["projects"][:2], ["p:garden", "p:recipes"], key)
            self.assertIsNone(d[key]["notice"], key)

    def test_repository_views_never_scroll_the_page_sideways(self):
        n = self.r["repos"]["narrow"]
        self.assertLessEqual(n["portfolio"], 320)
        self.assertLessEqual(n["activity"], 320)

    def test_history_draws_lanes_refs_and_branches_from_the_commits_read(self):
        d = self.r["history"]["demo"]
        self.assertEqual(d["focus"], "rs-history", "Right arrow moves to the History tab")
        self.assertIn("none of it is progress", d["notice"])
        rows = {r[0]: r for r in d["rows"]}
        self.assertEqual(len(d["rows"]), 8)
        self.assertEqual(d["rows"][0][3], ["read here: main", "main"])
        self.assertEqual(rows["94a4057"][2], "merge")
        self.assertEqual(rows["94a4057"][3], ["tag v0.2.0"])
        self.assertEqual(d["rows"][-1][2], "root")
        self.assertEqual({rows["2b2ee57"][1], rows["da7095a"][1], rows["adc73ab"][1]}, {"2", "1", "0"}, "diverging branches get lanes of their own")
        self.assertEqual(rows["2b2ee57"][3], ["feature/search"])
        self.assertIn("Search box <b>draft</b>", d["titles"])
        self.assertEqual(d["bold"], 0, "a commit title stays text")
        self.assertIn("this is the start of the history", d["coverage"])
        self.assertIn("The other 2 rows are compared branches' own commits", d["coverage"])
        self.assertEqual(d["branches"], [["feature/search", "2b2ee57", "No", "2", "4", "Diverged"], ["list-data", "da7095a", "No", "0", "3", "Behind"],
                                         ["main", "adc73ab", "Yes", "0", "0", "Identical"]])
        self.assertEqual(d["tags"], ["v0.1.035b718ein the history shown", "v0.2.094a4057in the history shown"])
        self.assertGreater(d["canvas"][0], 0)

    def test_history_zooms_fits_and_reads_older_commits_as_the_list_scrolls(self):
        h = self.r["history"]
        self.assertTrue(h["demo"]["zoomOut"])
        self.assertGreater(h["zoomed"]["rowHeight"], h["demo"]["rowHeight"])
        self.assertFalse(h["zoomed"]["zoomOut"])
        self.assertEqual(h["fit"]["rowHeight"], h["demo"]["rowHeight"])
        first, second = h["paged"]["first"], h["paged"]["second"]
        self.assertEqual(len(first["rows"]), 100)
        self.assertIn("Older commits are read as you scroll down the list", first["coverage"])
        self.assertTrue(first["older"], "a button reads the next page too, for the keyboard")
        self.assertEqual(len(second["rows"]), 140, "scrolling to the end read the next page")
        self.assertGreater(second["scrollTop"], 0, "the list keeps its place when more is read")
        self.assertIn("this is the start of the history", second["coverage"])
        self.assertFalse(second["older"])
        self.assertLessEqual(h["narrow"], 320)

    def test_history_says_what_it_could_not_read_and_only_reads(self):
        pr = self.r["history"]["private"]
        self.assertIn("1 line continues past the last row into commits not read", pr["first"]["open"])
        self.assertIn("No access", pr["first"]["branchesText"])
        self.assertEqual(pr["first"]["tags"], ["v0.10bb8400not in the commits read"])
        self.assertIn("The next page could not be read", pr["second"]["coverage"])
        self.assertFalse(pr["second"]["older"])
        urls = pr["urls"]
        self.assertTrue(all(u.startswith("GET ") for u in urls))
        self.assertFalse(any("/compare/" in u for u in urls), "nothing is compared when the branch list is refused")
        self.assertFalse(any(x in u for u in urls for x in ("/merges", "/git/", "/stats/", "/contributors", "/events")))

    def test_history_says_when_a_branch_has_no_lane(self):
        la = self.r["history"]["lanes"]
        self.assertEqual(la["laneNotes"], [
            ["dev", "failed", "dev: this branch's commits could not be read (Couldn't load), so it has no lane for its 4 commits ahead."],
            ["gone", "denied", "gone: this branch's commits could not be read (No access), so it has no lane for its 2 commits ahead."],
            ["empty", "empty", "empty: 1 commit ahead, none of them in the commits read, so it has no lane."]])
        self.assertEqual([r[0] for r in la["rows"]], ["31dc4b1"], "only the read commit is drawn")
        table = {row[0]: row[3:] for row in la["branches"]}
        self.assertEqual(table["dev"], ["4", "1", "Diverged"], "GitHub's counts stay in the table")
        self.assertEqual(table["gone"], ["2", "0", "Ahead"])

    def test_history_counts_cover_only_the_commits_read_and_name_logins_only(self):
        d = self.r["history"]["demo"]
        self.assertEqual(d["weeks"], 12)
        self.assertEqual(d["contributors"], ["demo-claude3 commits", "demo-owner2 commits"])
        self.assertIn("1 commit not linked to a GitHub account: counted, not named", d["unlinked"])
        self.assertGreater(d["heat"], 0)
        for word in ("Checkout", "Merge", "Delete", "Reset", "Create branch"):
            self.assertNotIn(word, d["controls"], "no control changes anything")

    def test_the_atlas_account_reads_nothing_until_asked_then_shows_profile_calendar_and_events(self):
        a = self.r["account"]
        self.assertEqual(a["parts"], ["atlas-part-account", [["Repository", "false"], ["Your account", "true"]], True, False, False],
                         "Right moves to Your account, which only offers to read")
        d = a["demo"]
        self.assertEqual([d["name"], d["login"], d["links"]], ["Demo User", "@demo-user", 0], "no profile page link without GitHub's address for it")
        self.assertIn("12 followers", d["meta"])
        self.assertIn("On GitHub since 2019", d["meta"])
        self.assertEqual(d["cells"], 91)
        self.assertEqual(d["levels"], ["ac-cell ac-l%d" % i for i in range(5)])
        self.assertEqual(d["labels"][-3:], ["Mon", "Wed", "Fri"])
        self.assertRegex(d["lastTip"], r"^\d+ actions? · \d{4}-\d\d-\d\d$")
        self.assertRegex(d["busiest"], r"^Busiest day: \d+ on \d{4}-\d\d-\d\d$")
        self.assertIn("by your local day", d["total"])
        self.assertGreater(d["days"], 10)
        self.assertEqual(len(d["mix"]), 5)
        self.assertEqual(d["mix"][0], "Pushes")
        self.assertEqual(len(d["feed"]), 9)
        self.assertTrue(all(re.search(r"\d{4}-\d\d-\d\d \d\d:\d\d$", x) for x in d["feed"]), d["feed"])
        self.assertFalse(d["gaps"] or d["retry"])
        self.assertEqual(a["daysOpen"], [True, d["days"]], "the days with activity, as a list by keyboard")
        self.assertEqual(a["extrasBefore"], [True, False, False], "starred repositories and gists only offered until asked for")
        st = a["stars"]
        self.assertEqual(st["count"], "5 repositories read")
        self.assertEqual(st["live"], "polite")
        self.assertEqual(len(st["shown"]), 5)
        self.assertIn("archived", st["shown"][3])
        self.assertIn("fork", st["shown"][4])
        self.assertEqual(a["gistHead"], "3 gists read")
        self.assertEqual(len(a["gists"]), 3)
        self.assertIn("2 files: notes.md (Markdown), plan.txt (Text)", a["gists"][1], "a gist without a description is named by its first file")
        self.assertIn("3 comments", a["gists"][2])
        self.assertEqual([a["starsSvg"]["count"], a["starsSvg"]["shown"], a["starsSvg"]["focus"]], ["1 of 5 repositories read", ["sample-labs/chart-bits"], "ac-star-q"],
                         "the starred list narrows by description as words are typed and the box keeps focus")
        self.assertEqual([a["starsKit"]["count"], len(a["starsKit"]["shown"])], ["2 of 5 repositories read", 2], "every word must match, in any case")
        self.assertEqual([a["starsNone"]["count"], a["starsNone"]["shown"]], ["0 of 5 repositories read", []])
        self.assertEqual([a["starsAll"]["count"], len(a["starsAll"]["shown"]), a["starsAll"]["focus"]], ["5 repositories read", 5, "ac-star-q"])
        self.assertFalse(a["vsBefore"]["table"] or a["vsBefore"]["said"], "nothing is compared until a login is given")
        for k, said in (("vsBad", "A GitHub login is 1 to 39 letters, digits or hyphens."), ("vsSelf", "That is your own account. Pick another one.")):
            self.assertEqual([a[k]["said"], a[k]["focus"], a[k]["invalid"], a[k]["table"]], [said, "ac-vs-q", "true", False], k)
        vs = a["vs"]
        self.assertEqual(vs["heads"], ["Round", "Demo User", "Sample Builder"])
        self.assertEqual([r[0] for r in vs["rows"]], ["Stars earned", "Public repositories", "Followers", "Actions, 90 days", "Best streak (days)",
                                                      "Languages", "Years on GitHub", "Active repositories, 30 days"])
        self.assertEqual(vs["rows"][0], ["Stars earned", "24", "163 won"], "stars from repositories that are not forks")
        self.assertEqual(vs["rows"][2], ["Followers", "12", "40 won"])
        self.assertEqual(vs["rows"][5], ["Languages", "3", "3"], "a tie is won by neither")
        wins_a = sum(r[1].endswith(" won") for r in vs["rows"]); wins_b = sum(r[2].endswith(" won") for r in vs["rows"])
        self.assertEqual(vs["score"], "Demo User %d – %d Sample Builder" % (wins_a, wins_b))
        self.assertEqual(vs["wins"], wins_a + wins_b)
        self.assertIn("by public numbers only", vs["verdict"])
        self.assertIn("Most starred: sample-builder/charts (★ 120)", vs["langs"][1])
        self.assertEqual([a["vsCleared"]["table"], a["vsCleared"]["focus"]], [False, "ac-vs-q"], "Compare with someone else goes back to the box")
        self.assertEqual(a["badgeBefore"], [True, False], "the README badge is only offered until asked for")
        b = a["badge"]
        # The demo's events are dated hours before now, so the best streak in local days depends on the hour the
        # test runs; the badge must show the comparison's own number.
        streak = vs["rows"][4][1].replace(" won", "")
        self.assertRegex(streak, r"^[0-9]+$")
        self.assertEqual([b["role"], b["label"]], ["img", "Demo User: 24 stars, 5 repos, 213 actions (90d), %sd best streak" % streak])
        self.assertEqual(b["texts"][2:10], ["24", "Stars", "5", "Repos", "213", "Actions (90d)", streak + "d", "Best streak"], "the same numbers as the comparison")
        self.assertIn("@demo-user · on GitHub since 2019", b["texts"])
        self.assertEqual([b["squares"], b["bg"], b["pressed"]], [91, "#0d1117", ["true", "false"]], "the last 13 weeks by local day, dark first")
        self.assertEqual([b["line"], b["dl"]], ["![GitHub stats](./github-stats-dark.svg)", "Download github-stats-dark.svg"])
        lt = a["badgeLight"]
        self.assertEqual([lt["bg"], lt["pressed"], lt["focus"], lt["line"]], ["#ffffff", ["false", "true"], "ac-badge-light", "![GitHub stats](./github-stats-light.svg)"],
                         "the colouring changes by keyboard and keeps focus")
        self.assertEqual(a["badgeFile"], {"name": "github-stats-light.svg", "start": "<svg", "script": False, "hasName": True, "svgNs": True},
                         "the download is a standalone SVG with no script or link")
        bp = a["badgePartial"]
        self.assertEqual([bp["texts"][4], bp["texts"][6], bp["texts"][8]], ["100+", "100+", "1d+"], "each lower bound marked on the picture, the streak too")
        self.assertEqual(bp["texts"][2], "100+", "stars from a cut list are a lower bound")
        self.assertEqual(bp["note"], "+ means at least: not all of GitHub's lists were read; languages from the repositories read")
        self.assertIn("+ means at least", bp["label"])
        self.assertTrue(a["badgePartialFile"], "the downloaded picture carries the note too")
        self.assertIn("Your public repositories (100 read): A later page could not be read (HTTP 500), so some are missing.", bp["gaps"])
        self.assertIn("Your public events (100 read): A later page could not be read (HTTP 500), so some are missing.", bp["gaps"])
        self.assertNotIn("most recently pushed", bp["gaps"], "a failure is not called the deliberate cap")
        self.assertTrue(bp["retry"])
        bw = a["badgeWhole"]
        self.assertEqual([bw["texts"][2], bw["texts"][4], bw["texts"][6], bw["note"], bw["gaps"], bw["retry"]], ["100", "100", "100", None, None, False],
                         "after Read again the numbers are exact and nothing is qualified")
        ev, rp = "GET /users/synthetic-user/events/public?per_page=100&page=", "GET /users/synthetic-user/repos?sort=pushed&per_page=100&page="
        self.assertEqual(sorted(a["badgeUrls"]), sorted(["GET /users/synthetic-user", ev + "1", ev + "2", rp + "1", rp + "2", ev + "1", ev + "2", rp + "1", rp + "2"]),
                         "Read again reads only the two failed lists again; the profile once")
        self.assertEqual(a["badgeMethods"], ["GET"])
        self.assertRegex(a["badgeCopy"], r"^(Copied\. Nothing was sent anywhere\.|Copy didn't work here)")
        self.assertEqual(a["phone"], 0, "no sideways page scroll on a phone")
        self.assertEqual(a["goto"][0], "Your account (Atlas)Atlas")
        self.assertEqual(a["gotoShown"], ["true", "true", True])
        self.assertEqual(a["afterForget"], ["true", True, False], "signing out goes back to Repository and forgets the ask and what was read")
        self.assertEqual(a["before"], 0, "nothing about the account is read before it is asked for")
        f = a["failed"]
        self.assertIn("Your public events could not be read (HTTP 500)", f["text"])
        self.assertTrue(f["retry"])
        self.assertEqual([f["imgs"], f["links"], f["name"], f["cells"]], [0, [], "<img src=x onerror=alert(1)>", 0],
                         "GitHub's text stays text; a profile page elsewhere and the website are never linked")
        self.assertIn("javascript:alert(1)", f["text"])
        later = a["later"]
        self.assertTrue(later["retry"], "a later page that failed can be read again")
        self.assertIn("A later page of events could not be read (HTTP 500)", later["gaps"])
        self.assertIn("Pushed 2 commits to acme/garden", later["text"])
        self.assertIn("<img src=x onerror=alert(1)>", later["name"], "the profile stays while the events are read again")
        g = a["again"]
        self.assertFalse(g["retry"])
        self.assertIsNone(g["gaps"])
        self.assertEqual(g["cells"], 91)
        self.assertIn("101 events read", g["text"])
        ev = "GET /users/synthetic-user/events/public?per_page=100&page="
        self.assertEqual(a["urls"], ["GET /users/synthetic-user", ev + "1", ev + "1", ev + "2", ev + "1", ev + "2"],
                         "Read again reads only the events again; the profile is read once")
        ef = a["extrasFailed"]
        self.assertIn("Your public gists could not be read (HTTP 500)", ef["text"])
        self.assertIn("1 repository not in the expected form was left out", ef["text"])
        self.assertIn("<img src=x onerror=alert(2)>", ef["text"], "GitHub's description stays text")
        self.assertEqual([ef["retry"], ef["imgs"], ef["links"], ef["gists"]], [True, 0, [], 0], "a starred page address that is not https is never linked")
        ea = a["extrasAgain"]
        self.assertEqual([ea["retry"], ea["imgs"], ea["gists"]], [False, 0, 2])
        self.assertEqual(ea["gistFiles"], ["1 file: a.txt (Text)", "At least 2 files: b.txt (Text), c.txt, and more GitHub did not list"],
                         "a gist whose file list GitHub cut says its count is only a lower bound; a complete one does not")
        self.assertEqual(ea["links"], ["https://gist.example.invalid/synthetic-user/abc123"])
        self.assertIn("1 gist not in the expected form was left out", ea["text"])
        self.assertEqual(a["extraUrls"], ["GET /users/synthetic-user/starred?per_page=100&page=1", "GET /users/synthetic-user/gists?per_page=100&page=1",
                                          "GET /users/synthetic-user/gists?per_page=100&page=1"], "Read again reads only the gists again")
        self.assertIn("Cannot compare: @synthetic-other's public profile (HTTP 404) could not be read.", a["vsFail"][0])
        self.assertEqual(a["vsFail"][1:], [True, False], "a comparison that cannot be read offers Read again and shows no table")
        self.assertEqual(a["vsUrls"], ["GET /users/synthetic-other", "GET /users/synthetic-other/events/public?per_page=100&page=1",
                                       "GET /users/synthetic-other/repos?sort=pushed&per_page=100&page=1", "GET /users/synthetic-other/repos?sort=pushed&per_page=100&page=2",
                                       "GET /users/synthetic-user/repos?sort=pushed&per_page=100&page=1"])
        vp = a["vsPartial"]
        self.assertTrue(vp["retry"], "a later page that failed can be read again")
        self.assertIn("synthetic-other's public repositories: A later page could not be read (HTTP 500), so some are missing.", vp["gaps"])
        self.assertNotIn("most recently pushed", vp["gaps"], "a failure is not called the deliberate 300 cap")
        self.assertEqual(vp["rows"][1], ["Public repositories", "1", "at least 100 won"], "at least 100 is sure to beat 1")
        self.assertEqual(vp["rows"][0], ["Stars earned", "2", "at least 0"], "2 is not sure to beat a lower bound")
        vw = a["vsWhole"]
        self.assertEqual([vw["retry"], vw["gaps"]], [False, None])
        self.assertEqual(vw["rows"][0], ["Stars earned", "2 won", "0"])
        self.assertEqual(vw["rows"][1], ["Public repositories", "1", "101 won"])
        self.assertEqual(a["methods"], ["GET"])

    def test_projects_can_be_put_in_order_by_dragging_or_the_keyboard_and_it_is_kept_in_this_browser_only(self):
        o = self.r["order"]
        start = o["start"]
        self.assertGreaterEqual(len(start), 3)
        self.assertEqual(sorted(o["draggable"]), sorted(start), "only projects can be dragged")
        self.assertEqual(o["dragged"], [start[-1]] + start[:-1], "the last project dragged above the first")
        self.assertRegex(o["dragLive"], r"^Moved .+ to place 1 of %d\.$" % len(start))
        self.assertEqual(o["marks"], 0, "the drop line goes when the drag ends")
        d = o["dragged"]
        self.assertEqual(o["keyed"], [d[1], d[0]] + d[2:], "Alt+Down moves the project one place")
        self.assertRegex(o["keyLive"], r"to place 2 of %d\.$" % len(start))
        self.assertEqual(o["focus"], d[0], "the moved project keeps focus")
        self.assertEqual(o["atTop"], o["keyed"], "Alt+Up on the first project changes nothing")
        self.assertEqual(o["storage"], [["sandboard.projectOrder", json.dumps([x[2:] for x in o["keyed"]], separators=(",", ":"))]],
                         "only the project IDs are stored, under one key")
        self.assertEqual(o["reloaded"], o["keyed"], "the order survives a reload in the same browser")

    def test_work_evidence_tabs_list_pull_requests_with_reviews_at_their_own_commit(self):
        w = self.r["work"]
        self.assertEqual(w["pulls"]["tabs"], ["Overview", "History", "Pull requests", "Issues", "Actions", "Releases", "Files"])
        self.assertEqual(w["pulls"]["focus"], "rs-pulls", "Right arrow moves from History to Pull requests")
        self.assertIn("none of it is progress", w["pulls"]["notice"])
        self.assertEqual([r[0] for r in w["pulls"]["pulls"]], ["#6", "#2"])
        self.assertEqual(w["pulls"]["pulls"][0][1:3], ["Search screen <b>draft</b>", "Draft"])
        self.assertEqual(w["pulls"]["bold"], 0, "a title stays text")
        self.assertEqual(w["evidence"]["reviews"], [["CHANGES_REQUESTED", "older"], ["COMMENTED", "older"], ["APPROVED", "head"]])
        self.assertIn("At the head adc73ab: 1 approval, 0 requests for changes. 1 review at an older commit does not count for the head.", w["evidence"]["reviewText"])
        self.assertIn("3 check runs: 1 passing, 1 not passing, 1 running or queued", w["evidence"]["checks"])
        self.assertEqual(w["evidence"]["focus"], "2", "focus stays on the button that opened the evidence")
        self.assertEqual([r[2] for r in w["closed"]["pulls"]], ["Merged2025-12-10 10:00 UTC", "Closed without merging"])
        z = w["zone"]
        self.assertEqual([r[2] for r in z["pulls"]], ["Merged2025-12-10 13:00 UTC+3", "Closed without merging"],
                         "a viewer in UTC+3 sees the merge time in their own zone")
        self.assertIn("Updated (your time)", z["heads"])
        self.assertTrue(z["updated"] and all(t.endswith(" UTC+3") and t.startswith(x) for x, t in z["updated"]), z["updated"])
        self.assertIn("evidence, not the owner's approval", w["pulls"]["text"])
        for word in ("Merge", "Approve", "Comment", "Close", "Review"):
            self.assertNotIn(word, w["evidence"]["controls"], "no control changes anything")

    def test_work_evidence_keeps_issues_runs_and_releases_apart_and_honest(self):
        w = self.r["work"]
        self.assertEqual([r[0] for r in w["issues"]["issues"]], ["#9", "#8"])
        self.assertEqual(w["issues"]["issuePulls"], "2 pull requests in GitHub's issue list are left to Pull requests.")
        self.assertEqual([r[2] for r in w["issuesAll"]["issues"]][2:], ["Closed: not plannedClosed 2026-01-05 12:00 UTC",
                         "Closed: completedClosed 2025-12-10 10:00 UTC", "Closed: duplicateClosed 2025-12-03 13:00 UTC"])
        runs = w["runs"]["runs"]
        self.assertEqual([r[:2] for r in runs], [["in_progress", "pending"], ["queued", "pending"], ["completed", "failure"],
                                                 ["completed", "success"], ["completed", "cancelled"], ["completed", "skipped"]])
        for r in runs[:2]:
            self.assertTrue(r[2].startswith("Not finished: no result yet"), "a run not finished is never a success")
        self.assertEqual(w["runs"]["runTotal"], "6 runs read of the 6 GitHub counts.")
        self.assertIn("No run is started, rerun or cancelled from here", w["runs"]["text"])
        self.assertIn("not readable with this token (Actions: read)", w["planRuns"]["text"])
        self.assertEqual(w["releases"]["releases"], ["v0.3.0", "v0.2.0", "v0.1.0"])
        self.assertEqual(w["releases"]["assets"], ["demo-app-0.2.0.zip 180.0 KB, 12 downloads, no GitHub download address",
                                                   "checksums.txt 164 bytes, 3 downloads, no GitHub download address"])
        self.assertEqual(w["releases"]["linkCount"], 0, "the demo gives no web address, so nothing links")
        self.assertLessEqual(w["narrowRuns"], 320)

    def test_the_inbox_lists_your_own_open_work_in_the_mapped_repositories_only(self):
        i = self.r["work"]["inbox"]
        self.assertEqual((i["mine"], i["review"], i["assigned"]), (["example-org/demo-app#6"], ["example-org/demo-app#2"], ["example-org/demo-app#9"]))
        self.assertIn("in 9 mapped repositories", i["notice"], "the two that could not be read stay in the count")
        self.assertIn("GitHub notifications and repositories outside your projects are not read", i["notice"])
        self.assertEqual([c.split(":")[0] for c in i["coverage"] if "so its lists are not read" in c], ["example-org/locked-plan", "example-org/locked-app"])
        self.assertTrue(any("a review asked of a team is not counted as asked of you" in c for c in i["coverage"]))
        self.assertLessEqual(self.r["work"]["narrowInbox"], 320)
        pr = self.r["work"]["private"]["inbox"]
        self.assertEqual((pr["mine"], pr["review"], pr["assigned"]), (["acme/garden#200"], ["acme/garden#7"], ["acme/garden#300"]))
        self.assertIn("acme/garden-plan: open pull requests not available (not readable with this token (Pull requests: read)), not read", pr["coverage"])
        self.assertIn("acme/garden: only the latest 100 open pull requests were read", pr["coverage"])
        self.assertIn("in 3 mapped repositories", pr["notice"], "a mapped repository that could not be read stays in the count")
        self.assertTrue(any(c.startswith("acme/recipes: the repository could not be read (") and c.endswith("so its lists are not read") for c in pr["coverage"]), pr["coverage"])
        self.assertFalse(any("/acme/recipes/pulls" in u or "/acme/recipes/issues" in u for u in self.r["work"]["private"]["urls"]),
                         "an unreadable repository's lists are never read")

    def test_work_evidence_on_a_private_run_links_out_says_what_it_could_not_read_and_only_reads(self):
        pr = self.r["work"]["private"]
        first = pr["first"]
        self.assertEqual(len(first["pulls"]), 100)
        self.assertEqual(first["pulls"][0][1], "XQ101 layout <b>now</b> · names XQ101")
        self.assertEqual(first["pulls"][2][2], "Draft")
        self.assertIn("Older ones are read only when you ask", first["coverage"])
        self.assertTrue(first["older"])
        self.assertEqual(first["links"][0], ["https://github.example.invalid/acme/garden/pull/200", "_blank", "noopener noreferrer"])
        self.assertTrue(first["linksSafe"])
        self.assertEqual(pr["evidence"]["reviews"], [["APPROVED", "older"]])
        self.assertIn("0 approvals", pr["evidence"]["reviewText"], "an approval at an older commit is not one of the head")
        self.assertIn("1 check run: 0 passing, 0 not passing, 1 running or queued", pr["evidence"]["checks"])
        self.assertIn("not readable with this token (Pull requests: read)", pr["denied"])
        self.assertIn("The next page could not be read", pr["second"]["coverage"])
        self.assertEqual(len(pr["second"]["pulls"]), 100, "what was read stays shown")
        self.assertFalse(pr["second"]["older"])
        self.assertIn("not readable with this token (Actions: read)", pr["runs"]["text"])
        self.assertEqual(pr["releases"]["links"], [["https://github.example.invalid/acme/garden/releases/tag/v1.0", "_blank", "noopener noreferrer"],
                                                   ["https://github.com/acme/garden/releases/download/v1.0/b.zip", "_blank", "noopener noreferrer"]],
                         "a release links to its page; an asset links only to GitHub's own download address for the repository")
        self.assertIn("a.zip 10 bytes, 1 download, no GitHub download address", pr["releases"]["text"])
        po = pr["prOnly"]
        self.assertEqual(po["issues"], [])
        self.assertEqual(po["empty"], None, "a page of pull requests only is not an empty list")
        self.assertIn("No issues in the 1 page read. That is not the whole list", po["noneRead"])
        self.assertEqual(po["issuePulls"], "100 pull requests in GitHub's issue list are left to Pull requests.")
        self.assertIn("Older ones are read only when you ask", po["coverage"])
        self.assertTrue(po["older"])
        self.assertEqual([r[0] for r in pr["prOnlyNext"]["issues"]], ["#12"], "the issue on page 2 is reachable")
        self.assertIn("to the end of GitHub's list", pr["prOnlyNext"]["coverage"])
        cr = pr["countedRuns"]
        self.assertEqual(cr["empty"], None, "runs GitHub counts are never shown as none")
        self.assertIn("No runs in the 1 page read. That is not the whole list", cr["noneRead"])
        self.assertIn("GitHub counts 5 runs but its last page read was short of that", cr["coverage"])
        self.assertEqual(cr["runTotal"], "0 runs read of the 5 GitHub counts.")
        self.assertFalse(cr["older"])
        urls = pr["urls"]
        self.assertTrue(all(u.startswith("GET ") for u in urls))
        self.assertFalse(any(x in u for u in urls for x in ("/merge", "/rerun", "/cancel", "/assets/", "/notifications", "/user/issues", "/search/", "/statuses/")))

    def test_files_show_the_tree_and_text_at_the_pinned_commit_with_nothing_run_or_linked(self):
        c = self.r["code"]
        self.assertEqual(c["tree"]["tabs"][-1], "Files")
        self.assertEqual(c["tree"]["focus"], "rs-files", "Right arrow moves from Releases to Files")
        self.assertRegex(c["tree"]["notice"], r"Files read at main → [0-9a-f]{7}")
        self.assertIn("nothing in it runs", c["tree"]["notice"])
        self.assertEqual(c["tree"]["tree"], [["assets", "false", None], ["docs", "false", None], ["src", "false", None], ["vendor", "false", None], ["README.md", None, None]],
                         "folders first and closed, then files")
        self.assertEqual(c["tree"]["coverage"], "11 files and 4 folders: the whole tree GitHub lists at this commit.")
        self.assertEqual([x[0] for x in c["opened"]["tree"]][2:6], ["src", "src/access.js", "src/app.js", "src/list.js"], "Enter opens a folder")
        self.assertEqual(c["opened"]["focus"], "src", "focus stays on the folder")
        a = c["access"]
        self.assertEqual(a["focus"], "src/access.js")
        self.assertIn(["src/access.js", None, "true"], a["tree"])
        self.assertEqual(a["hidden"], ["U+202E", "U+2066", "U+2069", "U+2066"], "direction marks are shown by their code")
        self.assertEqual(a["lines"][2], '  if (role !== "ownerU+202E U+2066// owner onlyU+2069 U+2066") {')
        self.assertIn("4 hidden characters", a["hiddenNote"])
        self.assertIn("7 lines, 213 bytes", a["meta"])
        self.assertIn("matched to GitHub's hash", a["meta"])
        self.assertEqual(c["html"]["lines"][1:4], ['<script>document.title = "ran";</script>', '<img src="x" onerror="document.title = \'ran\'">',
                                                   '<a href="javascript:alert(1)">Open the plan</a>'])
        self.assertEqual(c["links"]["lines"][2], "[Open the plan](javascript:alert(1))")
        for k in ("access", "html", "links"):
            self.assertEqual(c[k]["preTags"], ["DIV", "SPAN"], "only rows and text spans, never markup from the file")
            self.assertEqual(c[k]["active"], 0, "no image, frame, script, object or link from the file")
            self.assertEqual(c[k]["links"], [], "the demo gives no web address, so nothing links")
        self.assertEqual((c["startTitle"], c["titleAfter"]), ("Sandboard", "Sandboard"), "no script from a file ran")

    def test_files_that_cannot_be_shown_as_text_say_why(self):
        k = self.r["code"]["kinds"]
        expect = {"docs/latest.md": "Link not followed", "docs/Meeting notes.txt": "Path not opened", "vendor/ui-kit": "Another repository",
                  "assets/intro.mp4": "Too large to show", "assets/data.bin": "Not shown as text"}
        for path, title in expect.items():
            self.assertEqual(k[path]["state"], "unavailable", path)
            self.assertIn(title, k[path]["viewer"], path)
            self.assertEqual(k[path]["lines"], [], path)
        self.assertIn("27 bytes, blob", k["assets/data.bin"]["viewer"])
        self.assertIn("50.0 MB", k["assets/intro.mp4"]["viewer"])
        f = self.r["code"]
        self.assertEqual(f["find"]["found"], ["src/list.js"])
        self.assertEqual(f["find"]["focus"], "code-q", "typing keeps the search focused")
        self.assertEqual(f["found"]["tree"], [["src/list.js", None, "true"]])
        self.assertEqual(f["found"]["lines"][0], "// The task list, read from the plan's progress file.")
        self.assertIn("example-org/demo-app files (Demo Project)", f["goto"][0])
        self.assertEqual((f["narrowFiles"], f["narrowChanges"]), (320, 320), "no sideways page scroll at 320 px")

    def test_changes_show_the_commit_or_a_comparison_and_never_a_guessed_ref(self):
        c = self.r["code"]
        ch = c["changes"]
        self.assertEqual(ch["files"], [["src/list.js", "Changed", "+4", "−1"], ["src/access.js", "Added", "+7", "−0"], ["docs/untrusted.html", "Added", "+5", "−0"],
                                       ["docs/links.mdfrom docs/old-links.md", "Renamed", "+1", "−1"], ["assets/data.bin", "Added", "+0", "−0"]])
        self.assertRegex(ch["changes"], r"Changes in main → [0-9a-f]{7}Feature list screen Against its parent [0-9a-f]{7}\.")
        self.assertEqual(ch["pressed"], "src/list.js", "the first file's diff is shown")
        self.assertEqual(ch["kinds"], ["hunk", "ctx", "del", "add", "add", "add", "add"])
        self.assertEqual(c["diff"]["hidden"], ["U+202E", "U+2066", "U+2069", "U+2066"])
        self.assertEqual(c["diff"]["focus"], "src/access.js", "focus stays on the file picked")
        self.assertEqual(c["diffHtml"]["lines"][2], '<script>document.title = "ran";</script>')
        self.assertEqual((c["diffHtml"]["preTags"], c["diffHtml"]["active"]), (["DIV", "SPAN"], 0))
        self.assertEqual(c["diffBin"]["state"], "unavailable")
        self.assertIn("No text diff", c["diffBin"]["changes"])
        cmp = c["compare"]
        self.assertRegex(cmp["changes"], r"Changes from v0\.2\.0 → [0-9a-f]{7} to main → [0-9a-f]{7}")
        self.assertIn("main is 1 commit ahead of v0.2.0 and 0 commits behind it", cmp["source"])
        self.assertIn("common ancestor", cmp["source"])
        self.assertIn("GitHub finds no branch, tag or commit called “no-such-ref”", c["missing"]["changes"])
        self.assertIn("Nothing else is compared in its place.", c["missing"]["changes"])
        self.assertEqual(c["missing"]["files"], [], "nothing is compared in its place")
        self.assertEqual(c["badRef"]["status"], "Type a branch, tag or commit made of letters, digits, dots, dashes, underscores and slashes.")
        self.assertEqual(c["badRef"]["against"], "a b", "what was typed stays to be corrected")
        self.assertRegex(c["own"]["changes"], r"Changes in main → [0-9a-f]{7}")

    def test_files_on_a_private_run_link_out_say_what_github_cut_and_only_read(self):
        pv = self.r["code"]["private"]
        self.assertIn("GitHub cut its list of this tree at 3 entries", pv["tree"]["coverage"])
        self.assertEqual(pv["tree"]["tree"][0][0], "deep")
        f = pv["file"]
        self.assertEqual(f["lines"], ['Visit https://example.invalid/phish and <a href="javascript:alert(1)">this</a>'])
        self.assertEqual(f["links"], [["https://github.example.invalid/acme/garden/blob/" + self.code_commit() + "/src/main.js", "_blank", "noopener noreferrer"]],
                         "only the file's own page on GitHub links; no address in the text does")
        ch = pv["changes"]
        self.assertIn("A merge commit: shown against its first parent", ch["changes"])
        self.assertIn("GitHub lists at most 300 changed files in one reply. These are the first 300 files; the rest are not shown.", ch["changeCoverage"])
        self.assertEqual(ch["links"], [["https://github.example.invalid/acme/garden/commit/" + self.code_commit(), "_blank", "noopener noreferrer"]])
        cmp = pv["compare"]
        self.assertIn("main is 3 commits ahead of release", cmp["source"])
        self.assertEqual(cmp["lines"], ["@@ -1 +1,2 @@", "x", "https://example.invalid/more"])
        self.assertEqual(cmp["changeCoverage"], "1 file changed: the whole list GitHub gives.",
                         "a comparison's next page lists commits, so it never makes its files partial")
        nf = pv["noFiles"]
        self.assertIn("“nofiles” could not be read (no well-formed list of changed files). Nothing else is compared in its place.", nf["changes"])
        self.assertNotIn("No file changed", nf["changes"])
        self.assertEqual(nf["files"], [])
        self.assertEqual(len(cmp["links"]), 1)
        self.assertIn("/compare/", cmp["links"][0][0])
        self.assertEqual(pv["denied"]["treeState"], "denied")
        self.assertEqual(pv["denied"]["viewer"], "", "no file to pick without a tree")
        urls = pv["urls"]
        self.assertTrue(all(u.startswith("GET https://api.github.com/") for u in urls))
        code = [u for u in urls if "/git/trees/" in u or "/contents/src" in u or "/compare/" in u or "/commits/release" in u or u.endswith("/commits/" + self.code_commit())]
        self.assertEqual(len(code), len(set(code)), "each code read once")
        self.assertEqual(sum("/git/trees/" in u for u in urls), 2)
        self.assertFalse(any(x in u for u in urls for x in ("/git/blobs", "/tarball", "/zipball", "/raw", "/merges", "/git/refs")))

    @staticmethod
    def code_commit():
        return hashlib.sha1(b"code-main").hexdigest()  # F.CODE_COMMIT in tests/js/fixtures.js

    def test_framed_page_refuses_to_show(self):
        self.assertEqual(self.r["framed"], {"state": "This page cannot be shown inside another site.", "shell": "hidden"})

    def test_settings_keep_density_and_accent_in_this_browser_only(self):
        look = self.r["look"]
        self.assertEqual(look["before"], ["", "", 0], "nothing stored before a choice")
        self.assertTrue(look["open"])
        self.assertEqual((look["focused"], look["checked"]), ("violet", ["violet"]))
        self.assertEqual(look["after"], ["compact", "violet", "#5f42a3"])
        self.assertEqual(look["stored"], [["sandboard.look", '{"density":"compact","accent":"violet"}']])
        self.assertEqual(look["reloaded"], ["compact", "violet"])
        self.assertEqual(look["junk"], ["", ""])
        self.assertGreaterEqual(len(look["marks"]), 5)
        self.assertEqual([m for m in look["marks"] if not m[1]], [], "every status mark's ring is drawn in its status colour")

    def test_home_shows_every_project_on_one_page(self):
        home = self.r["home"]
        self.assertEqual(home["first"], ["a:home", "Home, 2 waiting on someone"], "Home leads the tree with its waiting count")
        self.assertIn(home["head"], ["Good morning", "Good afternoon", "Good evening"])
        self.assertEqual(home["counts"], ["5", "12", "4", "1"])
        self.assertEqual(home["rows"], ["demo", "second", "notes", "kit", "locked", "tools"], "one row per project, in tree order")
        self.assertEqual(home["tabs"], [["In review1", "true"], ["Blocked1", "false"], ["In progress3", "false"]])
        self.assertEqual(home["blocked"], ["Blocked"])
        self.assertTrue(home["days"])
        self.assertEqual(home["markup"], [True, 0], "a title from GitHub stays text")
        self.assertEqual(home["inline"], ["width: 14%;"], "the bar width is set from script, never as markup")
        self.assertIn(home["phone"][0], ["Good morning", "Good afternoon", "Good evening"])
        self.assertTrue(home["phone"][1], "no sideways page scroll on a phone")
        self.assertEqual(home["opened"], "Demo Project")

    def test_task_views_lay_out_the_same_rows_and_date_tasks_only_by_activity(self):
        tv = self.r["taskViews"]
        self.assertEqual(tv["layouts"][0], ["List", "true"], "the list stays the default")
        self.assertEqual([x[0] for x in tv["layouts"]], ["List", "Board", "Table", "Timeline", "Calendar"])
        self.assertEqual(tv["focus"], "layout-board")
        self.assertEqual([c[1] for c in tv["board"]], [4, 2, 1, 1, 3, 4])
        self.assertEqual(tv["draggable"], 0, "nothing on the board can be dragged")
        self.assertEqual(tv["filtered"], ["DT402", "DT601", "DT201", "DT201.1", "DT103", "DT101", "DT203", "DT302"], "the filters apply")
        self.assertEqual(tv["table"], 15)
        self.assertEqual(tv["bars"], ["DT101", "DT103", "DT201", "DT201.1"], "only tasks the activity read names get a bar")
        self.assertTrue(tv["barStyle"], "positions are set from script as plain percentages")
        self.assertEqual(tv["months"], ["Jan 2026"])
        self.assertEqual(tv["picked"], 1, "a bar opens the task's details")
        self.assertEqual((tv["month"], tv["chips"]), ("January 2026", 19))
        self.assertEqual(tv["next"], ["February 2026", 0, "cal-next"])
        self.assertTrue(tv["phone"], "no sideways page scroll on a phone")

    def test_text_grows_a_little_with_the_screen(self):
        size = {w: [float(v[:-2]) for v in vals] for w, vals in self.r["textSize"].items()}
        self.assertEqual(size["390"], [16, 14], "phones keep the browser's own size")
        self.assertGreater(size["1280"][1], 14)
        self.assertEqual(size["1920"], [16.96, 14.84], "never more than 6% above it")


@unittest.skipUnless(PLAYWRIGHT, "Node.js and Playwright are needed for the browser checks")
class LiveSiteCheckTest(unittest.TestCase):
    """The published-site check (tests/browser/live.check.js) run against a local copy served
    under a sub-path, as GitHub Pages serves a project site, so it keeps working between releases."""

    CHECKS = [
        "served files equal the reviewed build", "first visit is signed out", "nothing stored on first visit",
        "a task tab stays with its own project", "nothing stored while connected", "a new tab starts signed out",
        "reload signs out", "back after leaving stays signed out", "forward and back again stays signed out",
        "the back/forward cache restored the page", "a page restored from the back/forward cache is signed out",
        "Forget access clears everything", "a revoked token clears everything", "a revoked token is reported",
        "framed page refuses to show", "every connect opened the synthetic private project",
        "no page errors or dialogs", "no request to any other host", "GitHub API requests are GET only",
    ]

    @classmethod
    def setUpClass(cls):
        import functools
        import sys
        import threading
        from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
        sys.path.insert(0, os.path.join(ROOT, "scripts"))
        import build
        cls.tmp = tempfile.TemporaryDirectory()
        cls.dist = os.path.join(cls.tmp.name, "dist")
        assert build.build(cls.dist) == []
        cls.served = os.path.join(cls.tmp.name, "site", "sandboard")
        shutil.copytree(cls.dist, cls.served)

        class Quiet(SimpleHTTPRequestHandler):
            def log_message(self, *args):
                pass

        handler = functools.partial(Quiet, directory=os.path.join(cls.tmp.name, "site"))
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.site = "http://127.0.0.1:%d/sandboard/" % cls.server.server_address[1]

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.tmp.cleanup()

    def run_check(self):
        done = subprocess.run(["node", os.path.join(HERE, "browser", "live.check.js"), PLAYWRIGHT, self.site, self.dist],
                              capture_output=True, text=True, timeout=300, cwd=ROOT)
        return done.returncode, json.loads(done.stdout or "{}"), done.stderr[-2000:]

    def test_the_published_site_check_passes_on_the_reviewed_build(self):
        code, r, err = self.run_check()
        self.assertNotIn("crashed", r, err)
        self.assertEqual([c["name"] for c in r["checks"]], self.CHECKS)
        self.assertEqual([c["name"] for c in r["checks"] if not c["pass"]], [])
        self.assertTrue(r["pass"])
        self.assertEqual(code, 0)
        self.assertNotIn(self.site, json.dumps(r), "the output never names the site")

    def serve_changed(self, name, change):
        """Run the check with one served file changed, and put it back afterwards."""
        path = os.path.join(self.served, name)
        with open(path, "rb") as f:
            original = f.read()
        try:
            with open(path, "wb") as f:
                f.write(change(original))
            code, r, _ = self.run_check()
        finally:
            with open(path, "wb") as f:
                f.write(original)
        return code, r, {c["name"]: c for c in r["checks"]}

    def test_a_served_file_that_is_not_the_reviewed_build_fails_the_check(self):
        code, r, by = self.serve_changed("style.css", lambda b: b + b"\n/* changed after review */\n")
        served = by["served files equal the reviewed build"]
        self.assertFalse(served["pass"])
        self.assertIn("style.css", served["detail"])
        self.assertFalse(r["pass"])
        self.assertEqual(code, 1)

    def test_a_page_restored_from_the_cache_with_its_private_views_fails_the_check(self):
        listeners = (b'  window.addEventListener("pagehide", () => endSession("left"));\n',
                     b'  window.addEventListener("pageshow", e => { if (e.persisted) endSession("restored"); });\n')

        def without_listeners(b):
            for line in listeners:
                self.assertIn(line, b)
                b = b.replace(line, b"")
            return b

        code, r, by = self.serve_changed("app.js", without_listeners)
        self.assertTrue(by["the back/forward cache restored the page"]["pass"])
        self.assertFalse(by["a page restored from the back/forward cache is signed out"]["pass"])
        self.assertIn("Example Garden", by["a page restored from the back/forward cache is signed out"]["detail"])
        # Ordinary navigation reloads the page, so it cannot tell this apart.
        self.assertTrue(by["back after leaving stays signed out"]["pass"])
        self.assertFalse(r["pass"])
        self.assertEqual(code, 1)


if __name__ == "__main__":
    unittest.main()
