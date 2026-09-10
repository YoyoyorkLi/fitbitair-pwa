#!/bin/bash
# Re-authorize Google Health and hand you the fresh refresh token, ready to
# paste into the GitHub secret.
#
# Why this exists: mints a fresh refresh token for the GH_REFRESH_TOKEN repo
# secret. The OAuth app is now "In production" (unverified) -- see
# WORKFLOW.md 2b -- so a token minted here has no expiry clock. This is a
# one-time step now; re-run it only if the sync starts failing auth again
# (access revoked, a Workspace session policy, a password change).
#
# History: while the app was in Testing (through early 2026-09) that consent,
# refresh token included, died 7 days flat after each login, and this was a
# weekly chore.
#
# Usage:
#     ./refresh_login.sh
set -euo pipefail
cd "$(dirname "$0")"

echo "Opening the browser for a fresh Google consent -- approve it there."
echo "('Google hasn't verified this app' is expected; Advanced -> Continue.)"
echo

.venv/bin/python -m pulse login

TOKEN=$(.venv/bin/python -c "import json; print(json.load(open('.token.json'))['refresh_token'])")

echo
echo "─────────────────────────────────────────────────────────────"
if command -v gh >/dev/null 2>&1; then
  echo "gh found -- updating the GitHub secret directly."
  echo "$TOKEN" | gh secret set GH_REFRESH_TOKEN --repo YoyoyorkLi/fitbitair-pwa
  echo "GH_REFRESH_TOKEN updated. Nothing left to do."
else
  echo "New refresh token (gh isn't installed, so paste this by hand):"
  echo
  echo "  $TOKEN"
  echo
  echo "→ https://github.com/YoyoyorkLi/fitbitair-pwa/settings/secrets/actions"
  echo "  GH_REFRESH_TOKEN → the pencil icon → paste → Update secret"
  echo
  echo "(brew install gh && gh auth login, once, and this script updates"
  echo " the secret for you automatically from now on.)"
fi
echo "─────────────────────────────────────────────────────────────"
