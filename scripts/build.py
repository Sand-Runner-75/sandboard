#!/usr/bin/env python3
"""Build the static site into an output folder (default: dist).

Copies src/, turns the synthetic demo repositories in fixtures/demo into
demo-data.js, and refuses to finish if the result breaks the page rules.
HTML is parsed, not matched as text, so a tag inside a comment, <noscript>
or <template> does not count:

- the exact Content-Security-Policy and no-referrer meta tags are active
  elements directly inside <head>, once each, before any other element
  except <meta> and <title> and before any text;
- no inline script, style block, style attribute, event handler,
  javascript: URL or element-level referrer policy;
- no repeated attribute and no "/>" on a non-void element, where the
  browser would read the page differently from this check;
- every URL in a URL attribute or CSS url()/@import is relative to the site,
  with CSS escapes decoded first;
- no file mentions any network origin except https://api.github.com, after
  decoding escaped or encoded slashes, backslashes and colons. Hosts given
  as IP addresses, localhost and protocol-relative //host references are
  rejected like any other origin.

Limits: the origin check is static. A URL assembled at run time (string
joining, character codes, decoding) is not seen; the page's
Content-Security-Policy is the run-time guard for that case.

The output is byte-for-byte reproducible and listed with SHA-256 hashes in
build-manifest.json.
"""
import argparse
import hashlib
import html.parser
import json
import os
import re
import shutil
import sys

ROOT = os.path.normpath(os.path.join(os.path.dirname(__file__), ".."))
CSP = ("default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
       "font-src 'self'; connect-src https://api.github.com; base-uri 'none'; form-action 'none'")
SOURCE_TYPES = (".html", ".js", ".css")
# Elements allowed before the policy tags: they load nothing.
PRE_POLICY = {"html", "head", "meta", "title"}
INERT = {"noscript", "template"}
VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta",
        "source", "track", "wbr"}
URL_ATTRS = {"src", "href", "action", "formaction", "srcset", "imagesrcset", "poster", "data",
             "background", "cite", "longdesc", "manifest", "ping", "icon", "codebase",
             "archive", "xlink:href"}
SPECIAL_SCHEMES = {"http", "https", "ws", "wss", "ftp", "file"}
APPROVED = re.compile(r"//api\.github\.com(?=[/?#\"'`;,)\s]|$)")
ENCODED = [
    (re.compile(r"\\x2f|\\u002f|\\u\{0*2f\}|%2f|&#0*47;?|&#x0*2f;?|&sol;", re.I), "/"),
    (re.compile(r"\\x5c|\\u005c|\\u\{0*5c\}|%5c|&#0*92;?|&#x0*5c;?|&bsol;", re.I), "\\\\"),
    (re.compile(r"\\x3a|\\u003a|\\u\{0*3a\}|%3a|&#0*58;?|&#x0*3a;?|&colon;", re.I), ":"),
]
SCHEME = re.compile(r"\b([A-Za-z][A-Za-z0-9+.\-]*):")
PROTOCOL_RELATIVE = re.compile(r"(?<![:/\\])[/\\]{2,}(?=[^\s/\\*])")
CSS_URL = re.compile(r"""url\(\s*['"]?([^'")]*)|@import\s+['"]([^'"]*)""", re.I)


def demo_repos(fixture_dir):
    """The synthetic demo repositories: repos.json, with each repository's files
    read from files/<folder>/. Each gets a commit ID made from its own content,
    so the same fixture always builds the same data."""
    with open(os.path.join(fixture_dir, "repos.json"), encoding="utf-8") as f:
        spec = json.load(f)
    repos = {}
    for name, r in sorted(spec["repos"].items()):
        if "status" in r:
            repos[name] = {"status": r["status"]}
            continue
        files = {}
        folder = r.get("files")
        if folder:
            top = os.path.join(fixture_dir, "files", folder)
            for d, _, names in os.walk(top):
                for n in names:
                    full = os.path.join(d, n)
                    with open(full, encoding="utf-8", newline="") as f:
                        files[os.path.relpath(full, top).replace(os.sep, "/")] = f.read()
        seed = json.dumps([name, files], sort_keys=True).encode()
        repos[name] = {"private": r.get("private", True), "default_branch": "main",
                       "commit": hashlib.sha1(seed).hexdigest(), "date": spec["date"],
                       "files": dict(sorted(files.items()))}
        if "checks" in r:
            repos[name]["checks"] = r["checks"]
        if "pulls" in r:
            repos[name]["pulls"] = demo_pulls(r["pulls"], repos[name]["commit"])
    return {"sign_in": spec["sign_in"], "repos": repos}


