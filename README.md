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
* 🔎 **Name / ingredient search scope:** Besides Chinese and English product names, you can switch to searching by **ingredient**, matched directly against the raw `ingredients` field, so `AMLODIPINE` also matches `AMLODIPINE (AS BESYLATE)`. This covers brand names that don't contain the ingredient string (e.g. 「脈優」), and ingredient search returns a notably larger result set than name search. The default stays on "name" so that combination products of common ingredients such as ACETAMINOPHEN don't dilute name results.
* 💡 **Autosuggest:** Suggestions appear after 2+ characters, split into "ingredient / name" sections, with the number of products per ingredient, and support arrow-key selection. The index is built once after data loads (currently about 3.7K distinct ingredients and 42K names; the scale changes with the weekly data update, and `data_version.json` holds the actual counts). Ingredient suggestions also appear under the "name" scope as a shortcut to switch scope; choosing one updates the scope button, so the result set is never changed silently.
* ⚡ **Ultra-light (zero dependencies):** No heavy modern framework (React/Vue); plain vanilla JS and native DOM operations. The rendering core is minimal, significantly lowering time to interactive (TTI).
* 📱 **Responsive card design:** Built mobile-first, turning sprawling package-insert data into structured "drug cards". Indications, ingredients and dosage are clear to read on a phone or a nursing-station desktop.
* 🔗 **Cross-dataset integration:** The UI automatically links data siloed across agencies — drug licenses, original package insert links (PDF) and NHI reimbursement rules — greatly reducing lookup effort for clinical pharmacists and physicians.

## Facts: Tech Stack and Modules

| Module | Implementation | Description |
| :--- | :--- | :--- |
| **Frontend** | HTML5, vanilla JavaScript, CSS3 | Event-driven; performs in-memory fuzzy search and DOM rendering over `drugs_data.json` cached locally / via CDN. |
| **Data extraction (ETL)** | Python 3.x (`build_data.py`) | Connects to TFDA open data APIs (licenses, package inserts, etc.), filters and merges fields, and normalizes structure. |
| **Automation (CI/CD)** | GitHub Actions | A cron job defined in YAML under `.github/workflows` periodically runs the ETL script and auto-commits changes to the repository. |
| **Hosting** | GitHub Pages | Serves the static files (CDN) with a highly available HTTPS endpoint. |

## Data Pipeline

Data updates follow this automated flow:
1. **Trigger:** GitHub Actions starts a runner on the configured cron schedule (e.g. monthly).
2. **Setup:** Installs the required Python modules from `requirements.txt`.
3. **Fetch:** `build_data.py` sends HTTP GET requests to the TFDA server and downloads the large raw JSON datasets.
4. **Cleanse:** Removes fields the frontend doesn't need to minimize size, and builds an integrated structure keyed on the license number.
5. **Build:** Writes the slimmed `drugs_data.json`, overwriting the old file.
6. **Deploy:** GitHub Actions commits and pushes the updated JSON to the main branch, triggering a GitHub Pages update.

## Local Development

To debug or develop locally:

### 1. Get the source

```bash
git clone https://github.com/liangRXdev/TFDA-drug-info-search.git
cd TFDA-drug-info-search
```

### 2. Data layer (Python)

A virtual environment is recommended to isolate dependencies:

```bash
# Create and activate a virtual environment (Windows)
python -m venv venv
venv\Scripts\activate

# Create and activate a virtual environment (macOS/Linux)
python3 -m venv venv
source venv/bin/activate

# Install dependencies
pip install -r requirements.txt

# Run the data update script to produce the latest drugs_data.json
python build_data.py
```

### 3. Frontend (UI)

Modern browsers restrict the local `file://` protocol (`fetch()` can't read local JSON), so serve it through a local server:

```bash
# Python's built-in HTTP server
python -m http.server 8000
```

Then open `http://localhost:8000` in a browser to preview the UI and test search.

## Pitfalls and Maintenance Notes

* **File size monitoring:** Monitor the **gzip-compressed transfer size**, not the raw file size on disk — GitHub Pages enables gzip by default, and the two differ by about 4.5×. As of 2026-07, the raw file is 37.7 MB and the actual transfer is **8.3 MB**. A 10 MB transfer size is the suggested alert line.

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
* **Data caching strategy (SWR):** `sw.js` uses stale-while-revalidate for `drugs_data.json` — the cached copy is returned first so the page is usable immediately, and a background conditional request with `If-None-Match` checks for a new version. Data updates weekly, so when unchanged the response is just a 304 (0 bytes), with no need to refetch 8.3 MB. **If you change this strategy, never fall back to network-first**: that would redownload the whole dataset every time the app opens. When a new version arrives, a green banner prompts the user to reload; it doesn't auto-reload, to avoid interrupting a search in progress.

  Note: on the **first** visit the service worker finishes registering only after the `drugs_data.json` request has been sent, so it can't intercept or cache that request. The SW takes over and writes the cache on the **2nd** visit, and the 304 steady state starts from the **3rd**. When testing caching, a single reload will make it look broken.
* **Service worker cache version:** After changing `index.html` or `app.js` it is **recommended** to bump `STATIC_CACHE` in `sw.js`, but for a counter-intuitive reason:

  | Situation | Without bump | With bump |
  | :--- | :--- | :--- |
  | Page seen by online users | ✅ new | ✅ new |
  | Page in the offline cache | ⚠️ see below | ✅ new |

  `index.html` and `app.js` are **network-first** (see the end of `sw.js`), so **online users always get the latest page regardless of the version number** — bumping isn't a precondition for new features to take effect. What it really does is refresh the **offline copy**.

  > **⚠️ This behavior changed on 2026-07-20 and has not been re-measured.** The earlier measured conclusion was: `cache.put` in the network-first branch was fire-and-forget (not protected by `waitUntil`) and was discarded when the SW event ended, so the offline copy was **not** updated; only a version bump triggering `addAll` in `install` refreshed it. That defect has been fixed (`cache.put` is now inside `event.waitUntil`), so in theory the offline copy should update during normal browsing, but **the new behavior in the "without bump" column has not been verified by measurement**, so the recommendation to bump stays for now.
  >
  > Also note: the `install` `addAll` precache list now includes `./app.js`. **When adding static files, always add them to that list too**, or the site will be missing files offline and stop working.
