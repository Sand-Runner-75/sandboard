#!/usr/bin/env python3
"""Public audit: fail if anything private is in this public repository.

Scans every tracked file, every blob ever committed on any ref (so deleted
files, text or binary, are still checked), every commit's message, author and
committer, build output folders and any CI log files given with --log. It
looks for credential patterns, email addresses other than the allowed noreply
ones, private record markers, chat session links (commit messages up to
LEGACY_SESSION_END excepted), generated artifacts that must not be committed,
and the private terms listed
in the PUBLIC_AUDIT_TERMS environment variable (one per line, matched
case-insensitively in contents and in file names).

Output never contains a matched value: findings name only the kind and a
location, and every location is redacted (private terms replaced by their
number, control characters escaped) before it is printed.

Limits: compressed or encoded content inside allowed media files (images,
fonts) is scanned only as raw bytes; GitHub's own log store and pull
request text are outside this script.
"""
import argparse
import fnmatch
import os
import re
import subprocess
import sys

# Generic patterns only; owner-specific values come from PUBLIC_AUDIT_TERMS.
# Each regex is written so that its own source text does not match it.
PATTERNS = [
    (re.compile(r"gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}"), "a GitHub token"),
    (re.compile(r"\bsk-[A-Za-z0-9_-]{16,}"), "an API key"),
    (re.compile(r"\bAKIA[0-9A-Z]{16}\b"), "a cloud access key"),
    (re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"), "a private key"),
    (re.compile(r"\bS[T]\d{3}\b"), "a private task ID"),
    (re.compile(r"\bSB-[D]\d+\b"), "a private decision ID"),
    (re.compile(r"\bhandover[s]/|\bproject-recor[d]/|\bmaster-task-tabl[e]\b"), "a private record path"),
    (re.compile(r"claude\.ai/code/sessio[n]_|\bClaude-Sessio[n]:", re.IGNORECASE), "a chat session link"),
]
SESSION_LINK = "a chat session link"
# Commit messages up to this commit carried chat session links before they
# were ruled out; the owner chose to keep that history as it is. Only those
# commit messages are exempt from the session-link check, nothing else.
LEGACY_SESSION_END = "b6595d9d5b7b4922058e1e4122313b0652b65e71"
EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}")
# Exact allowlist: GitHub's per-user noreply domain, or a local part that is exactly "noreply".
NOREPLY_DOMAIN = "users.noreply.github.com"
# Generated files that must never be committed (they can embed paths and test values).
ARTIFACTS = ("*.pyc", "*.pyo", "__pycache__/*", "*/__pycache__/*", ".DS_Store", "*/.DS_Store",
             "*.egg-info/*", ".pytest_cache/*", "node_modules/*")