def demo_pulls(pulls, commit):
    """Synthetic pull requests in the API's shape. "{commit}" stands for the repository's
    demo commit and "{sha:seed}" for a made-up commit ID; a bare head is a seed."""
    def fill(text):
        text = text.replace("{commit}", commit)
        return re.sub(r"\{sha:([A-Za-z0-9_.-]+)\}", lambda m: hashlib.sha1(m.group(1).encode()).hexdigest(), text)
    out = []
    for p in pulls:
        head = fill(p["head"]) if "{" in p["head"] else hashlib.sha1(p["head"].encode()).hexdigest()
        out.append({"number": p["number"], "title": p["title"], "state": p["state"], "merged_at": p["merged_at"],
                    "merge_commit_sha": fill(p["merge_commit_sha"]) if p["merge_commit_sha"] else None,
                    "head": {"sha": head}, "body": p["body"],
                    "comments": [{"body": fill(c["body"]), "created_at": c["at"]} for c in p["comments"]]})
    return out


def demo_js(data):
    body = json.dumps(data, ensure_ascii=True, sort_keys=True, indent=1)
    # JSON as a plain data assignment; "<" is escaped so no tag can close early.
    return ("// Generated by scripts/build.py from fixtures/demo. Synthetic data only.\n"
            "window.SANDBOARD_DEMO = " + body.replace("<", "\\u003c") + ";\n")


def css_unescape(text):
    """CSS text with escapes decoded, as the browser reads it (CSS Syntax 4.3.7)."""
    def code_point(m):
        n = int(m.group(1), 16)
        return chr(n) if 0 < n <= 0x10FFFF and not 0xD800 <= n <= 0xDFFF else "\ufffd"
    text = re.sub(r"\\([0-9A-Fa-f]{1,6})(?:\r\n|[ \t\n\r\f])?", code_point, text)
    text = re.sub(r"\\(?:\r\n|[\n\r\f])", "", text)  # line continuation inside a string
    return re.sub(r"\\(.)", r"\1", text)


def is_relative(url):
    """True if a URL can only point into this site."""
    url = re.sub(r"[\t\n\r]", "", url).strip(" \x00-\x1f")
    return not (re.match(r"[/\\]{2}", url) or re.match(r"[A-Za-z][A-Za-z0-9+.\-]*:", url))


def origin_problems(text):
    """Network origins other than the approved API, after undoing encodings."""
    for pattern, plain in ENCODED:
        text = pattern.sub(plain, text)
    found = False
    for m in SCHEME.finditer(text):
        rest = text[m.end():]
        if m.group(1).lower() in SPECIAL_SCHEMES or re.match(r"[/\\]{2}", rest):
            if not (m.group(0) == "https:" and APPROVED.match(rest)):
                found = True
    if PROTOCOL_RELATIVE.search(text):
        found = True
    return ["a reference to another origin"] if found else []


