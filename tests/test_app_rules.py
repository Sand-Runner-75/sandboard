"""Rules for the app's browser code, checked on the source: read-only network
use, nothing stored in the browser, no HTML parsing of data, and the Node
tests of the browser modules (tests/js) run and pass."""
import glob
import os
import re
import shutil
import subprocess
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, ".."))
SRC = os.path.join(ROOT, "src")

FORBIDDEN = [
    (r"\bXMLHttpRequest\b|\bsendBeacon\b|\bWebSocket\b|\bEventSource\b|\bimportScripts\b|\bwindow\.open\b",
     "a network or window API other than the read-only client"),
    (r"\blocalStorage\b|\bsessionStorage\b|\bindexedDB\b|document\.cookie|\bcaches\.|history\.(push|replace)State",
     "browser storage or history"),
    (r"\binnerHTML\b|\bouterHTML\b|insertAdjacentHTML|document\.write|\beval\s*\(|\bnew\s+Function\b|DOMParser",
     "HTML parsing or code evaluation"),
    (r"\bconsole\.", "console logging"),
]


def violations(name, text):
    found = [why for pattern, why in FORBIDDEN if re.search(pattern, text)]
    for method in re.findall(r"\bmethod\s*:\s*[\"']?([A-Za-z]+)", text):
        if method != "GET":
            found.append("an HTTP method other than GET")
    fetches = len(re.findall(r"\bfetch\b", text))
    if fetches and not (name == "sb-core.js" and fetches == 1):
        found.append("a network call outside the read-only client")
    return found


def sources():
    for path in sorted(glob.glob(os.path.join(SRC, "*.js"))):
        with open(path, encoding="utf-8") as f:
            yield os.path.basename(path), f.read()


class SourceRulesTest(unittest.TestCase):
    def test_browser_code_follows_the_rules(self):
        for name, text in sources():
            with self.subTest(name):
                self.assertEqual(violations(name, text), [])

    def test_the_rules_catch_each_break(self):
        bad = {
            "post": 'fetch(u, { method: "POST" })', "put": "x = { method: 'PUT' }",
            "xhr": "new XMLHttpRequest()", "beacon": "navigator.sendBeacon(u, d)",
            "storage": "localStorage.setItem('t', t)", "session": "sessionStorage.t = 1",
            "cookie": "document.cookie = t", "html": "el.innerHTML = s", "eval": "eval(s)",
            "log": "console.log(token)", "second fetch": "fetch(u)", "open": "window.open(u)",
        }
        for label, snippet in bad.items():
            with self.subTest(label):
                self.assertTrue(violations("app.js", snippet))

    def test_page_loads_every_module_in_order(self):
        with open(os.path.join(SRC, "index.html"), encoding="utf-8") as f:
            html = f.read()
        loaded = re.findall(r'<script src="([^"]+)" defer></script>', html)
        self.assertEqual(loaded, ["demo-data.js", "sb-core.js", "sb-readers.js", "sb-render.js", "app.js"])
        self.assertEqual(sorted(n for n, _ in sources()), sorted(loaded[1:]))

    def test_token_field_is_a_password_field_never_kept(self):
        with open(os.path.join(SRC, "index.html"), encoding="utf-8") as f:
            html = f.read()
        self.assertRegex(html, r'<input id="token" name="token" type="password" autocomplete="off"')
        with open(os.path.join(SRC, "app.js"), encoding="utf-8") as f:
            app = f.read()
        self.assertGreaterEqual(app.count('$("token").value = "";'), 2)  # cleared on connect and on sign-out


class NodeTest(unittest.TestCase):
    def test_browser_module_tests_pass(self):
        node = shutil.which("node")
        self.assertIsNotNone(node, "Node.js is needed to test the browser modules")
        files = sorted(glob.glob(os.path.join(HERE, "js", "*.test.js")))
        self.assertGreaterEqual(len(files), 3)
        done = subprocess.run([node, "--test", *files], cwd=ROOT, capture_output=True, text=True)
        self.assertEqual(done.returncode, 0, done.stdout[-6000:] + done.stderr[-2000:])
        self.assertRegex(done.stdout, r"# fail 0")


if __name__ == "__main__":
    unittest.main()