# Binary formats allowed in the repository; any other binary content is a finding.
MEDIA = (".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".woff", ".woff2")
BUILD_DIRS = ("dist", "_site", "build")


def is_allowed_email(address):
    local, _, domain = address.lower().partition("@")
    return domain == NOREPLY_DOMAIN or local == "noreply"


def load_terms(raw):
    return [t.strip().lower() for t in (raw or "").splitlines() if t.strip()]


def safe(text, terms):
    """A location string with private terms, generic secret values and control
    characters removed."""
    for pattern, _ in PATTERNS:
        text = pattern.sub("[redacted]", text)
    text = EMAIL.sub(lambda m: m.group(0) if is_allowed_email(m.group(0)) else "[redacted]", text)
    if terms:
        alternation = "|".join(re.escape(t) for t in sorted(terms, key=len, reverse=True))
        number = {t: i for i, t in enumerate(terms, 1)}
        text = re.sub(alternation, lambda m: f"[term #{number.get(m.group(0).lower(), 0)}]",
                      text, flags=re.IGNORECASE)
    return "".join(c if c.isprintable() else f"\\x{ord(c):02x}" for c in text)


def scan_text(text, terms):
    """Yield (line number, kind) for every finding in text."""
    for n, line in enumerate(text.splitlines(), 1):
        for pattern, kind in PATTERNS:
            if pattern.search(line):
                yield n, kind
        for m in EMAIL.finditer(line):
            if not is_allowed_email(m.group(0)):
                yield n, "an email address"
        low = line.lower()
        for i, term in enumerate(terms, 1):
            if term in low:
                yield n, f"private term #{i}"


def scan_bytes(data, terms):
    """Yield (line number or None, kind) for file contents, text or binary."""
    if b"\0" not in data:
        yield from scan_text(data.decode("utf-8", errors="replace"), terms)
        return
    # Binary: check the raw bytes as Latin-1 and as UTF-16 so text hidden in
    # a binary is still found; line numbers mean nothing here.
    seen = set()
    decodings = (data.decode("latin-1"), data.decode("utf-16-le", errors="ignore"),
                 data[1:].decode("utf-16-le", errors="ignore"))  # both byte alignments
    for decoded in decodings:
        for _, kind in scan_text(decoded, terms):
            if kind not in seen:
                seen.add(kind)
                yield None, kind


def scan_path(path, terms):
    """Findings in a file name itself, plus files that may not be committed."""
    for _, kind in scan_text(path, terms):
        yield f"{kind} in the file name"
    if any(fnmatch.fnmatch(path, p) for p in ARTIFACTS):
        yield "a generated artifact"


def scan_file(label, path, data, terms):
    for kind in scan_path(path, terms):
        yield label, path, None, kind
    if b"\0" in data and not path.lower().endswith(MEDIA):
        yield label, path, None, "an unsupported binary file"
    for n, kind in scan_bytes(data, terms):
        yield label, path, n, kind


def git(root, *args, data=None):
    return subprocess.run(["git", "-C", root, *args], check=True, input=data,
                          capture_output=True).stdout


def scan_tracked(root, terms):
    for rel in git(root, "ls-files", "-z").decode("utf-8", "replace").split("\0"):
        path = os.path.join(root, rel)
        if rel and os.path.isfile(path):
            with open(path, "rb") as f:
                yield from scan_file("file", rel, f.read(), terms)


def scan_build(root, terms, dirs):
    for d in dirs:
        for base, _, files in os.walk(os.path.join(root, d)):
            for name in files:
                path = os.path.join(base, name)
                with open(path, "rb") as f:
                    yield from scan_file("build", os.path.relpath(path, root), f.read(), terms)


def scan_logs(terms, paths):
    for path in paths or ():
        with open(path, "rb") as f:
            data = f.read()
        for n, kind in scan_bytes(data, terms):
            yield "log", os.path.basename(path), n, kind


def history_blobs(root):
    """{blob id: path where it was first seen} for every blob on every ref."""
    blobs = {}
    listing = git(root, "rev-list", "--all", "--objects").decode("utf-8", "replace")
    ids = [line.split(" ", 1) for line in listing.splitlines() if " " in line]
    if not ids:
        return blobs
    types = git(root, "cat-file", "--batch-check=%(objectname) %(objecttype)",
                data="\n".join(i for i, _ in ids).encode()).decode().split("\n")
    kinds = dict(t.split(" ", 1) for t in types if t)
    for oid, path in ids:
        if kinds.get(oid) == "blob":
            blobs.setdefault(oid, path)
    return blobs


def read_blobs(root, oids):
    out = git(root, "cat-file", "--batch", data="\n".join(oids).encode())
    pos = 0
    for oid in oids:
        header_end = out.index(b"\n", pos)
        size = int(out[pos:header_end].split()[2])
        start = header_end + 1
        yield oid, out[start:start + size]
        pos = start + size + 1


def legacy_commits(root, end):
    """Commits reachable from end, or none when end is not in this clone."""
    if not end:
        return set()
    out = subprocess.run(["git", "-C", root, "rev-list", end], capture_output=True)
    return set(out.stdout.decode().split()) if out.returncode == 0 else set()


def scan_history(root, terms, legacy_end=LEGACY_SESSION_END):
    legacy = legacy_commits(root, legacy_end)
    blobs = history_blobs(root)
    for oid, data in read_blobs(root, list(blobs)):
        for _, path, n, kind in scan_file("history", blobs[oid], data, terms):
            yield f"history blob {oid[:7]}", path, n, kind
    # Every path any commit ever touched, so a private name survives no rename.
    names = git(root, "log", "--all", "--no-renames", "--name-only", "-z", "--format=")
    for path in sorted({p for p in names.decode("utf-8", "replace").split("\0") if p.strip()}):
        for kind in scan_path(path.strip("\n"), terms):
            yield "history path", path.strip("\n"), None, kind
    sep, nul = "\x1e", "\x00"
    log = git(root, "log", "--all", "--format=%x1e%H%x00%an <%ae>%x00%cn <%ce>%x00%B")
    for record in log.decode("utf-8", "replace").split(sep)[1:]:
        sha, author, committer, message = (record.split(nul) + ["", "", ""])[:4]
        for part, text in (("author", author), ("committer", committer), ("message", message)):
            for n, kind in scan_text(text, terms):
                if kind == SESSION_LINK and part == "message" and sha in legacy:
                    continue
                yield f"history commit {sha[:7]}", part, n if part == "message" else None, kind


def audit(root, terms, build_dirs=BUILD_DIRS, logs=None, legacy_end=LEGACY_SESSION_END):
    """Sorted, de-duplicated, already-redacted (location, kind) findings."""
    findings = set()
    for scan in (scan_tracked(root, terms), scan_history(root, terms, legacy_end),
                 scan_build(root, terms, build_dirs), scan_logs(terms, logs)):
        for label, path, n, kind in scan:
            where = f"{label} {path}" + (f":{n}" if n else "")
            findings.add((safe(where, terms), kind))
    return sorted(findings)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--root", default=".", help="repository root (default: .)")
    ap.add_argument("--build-dir", action="append",
                    help="build output folder to scan (default: dist, _site, build)")
    ap.add_argument("--log", action="append",
                    help="CI log file to scan as well (repeatable)")
    ap.add_argument("--allow-missing-terms", action="store_true",
                    help="run without PUBLIC_AUDIT_TERMS (local use only)")
    args = ap.parse_args(argv)
    terms = load_terms(os.environ.get("PUBLIC_AUDIT_TERMS"))
    if not terms and not args.allow_missing_terms:
        print("FAIL: PUBLIC_AUDIT_TERMS is not set, so private terms cannot be checked.")
        return 1
    findings = audit(args.root, terms, args.build_dir or BUILD_DIRS, args.log)
    for where, kind in findings:
        print(f"FAIL: {kind} in {where}")
    if findings:
        return 1
    print(f"OK: no finding ({len(terms)} private terms checked in tracked files, "
          "every committed blob, commit metadata, build output and logs given).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
