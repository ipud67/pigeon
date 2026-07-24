# Pigeon — what actually mattered

A minimalist, fact-only news app. Time, place, fact, primary-source link. No opinion.
No gossip. **FACT → CONTEXT → WEIGH-IT.**

**Live:** https://ipud67.github.io/pigeon/

This repository is a **public deploy mirror** of the Pigeon app, hosted on GitHub Pages as
a stopgap demo. It contains the application source and a baked, pre-ingested fact store
(`data/facts.json`) built from free primary-source feeds (Federal Register, White House,
SEC EDGAR, U.S. Treasury, DoD, Federal Reserve, UK Hansard, UN, CourtListener, BLS, GDELT,
and a small set of vetted independent wires). No paid LLM call runs in the pipeline — the
editorial gate uses a deterministic mock classifier by default.

## Run locally

```
npm install
npm run ingest      # pulls free primary-source feeds -> data/facts.json (no API key)
PIGEON_BASE_PATH=/pigeon npm run build   # static export to out/
npx serve out
```

## Deploy

Pushes to `main` trigger `.github/workflows/pages.yml`, which builds the static export
with `basePath=/pigeon` and publishes to GitHub Pages. On a schedule (every 6 hours) and on
manual dispatch, the workflow also re-ingests the free feeds and commits the refreshed
fact store before building, so the published edition updates itself.

---

© 2026 Creatus LLC. All rights reserved.
