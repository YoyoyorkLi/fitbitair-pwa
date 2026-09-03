"""Google OAuth 2.0 for a desktop app, loopback redirect.

Run once. Opens a browser, catches the redirect on 127.0.0.1, exchanges the
code, stores the refresh token locally. Nothing goes anywhere except Google.

Publishing status decides how often you repeat this:
  Testing    - authorisations, INCLUDING the refresh token, expire 7 days
               after consent.
  Production - still unverified, still shows the "Google hasn't verified this
               app" warning, still capped at 100 users, but no 7-day clock.
"""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer

from . import config as cfg

AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token"

_PAGE = """<!doctype html><meta charset="utf-8"><title>Pulse</title>
<style>body{background:#0B0E14;color:#E6EAF2;font-family:ui-sans-serif,-apple-system,sans-serif;
display:flex;height:100vh;align-items:center;justify-content:center;margin:0}
div{text-align:center}h1{font-size:20px;margin:0 0 8px}p{color:#7E8AA3;font-size:13px;margin:0}
</style><div><h1>%s</h1><p>%s</p></div>"""


class _Handler(BaseHTTPRequestHandler):
    code = None
    error = None
    state = None

    def do_GET(self):
        q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        if "code" in q and q.get("state", [None])[0] == _Handler.state:
            _Handler.code = q["code"][0]
            body = _PAGE % ("Connected", "Close this tab and return to the terminal.")
        elif "code" in q:
            _Handler.error = "state mismatch (possible CSRF); try again"
            body = _PAGE % ("Authorisation failed", _Handler.error)
        else:
            _Handler.error = q.get("error", ["unknown"])[0]
            body = _PAGE % ("Authorisation failed", _Handler.error)
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write(body.encode())

    def log_message(self, *a):
        pass


def _post(body):
    req = urllib.request.Request(
        TOKEN_ENDPOINT, data=urllib.parse.urlencode(body).encode(),
        headers={"Content-Type": "application/x-www-form-urlencoded"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        try:
            detail = json.loads(e.read() or b"{}")
        except Exception:
            detail = {}
        raise RuntimeError(f"token endpoint {e.code}: {detail.get('error')} "
                           f"{detail.get('error_description', '')}") from None
    except urllib.error.URLError as e:
        raise RuntimeError(f"cannot reach Google: {e.reason}") from None


def auth_url(state):
    return AUTH_ENDPOINT + "?" + urllib.parse.urlencode({
        "client_id": cfg.CLIENT_ID,
        "redirect_uri": cfg.REDIRECT_URI,
        "response_type": "code",
        "scope": " ".join(cfg.SCOPES),
        "access_type": "offline",
        "prompt": "consent",     # guarantees a refresh_token on repeat logins
        "state": state,
        # Deliberately NO include_granted_scopes. If this client has ever been
        # consented for legacy Google Fit fitness.* scopes they get unioned into
        # the token and the Health data plane rejects it with an opaque 403.
    })


def login(timeout=300):
    if not cfg.CLIENT_ID or not cfg.CLIENT_SECRET:
        raise SystemExit("Missing credentials.\n"
                         "  export GH_CLIENT_ID=...\n"
                         "  export GH_CLIENT_SECRET=...\n"
                         "See WORKFLOW.md step 4.")
    if not cfg.CLIENT_ID.endswith(".apps.googleusercontent.com"):
        print(f"warning: GH_CLIENT_ID looks wrong: {cfg.CLIENT_ID[:40]}...")

    port = urllib.parse.urlparse(cfg.REDIRECT_URI).port or 8765
    _Handler.state = str(int(time.time()))
    _Handler.code = _Handler.error = None
    try:
        server = HTTPServer(("127.0.0.1", port), _Handler)
    except OSError as e:
        raise SystemExit(f"Cannot listen on port {port}: {e}\n"
                         f"Something else is using it. Try:\n"
                         f"  export PULSE_REDIRECT_URI=http://localhost:8799/callback")
    server.timeout = timeout
    url = auth_url(_Handler.state)

    print("\nOpening your browser to approve access.")
    print("You will see 'Google hasn't verified this app'. That is expected for a")
    print("personal app: click Advanced, then Continue.\n")
    print(f"If the browser does not open, paste this:\n\n{url}\n")
    try:
        webbrowser.open(url)
    except Exception:
        pass

    deadline = time.time() + timeout
    while _Handler.code is None and _Handler.error is None:
        if time.time() > deadline:
            server.server_close()
            raise SystemExit("Timed out waiting for the browser redirect.")
        server.handle_request()
    server.server_close()

    if _Handler.error:
        raise SystemExit(f"Authorisation failed: {_Handler.error}")

    tok = _post({"grant_type": "authorization_code", "code": _Handler.code,
                 "redirect_uri": cfg.REDIRECT_URI, "client_id": cfg.CLIENT_ID,
                 "client_secret": cfg.CLIENT_SECRET})
    if "refresh_token" not in tok:
        raise SystemExit("No refresh token returned. Revoke Pulse at "
                         "myaccount.google.com/permissions and run login again.")
    tok["obtained_at"] = time.time()
    tok["expires_at"] = time.time() + tok.get("expires_in", 3600)
    cfg.TOKEN_FILE.write_text(json.dumps(tok, indent=2))
    try:
        cfg.TOKEN_FILE.chmod(0o600)
    except Exception:
        pass
    return tok


def access_token():
    """Return a valid access token, refreshing if needed."""
    if not cfg.TOKEN_FILE.exists():
        raise SystemExit("Not connected yet. Run:  python -m pulse login")
    tok = json.loads(cfg.TOKEN_FILE.read_text())

    if tok.get("access_token") and time.time() < tok.get("expires_at", 0) - 60:
        return tok["access_token"]

    if not cfg.CLIENT_ID or not cfg.CLIENT_SECRET:
        raise SystemExit("Token needs refreshing but GH_CLIENT_ID / "
                         "GH_CLIENT_SECRET are not set in this shell.")
    try:
        fresh = _post({"grant_type": "refresh_token",
                       "refresh_token": tok["refresh_token"],
                       "client_id": cfg.CLIENT_ID,
                       "client_secret": cfg.CLIENT_SECRET})
    except RuntimeError as e:
        if "invalid_grant" in str(e):
            raise SystemExit(
                "Your refresh token has expired or was revoked.\n\n"
                "The usual cause is the OAuth app still being in 'Testing' status,\n"
                "where consent expires after 7 days. Set it to 'In production' in\n"
                "the Google Auth Platform console (stays unverified, still free),\n"
                "then run:  python -m pulse login") from None
        raise

    tok.update(fresh)
    tok["expires_at"] = time.time() + tok.get("expires_in", 3600)
    cfg.TOKEN_FILE.write_text(json.dumps(tok, indent=2))
    return tok["access_token"]


def status():
    if not cfg.TOKEN_FILE.exists():
        return "not connected"
    try:
        tok = json.loads(cfg.TOKEN_FILE.read_text())
    except Exception:
        return "token file unreadable; run login again"
    age = (time.time() - tok.get("obtained_at", time.time())) / 86400
    warn = "  (Testing-mode tokens die at 7 days)" if age > 5 else ""
    return f"connected, consent is {age:.1f} days old{warn}"
