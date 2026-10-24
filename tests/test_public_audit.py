"""Tests for scripts/public_audit.py, using throwaway git repositories and
synthetic values read from a fixture file at run time, so neither this source
nor its compiled form holds a real-looking secret."""
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "scripts"))
import public_audit as pa  # noqa: E402

TERM = "Zebulon Quarry"  # synthetic private term


def fixture(name):
    """Synthetic values, stored reversed so the fixture file itself is clean."""
    with open(os.path.join(HERE, "fixtures", "audit_values.txt")) as f:
        values = dict(line.rstrip("\n").split("=", 1) for line in f if "=" in line)
    return values[name][::-1]


def git(root, *args):
    subprocess.run(["git", "-C", root, *args], check=True, capture_output=True)


class Repo:
    def __init__(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = self.tmp.name
        git(self.root, "init", "-q", "-b", "main")
        git(self.root, "config", "user.name", "Test Bot")
        git(self.root, "config", "user.email", "1+bot@users.noreply.github.com")

    def write(self, rel, data):
        path = os.path.join(self.root, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as f:
            f.write(data if isinstance(data, bytes) else data.encode())

    def commit(self, files, message="change", author=None):
        for rel, data in files.items():
            if data is None:
                os.remove(os.path.join(self.root, rel))
            else:
                self.write(rel, data)
        git(self.root, "add", "-A")
        args = ["commit", "-q", "-m", message]
        if author:
            args += ["--author", author]
        git(self.root, *args)


class PublicAuditTest(unittest.TestCase):
    def setUp(self):
        self.repo = Repo()
        self.terms = pa.load_terms("\n" + TERM + "\n\n")

    def tearDown(self):
        self.repo.tmp.cleanup()

    def findings(self, build_dirs=pa.BUILD_DIRS):
        return pa.audit(self.repo.root, self.terms, build_dirs)

    def kinds(self):
        return [kind for _, kind in self.findings()]

    def assert_no_term_in_output(self, findings):
        text = repr(findings).lower()
        self.assertNotIn(TERM.lower(), text)
        self.assertNotIn(TERM.lower().replace(" ", ""), text)

    def test_clean_repo_passes(self):
        self.repo.commit({"src/app.js": "const token = null; // in memory only\n"},
                         "Initial\n\nCo-Authored-By: Claude <noreply@anthropic.com>")
        self.assertEqual(self.findings(), [])

    def test_private_term_in_file_is_reported_without_its_text(self):
        self.repo.commit({"README.md": "Made by zebulon quarry\n"})
        findings = self.findings()
        self.assertIn(("file README.md:1", "private term #1"), findings)
        self.assert_no_term_in_output(findings)

    def test_term_in_file_name_is_found_and_redacted_everywhere(self):
        # Tracked, kept in history, and in untracked build output; case varies.
        self.repo.commit({"docs/ZEBULON quarry notes.md": "harmless\n"})
        os.makedirs(os.path.join(self.repo.root, "dist"))
        self.repo.write("dist/zebulon Quarry.html", "<p>ok</p>\n")
        findings = self.findings()
        where = {w.split(" ", 1)[0] for w, k in findings if k == "private term #1 in the file name"}
        self.assertEqual(where, {"file", "history", "build"})
        self.assert_no_term_in_output(findings)
        self.assertTrue(any("[term #1]" in w for w, _ in findings))

    def test_generic_secret_in_a_file_name_is_not_echoed(self):
        token = fixture("token")
        self.repo.commit({"keys/" + token + ".txt": "harmless\n"})
        findings = self.findings()
        self.assertIn("a GitHub token in the file name", [k for _, k in findings])
        self.assertNotIn(token, repr(findings))
        self.assertNotIn(fixture("email"), pa.safe("a/" + fixture("email") + "/b", []))

    def test_private_name_is_found_after_an_unchanged_rename(self):
        self.repo.commit({"Zebulon Quarry.txt": "same content\n"})
        git(self.repo.root, "mv", "Zebulon Quarry.txt", "neutral.txt")
        git(self.repo.root, "commit", "-q", "-m", "rename")
        findings = self.findings()
        self.assertTrue(any(w.startswith("history path ") and k == "private term #1 in the file name"
                            for w, k in findings), findings)
        self.assert_no_term_in_output(findings)

    def test_control_characters_in_names_are_escaped(self):
        self.repo.commit({"odd\tname.txt": "x\n"})
        self.assertEqual(pa.safe("odd\tname\x1b.txt", []), "odd\\x09name\\x1b.txt")

    def test_redaction_handles_a_term_inside_its_own_placeholder(self):
        self.assertEqual(pa.safe("a Term b", ["term"]), "a [term #1] b")

    def test_deleted_text_secret_is_still_found_in_history(self):
        self.repo.commit({"config.js": "const t = '" + fixture("token") + "';\n"})
        self.repo.commit({"config.js": None}, "remove it")
        findings = self.findings()
        self.assertFalse([w for w, _ in findings if w.startswith("file ")])
        self.assertTrue(any(w.startswith("history blob ") and "config.js" in w and k == "a GitHub token"
                            for w, k in findings))

    def test_deleted_binary_with_a_term_is_still_found(self):
        self.repo.commit({"data.bin": b"\0\1" + TERM.upper().encode() + b"\0"})
        self.repo.commit({"data.bin": None}, "remove it")
        kinds = self.kinds()
        self.assertIn("private term #1", kinds)
        self.assertIn("an unsupported binary file", kinds)

    def test_utf16_text_inside_a_binary_is_found(self):
        self.repo.commit({"img.png": b"\x89PNG\0" + TERM.encode("utf-16-le")})
        self.assertIn("private term #1", self.kinds())
        self.assertNotIn("an unsupported binary file", self.kinds())

    def test_untracked_binary_build_output_is_scanned(self):
        self.repo.commit({"src/app.js": "ok\n"})
        os.makedirs(os.path.join(self.repo.root, "build"))
        self.repo.write("build/app.bin", b"\0" + TERM.encode())
        kinds = [k for w, k in self.findings() if w.startswith("build ")]
        self.assertIn("private term #1", kinds)
        self.assertIn("an unsupported binary file", kinds)

    def test_generated_artifacts_are_rejected(self):
        self.repo.commit({"pkg/__pycache__/mod.cpython-313.pyc": b"\0compiled",
                          "src/.DS_Store": "x"})
        self.assertEqual(self.kinds().count("a generated artifact") >= 2, True)

    def test_commit_message_and_author_are_scanned(self):
        self.repo.commit({"a.txt": "x\n"}, "Fix for " + TERM,
                         author="Someone <" + fixture("email") + ">")
        findings = self.findings()
        self.assertIn(("history commit " + self.head()[:7] + " message:1", "private term #1"), findings)
        self.assertIn("an email address", [k for _, k in findings])

    def head(self):
        return subprocess.run(["git", "-C", self.repo.root, "rev-parse", "HEAD"],
                              capture_output=True, text=True).stdout.strip()

    def test_private_record_markers(self):
        self.repo.commit({"notes.md": fixture("markers") + "\n"})
        kinds = self.kinds()
        for kind in ("a private task ID", "a private decision ID", "a private record path"):
            self.assertIn(kind, kinds)

    def test_email_allowlist_is_exact(self):
        for address in ("noreply@anthropic.com", "123+bot@users.noreply.github.com",
                        "noreply@github.com"):
            self.assertTrue(pa.is_allowed_email(address))
        for address in (fixture("email"), "mynoreply" + "@example.org", "x" + "@evilnoreply.github.com"):
            self.assertFalse(pa.is_allowed_email(address))

    def test_missing_terms_fail_unless_allowed(self):
        self.repo.commit({"a.txt": "x\n"})
        old = os.environ.pop("PUBLIC_AUDIT_TERMS", None)
        try:
            self.assertEqual(pa.main(["--root", self.repo.root]), 1)
            self.assertEqual(pa.main(["--root", self.repo.root, "--allow-missing-terms"]), 0)
        finally:
            if old is not None:
                os.environ["PUBLIC_AUDIT_TERMS"] = old

    def test_this_repository_is_clean_without_private_terms(self):
        root = os.path.join(HERE, "..")
        self.assertEqual(list(pa.scan_tracked(root, [])), [])


if __name__ == "__main__":
    unittest.main()
