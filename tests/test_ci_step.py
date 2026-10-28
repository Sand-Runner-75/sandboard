"""Tests for scripts/ci_step.py: a CI step's output is audited before any of
it is shown, whether the command passed or failed. Uses a synthetic private
term and a synthetic credential read from the fixture file."""
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, ".."))
sys.path.insert(0, os.path.join(ROOT, "scripts"))
import ci_step  # noqa: E402
from test_public_audit import fixture  # noqa: E402

TERM = "Quillon Marsh"  # synthetic private term


def printer(text, status):
    """A command that prints text to stdout and stderr, then exits with status."""
    code = (f"import sys; print({text!r}); print({text!r}, file=sys.stderr); "
            f"sys.exit({status})")
    return [sys.executable, "-c", code]


class CiStepTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.log = os.path.join(self.tmp.name, "ci-log.txt")

    def tearDown(self):
        self.tmp.cleanup()

    def run_main(self, command, terms):
        """Run ci_step.py as CI does and return (exit code, everything it printed)."""
        env = dict(os.environ, PUBLIC_AUDIT_TERMS=terms)
        done = subprocess.run([sys.executable, os.path.join(ROOT, "scripts", "ci_step.py"),
                               "--log", self.log, "--", *command],
                              env=env, capture_output=True, text=True)
        return done.returncode, done.stdout + done.stderr

    def test_private_output_never_shown_on_success_or_failure(self):
        secrets = {"private term #1": "build ok for " + TERM,
                   "a GitHub token": "token=" + fixture("token")}
        for kind, text in secrets.items():
            for status in (0, 3):
                with self.subTest(kind=kind, status=status):
                    code, shown = self.run_main(printer(text, status), TERM)
                    self.assertNotEqual(code, 0)
                    self.assertIn(kind, shown)
                    self.assertNotIn(text, shown)
                    self.assertNotIn(TERM.lower(), shown.lower())
                    self.assertNotIn(fixture("token"), shown)

    def test_clean_output_is_shown_and_status_kept(self):
        for status in (0, 3):
            with self.subTest(status=status):
                code, shown = self.run_main(printer("all 12 checks ran", status), TERM)
                self.assertEqual(code, status)
                self.assertIn("all 12 checks ran", shown)
                self.assertIn(f"(command exited with status {status})", shown)

    def test_output_withheld_without_terms(self):
        code, shown = self.run_main(printer("anything at all", 0), "")
        self.assertEqual(code, 1)
        self.assertNotIn("anything at all", shown)
        self.assertIn("PUBLIC_AUDIT_TERMS is not set", shown)

    def test_raw_output_kept_in_log_for_the_final_audit(self):
        ci_step.run(printer("first", 0), self.log, [TERM.lower()])
        status, text = ci_step.run(printer("second " + TERM, 1), self.log, [TERM.lower()])
        self.assertEqual(status, 1)
        self.assertNotIn("first", text)  # only this step's output is judged and shown
        with open(self.log, encoding="utf-8") as f:
            log = f.read()
        self.assertIn("first", log)
        self.assertIn(TERM, log)

    def test_missing_command_fails(self):
        status, text = ci_step.run([os.path.join(self.tmp.name, "no-such-command")],
                                   self.log, [TERM.lower()])
        self.assertEqual(status, 127)
        self.assertIn("cannot run the command", text)


class WorkflowLogTest(unittest.TestCase):
    """Every workflow runs tests and build through ci_step.py, never with tee."""

    def read(self, name):
        with open(os.path.join(ROOT, ".github", "workflows", name)) as f:
            return f.read()

    def steps(self, text):
        return text.split("\n      - ")[1:]

    def test_test_and_build_steps_are_audited_before_shown(self):
        for name in ("checks.yml", "pages.yml"):
            text = self.read(name)
            with self.subTest(name):
                self.assertNotIn("tee", text)
                runs = [s for s in self.steps(text) if "unittest" in s or "build.py" in s]
                self.assertEqual(len(runs), 2)
                for step in runs:
                    self.assertIn("python3 scripts/ci_step.py --log ci-log.txt -- ", step)
                    self.assertIn("PUBLIC_AUDIT_TERMS: ${{ secrets.PUBLIC_AUDIT_TERMS }}", step)

    def test_checks_install_a_pinned_browser_and_require_it(self):
        text = self.read("checks.yml")
        install = [s for s in self.steps(text) if "playwright@" in s]
        self.assertEqual(len(install), 1)
        self.assertRegex(install[0], r"playwright@\d+\.\d+\.\d+\b")
        for line in install[0].splitlines():
            if "npm " in line or " install " in line:
                self.assertIn("python3 scripts/ci_step.py --log ci-log.txt -- ", line)
        tests = [s for s in self.steps(text) if "unittest" in s]
        self.assertIn('SANDBOARD_REQUIRE_BROWSER: "1"', tests[0])
        self.assertIn("SANDBOARD_PLAYWRIGHT:", tests[0])

    def test_final_audit_runs_even_after_a_failed_step(self):
        audit = [s for s in self.steps(self.read("checks.yml")) if "public_audit.py" in s]
        self.assertEqual(len(audit), 1)
        self.assertIn("if: always()", audit[0])

    def test_nothing_is_uploaded_after_any_failure(self):
        text = self.read("pages.yml")
        for step in self.steps(text):
            if "upload-pages-artifact" in step or "deploy-pages" in step:
                with self.subTest(step.splitlines()[0]):
                    self.assertNotIn("always()", step)
                    self.assertNotIn("failure()", step)
                    self.assertNotIn("continue-on-error", step)
        self.assertNotIn("continue-on-error", text)


if __name__ == "__main__":
    unittest.main()
