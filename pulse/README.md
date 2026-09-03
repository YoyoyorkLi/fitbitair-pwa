# Pulse

Personal health dashboard on the Google Health API v4. Replaces the Google
Health app's charts with one self-contained HTML file you open on your phone.

Free to run. No published app, no hosting, no billing account.

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

python -m pulse demo      # synthetic data, no Google account needed
python -m pulse phone     # prints a QR code, scan it
```

Then connect real data — full guide in **WORKFLOW.md**:

```bash
python -m pulse setup     # stores your client ID/secret in .env, once
python -m pulse login     # one-time browser sign-in
python -m pulse doctor    # probe what your account actually returns
python -m pulse sync 7    # pull 7 days
```

## First screen

Three headline KPIs: **Day strain** (0–21), **Recovery** (0–100),
**Sleep score** (0–100). Then full-resolution heart rate, time-in-zone, and
strain vs a recovery-scaled target. Sleep and Trends tabs behind that.

## Design notes

- **Credentials live in `.env`**, written once by `setup` with `chmod 600` and
  covered by `.gitignore`. Nothing to export per shell.
- **Timezone-correct.** The API returns UTC instants; aggregation happens in
  local civil time. Without this a Chicago evening lands on the next UTC day.
- **Query windows chunked** to Google's caps: 14 days for heart-rate, 90 for
  the rest. Verified up to a 365-day sync.
- **Schema-drift tolerant.** Daily metrics fall back to the single numeric
  field if Google renames one; v4 is still pre-GA.
- **Degrades gracefully.** Missing HRV, missing resting HR, CLASSIC-only sleep
  and single-night histories all render rather than crash.
- **Naps excluded** (< 3 h) so they cannot masquerade as last night.
- **`phone` serves one file only.** No directory listing, no traversal;
  `pulse.db`, `.env` and `.token.json` are unreachable.
- **No dependencies beyond numpy and pandas.** SVG, QR and OAuth are hand-rolled
  stdlib, so the output HTML is fully offline.
- **Python 3.9+**, which is what macOS ships.
