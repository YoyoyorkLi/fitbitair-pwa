#!/bin/bash
# Re-authorize Google Health and hand you the fresh refresh token, ready to
# paste into the GitHub secret.
#
# Why this exists: the OAuth app is staying in Testing mode (not chasing
# Google's full brand-verification review, which is built for public
# products with external users, not a single-person tool on a free vercel.app
# subdomain that Google's own domain rules only half-accept). Testing mode's
# real cost is a refresh token that dies 7 days after consent -- this makes
# renewing it a 30-second, once-a-week habit instead of a research project.
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
