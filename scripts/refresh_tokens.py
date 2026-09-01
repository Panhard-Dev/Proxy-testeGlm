#!/usr/bin/env python3
"""Token bank renewal for the Z.AI bridge (captcha device tokens).

Aliyun rejects device tokens older than ~39h (VerifyResult=false). This
script keeps the bank fresh so the captcha subsystem never starves:

  1. Read every token in the bank, decode its embedded timestamp
     (`...-h-<unix_ms>-...` inside the base64 body) and drop tokens older
     than MAX_AGE_H (default 20h — safe margin under the ~39h expiry).
  2. Harvest fresh tokens with the token-collector into a STAGING database
     (the collector wipes and recreates tokens.sqlite in its cwd, so it
     runs in an isolated dir and never touches the live bank).
  3. Merge survivors + fresh tokens (deduplicated) into the local bank and
     into the glm-render deploy repo, then push — Render auto-redeploys.

Exit codes: 0 = bank healthy (>= TARGET fresh), 1 = collected but below
target, 2 = collector/merge/push failure.

Usage:
  python refresh_tokens.py            # normal run (default flags)
  python refresh_tokens.py --dry-run  # report ages, collect nothing
  python refresh_tokens.py --target 300 --max-age-h 20
"""

import argparse
import base64
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

if os.name == "nt":
    import winreg
else:
    winreg = None

# ---------------------------------------------------------------------------
# Paths (all under the sibling glm-render/GLM-Free-API dirs on this machine)
# ---------------------------------------------------------------------------
ROOT = Path(r"C:\Users\Administrator\Desktop\glm zia")
MAIN_REPO = ROOT / "GLM-Free-API"        # live local server + collector
DEPLOY_REPO = ROOT / "glm-render"        # private Render deploy repo
STAGING = MAIN_REPO / ".token-staging"   # collector runs here (isolated)

LOCAL_BANK = MAIN_REPO / "tokens.sqlite"
DEPLOY_BANK = DEPLOY_REPO / "tokens.sqlite"
SERVER_STDOUT_LOG = MAIN_REPO / "zai-api.stdout.log"
SERVER_STDERR_LOG = MAIN_REPO / "zai-api.stderr.log"

COLLECTOR = MAIN_REPO / "token-collector.exe"
COLLECT_ARGS = ["-no-tui", "-batch", "1", "-parallel", "4"]

TS_RE = re.compile(rb"-h-(\d{13})-")

DEFAULT_TARGET = 300   # desired fresh-token count after renewal
DEFAULT_MAX_AGE = 20.0 # hours; tokens older than this are dropped


def log(msg: str) -> None:
    print(f"[refresh] {msg}", flush=True)


def winuser_env(name: str) -> str | None:
    """Read a persistent USER env var from the registry (Windows only).

    Returns None on non-Windows or when the value is absent."""
    if winreg is None:
        return None
    try:
        key = winreg.OpenKey(
            winreg.HKEY_CURRENT_USER, "Environment", 0, winreg.KEY_READ)
        try:
            value, _ = winreg.QueryValueEx(key, name)
        finally:
            key.Close()
        return value if isinstance(value, str) else None
    except OSError:
        return None


def token_age_hours(token: str) -> float | None:
    """Age in hours decoded from the token's embedded `-h-<unix_ms>-` stamp."""
    try:
        raw = base64.b64decode(token + "=" * (-len(token) % 4))
    except Exception:
        return None
    m = TS_RE.search(raw)
    if not m:
        return None
    return (time.time() * 1000 - int(m.group(1))) / 3_600_000


def load_bank(path: Path) -> list[tuple[str, float | None]]:
    """[(token, age_hours)] from the bank; unreadable tokens get age None."""
    con = sqlite3.connect(path)
    try:
        rows = con.execute("SELECT token FROM tokens").fetchall()
    finally:
        con.close()
    return [(t, token_age_hours(t)) for (t,) in rows]


def write_bank(path: Path, tokens: list[str]) -> None:
    """Recreate the bank file with exactly `tokens` (fresh, deduplicated)."""
    if path.exists():
        path.unlink()
        for suffix in ("-wal", "-shm"):
            extra = Path(str(path) + suffix)
            if extra.exists():
                extra.unlink()
    con = sqlite3.connect(path)
    try:
        con.execute(
            "CREATE TABLE tokens (id INTEGER PRIMARY KEY AUTOINCREMENT, "
            "token TEXT, batch INTEGER)"
        )
        con.executemany(
            "INSERT INTO tokens(token, batch) VALUES(?, 1)",
            [(t,) for t in tokens],
        )
        con.commit()
        con.execute("VACUUM")
    finally:
        con.close()


