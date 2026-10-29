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


# The opening tag of the page's main element, where the rule-break cases insert markup.
MAIN = '<main id="main" tabindex="-1">'

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
                         ["app.js", "build-manifest.json", "demo-data.js", "index.html", "sb-atlas-account.js", "sb-atlas-graph.js", "sb-atlas-tree.js", "sb-atlas.js", "sb-code.js", "sb-core.js", "sb-demo.js", "sb-gif.js", "sb-history.js",
                          "sb-home.js", "sb-model.js", "sb-readers.js", "sb-render.js", "sb-repos.js", "sb-search.js", "sb-taskviews.js", "sb-views.js", "sb-work.js", "style.css"])

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
        self.assertNotIn("</script>", build.demo_js({"repos": {"a/b": {"files": {"x.md": "</script><b>x"}}}}))

    def test_rule_breaks_are_rejected(self):
        good = build.check_page("index.html", self.page())
        self.assertEqual(good, [])
        cases = {
            "an inline script": self.page().replace("</body>", "<script>x()</script></body>"),
            "an inline event handler": self.page().replace(MAIN, '<main onclick="x()">'),
            "an inline style attribute": self.page().replace(MAIN, '<main style="color:red">'),
            "a reference to another origin": self.page().replace("</body>", '<img src="https://cdn.example.com/a.png"></body>'),
            "missing or changed Content-Security-Policy meta tag": self.page().replace("connect-src https://api.github.com", "connect-src *"),
            "missing no-referrer meta tag": self.page().replace('<meta name="referrer" content="no-referrer">', ""),
            "a resource URL that is not relative": self.page().replace("</body>", '<img src="https://cdn.example.com/a.png"></body>'),
        }
        for why, html in cases.items():
            with self.subTest(why):
                self.assertTrue(any(why in p for p in build.check_page("index.html", html)))
        self.assertTrue(build.check_page("app.js", 'fetch("https://evil.example.net/x")'))
        self.assertEqual(build.check_page("app.js", 'fetch("https://api.github.com/repos")'), [])

    def page(self):
        with open(os.path.join(ROOT, "src", "index.html"), encoding="utf-8") as f:
            return f.read()

    def build_with(self, changes):
        """Build a copy of the repository with src files changed; return the problems."""
        repo = os.path.join(self.tmp.name, "repo")
        shutil.rmtree(repo, ignore_errors=True)
        shutil.copytree(os.path.join(ROOT, "src"), os.path.join(repo, "src"))
        shutil.copytree(os.path.join(ROOT, "fixtures"), os.path.join(repo, "fixtures"))
        for name, change in changes.items():
            path = os.path.join(repo, "src", name)
            text = ""
            if os.path.exists(path):
                with open(path, encoding="utf-8") as f:
                    text = f.read()
            with open(path, "w", encoding="utf-8") as f:
                f.write(change(text))
        old = build.ROOT
        build.ROOT = repo
        try:
            return build.build(self.out)
        finally:
            build.ROOT = old

    def assert_rejected(self, changes, why):
        problems = self.build_with(changes)
        self.assertTrue(any(why in p for p in problems), problems)
        self.assertEqual(os.listdir(self.out), [])

    def test_failed_build_writes_no_site(self):
        self.assert_rejected({"index.html": lambda t: t + "<script>bad()</script>\n"}, "an inline script")

    def test_inactive_or_misplaced_policy_tags_are_rejected(self):
        csp = '<meta http-equiv="Content-Security-Policy" content="%s">' % build.CSP
        ref = '<meta name="referrer" content="no-referrer">'
        cases = {
            "both commented out": (lambda t: t.replace(csp, "<!-- " + csp + " -->")
                                   .replace(ref, "<!-- " + ref + " -->"),
                                   "missing or changed Content-Security-Policy meta tag"),
            "referrer commented out": (lambda t: t.replace(ref, "<!--" + ref + "-->"),
                                       "missing no-referrer meta tag"),
            "policy inside noscript": (lambda t: t.replace(csp, "<noscript>" + csp + "</noscript>"),
                                       "inside inert content"),
            "policy inside template": (lambda t: t.replace(ref, "<template>" + ref + "</template>"),
                                       "inside inert content"),
            "policy after a script": (lambda t: t.replace(csp, "").replace(
                                          "</head>", csp + "\n</head>"),
                                      "after content"),
            "referrer after a stylesheet": (lambda t: t.replace(ref, "").replace(
                                                "</head>", ref + "\n</head>"),
                                            "after content"),
            "policy in the body": (lambda t: t.replace(csp, "").replace(MAIN, MAIN + csp),
                                   "missing or changed Content-Security-Policy meta tag"),
            "text before the policy": (lambda t: t.replace("<meta charset", "hello <meta charset"),
                                       "after content"),
            "a second, weaker referrer policy": (lambda t: t.replace(
                                                     "</head>", '<meta name="referrer" content="unsafe-url">\n</head>'),
                                                 "more than one no-referrer meta tag"),
            "policy as plain text": (lambda t: t.replace(csp, "<title>" + csp.replace("<", "&lt;") + "</title>"),
                                     "missing or changed Content-Security-Policy meta tag"),
        }
        for label, (change, why) in cases.items():
            with self.subTest(label):
                self.assert_rejected({"index.html": change}, why)

    def test_pages_the_browser_reads_differently_are_rejected(self):
        csp_attr = 'http-equiv="Content-Security-Policy"'
        ref_attrs = 'name="referrer" content="no-referrer"'
        cases = {
            "duplicate http-equiv, ineffective first": (
                lambda t: t.replace(csp_attr, 'http-equiv="x" ' + csp_attr), "a repeated attribute"),
            "duplicate http-equiv, other case": (
                lambda t: t.replace(csp_attr, 'HTTP-EQUIV="x" ' + csp_attr), "a repeated attribute"),
            "duplicate content, weaker CSP first": (
                lambda t: t.replace(csp_attr, csp_attr + ' content="default-src *"'), "a repeated attribute"),
            "duplicate content, weaker referrer first": (
                lambda t: t.replace(ref_attrs, 'name="referrer" content="unsafe-url" content="no-referrer"'),
                "a repeated attribute"),
            "duplicate content, other case": (
                lambda t: t.replace(ref_attrs, 'name="referrer" Content="unsafe-url" content="no-referrer"'),
                "a repeated attribute"),
            "duplicate name": (
                lambda t: t.replace(ref_attrs, 'name="x" NAME="referrer" content="no-referrer"'),
                "a repeated attribute"),
            "self-closing title before the policies": (
                lambda t: t.replace("<meta charset", "<title/><meta charset"), "self-closing syntax on <title>"),
            "self-closing head": (
                lambda t: t.replace("<head>", "<head/>"), "self-closing syntax on <head>"),
        }
        for label, (change, why) in cases.items():
            with self.subTest(label):
                self.assert_rejected({"index.html": change}, why)
                # The policies must also count as missing, as the browser sees them.
                if "self-closing title" in label:
                    self.assertTrue(any("missing or changed Content-Security-Policy" in p
                                        for p in self.build_with({"index.html": change})))

    def test_css_escapes_cannot_hide_another_origin(self):
        cases = {
            "short hex escapes, unquoted url": r"body { background: url(\2f\2f cdn.example.org/x.png); }",
            "short hex escapes, @import": '@import "\\2f\\2f cdn.example.org/x.css";',
            "padded hex escapes": '@import "\\00002f\\00002f cdn.example.org/x.css";',
            "upper-case hex, single quotes": "body { background: url('\\2F\\2F cdn.example.org/x.png'); }",
            "escaped url identifier": r"body { background: u\72l(\2f\2f cdn.example.org/x.png); }",
            "escaped import identifier": '@\\69mport "\\2f/cdn.example.org/x.css";',
            "escaped slashes": 'body { background: url("\\/\\/cdn.example.org/x.png"); }',
            "escaped scheme": r"body { background: url(htt\70 s://127.0.0.1/x.png); }",
            "space before the url": "body { background: url(   //cdn.example.org/x.png  ); }",
        }
        for label, css in cases.items():
            with self.subTest(label):
                problems = self.build_with({"style.css": lambda t, c=css: t + "\n" + c + "\n"})
                self.assertTrue(any("another origin" in p or "not relative" in p for p in problems),
                                (label, problems))
                self.assertEqual(os.listdir(self.out), [])
        self.assertEqual(self.build_with({"style.css": lambda t: t + '\n.a::before { content: "\\2014"; }\n'
                                                                    ".b { background: url(icons/\\61.png); }\n"}), [])

    def test_hidden_inline_code_is_rejected(self):
        cases = {
            "a javascript: URL": '<a href="jav&#x61;script:x()">a</a>',  # entity-encoded
            "an element-level referrer policy": '<img src="a.png" referrerpolicy="unsafe-url">',
            "an inline style block": "<style>main{}</style>",
            "an inline event handler": '<img src="a.png" ONERROR="x()">',
        }
        for why, tag in cases.items():
            with self.subTest(why):
                self.assert_rejected({"index.html": lambda t: t.replace(MAIN, MAIN + tag)}, why)

    def test_other_origins_are_rejected_in_every_form(self):
        cases = {
            "IPv4 image": ("index.html", '<img src="https://127.0.0.1/x.png">'),
            "localhost script": ("index.html", '<script src="http://localhost/x.js"></script>'),
            "IPv6 stylesheet": ("index.html", '<link rel="stylesheet" href="https://[::1]/x.css">'),
            "protocol-relative image": ("index.html", '<img src="//cdn.example.org/a.png">'),
            "backslash image": ("index.html", '<img src="\\\\cdn.example.org/a.png">'),
            "entity-encoded slashes": ("index.html", '<img src="&#47;&#47;cdn.example.org/a.png">'),
            "srcset candidate": ("index.html", '<img src="a.png" srcset="a.png 1x, https://10.0.0.1/b.png 2x">'),
            "JS fetch to localhost": ("app.js", 'fetch("http://localhost:8080/x");'),
            "JS fetch to an IP": ("app.js", 'fetch("https://192.168.1.1/x");'),
            "JS protocol-relative": ("app.js", 'fetch("//cdn.example.org/x");'),
            "JS escaped slashes": ("app.js", 'fetch("https:\\x2f\\x2fcdn.example.org/x");'),
            "JS unicode-escaped slashes": ("app.js", 'fetch("\\u002f\\u002fcdn.example.org/x");'),
            "JS escaped backslashes": ("app.js", 'fetch("\\\\\\\\cdn.example.org/x");'),
            "JS percent-encoded": ("app.js", 'fetch("https:%2F%2Fcdn.example.org/x");'),
            "JS missing slashes": ("app.js", 'fetch("http:cdn.example.org/x");'),
            "JS lookalike API host": ("app.js", 'fetch("https://api.github.com.example.org/x");'),
            "JS API on another port": ("app.js", 'fetch("https://api.github.com:8443/x");'),
            "JS API over http": ("app.js", 'fetch("http://api.github.com/x");'),
            "JS websocket": ("app.js", 'new WebSocket("wss://127.0.0.1/");'),
            "CSS url to IPv6": ("style.css", "body { background: url(https://[::1]/a.png); }"),
            "CSS protocol-relative url": ("style.css", "body { background: url('//cdn.example.org/a.png'); }"),
            "CSS import": ("style.css", '@import "http://localhost/x.css";'),
        }
        for label, (name, snippet) in cases.items():
            with self.subTest(label):
                if name == "index.html":
                    change = lambda t, s=snippet: t.replace(MAIN, MAIN + s)
                else:
                    change = lambda t, s=snippet: t + "\n" + s + "\n"
                problems = self.build_with({name: change})
                self.assertTrue(any("another origin" in p or "not relative" in p for p in problems),
                                (label, problems))
                self.assertEqual(os.listdir(self.out), [])

    def test_relative_assets_and_the_api_still_pass(self):
        problems = self.build_with({
            "index.html": lambda t: t.replace(MAIN, MAIN + '<img src="icons/a.png" alt="" '
                                              'srcset="icons/a.png 1x, icons/a2.png 2x">'
                                              '<a href="#demo">demo</a><a href="?view=list">list</a>'),
            "app.js": lambda t: t + '\n// Calls the API only.\nfetch("https://api.github.com/user");\n'
                                    'const re = "a / b";\n',
            "style.css": lambda t: t + "\n.icon { background: url(icons/a.png); }\n",
        })
        self.assertEqual(problems, [])
        self.assertIn("index.html", os.listdir(self.out))

    def test_only_known_file_types_are_built(self):
        self.assert_rejected({"logo.svg": lambda t: "<svg></svg>"}, "an unsupported file type")


