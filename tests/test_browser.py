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
        self.assertEqual((p["scripts"], p["imgs"]), (10, 0))
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
        self.assertEqual(f["itemsCollapsed"], ["g:projects", "p:demo", "p:second", "p:notes", "p:kit", "p:locked", "p:tools", "g:account", "a:portfolio", "a:activity"])

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
        self.assertFalse(any("/users/" in u or "/events" in u or "/user/repos" in u for u in pr["urls"]), "no account-wide read")

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
        self.assertEqual({rows["2b2ee57"][1], rows["da7095a"][1], rows["9c65a9a"][1]}, {"2", "1", "0"}, "diverging branches get lanes of their own")
        self.assertEqual(rows["2b2ee57"][3], ["feature/search"])
        self.assertIn("Search box <b>draft</b>", d["titles"])
        self.assertEqual(d["bold"], 0, "a commit title stays text")
        self.assertIn("this is the start of the history", d["coverage"])
        self.assertIn("The other 2 rows are compared branches' own commits", d["coverage"])
        self.assertEqual(d["branches"], [["feature/search", "2b2ee57", "No", "2", "4", "Diverged"], ["list-data", "da7095a", "No", "0", "3", "Behind"],
                                         ["main", "9c65a9a", "Yes", "0", "0", "Identical"]])
        self.assertEqual(d["tags"], ["v0.1.035b718ein the history shown", "v0.2.094a4057in the history shown"])
        self.assertGreater(d["canvas"][0], 0)

    def test_history_zooms_fits_and_reads_older_commits_only_when_asked(self):
        h = self.r["history"]
        self.assertTrue(h["demo"]["zoomOut"])
        self.assertGreater(h["zoomed"]["rowHeight"], h["demo"]["rowHeight"])
        self.assertFalse(h["zoomed"]["zoomOut"])
        self.assertEqual(h["fit"]["rowHeight"], h["demo"]["rowHeight"])
        first, second = h["paged"]["first"], h["paged"]["second"]
        self.assertEqual(len(first["rows"]), 100)
        self.assertIn("Older history is read only when you ask", first["coverage"])
        self.assertTrue(first["older"])
        self.assertEqual(len(second["rows"]), 140)
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

    def test_history_counts_cover_only_the_commits_read_and_name_logins_only(self):
        d = self.r["history"]["demo"]
        self.assertEqual(d["weeks"], 12)
        self.assertEqual(d["contributors"], ["demo-claude3 commits", "demo-owner2 commits"])
        self.assertIn("1 commit not linked to a GitHub account: counted, not named", d["unlinked"])
        self.assertGreater(d["heat"], 0)
        for word in ("Checkout", "Merge", "Delete", "Reset", "Create branch"):
            self.assertNotIn(word, d["controls"], "no control changes anything")

    def test_framed_page_refuses_to_show(self):
        self.assertEqual(self.r["framed"], {"state": "This page cannot be shown inside another site.", "shell": "hidden"})

    def test_text_grows_a_little_with_the_screen(self):
        size = {w: [float(v[:-2]) for v in vals] for w, vals in self.r["textSize"].items()}
        self.assertEqual(size["390"], [16, 14], "phones keep the browser's own size")
        self.assertGreater(size["1280"][1], 14)
        self.assertEqual(size["1920"], [18, 15.75], "never more than an eighth above it")


if __name__ == "__main__":
    unittest.main()
