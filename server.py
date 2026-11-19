"""
SD Operations Agent — backend
FastAPI server that (1) serves the UI, (2) proxies SAP reads/writes through sap_rfc.py,
(3) keeps the tool's own state (issues, approvals, tasks, audit, PO inbox) in SQLite,
(4) optionally answers copilot questions with an LLM.

Run:  pip install -r requirements.txt && uvicorn server:app --port 8766
Then set the UI to "Live SAP via RFC backend" (Data tab) with endpoint /api/sap.

Modes:
  SAP_MODE=rfc   -> real system through pyrfc (needs SAP_* env vars + NW RFC SDK)
  SAP_MODE=mock  -> the same embedded tables the browser uses (for integration tests)
"""
from __future__ import annotations
import json, os, sqlite3, time
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel

from sap_rfc import SapRfc, SapError, VIRTUAL_TABLES

HERE = Path(__file__).parent
DIST = HERE.parent / "dist" / "InfraBeat_SD_Operations_Agent.html"
DBFILE = HERE / "sd_agent.sqlite3"
SAP_MODE = os.getenv("SAP_MODE", "mock")

app = FastAPI(title="InfraBeat SD Operations Agent")
sap = SapRfc()

# ---------------------------------------------------------------- local DB (tool state + virtual tables)
def db() -> sqlite3.Connection:
    c = sqlite3.connect(DBFILE); c.row_factory = sqlite3.Row
    c.executescript("""
    CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
    CREATE TABLE IF NOT EXISTS audit (at REAL, who TEXT, what TEXT, ref TEXT);
    CREATE TABLE IF NOT EXISTS po_inbox (id TEXT PRIMARY KEY, payload TEXT, status TEXT);
    CREATE TABLE IF NOT EXISTS sap_log (at REAL, kind TEXT, name TEXT, params TEXT, result TEXT, ms INTEGER);
    """)
    return c

def virtual_read(table: str, where: dict) -> list[dict]:
    """Tables that live in this backend, not in SAP (PO inbox from the e-mail/DOX pipeline, e-invoice status, etc.)."""
    c = db()
    if table == "ZSD_PO_INBOX":
        rows = [json.loads(r["payload"]) | {"STATUS": r["status"]} for r in c.execute("SELECT * FROM po_inbox")]
    else:
        rows = json.loads((c.execute("SELECT v FROM kv WHERE k=?", (f"vt:{table}",)).fetchone() or {"v": "[]"})["v"])
    return [r for r in rows if all(r.get(k) == v for k, v in (where or {}).items())]

# ---------------------------------------------------------------- SAP proxy
class SapReq(BaseModel):
    op: str                  # 'read' | 'call'
    table: str | None = None
    where: dict[str, Any] | None = None
    opts: dict[str, Any] | None = None
    fm: str | None = None
    params: dict[str, Any] | None = None

@app.post("/api/sap")
def sap_proxy(req: SapReq, request: Request):
    t0 = time.time()
    try:
        if req.op == "read":
            if req.table in VIRTUAL_TABLES:
                rows = virtual_read(req.table, req.where or {})
            elif SAP_MODE == "mock":
                rows = mock_read(req.table, req.where or {})
            else:
                rows = sap.read(req.table, req.where, req.opts)
            _log("READ", req.table, req.where, len(rows), t0)
            return rows
        if req.op == "call":
            if req.fm == "ZSD_INBOX_UPDATE":
                c = db(); c.execute("UPDATE po_inbox SET status=? WHERE id=?", (req.params["STATUS"], req.params["ID"])); c.commit()
                res = {"RETURN": {"TYPE": "S", "MESSAGE": f"Inbox {req.params['ID']} set to {req.params['STATUS']}"}}
            elif SAP_MODE == "mock":
                res = mock_call(req.fm, req.params or {})
            else:
                res = sap.call(req.fm, req.params or {})
            _log("CALL", req.fm, req.params, res["RETURN"]["MESSAGE"], t0)
            return res
        raise HTTPException(400, "op must be read or call")
    except SapError as e:
        _log("CALL" if req.op == "call" else "READ", req.fm or req.table, req.params or req.where, f"ERROR {e}", t0)
        return JSONResponse({"RETURN": {"TYPE": "E", "MESSAGE": str(e)}}, status_code=422)