class PagesWorkflowTest(unittest.TestCase):
    def setUp(self):
        with open(os.path.join(ROOT, ".github", "workflows", "pages.yml")) as f:
            self.text = f.read()

    def test_publishing_is_manual_and_gated(self):
        on_block = self.text.split("\non:\n", 1)[1].split("\npermissions:", 1)[0]
        self.assertIn("workflow_dispatch:", on_block)
        for trigger in ("push:", "pull_request:", "schedule:", "release:"):
            self.assertNotIn(trigger, on_block)
        self.assertEqual(self.text.count("if: vars.PAGES_ENABLED == 'true'"), 3)
        self.assertEqual(self.text.count("\n    runs-on:") + self.text.count("\n    uses:"), 3, "every job is gated")

    def test_the_live_site_is_checked_after_deploy_at_the_built_commit(self):
        live = self.text.split("\n  live:\n", 1)[1]
        self.assertIn("needs: [build, deploy]", live)
        self.assertIn("uses: ./.github/workflows/live-check.yml", live)
        self.assertIn("url: ${{ needs.deploy.outputs.page_url }}", live)
        self.assertIn("ref: ${{ needs.build.outputs.sha }}", live)
        self.assertIn('echo "sha=$(git rev-parse HEAD)" >> "$GITHUB_OUTPUT"', self.text)
        with open(os.path.join(ROOT, ".github", "workflows", "live-check.yml")) as f:
            check = f.read()
        on_block = check.split("\non:\n", 1)[1].split("\npermissions:", 1)[0]
        for trigger in ("push:", "pull_request:", "schedule:", "release:"):
            self.assertNotIn(trigger, on_block)
        self.assertEqual(check.split("\npermissions:\n", 1)[1].split("\n\n", 1)[0].strip(), "contents: read")
        self.assertNotIn("pages: write", check)

    def test_audit_runs_before_upload(self):
        self.assertLess(self.text.index("scripts/public_audit.py --build-dir dist --log ci-log.txt"),
                        self.text.index("upload-pages-artifact"))


if __name__ == "__main__":
    unittest.main()