class PageParser(html.parser.HTMLParser):
    """Collects page-rule problems from the active elements of an HTML page."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack = []
        self.loaded = False  # an element that may load something, or text, was seen
        self.policies = {"csp": [], "referrer": []}
        self.problems = []

    def handle_starttag(self, tag, attrs):
        self.check(tag, attrs)
        if tag not in VOID:
            self.stack.append(tag)

    def handle_startendtag(self, tag, attrs):
        # Browsers ignore "/>" on a non-void element: <title/> opens a title
        # whose text swallows the tags after it.
        if tag not in VOID:
            self.problems.append(f"self-closing syntax on <{tag}>")
        self.handle_starttag(tag, attrs)

    def handle_endtag(self, tag):
        if tag in self.stack:
            del self.stack[len(self.stack) - 1 - self.stack[::-1].index(tag):]

    def handle_data(self, data):
        if data.strip() and (not self.stack or self.stack[-1] != "title"):
            self.loaded = True

    def check(self, tag, attrs):
        attrs = [(name, value or "") for name, value in attrs]
        names = [name for name, _ in attrs]  # already lower case
        if len(set(names)) != len(names):
            # Browsers keep the first of repeated attributes; refuse rather than guess.
            self.problems.append("a repeated attribute")
        values = {}
        for name, value in attrs:
            values.setdefault(name, value)
        inert = any(t in INERT for t in self.stack)
        if tag == "meta":
            kind = None
            if values.get("http-equiv", "").strip().lower() == "content-security-policy":
                kind, wanted = "csp", CSP
            elif values.get("name", "").strip().lower() == "referrer":
                kind, wanted = "referrer", "no-referrer"
            if kind:
                active = not inert and self.stack[-1:] == ["head"] and not self.loaded
                self.policies[kind].append((active, values.get("content") == wanted))
        if tag not in PRE_POLICY:
            self.loaded = True
        if tag == "script" and "src" not in values:
            self.problems.append("an inline script")
        if tag == "style":
            self.problems.append("an inline style block")
        for name, value in attrs:
            if name == "style":
                self.problems.append("an inline style attribute")
            elif name.startswith("on"):
                self.problems.append("an inline event handler")
            elif name == "referrerpolicy":
                self.problems.append("an element-level referrer policy")
            if "javascript:" in re.sub(r"[\x00-\x20]", "", value).lower():
                self.problems.append("a javascript: URL")
            if name in URL_ATTRS:
                urls = [c.split()[0] for c in value.split(",") if c.split()] if "srcset" in name else [value]
                if not all(is_relative(u) for u in urls):
                    self.problems.append("a resource URL that is not relative")

    def policy_problems(self):
        problems = []
        for kind, label in (("csp", "Content-Security-Policy"), ("referrer", "no-referrer")):
            tags = self.policies[kind]
            if not any(active and right for active, right in tags):
                problems.append(f"missing or changed {label} meta tag" if kind == "csp"
                                else "missing no-referrer meta tag")
            if len(tags) > 1:
                problems.append(f"more than one {label} meta tag")
            if any(not active for active, _ in tags):
                problems.append(f"a {label} meta tag outside <head>, inside inert content "
                                "or after content")
        return problems


def check_page(name, text):
    problems = []
    if not name.endswith(SOURCE_TYPES):
        problems.append("an unsupported file type")
    if name.endswith(".html"):
        parser = PageParser()
        parser.feed(text)
        parser.close()
        problems += parser.problems + parser.policy_problems()
    if name.endswith(".css"):
        text = css_unescape(text)
        for m in CSS_URL.finditer(text):
            if not is_relative(m.group(1) if m.group(1) is not None else m.group(2)):
                problems.append("a resource URL that is not relative")
    problems += origin_problems(text)
    return [f"{name}: {p}" for p in dict.fromkeys(problems)]


def build(out):
    src = os.path.join(ROOT, "src")
    if os.path.exists(out):
        shutil.rmtree(out)
    os.makedirs(out)
    files = {}
    for name in sorted(os.listdir(src)):
        with open(os.path.join(src, name), "rb") as f:
            files[name] = f.read()
    files["demo-data.js"] = demo_js(demo_repos(os.path.join(ROOT, "fixtures", "demo"))).encode()
    problems = []
    for name, data in files.items():
        problems += check_page(name, data.decode("utf-8"))
    if problems:
        return problems
    for name, data in files.items():
        with open(os.path.join(out, name), "wb") as f:
            f.write(data)
    manifest = {name: hashlib.sha256(data).hexdigest() for name, data in sorted(files.items())}
    with open(os.path.join(out, "build-manifest.json"), "w") as f:
        json.dump(manifest, f, indent=1, sort_keys=True)
        f.write("\n")
    return []


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out", default=os.path.join(ROOT, "dist"))
    args = ap.parse_args(argv)
    problems = build(args.out)
    for p in problems:
        print("FAIL:", p)
    if problems:
        return 1
    print(f"OK: built {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