def _log(kind, name, params, result, t0):
    c = db(); c.execute("INSERT INTO sap_log VALUES (?,?,?,?,?,?)", (time.time(), kind, name, json.dumps(params)[:400], str(result)[:400], int((time.time() - t0) * 1000))); c.commit()

# ---------------------------------------------------------------- mock mode (reuses the tables embedded in the UI build)
_MOCK: dict | None = None
def _mock_tables() -> dict:
    """Pull SAP_TABLES out of the built HTML so backend tests use the same data as the browser."""
    global _MOCK
    if _MOCK is None:
        import re, subprocess
        html = DIST.read_text(encoding="utf-8")
        js = re.search(r"const SAP_TABLES = (\{.*?\n\});", html, re.S).group(1)
        _MOCK = json.loads(subprocess.check_output(["node", "-e", f"process.stdout.write(JSON.stringify({js}))"]))
    return _MOCK

def mock_read(table, where):
    return [r for r in _mock_tables().get(table, []) if all((r.get(k) in v) if isinstance(v, list) else r.get(k) == v for k, v in where.items())]

def mock_call(fm, params):
    return {"RETURN": {"TYPE": "S", "MESSAGE": f"[mock backend] {fm} accepted — no SAP connected"}}

# ---------------------------------------------------------------- copilot (optional LLM)
class Ask(BaseModel):
    question: str
    context: dict[str, Any]

@app.post("/api/answer")
def answer(a: Ask):
    """Grounded copilot. Set LLM_API_KEY / LLM_MODEL (OpenAI-compatible) to enable; otherwise the UI falls back to its rule-based answers."""
    key = os.getenv("LLM_API_KEY"); model = os.getenv("LLM_MODEL", "gpt-4o-mini"); base = os.getenv("LLM_BASE_URL", "https://api.openai.com/v1")
    if not key:
        raise HTTPException(501, "No LLM configured")
    import urllib.request
    system = ("You are the SD operations copilot for an SAP consulting team. Answer only from the JSON context "
              "(open issues and order narratives read from SAP). Be concise, name documents and amounts, and end with the next step. "
              "Never claim an action was executed; the tool executes actions only through approved workflows.")
    body = json.dumps({"model": model, "messages": [{"role": "system", "content": system}, {"role": "user", "content": f"Context:\n{json.dumps(a.context)[:60000]}\n\nQuestion: {a.question}"}], "temperature": 0.2}).encode()
    req = urllib.request.Request(f"{base}/chat/completions", data=body, headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        out = json.load(r)
    return {"answer": out["choices"][0]["message"]["content"]}

# ---------------------------------------------------------------- PO inbox intake (e-mail / DOX / portal)
class InboxPO(BaseModel):
    ID: str; KUNNR: str; VKORG: str; BSTNK: str; RECEIVED: str; SOURCE: str; REQ_DATE: str; CONFIDENCE: float; LINES: list[dict]

@app.post("/api/inbox")
def inbox_add(po: InboxPO):
    """Called by the extraction pipeline (SAP Document Information Extraction, an e-mail parser, or EDI ORDERS) for each incoming customer PO."""
    c = db(); c.execute("INSERT OR REPLACE INTO po_inbox VALUES (?,?,?)", (po.ID, po.model_dump_json(), "New")); c.commit()
    return {"ok": True}

# ---------------------------------------------------------------- UI
@app.get("/")
def ui():
    if not DIST.exists():
        raise HTTPException(404, "Build the UI first: python build.py")
    return FileResponse(DIST)

@app.get("/api/health")
def health():
    return {"mode": SAP_MODE, "pyrfc": sap._conn is not None, "dist": DIST.exists()}
