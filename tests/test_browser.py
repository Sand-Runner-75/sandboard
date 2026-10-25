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
        self.assertEqual(f["itemsCollapsed"], ["g:projects", "p:demo", "p:second", "p:notes", "p:kit", "p:locked", "p:tools"])

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
        self.assertFalse(f["hoverTip"][0])
        self.assertIn("Dropped from the plan", f["hoverTip"][1])
        self.assertTrue(f["escHides"])
        self.assertEqual(f["detailsStillOpen"], 1, "the first Esc only hides the bubble")
        self.assertEqual(f["focusTip"], [False, "tip"])
        for word in ("Removed", "Verified", "To be estimated", "Original plan notes", "Cross-references"):
            self.assertIn(word, f["glossary"])

    def test_framed_page_refuses_to_show(self):
        self.assertEqual(self.r["framed"], {"state": "This page cannot be shown inside another site.", "shell": "hidden"})


if __name__ == "__main__":
    unittest.main()
