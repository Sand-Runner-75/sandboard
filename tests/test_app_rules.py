"""Rules for the app's browser code, checked on the source: read-only network
use everywhere except Edit mode's one write client (sb-write.js), nothing
stored in the browser, no HTML parsing of data, and the Node tests of the
browser modules (tests/js) run and pass."""
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


# The one thing kept in the browser, by the owner's choice: the left tree's project order, under one key,
# read and written only in app.js. Any other use of storage still breaks the rules.
ORDER_STORE = ('window.localStorage.getItem(ORDER_KEY)', 'window.localStorage.setItem(ORDER_KEY, JSON.stringify(ids))')
# And the look chosen in Settings (density and accent colour), under one more key, also in app.js only.
LOOK_STORE = ('window.localStorage.getItem(LOOK_KEY)', 'window.localStorage.setItem(LOOK_KEY, JSON.stringify(look))')
# And favourites and saved task views, under one more key, also in app.js only.
MARKS_STORE = ('window.localStorage.getItem(MARKS_KEY)', 'window.localStorage.setItem(MARKS_KEY, JSON.stringify(marks))')
KEYS = ((ORDER_STORE, 'const ORDER_KEY = "sandboard.projectOrder";'), (LOOK_STORE, 'const LOOK_KEY = "sandboard.look";'),
        (MARKS_STORE, 'const MARKS_KEY = "sandboard.marks";'))


# The one file allowed to send anything but GET, and the methods it may use.
WRITE_CLIENT = "sb-write.js"
WRITE_METHODS = {"GET", "POST", "PATCH", "PUT", "DELETE"}


def violations(name, text):
    for uses, key in KEYS:
        if name == "app.js" and all(text.count(use) == 1 for use in uses) and text.count(key) == 1:
            for use in uses:
                text = text.replace(use, "")
    found = [why for pattern, why in FORBIDDEN if re.search(pattern, text)]
    # Edit mode's write client is the only file that may name another method, and only these.
    allowed = WRITE_METHODS if name == WRITE_CLIENT else {"GET"}
    for method in re.findall(r"\bmethod\s*:\s*[\"']?([A-Za-z]+)", text):
        if method not in allowed:
            found.append("an HTTP method other than GET")
    fetches = len(re.findall(r"\bfetch\b", text))
    if fetches and not (name in ("sb-core.js", WRITE_CLIENT) and fetches == 1):
        found.append("a network call outside the read-only client and the write client")
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
        # The project order's key is allowed in app.js only, and nothing else may be stored beside it.
        order = 'const ORDER_KEY = "sandboard.projectOrder";\n' + "\n".join(ORDER_STORE)
        self.assertEqual(violations("app.js", order), [])
        self.assertTrue(violations("sb-views.js", order))
        self.assertTrue(violations("app.js", order + "\nlocalStorage.setItem('token', t)"))
        self.assertTrue(violations("app.js", order.replace("sandboard.projectOrder", "sandboard.token")))
        look = 'const LOOK_KEY = "sandboard.look";\n' + "\n".join(LOOK_STORE)
        self.assertEqual(violations("app.js", order + "\n" + look), [])
        self.assertTrue(violations("sb-views.js", look))
        self.assertTrue(violations("app.js", look.replace("sandboard.look", "sandboard.token")))
        marks = 'const MARKS_KEY = "sandboard.marks";\n' + "\n".join(MARKS_STORE)
        self.assertEqual(violations("app.js", order + "\n" + look + "\n" + marks), [])
        self.assertTrue(violations("sb-views.js", marks))
        self.assertTrue(violations("app.js", marks.replace("sandboard.marks", "sandboard.token")))
        # Only the write client may write, and even it may not use any other method or a second network call.
        write = 'x = { method: "POST" }; y = { method: "DELETE" }; root.fetch.bind(root)'
        self.assertEqual(violations(WRITE_CLIENT, write), [])
        self.assertTrue(violations("sb-core.js", 'x = { method: "POST" }'))
        self.assertTrue(violations("app.js", write))
        self.assertTrue(violations(WRITE_CLIENT, 'x = { method: "TRACE" }'))
        self.assertTrue(violations(WRITE_CLIENT, write + "; fetch(u)"))
        self.assertTrue(violations(WRITE_CLIENT, "localStorage.setItem('t', t)"))

    def test_page_loads_every_module_in_order(self):
        with open(os.path.join(SRC, "index.html"), encoding="utf-8") as f:
            html = f.read()
        loaded = re.findall(r'<script src="([^"]+)" defer></script>', html)
        self.assertEqual(loaded, ["demo-data.js", "sb-core.js", "sb-write.js", "sb-readers.js", "sb-render.js", "sb-model.js", "sb-demo.js",
                                  "sb-views.js", "sb-repos.js", "sb-home.js", "sb-taskviews.js", "sb-people.js", "sb-history.js", "sb-work.js", "sb-code.js", "sb-search.js",
                                  "sb-gif.js", "sb-atlas-graph.js", "sb-atlas-tree.js", "sb-atlas-account.js", "sb-atlas.js", "app.js"])
        self.assertEqual(sorted(n for n, _ in sources()), sorted(loaded[1:]))

    def test_token_field_is_a_password_field_never_kept(self):
        with open(os.path.join(SRC, "index.html"), encoding="utf-8") as f:
            html = f.read()
        self.assertRegex(html, r'<input id="token" name="token" type="password" autocomplete="off"')
        with open(os.path.join(SRC, "app.js"), encoding="utf-8") as f:
            app = f.read()
        self.assertGreaterEqual(app.count('$("token").value = "";'), 2)  # cleared on connect and on sign-out
        # The write token too: its own password field, cleared when taken, when Edit mode ends and on sign-out.
        self.assertRegex(html, r'<input id="write-token" name="write-token" type="password" autocomplete="off"')
        self.assertGreaterEqual(app.count('$("write-token").value = "";'), 4)

    def test_the_write_client_sends_only_its_fixed_actions(self):
        with open(os.path.join(SRC, WRITE_CLIENT), encoding="utf-8") as f:
            text = f.read()
        methods = re.findall(r"\bmethod\s*:\s*\"([A-Z]+)\"", text)
        self.assertGreaterEqual(len(methods), 10)
        self.assertLessEqual(set(methods), WRITE_METHODS - {"GET"})
        # Workflow files and the Workflows permission are never touched; nothing forces or bypasses.
        self.assertNotRegex(text, r"\bforce\b\s*:|bypass|\badmin\b")
        self.assertNotIn("/contents/", text)


class NodeTest(unittest.TestCase):
    def test_browser_module_tests_pass(self):
        node = shutil.which("node")
        self.assertIsNotNone(node, "Node.js is needed to test the browser modules")
        files = sorted(glob.glob(os.path.join(HERE, "js", "*.test.js")))
        self.assertGreaterEqual(len(files), 3)
        done = subprocess.run([node, "--test", "--test-reporter=tap", *files], cwd=ROOT, capture_output=True, text=True)
        self.assertEqual(done.returncode, 0, done.stdout[-6000:] + done.stderr[-2000:])
        self.assertRegex(done.stdout, r"# fail 0")


if __name__ == "__main__":
    unittest.main()
