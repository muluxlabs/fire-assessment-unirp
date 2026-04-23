# FIRE Assessment + INDRIYA Smart Campus Audit — UniRP by Bloomfield Innovations

Two consulting-grade diagnostic tools for university digital transformation, both shipping as static HTML pages and a single Google Apps Script backend.

- **FIRE Assessment** (`index.html`) — Free Intense Research Evaluation. A 25-question, 5-pillar diagnostic scored out of 100 with an ROI calculator.
- **INDRIYA Smart Campus Audit** (`indriya.html`) — Institutional Digital Readiness & Intelligent Yield Assessment. A 6-dimension, evidence-led audit scored out of 120 with a client-generated PDF report that embeds the auditor's photo evidence.

Both tools post to the same Apps Script Web App (`apps-script/Code.gs`) which routes by `payload.type`.

---

## Files

| File | Purpose |
| --- | --- |
| `index.html` | FIRE Assessment single-page app. |
| `indriya.html` | INDRIYA Smart Campus Audit single-page app. |
| `assets/unirp-logo.png` | uniRP wordmark used in both headers. |
| `assets/bfi-mcg-lockup.jpg` | Bloomfield Innovations + Marwadi Chandarana Group lockup. |
| `apps-script/Code.gs` | Google Apps Script backend — three handlers, one Web App URL. |

---

## Data model

Every submission is a JSON POST to the same `/exec` URL. The `type` field is the router.

### `type: "FIRE"` → tab **`FIRE Responses`**

Sent by `index.html` on FIRE completion. Fields: `firstName`, `lastName`, `email`, `phone`, `role`, `department`, `institutionName`, `institutionType`, `studentCount`, `faculty`, `programs`, `city`, `currentERP`, `goals`, `fireIndex`, `category`, `totalRaw`, `pillarF/I/R/E/S`, plus every question as `<QID>_answer` / `<QID>_score`.

### `type: "INDRIYA_INTEREST"` → tab **`INDRIYA Leads`**

Sent by the INDRIYA teaser modal on the FIRE results page. Fields: `name`, `institution`, `email`, `phone`, `goals`.

### `type: "INDRIYA_AUDIT"` → tab **`INDRIYA Responses`** + **PDF in Drive**

Sent by `indriya.html` once at the end of the audit (either free or premium path). Fields:

- `context` — captured from Step 1 (institution, auditor name/email/phone/role, city, students, programs, audit focus). **Not re-asked for premium.**
- `ratings`, `remarks` — per-item score and auditor note
- `scores.byDim` — `{ I, E, A, D, R, S }` dimension scores (premium dims are `null` if the free path was chosen)
- `scores.total`, `scores.max` — totals out of 80 (free) or 120 (premium)
- `premium_requested` — `true` if the auditor chose the premium branch
- `pdf_base64`, `pdf_filename` — the full branded PDF report generated client-side with photo evidence embedded

The Apps Script decodes `pdf_base64`, finds or creates `DRIVE_FOLDER_ID/<Institution Name>/`, and saves the PDF as `INDRIYA_<institution>_<auditor>_<timestamp>.pdf`. The Drive file URL is written back to the sheet row.

---

## INDRIYA flow

1. **Step 1 · Context** — collects institution + auditor once. Stored in the record and reused on both paths.
2. **Dimensions 1–4 · Free tier** — Digital Infrastructure, Student Experience, Automation & RPA, Data Intelligence. Each item has: star rating, remarks, optional photo evidence with per-photo captions.
3. **Step 5 · Choose path** — no re-registration. The auditor picks either:
   - **Get my free report** — generates PDF for dimensions 1–4, `premium_requested: false`.
   - **Continue to premium assessment** — adds dimensions 5–6 (NAAC/NBA aligned), `premium_requested: true`.
4. **Dimensions 5–6 · Premium** (premium path only) — Innovation & Industry Connect, Sustainability & Future Readiness.
5. **Submission** — the client renders the full report into `#printArea`, then uses `html2pdf.js` to build a single PDF blob with all photos embedded, and POSTs it to the Apps Script. The same blob powers the "Download PDF" button on the results screen, guaranteeing the user receives exactly what the consulting team receives.

Leadership priority is decided by the `Premium Requested` column on the **INDRIYA Responses** tab.

---

## Apps Script deployment

1. Open the Google Sheet → `Extensions → Apps Script`.
2. Paste the contents of `apps-script/Code.gs`.
3. `Project Settings → Script properties`:
   - `SHEET_ID` — the Google Sheet ID (from the Sheet's URL).
   - `DRIVE_FOLDER_ID` — the parent Drive folder for audit PDFs.
   - `NOTIFY_EMAIL` — (optional) email to receive submission notifications.
4. `Deploy → Manage deployments → New version`.
   - **Execute as:** Me
   - **Who has access:** Anyone
5. The `/exec` URL is already hard-coded in both HTML files. If you create a brand-new deployment (not a new version of the existing one), update `GS_URL` in `index.html` and `indriya.html`.

The script auto-creates any missing sheets (`FIRE Responses`, `INDRIYA Leads`, `INDRIYA Responses`) with pre-formatted headers on first use.

---

## Local preview

Everything is static — no build step. Open `index.html` or `indriya.html` directly, or serve the repo with any static server (e.g. `python -m http.server`). The `html2pdf.js` and Chart.js CDNs are loaded over the network.

---

## License

Proprietary · © 2026 Bloomfield Innovations. All rights reserved.

Built by [Bloomfield Innovations](https://bloomfieldinnovations.in) · [UniRP](https://bloomfieldinnovations.in)
