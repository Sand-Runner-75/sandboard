"""Tests for scripts/build.py: page rules, reproducibility and the disabled Pages workflow."""
import hashlib
import json
import os
import shutil
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, ".."))
sys.path.insert(0, os.path.join(ROOT, "scripts"))
import build  # noqa: E402


class BuildTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.out = os.path.join(self.tmp.name, "dist")

    def tearDown(self):
        self.tmp.cleanup()

    def read(self, name):
        with open(os.path.join(self.out, name), encoding="utf-8") as f:
            return f.read()

    def test_build_succeeds_with_expected_files(self):
        self.assertEqual(build.build(self.out), [])
        self.assertEqual(sorted(os.listdir(self.out)),
                         ["app.js", "build-manifest.json", "demo-data.js", "index.html", "style.css"])

    def test_page_has_csp_referrer_and_only_external_scripts(self):
        build.build(self.out)
        html = self.read("index.html")
        self.assertIn(build.CSP, html)
        self.assertIn("connect-src https://api.github.com", html)
        self.assertIn("base-uri 'none'", html)
        self.assertIn("form-action 'none'", html)
        self.assertIn('<meta name="referrer" content="no-referrer">', html)
        self.assertEqual(build.check_page("index.html", html), [])

    def test_frame_refusal_runs_before_anything_is_shown(self):
        build.build(self.out)
        self.assertIn('class="pending"', self.read("index.html"))
        self.assertIn("html.pending body", self.read("style.css"))
        app = self.read("app.js")
        self.assertLess(app.index("window.top !== window.self"), app.rindex('root.classList.remove("pending");'))

    def test_build_is_reproducible_and_manifest_matches(self):
        build.build(self.out)
        first = {n: self.read(n) for n in os.listdir(self.out)}
        build.build(self.out)
        second = {n: self.read(n) for n in os.listdir(self.out)}
        self.assertEqual(first, second)
        manifest = json.loads(first["build-manifest.json"])
        for name, digest in manifest.items():
            with open(os.path.join(self.out, name), "rb") as f:
                self.assertEqual(hashlib.sha256(f.read()).hexdigest(), digest)

    def test_demo_data_is_plain_data_and_escapes_tags(self):
        build.build(self.out)
        js = self.read("demo-data.js")
        self.assertTrue(js.split("\n", 1)[1].startswith("window.SANDBOARD_DEMO = {"))
        fixture = os.path.join(self.tmp.name, "f.json")
        with open(fixture, "w") as f:
            json.dump({"projects": [{"name": "</script><b>x"}]}, f)
        self.assertNotIn("</script>", build.demo_js(fixture))

    def test_rule_breaks_are_rejected(self):
        good = build.check_page("index.html", self.page())
        self.assertEqual(good, [])
        cases = {
            "an inline script": self.page().replace("</body>", "<script>x()</script></body>"),
            "an inline event handler": self.page().replace("<main>", '<main onclick="x()">'),
            "an inline style attribute": self.page().replace("<main>", '<main style="color:red">'),
            "a reference to another origin": self.page().replace("</body>", '<img src="https://cdn.example.com/a.png"></body>'),
            "missing or changed Content-Security-Policy meta tag": self.page().replace("connect-src https://api.github.com", "connect-src *"),
            "missing no-referrer meta tag": self.page().replace('<meta name="referrer" content="no-referrer">', ""),
        }
        for why, html in cases.items():
            with self.subTest(why):
                self.assertTrue(any(why in p for p in build.check_page("index.html", html)))
        self.assertTrue(build.check_page("app.js", 'fetch("https://evil.example.net/x")'))
        self.assertEqual(build.check_page("app.js", 'fetch("https://api.github.com/repos")'), [])

    def page(self):
        with open(os.path.join(ROOT, "src", "index.html"), encoding="utf-8") as f:
            return f.read()

    def test_failed_build_writes_no_site(self):
        src = os.path.join(self.tmp.name, "repo")
        shutil.copytree(os.path.join(ROOT, "src"), os.path.join(src, "src"))
        shutil.copytree(os.path.join(ROOT, "fixtures"), os.path.join(src, "fixtures"))
        with open(os.path.join(src, "src", "index.html"), "a") as f:
            f.write("<script>bad()</script>\n")
        old = build.ROOT
        build.ROOT = src
        try:
            self.assertTrue(build.build(self.out))
            self.assertEqual(os.listdir(self.out), [])
        finally:
            build.ROOT = old


class PagesWorkflowTest(unittest.TestCase):
    def setUp(self):
        with open(os.path.join(ROOT, ".github", "workflows", "pages.yml")) as f:
            self.text = f.read()

    def test_publishing_is_manual_and_gated(self):
        on_block = self.text.split("\non:\n", 1)[1].split("\npermissions:", 1)[0]
        self.assertIn("workflow_dispatch:", on_block)
        for trigger in ("push:", "pull_request:", "schedule:", "release:"):
            self.assertNotIn(trigger, on_block)
        self.assertEqual(self.text.count("if: vars.PAGES_ENABLED == 'true'"), 2)

    def test_audit_runs_before_upload(self):
        self.assertLess(self.text.index("scripts/public_audit.py --build-dir dist --log ci-log.txt"),
                        self.text.index("upload-pages-artifact"))


if __name__ == "__main__":
    unittest.main()