def collect_fresh(count: int) -> list[str]:
    """Run the collector in staging and return the harvested tokens."""
    if count <= 0:
        return []
    STAGING.mkdir(exist_ok=True)
    staging_db = STAGING / "tokens.sqlite"
    for suffix in ("", "-wal", "-shm"):
        p = Path(str(staging_db) + suffix)
        if p.exists():
            p.unlink()
    log(f"collecting {count} fresh token(s) via token-collector...")
    proc = subprocess.run(
        [str(COLLECTOR), *COLLECT_ARGS, "-tokens", str(count)],
        cwd=STAGING,
        capture_output=True,
        text=True,
        timeout=900,
    )
    if proc.returncode != 0 or not staging_db.exists():
        log(f"collector FAILED (rc={proc.returncode})")
        log(proc.stdout[-800:])
        log(proc.stderr[-800:])
        sys.exit(2)
    # collector prints "Collected N tokens in X.XXs" — cross-check the file
    fresh = [t for (t,) in sqlite3.connect(staging_db).execute(
        "SELECT token FROM tokens").fetchall()]
    log(f"collector harvested {len(fresh)} token(s)")
    return fresh


def push_deploy() -> bool:
    """Commit the refreshed bank to glm-render and push (triggers redeploy).

    Returns False when the bank is unchanged (nothing to commit) — a healthy
    bank with no stale tokens produces no commit and no pointless redeploy.
    """
    status = subprocess.run(
        ["git", "status", "--porcelain", "tokens.sqlite"],
        cwd=DEPLOY_REPO, capture_output=True, text=True,
    )
    if not status.stdout.strip():
        log("deploy bank unchanged — no commit/push needed")
        return False
    subprocess.run(["git", "add", "tokens.sqlite"], cwd=DEPLOY_REPO, check=True)
    now = time.strftime("%Y-%m-%d %H:%M")
    subprocess.run(
        ["git", "-c", "user.name=Panhard-Dev",
         "-c", "user.email=spanhard5@gmail.com",
         "commit", "-m", f"chore(tokens): automated renewal {now}"],
        cwd=DEPLOY_REPO, check=True, capture_output=True,
    )
    proc = subprocess.run(["git", "push"], cwd=DEPLOY_REPO,
                          capture_output=True, text=True)
    if proc.returncode != 0:
        log("git push FAILED: " + proc.stderr[-500:])
        sys.exit(2)
    log("pushed glm-render — Render auto-redeploy triggered")
    return True


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--target", type=int, default=DEFAULT_TARGET)
    ap.add_argument("--max-age-h", type=float, default=DEFAULT_MAX_AGE)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if not LOCAL_BANK.exists():
        log("local bank missing — nothing to renew from")
        sys.exit(2)

    bank = load_bank(LOCAL_BANK)
    fresh = [t for (t, age) in bank if age is not None and age <= args.max_age_h]
    stale = [t for (t, age) in bank if age is None or age > args.max_age_h]
    log(f"bank: {len(bank)} total | {len(fresh)} fresh | {len(stale)} stale/undated")

    if args.dry_run:
        for t, age in bank[:0]:  # ages not printed per-token (huge output)
            pass
        ages = sorted(a for (_, a) in bank if a is not None)
        if ages:
            log(f"age range: {ages[0]:.1f}h .. {ages[-1]:.1f}h")
        return 0

    need = max(0, args.target - len(fresh))
    harvested = collect_fresh(need)

    # Merge: fresh survivors + harvest, deduplicated, survivors first.
    merged, seen = [], set()
    for t in fresh + harvested:
        if t not in seen:
            seen.add(t)
            merged.append(t)
    log(f"merged bank: {len(merged)} token(s)")

    # Staging db is disposable now; drop it.
    shutil.rmtree(STAGING, ignore_errors=True)

    if len(merged) < args.target:
        log(f"WARNING: below target ({len(merged)}/{args.target})")

    # Stop the local server BEFORE rewriting its bank: the sqlite file must
    # not be swapped under a live process (it holds it open with WAL).
    subprocess.run(
        ["powershell", "-Command",
         "Get-Process zai-api -ErrorAction SilentlyContinue | Stop-Process -Force"],
        capture_output=True,
    )

    write_bank(LOCAL_BANK, merged)
    log(f"local bank updated: {len(merged)} tokens")

    if DEPLOY_REPO.exists():
        write_bank(DEPLOY_BANK, merged)
        push_deploy()

    # The local server was stopped above — restart it detached on the fresh
    # bank so the machine keeps serving after an unattended renewal run.
    # Credentials come from the persistent user environment (setx-style),
    # which the scheduled task and this script both inherit. The registry
    # read is the source of truth: even when this script runs from a shell
    # without the vars exported, the server still gets the account token.
    if (MAIN_REPO / "zai-api.exe").exists():
        env = dict(os.environ)
        for name in ("ZAI_TOKEN", "ALIYUN_ACCESS_KEY", "ALIYUN_SECRET_KEY"):
            if not env.get(name):
                stored = winuser_env(name)
                if stored:
                    env[name] = stored
        subprocess.Popen(
            [str(MAIN_REPO / "zai-api.exe"), "--agent-mode"],
            cwd=str(MAIN_REPO),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            env=env,
        )
        log("local server restarted on fresh bank")

    return 0 if len(merged) >= args.target else 1


if __name__ == "__main__":
    sys.exit(main())
