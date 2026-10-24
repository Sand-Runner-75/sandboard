#!/usr/bin/env python3
"""Run one CI command without exposing its raw output.

The command's stdout and stderr go only to a log file, never to the job's
output. Whether the command passed or failed, its output is then audited with
the scripts/public_audit.py rules. Only if the audit finds nothing is the
output printed, and even then line by line through the audit's redaction.
Otherwise only the kinds of finding are printed and the step fails. The
command's own exit status is kept, so a failing command still fails the step.
Without PUBLIC_AUDIT_TERMS nothing is printed and the step fails.

Usage: python3 scripts/ci_step.py --log ci-log.txt -- <command> [args...]
"""
import argparse
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import public_audit as pa  # noqa: E402


def run(command, log_path, terms):
    """Return (exit code, text safe to print)."""
    with open(log_path, "ab") as log:
        start = log.tell()
        try:
            status = subprocess.run(command, stdout=log, stderr=subprocess.STDOUT).returncode
        except OSError as e:
            log.write(f"cannot run the command: {e.strerror}\n".encode())
            status = 127
    with open(log_path, "rb") as log:
        log.seek(start)
        output = log.read()
    if not terms:
        return 1, "FAIL: PUBLIC_AUDIT_TERMS is not set, so this step's output is withheld.\n"
    findings = sorted({kind for _, kind in pa.scan_bytes(output, terms)})
    if findings:
        lines = [f"FAIL: {kind} in this step's output; output withheld." for kind in findings]
        return 1, "\n".join(lines) + "\n"
    summary = f"(command exited with status {status})\n"
    lines = output.decode("utf-8", errors="replace").splitlines()
    return status, "".join(pa.safe(line, terms) + "\n" for line in lines) + summary


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if "--" not in argv:
        print("usage: ci_step.py --log FILE -- COMMAND [ARGS...]")
        return 2
    split = argv.index("--")
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--log", required=True)
    args = ap.parse_args(argv[:split])
    status, text = run(argv[split + 1:], args.log, pa.load_terms(os.environ.get("PUBLIC_AUDIT_TERMS")))
    sys.stdout.write(text)
    return status


if __name__ == "__main__":
    sys.exit(main())
