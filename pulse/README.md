# Pulse

The data half: pull the Google Health API v4 into SQLite, turn it into
per-night strain / recovery / sleep, and upsert one row per night to Supabase
for the PWA (`../public/`) to read. There is no local dashboard — the PWA is
the only front end.

Free to run. No paid hosting, no billing account.

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

python -m pulse demo      # synthetic data end-to-end -- a fast pipeline check
```

Then connect real data — full guide in **WORKFLOW.md**:

```bash
python -m pulse setup     # stores your client ID/secret in .env, once
python -m pulse login     # one-time browser sign-in
python -m pulse doctor    # probe what your account actually returns
python -m pulse sync 7    # pull 7 days into pulse.db
python -m pulse push      # compute every night and upsert to Supabase
```

## The numbers

Three headline metrics: **Day strain** (0–21), **Recovery** (0–100),
**Sleep score** (0–100), plus **Recovery Load** (settled / elevated / high).

How each is calculated — with the constants and the research behind them — is in
**[METRICS.md](METRICS.md)**. `python -m pulse test` checks the formulas.

## Design notes

- **Credentials live in `.env`**, written once by `setup` with `chmod 600` and
  covered by `.gitignore`. Nothing to export per shell.
- **Timezone-correct.** The API returns UTC instants; aggregation happens in
  local civil time. Without this a Chicago evening lands on the next UTC day.
- **Query windows chunked** to Google's caps: 14 days for heart-rate, 90 for
  the rest. Verified up to a 365-day sync.
- **Schema-drift tolerant.** Daily metrics fall back to the single numeric
  field if Google renames one; v4 is still pre-GA. One data type the API
  rejects is skipped, not fatal.
- **Degrades gracefully.** Missing HRV, missing resting HR, CLASSIC-only sleep,
  no skin temperature and single-night histories all compute rather than crash.
- **Naps** (< 3 h) don't masquerade as last night, but their minutes still
  credit sleep debt and recovery.
- **No dependencies beyond numpy and pandas.** OAuth is hand-rolled stdlib.
- **Python 3.9+**, which is what macOS ships.
