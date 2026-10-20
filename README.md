# TFDA Drug Info Search (TFDA 藥品資訊查詢系統)

**English** | [繁體中文](README.zh-TW.md)

[![Live Demo](https://img.shields.io/badge/Live%20Demo-Click%20Here-2563eb?style=flat-square)](https://liangrxdev.github.io/TFDA-drug-info-search/)
[![License](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](LICENSE)
[![HTML5](https://img.shields.io/badge/HTML5-E34F26.svg?style=flat-square&logo=html5&logoColor=white)]()
[![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E.svg?style=flat-square&logo=javascript&logoColor=black)]()
[![Python](https://img.shields.io/badge/Python-3.10+-3776ab.svg?style=flat-square&logo=python&logoColor=white)]()
[![GitHub Actions](https://img.shields.io/badge/GitHub%20Actions-2088FF.svg?style=flat-square&logo=github-actions&logoColor=white)]()

## Architecture Summary

A serverless, purely static single-page application (SPA). GitHub Actions periodically runs a Python data-processing script that pulls raw open data from the Taiwan Food and Drug Administration (TFDA), pre-fetches and cleanses it, and generates a lightweight static JSON cache. This architecture removes the physical limits of calling government APIs directly from the frontend — CORS restrictions, high network latency and browser out-of-memory (OOM) — and delivers millisecond-level client-side search. The interface is in Traditional Chinese.

## Frontend Features

Designed around the lookup pain points of clinical staff and the public, the frontend offers these engineering and UX advantages:

* 🚀 **Millisecond search (in-memory):** No API round trips. When the page loads, the lightweight JSON is cached locally, and all Chinese/English fuzzy searches complete instantly in memory — results appear as you type, with zero latency.
* 🔎 **Name / ingredient / ATC search scope:** Besides Chinese and English product names, you can switch to searching by **ingredient**, matched directly against the raw `ingredients` field, so `AMLODIPINE` also matches `AMLODIPINE (AS BESYLATE)`. This covers brand names that don't contain the ingredient string (e.g. 「脈優」), and ingredient search returns a notably larger result set than name search. The default stays on "name" so that combination products of common ingredients such as ACETAMINOPHEN don't dilute name results.
* 🏷️ **ATC code search:** Prefix match against NHI ATC codes, for both finding a drug class and exact lookup: `C09` lists the whole RAS class, while `C09CA01` lists only losartan. Results come with an **ATC group summary table** (code / ingredient / product count); clicking a code narrows the cards to that group, so a whole class is visible despite the 30-card limit. Limitations:
  * ATC codes **come only from NHI data**, so non-NHI products can't be found by ATC. A fixed notice above the results says so.
  * Products whose NHI code stops at a broader level (e.g. only `N07CA`) are **not included** in deeper queries — they may be a different drug in the same class. Only their count is shown.
  * The "all" scope deliberately does not include ATC matching.

  See `docs/plan-atc-search.md`.
* 🌐 **US prescription label reference (openFDA):** A collapsible section in each drug card. It matches openFDA US prescription drug labels by ingredient and route, and shows the verbatim Boxed Warning, pregnancy and lactation text of a **representative label** (NDA/BLA innovator labels first), with a DailyMed link.
  * Matching is deliberately **strict**: counter-ion salts and hydrates are treated as equivalent, while esters and prodrugs are kept distinct; combination products must match the exact ingredient set.
  * It only makes **positive statements**: about 30% of current US Rx labels lack structured openFDA fields, so "no Boxed Warning found" does not mean there is none.
  * A fixed notice at the top states that this is not the Taiwan-approved information for the product.

  Spec and acceptance records: `docs/plan-us-label.md`.
* 💡 **Autosuggest:** Suggestions appear after 2+ characters, split into "ingredient / name" sections (plus "search by ATC" when the input looks like an ATC code of 3+ characters), with the number of products per ingredient, and support arrow-key selection. The index is built once after data loads (currently about 3.7K distinct ingredients and 42K names; the scale changes with the weekly data update, and `data_version.json` holds the actual counts). Ingredient suggestions also appear under the "name" scope as a shortcut to switch scope; choosing one updates the scope button, so the result set is never changed silently.
* ⚡ **Ultra-light (zero dependencies):** No heavy modern framework (React/Vue); plain vanilla JS and native DOM operations. The rendering core is minimal, significantly lowering time to interactive (TTI).
* 📱 **Responsive card design:** Built mobile-first, turning sprawling package-insert data into structured "drug cards". Indications, ingredients and dosage are clear to read on a phone or a nursing-station desktop.
* 🔗 **Cross-dataset integration:** The UI automatically links data siloed across agencies — drug licenses, original package insert links (PDF) and NHI reimbursement rules — greatly reducing lookup effort for clinical pharmacists and physicians.

## Facts: Tech Stack and Modules

| Module | Implementation | Description |
| :--- | :--- | :--- |
| **Frontend** | HTML5, vanilla JavaScript, CSS3 | Event-driven; performs in-memory fuzzy search and DOM rendering over `drugs_data.json` cached locally / via CDN. |
| **Data extraction (ETL)** | Python 3.x (`build_data.py`) | Connects to TFDA open data APIs (licenses, package inserts, etc.), filters and merges fields, and normalizes structure; also derives each product's US-label matching key from dosage form and ingredients. |
| **US label reference (ETL)** | Python 3.x (`build_us_label.py`, `us_label.py`) | Downloads the full openFDA `/drug/label` **bulk export** (14 files, ~1.8 GB, record counts checked per file against the manifest), selects a representative label per key, and writes `us_label_data.json` (~1 MB gzipped). **All-or-nothing**: any failure aborts and keeps the previous file; the main data is still published. |
| **Automation (CI/CD)** | GitHub Actions | `Build Drug Database` runs both ETL stages weekly and auto-commits changes. `Tests` runs pytest and the jsdom frontend tests on PRs and pushes. |
| **Hosting** | GitHub Pages | Serves the static files (CDN) with a highly available HTTPS endpoint. |

## Data Pipeline

Data updates follow this automated flow:
1. **Trigger:** GitHub Actions runs every Sunday at 18:00 UTC (Monday 02:00 Taiwan). It can also be started manually via `workflow_dispatch`, and runs on pushes to main that change the ETL scripts.
2. **Setup:** Installs the required Python modules from `requirements.txt`.
3. **Fetch:** `build_data.py` sends HTTP GET requests to the TFDA server and downloads the large raw JSON datasets.
4. **Cleanse:** Removes fields the frontend doesn't need to minimize size, and builds an integrated structure keyed on the license number.
5. **Build:** Writes the slimmed `drugs_data.json`, overwriting the old file.
6. **US label:** `build_us_label.py` downloads the openFDA bulk export and writes `us_label_data.json`. The step uses `continue-on-error`; on failure, the previous file is restored before committing, so the main data is unaffected.
7. **Deploy:** When the content of either data file changes, the files are committed and pushed to the main branch, triggering a GitHub Pages update. Timestamp-only changes are not committed.

## Local Development

To debug or develop locally:

### 1. Get the source

```bash
git clone https://github.com/liangRXdev/TFDA-drug-info-search.git
cd TFDA-drug-info-search
```

### 2. Data layer (Python)

Requires [uv](https://docs.astral.sh/uv/). `uv` resolves dependencies on the fly from the requirements files, so there is no need to create or activate a virtual environment manually:

```bash
# Run the data update script to produce the latest drugs_data.json
uv run --with-requirements requirements.txt python build_data.py

# Build the US label reference (needs drugs_data.json first; downloads ~1.8 GB)
uv run --with-requirements requirements.txt python build_us_label.py

# Run the tests (requirements-dev.txt includes pytest)
uv run --with-requirements requirements-dev.txt python -m pytest tests/ -q
```

### 3. Frontend (UI)

Modern browsers restrict the local `file://` protocol (`fetch()` can't read local JSON), so serve it through a local server:

```bash
# Python's built-in HTTP server
uv run python -m http.server 8000
```

Then open `http://localhost:8000` in a browser to preview the UI and test search.

Frontend tests load `index.html` and `app.js` in jsdom (requires Node and `npm ci`):

```bash
npm test   # xss.spec.mjs (XSS regression), us_label.spec.mjs (US label section, SW validation), atc.spec.mjs (ATC search)
```

## Pitfalls and Maintenance Notes

* **File size monitoring:** Monitor the **gzip-compressed transfer size**, not the raw file size on disk — GitHub Pages enables gzip by default, and the two differ by about 4.5×. As of 2026-07, the raw file is 37.7 MB and the actual transfer is **8.3 MB**. A 10 MB transfer size is the suggested alert line. `us_label_data.json` is tracked separately, with a 3 MB gzip budget (about 1 MB measured in 2026-10); it is only loaded the first time a US label section is expanded.

  Local measurements (8 cores / 16 GB, Chrome) of each stage show that **computation isn't the bottleneck; network transfer is**:

  | Stage | Time |
  | :--- | ---: |
  | `JSON.parse` (37.7 MB) | 102 ms |
  | Build search index | 163 ms |
  | Single ingredient search (953 hits) | 9 ms |
  | Autosuggest scan (42K names) | 2 ms |

  Peak JS heap is about 138 MB (desktop limit 4192 MB, no concern). **Low-end mobile devices have much lower heap limits, and this hasn't been measured**; if mobile crashes are ever reported, start looking here.
* **API endpoint stability:** `build_data.py` depends on the TFDA open-data platform's URL structure and JSON key names. If the government side changes the schema without notice, the GitHub Actions build will fail; keep an eye on the Action logs.
* **Ingredient field is English only:** The raw TFDA `ingredients` field holds English ingredient names (salts in parentheses, multiple ingredients separated by `;;`), **with no Chinese**. So the ingredient scope can't search Chinese names such as 「阿莫西林」 (amoxicillin) (measured: 0 results). Supporting that would need a separate Chinese–English ingredient mapping table, which the frontend can't solve alone. Coverage: about 88.7% of all records have ingredients, and nearly all NHI items do (only a handful missing). **Always take total and NHI record counts from `totalRecords` / `nhiRecords` in `data_version.json`**, which is rewritten on every build; absolute counts aren't hard-coded here so they don't go stale with weekly updates.
* **Data caching strategy (SWR):** `sw.js` uses stale-while-revalidate for the data files (`drugs_data.json`, `us_label_data.json`, listed in `DATA_FILES`). **Each file has its own validator and update lock**, and a failed validation keeps the old cache — the cached copy is returned first so the page is usable immediately, and a background conditional request with `If-None-Match` checks for a new version. Data updates weekly, so when unchanged the response is just a 304 (0 bytes), with no need to refetch 8.3 MB. **If you change this strategy, never fall back to network-first**: that would redownload the whole dataset every time the app opens. When a new version arrives, a green banner prompts the user to reload; it doesn't auto-reload, to avoid interrupting a search in progress.

  Note: on the **first** visit the service worker finishes registering only after the `drugs_data.json` request has been sent, so it can't intercept or cache that request. The SW takes over and writes the cache on the **2nd** visit, and the 304 steady state starts from the **3rd**. When testing caching, a single reload will make it look broken.
* **Service worker cache version:** After changing `index.html` or `app.js` it is **recommended** to bump `STATIC_CACHE` in `sw.js`, but for a counter-intuitive reason:

  | Situation | Without bump | With bump |
  | :--- | :--- | :--- |
  | Page seen by online users | ✅ new | ✅ new |
  | Page in the offline cache | ⚠️ see below | ✅ new |

  `index.html` and `app.js` are **network-first** (see the end of `sw.js`), so **online users always get the latest page regardless of the version number** — bumping isn't a precondition for new features to take effect. What it really does is refresh the **offline copy**.

  > **⚠️ This behavior changed on 2026-07-20 and has not been re-measured.** The earlier measured conclusion was: `cache.put` in the network-first branch was fire-and-forget (not protected by `waitUntil`) and was discarded when the SW event ended, so the offline copy was **not** updated; only a version bump triggering `addAll` in `install` refreshed it. That defect has been fixed (`cache.put` is now inside `event.waitUntil`), so in theory the offline copy should update during normal browsing, but **the new behavior in the "without bump" column has not been verified by measurement**, so the recommendation to bump stays for now.
  >
  > Also note: the `install` `addAll` precache list now includes `./app.js`. **When adding static files, always add them to that list too**, or the site will be missing files offline and stop working. **Data files are the exception**: add a new data file to `DATA_FILES` in `sw.js` (with its own validator), **not** to the install list — otherwise every SW install would prefetch the whole dataset.
