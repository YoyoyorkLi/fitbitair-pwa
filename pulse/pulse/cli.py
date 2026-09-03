"""Command line entry point.

    python -m pulse demo      synthetic 30 days -> dashboard.html, no account needed
    python -m pulse setup     write .env with your Google client ID/secret
    python -m pulse login     one-time Google sign-in, opens your browser
    python -m pulse doctor    probe every data type, show real field names
    python -m pulse sync      pull real data into pulse.db, then rebuild
    python -m pulse build     rebuild dashboard.html from what is already cached
    python -m pulse phone     serve on your wifi and print a QR code to scan
    python -m pulse status    what is connected, what is cached
"""
from __future__ import annotations

import os
import socket
import sys
from datetime import datetime

from . import config as cfg


def _lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"
    finally:
        s.close()


def _serve(port):
    import http.server
    import socketserver

    from . import qr

    ip = _lan_ip()
    url = f"http://{ip}:{port}/dashboard.html"

    class OnlyDashboard(http.server.BaseHTTPRequestHandler):
        """Serves exactly one file.

        A directory-serving handler would expose the whole folder on your wifi,
        including .token.json (your refresh token) and pulse.db (your full
        health history). This one cannot: there is no path traversal to find.
        """

        def do_GET(self):
            if self.path.split("?")[0] not in ("/", "/dashboard.html"):
                self.send_error(404)
                return
            try:
                body = cfg.OUT_HTML.read_bytes()
            except FileNotFoundError:
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *a):
            pass

    socketserver.TCPServer.allow_reuse_address = True
    try:
        server = socketserver.TCPServer(("", port), OnlyDashboard)
    except OSError as e:
        sys.exit(f"Cannot bind port {port}: {e}\nTry another: python -m pulse phone 8010")

    print()
    print(qr.terminal(url, "M"), flush=True)
    print(f"  Scan that, or open:  {url}")
    if ip.startswith("127."):
        print("  WARNING: no LAN address detected; your phone may not reach this.")
    print("  Phone must be on the same wifi. Ctrl-C to stop.\n", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("stopped")
    finally:
        server.server_close()


def _setup(json_path=None):
    """Write .env from a downloaded Google OAuth client JSON, or interactively.

    This is the only place credentials are entered. Everything afterwards reads
    .env, so there is nothing to re-export in a new terminal.
    """
    import glob
    import json
    import time

    cid = csec = None
    candidates = []
    if json_path:
        candidates = [json_path]
    else:
        for pat in ("client_secret*.json", "~/Downloads/client_secret*.json",
                    "~/.config/pulse/*.json"):
            candidates += sorted(glob.glob(os.path.expanduser(pat)))

    for c in candidates:
        try:
            blob = json.loads(open(os.path.expanduser(c)).read())
        except Exception:
            continue
        node = blob.get("installed") or blob.get("web") or {}
        if node.get("client_id"):
            cid, csec = node["client_id"], node.get("client_secret", "")
            print(f"found credentials in {c}")
            if "web" in blob and "installed" not in blob:
                print("  note: this is a Web application client. A Desktop app client is\n"
                      "  simpler (no redirect URIs to register). If login fails with\n"
                      "  redirect_uri_mismatch, add http://localhost:8765/callback and\n"
                      "  http://127.0.0.1:8765/callback in the console.")
            break

    if not cid:
        print("Paste the two values from Google Cloud Console")
        print("  (APIs & Services -> Credentials -> your OAuth 2.0 Client ID)\n")
        try:
            cid = input("  Client ID     : ").strip()
            csec = input("  Client secret : ").strip()
        except (EOFError, KeyboardInterrupt):
            sys.exit("\ncancelled")
    if not cid.endswith(".apps.googleusercontent.com"):
        print(f"\nwarning: that client ID looks wrong -- it should end in\n"
              f"  .apps.googleusercontent.com\n  got: {cid[:60]}")

    tz = os.environ.get("PULSE_TZ") or ""
    if not tz:
        from .metrics import _detect_zone_name
        tz = _detect_zone_name() or "America/Chicago"
        try:
            ans = input(f"  Timezone [{tz}] : ").strip()
            tz = ans or tz
        except (EOFError, KeyboardInterrupt):
            pass

    if cfg.ENV_FILE.exists():
        backup = cfg.ENV_FILE.with_suffix(f".env.bak.{int(time.time())}")
        cfg.ENV_FILE.rename(backup)
        print(f"\nexisting .env backed up to {backup.name}")

    cfg.ENV_FILE.write_text(
        "# Pulse credentials. Never commit this file -- .gitignore covers it.\n"
        f"GH_CLIENT_ID={cid}\n"
        f"GH_CLIENT_SECRET={csec}\n"
        f"PULSE_TZ={tz}\n")
    try:
        cfg.ENV_FILE.chmod(0o600)
    except Exception:
        pass

    print(f"\nwrote {cfg.ENV_FILE}  (chmod 600)")
    print("  Every command reads this automatically. Nothing to export.\n")
    print("next:  python -m pulse login")


def main(argv=None):
    argv = argv if argv is not None else sys.argv[1:]
    cmd = argv[0] if argv else "help"
    arg = argv[1] if len(argv) > 1 else None

    if cmd == "demo":
        from . import ingest, render
        days = int(arg or 30)
        print(f"generating {days} synthetic days in the v4 wire format ...")
        con = ingest.db(cfg.DEMO_DB_PATH)
        try:
            ingest.synthesize(days=days, con=con)
        finally:
            con.close()
        con = ingest.db(cfg.DEMO_DB_PATH)
        try:
            out, D = render.build(con=con)
        finally:
            con.close()
        print(f"ok  {out}")
        print(f"    {len(D['m'])} days, {len(D['hr']):,} heart-rate samples")
        print("\nnext:  python -m pulse phone")

    elif cmd == "setup":
        _setup(arg)

    elif cmd == "login":
        from . import auth
        auth.login()
        print("\nConnected. Now run:  python -m pulse doctor")

    elif cmd == "backfill":
        from . import backfill as bf
        bf.backfill(int(arg) if arg else 36)

    elif cmd == "push":
        from . import push as ps
        if arg:                       # optional: sync first, then push
            from . import ingest as ig
            print(f"syncing {arg} days first ...")
            ig.sync(days=int(arg))
        ps.push()

    elif cmd == "doctor":
        from . import ingest, metrics
        print(f"timezone in use : {metrics._tz()}")
        print(f"credentials     : {'set' if cfg.CLIENT_ID else 'NOT SET'}")
        print("\nprobing each data type with a short window ...\n")
        try:
            rows = ingest.probe(int(arg or 2))
        except SystemExit:
            raise
        except Exception as e:                       # noqa: BLE001
            sys.exit(f"probe failed: {e}")
        ok = 0
        for r in rows:
            if r["error"]:
                print(f"  FAIL  {r['type']:30s} {r['error']}")
            elif r["n"] == 0:
                print(f"  EMPTY {r['type']:30s} no points in this window")
            else:
                ok += 1
                print(f"  OK    {r['type']:30s} {r['n']:>7,} pts")
                print(f"        fields: {r['fields']}")
        print(f"\n  {ok}/{len(rows)} data types returning data")
        if ok:
            print("\n  If a field name is not what Pulse expects it still works: the")
            print("  parser falls back to the single numeric field in the payload.")
            print("  Paste this output if anything looks wrong.")

    elif cmd == "sync":
        from . import ingest, render
        days = int(arg) if arg else None
        print("catching up from the last cached day ..." if days is None
              else f"pulling {days} days from the Google Health API ...")

        def prog(dt, i, n):
            if n > 1:
                print(f"\r  {dt:32s} window {i}/{n}", end="", flush=True)

        try:
            counts = ingest.sync(days=days, progress=prog)
        except RuntimeError as e:
            sys.exit(f"\n\nSync failed:\n  {e}")
        print("\r" + " " * 60 + "\r", end="")
        for k, v in counts.items():
            print(f"  {k:32s} {v:>8,} points")
        if not any(counts.values()):
            sys.exit("\nNothing came back. Run:  python -m pulse doctor")
        out, D = render.build()
        print(f"ok  {out}  ({len(D['m'])} days)")
        print("\nnext:  python -m pulse phone")

    elif cmd == "build":
        from . import render
        out, D = render.build()
        print(f"ok  {out}  ({len(D['m'])} days)")

    elif cmd in ("phone", "serve"):
        if not cfg.OUT_HTML.exists():
            sys.exit("No dashboard yet. Run:  python -m pulse demo")
        _serve(int(arg or 8000))

    elif cmd == "status":
        from . import auth, metrics
        from .ingest import db
        print(f"credentials : {'set' if cfg.CLIENT_ID else 'NOT SET (see WORKFLOW.md)'}")
        print(f"account     : {auth.status()}")
        print(f"timezone    : {metrics._tz()}")
        if cfg.DB_PATH.exists():
            con = db()
            try:
                rows = con.execute(
                    "SELECT data_type, COUNT(*), MIN(pit), MAX(pit) "
                    "FROM raw GROUP BY data_type").fetchall()
            finally:
                con.close()
            print(f"cache       : {cfg.DB_PATH.name} "
                  f"({cfg.DB_PATH.stat().st_size / 1e6:.1f} MB)")
            for t, n, lo, hi in rows:
                print(f"  {t:32s} {n:>8,}   {str(lo)[:10]} .. {str(hi)[:10]}")
        else:
            print("cache       : empty (no real data synced yet)")
        if cfg.OUT_HTML.exists():
            ts = datetime.fromtimestamp(cfg.OUT_HTML.stat().st_mtime)
            print(f"dashboard   : {cfg.OUT_HTML.name}, built {ts:%Y-%m-%d %H:%M}")
    else:
        print(__doc__)


if __name__ == "__main__":
    main()
