# InfraBeat SD Operations Agent

Finds, explains and fixes recurring SAP SD problems — the SD counterpart of the PP tool.
Theme and layout follow the InfraBeat Procurement dashboard.

## What it does (first release — 8 modules)

| # | Module | Finds | Fixes through |
|---|--------|-------|---------------|
| 1 | Order tracker | blocked orders (LIFSK), incomplete orders (VBUV), unconfirmed quantities (VBEP); "where is my order" with full document flow | `BAPI_SALESORDER_CHANGE` |
| 2 | Billing | delivered but not billed (LIKP WBSTK=C with no VBRP), billing-blocked orders | `BAPI_BILLINGDOC_CREATEMULTIPLE`, block removal |
| 3 | Deliveries | due list not processed, PGI pending / failed (batch determination) | `BAPI_OUTB_DELIVERY_CREATE_SLS`, `BAPI_OUTB_DELIVERY_CHANGE`, PGI |
| 4 | Outputs & IDocs | NAST errors, IDocs in status 29/51, e-invoice IRN rejections | RSNAST00 / BD87 wrappers, customer master, IRP resubmit |
| 5 | PO inbox | customer POs from e-mail/portal: KNMT mapping, case→EA conversion, duplicate PO, price variance | `BAPI_SALESORDER_CREATEFROMDAT2` |
| 6 | Credit blocks | orders with CMGST=B plus limit / exposure / overdue / payment history and a recommendation | VKM1 release after Finance approval |
| 7 | Accounting | invoices with RFBSK=E (VKOA gap, tax code), SD–FI amount mismatches | consultant config task + release to accounting |
| 8 | Pricing | missing/expired condition records, manual discounts outside the customer's range | `BAPI_PRICES_CONDITIONS` + re-pricing |

Cross-cutting: maker–checker approvals (proposer cannot approve, reason mandatory), consultant assignment by skill + load,
task tracking, audit log, grounded copilot ("Ask"), light/dark theme, sales-org scoping.

## Files

```
dist/InfraBeat_SD_Operations_Agent.html   single-file app — open in Chrome/Edge, no install
src/                                      source (style.css, util.js, data.js, sap.js, catalog.js, app.js, index.html)
build.py                                  inlines src/ into dist/
backend/server.py                         FastAPI: serves UI, proxies SAP via RFC, local state, copilot LLM hook, PO intake
backend/sap_rfc.py                        pyrfc adapter — table/FM whitelists and parameter mapping to real BAPIs
test/shots.js                             Playwright smoke test (all tabs + fix/approve/execute flows)
```

## Where to plug things in

* **Issue catalog** — `src/catalog.js`. One entry per SD problem: `detect()` reads SAP tables through `SAP.read`,
  returns evidence + the exact FM steps. Add a new SD issue = add one entry; the engine does approvals, assignment, execution, verification.
* **SAP connection** — `src/sap.js` is the browser adapter (`SAP.mode = 'mock' | 'rfc'`). In `rfc` mode every read/call is POSTed
  to `backend/server.py`, which calls `sap_rfc.py`. Reuse the PP tool's connection block there (env `SAP_ASHOST`, `SAP_SYSNR`, `SAP_CLIENT`, `SAP_USER`, `SAP_PASSWD`).
* **Z-RFCs to create in SAP** (listed in `FM_WHITELIST`): `ZSD_INVOICE_RELEASE`, `ZSD_NAST_REPROCESS`, `ZSD_IDOC_REPROCESS`,
  `ZSD_EINV_RESUBMIT`, `ZSD_KNMT_MAINTAIN`. Everything else uses standard BAPIs. **No direct table writes** — SD documents stay consistent only through FMs.
* **Roles / approvals** — `USERS`, `ROLES`, `CONSULTANTS` in `src/data.js`. Map to the real team; in production replace with SSO claims.
* **Copilot LLM** — set `LLM_API_KEY` (+ `LLM_MODEL`, `LLM_BASE_URL`) on the backend and point the UI (Data tab) at `/api/answer`.
* **PO intake** — POST extracted POs to `/api/inbox` from the e-mail parser / SAP Document Information Extraction / EDI ORDERS.

## Run

Offline demo: open `dist/InfraBeat_SD_Operations_Agent.html`. Users: Priya (SD Lead), Rohan (Customer Service), Meera (Finance), Sameer (Consultant).

With backend:
```
cd backend && pip install -r requirements.txt
SAP_MODE=mock uvicorn server:app --port 8766        # or SAP_MODE=rfc with SAP_* env vars and pyrfc installed
```
Open http://127.0.0.1:8766 → Data tab → "Live SAP via RFC backend".

Demo flows to rehearse: bill delivery 80001290 in one click; credit release 50001286 (propose as Priya → approve as Meera → execute);
PO-IN-0071 → new sales order; PGI 80001297 with batch assignment; e-mail output 90001292; IDoc 481223 → assign to Kiran.
