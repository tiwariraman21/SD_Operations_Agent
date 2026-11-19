"""
SAP RFC adapter for the SD Operations Agent.

Same two operations the browser adapter (src/sap.js) uses:
    read(table, where, opts)  -> list[dict]      (RFC_READ_TABLE, or a Z-RFC for joins)
    call(fm, params)          -> dict             (any BAPI / FM, followed by BAPI_TRANSACTION_COMMIT)

Connection settings come from environment variables (same style as the PP tool):
    SAP_ASHOST, SAP_SYSNR, SAP_CLIENT, SAP_USER, SAP_PASSWD, SAP_LANG   (direct)
    or SAP_MSHOST, SAP_MSSERV, SAP_GROUP, SAP_SYSID                     (load-balanced)

Rules this adapter enforces:
  * SD documents are never written with direct table updates — only through the
    function modules listed in FM_WHITELIST. Anything else is refused.
  * Every write is followed by BAPI_TRANSACTION_COMMIT (WAIT='X') and the RETURN
    table is inspected; an E/A message raises SapError so the UI shows it.
  * RFC_READ_TABLE is limited to the tables in TABLE_WHITELIST and to the
    fields the UI needs (keeps the 512-byte row limit safe).
"""
from __future__ import annotations
import os
from typing import Any

try:
    from pyrfc import Connection  # type: ignore
except ImportError:  # allow the server to start without the SDK for mock runs
    Connection = None  # type: ignore


class SapError(Exception):
    pass


# Function modules the UI is allowed to call. Keys = names used by the UI.
# Value = real FM name (None = handled by a custom routine below).
FM_WHITELIST: dict[str, str | None] = {
    "BAPI_SALESORDER_CHANGE": "BAPI_SALESORDER_CHANGE",
    "BAPI_SALESORDER_CREATEFROMDAT2": "BAPI_SALESORDER_CREATEFROMDAT2",
    "SD_ORDER_CREDIT_RELEASE": "SD_ORDER_CREDIT_RELEASE",          # VKM1 release (or Z wrapper)
    "BAPI_OUTB_DELIVERY_CREATE_SLS": "BAPI_OUTB_DELIVERY_CREATE_SLS",
    "BAPI_OUTB_DELIVERY_CHANGE": "BAPI_OUTB_DELIVERY_CHANGE",
    "WS_DELIVERY_UPDATE": "BAPI_OUTB_DELIVERY_CONFIRM_DEC",         # PGI
    "BAPI_BILLINGDOC_CREATEMULTIPLE": "BAPI_BILLINGDOC_CREATEMULTIPLE",
    "RV_INVOICE_RELEASE_TO_ACCOUNTING": "ZSD_INVOICE_RELEASE",      # Z wrapper around VF02 release (RV_INVOICE_DOCUMENT_UPDATE)
    "RSNAST00": "ZSD_NAST_REPROCESS",                                # Z wrapper: SUBMIT RSNAST00 for one NAST key
    "BD87_REPROCESS": "ZSD_IDOC_REPROCESS",                          # Z wrapper: IDOC_INBOUND_PROCESS / RBDMANI2 logic
    "WE20_CREATE_PARTNER_PROFILE": None,                             # consultant task — not automated in production
    "EINV_RESUBMIT": "ZSD_EINV_RESUBMIT",                            # e-invoice (IRP) resubmission via the eDocument framework
    "BAPI_CUSTOMER_CHANGEFROMDATA": "BAPI_CUSTOMER_CHANGEFROMDATA1",
    "BAPI_PRICES_CONDITIONS": "BAPI_PRICES_CONDITIONS",
    "VKOA_MAINTAIN": None,                                           # customising — consultant task with transport, not automated
    "FTXP_MAINTAIN": None,                                           # customising — consultant task
    "KNMT_CREATE": "ZSD_KNMT_MAINTAIN",                              # Z wrapper (no released BAPI for KNMT)
    "ZSD_INBOX_UPDATE": None,                                        # local inbox table, handled by the server DB
}

# Tables the UI may read, with the field list returned (keeps RFC_READ_TABLE rows < 512 bytes).
TABLE_WHITELIST: dict[str, list[str]] = {
    "VBAK": ["VBELN", "AUART", "VKORG", "VTWEG", "SPART", "KUNNR", "BSTNK", "ERDAT", "VDATU", "NETWR", "WAERK", "LIFSK", "FAKSK", "CMGST", "GBSTK", "KNUMV"],
    "VBAP": ["VBELN", "POSNR", "MATNR", "ARKTX", "KWMENG", "NETPR", "NETWR", "WERKS", "LGORT", "PSTYV", "ABGRU"],
    "VBEP": ["VBELN", "POSNR", "ETENR", "EDATU", "WMENG", "BMENG"],
    "VBUV": ["VBELN", "POSNR", "TBNAM", "FDNAM"],
    "VBFA": ["VBELV", "POSNV", "VBELN", "POSNN", "VBTYP_N", "RFMNG"],
    "LIKP": ["VBELN", "LFART", "VSTEL", "KUNNR", "LFDAT", "WADAT", "WADAT_IST", "WBSTK", "KOSTK", "ERDAT"],
    "LIPS": ["VBELN", "POSNR", "VGBEL", "VGPOS", "MATNR", "LFIMG", "WERKS", "LGORT", "CHARG"],
    "VBRK": ["VBELN", "FKART", "FKDAT", "KUNRG", "VKORG", "NETWR", "MWSBK", "RFBSK", "FKSTO", "KNUMV"],
    "VBRP": ["VBELN", "POSNR", "VGBEL", "VGPOS", "AUBEL", "AUPOS", "MATNR", "FKIMG", "NETWR"],
    "BKPF": ["BUKRS", "BELNR", "GJAHR", "AWKEY", "BUDAT", "BLART"],
    "NAST": ["KAPPL", "OBJKY", "KSCHL", "NACHA", "VSTAT", "ERDAT", "LDEST"],
    "EDIDC": ["DOCNUM", "MESTYP", "IDOCTP", "DIRECT", "RCVPRN", "STATUS", "CREDAT"],
    "KNA1": ["KUNNR", "NAME1", "ORT01", "STCD3", "ADRNR"],
    "KNVV": ["KUNNR", "VKORG", "VTWEG", "SPART", "KDGRP", "ZTERM", "VSBED", "INCO1"],
    "KNMT": ["KUNNR", "VKORG", "VTWEG", "KDMAT", "MATNR"],
    "KNKK": ["KUNNR", "KKBER", "KLIMK", "SKFOR", "SSOBL"],       # ECC; for S/4 FSCM use UKMBP_CMS_SGM / UKM_ITEM
    "MARD": ["MATNR", "WERKS", "LGORT", "LABST", "INSME"],
    "MCHB": ["MATNR", "WERKS", "LGORT", "CHARG", "CLABS"],
    "MAKT": ["MATNR", "MAKTX"],
    "A305": ["KSCHL", "VKORG", "VTWEG", "KUNNR", "MATNR", "DATAB", "DATBI", "KNUMH"],
    "A304": ["KSCHL", "VKORG", "VTWEG", "MATNR", "DATAB", "DATBI", "KNUMH"],
    "KONP": ["KNUMH", "KSCHL", "KBETR", "KONWA", "KPEIN"],
    "PRCD_ELEMENTS": ["KNUMV", "KPOSN", "STUNR", "KSCHL", "KBETR", "KWERT", "KINAK", "KMPRS"],  # KONV on ECC
    "TVLST": ["LIFSP", "VTEXT"], "TVFST": ["FAKSP", "VTEXT"], "TVKO": ["VKORG", "VTEXT"],
}

# Things that are not tables in SAP but the UI reads as if they were — served by the backend.
VIRTUAL_TABLES = {"EINV", "ZSD_PO_INBOX", "WE20", "PRINTERS", "VKOA", "PRICE_HISTORY"}


class SapRfc:
    def __init__(self) -> None:
        self._conn = None

    # ------------------------------------------------------------ connection
    def conn(self):
        if self._conn is None:
            if Connection is None:
                raise SapError("pyrfc is not installed — install the SAP NW RFC SDK and `pip install pyrfc`")
            params = {k[4:].lower(): v for k, v in os.environ.items() if k.startswith("SAP_")}
            self._conn = Connection(**params)
        return self._conn

    # ------------------------------------------------------------ reads
    def read(self, table: str, where: dict[str, Any] | None = None, opts: dict | None = None) -> list[dict]:
        if table in VIRTUAL_TABLES:
            raise SapError(f"{table} is served by the local database, not SAP")
        if table not in TABLE_WHITELIST:
            raise SapError(f"Table {table} is not in the read whitelist")
        fields = TABLE_WHITELIST[table]
        options = []
        for k, v in (where or {}).items():
            if isinstance(v, list):
                options.append({"TEXT": f"{k} IN ({', '.join(repr(str(x)) for x in v)})"})
            else:
                options.append({"TEXT": f"{k} = '{v}'"})
        # RFC_READ_TABLE needs AND between options
        for i in range(1, len(options)):
            options[i]["TEXT"] = "AND " + options[i]["TEXT"]
        res = self.conn().call(
            "RFC_READ_TABLE", QUERY_TABLE=table, DELIMITER="|",
            FIELDS=[{"FIELDNAME": f} for f in fields], OPTIONS=options,
            ROWCOUNT=(opts or {}).get("rowcount", 5000),
        )
        rows = []
        for r in res["DATA"]:
            vals = r["WA"].split("|")
            rows.append({f: _coerce(f, v.strip()) for f, v in zip(fields, vals)})
        return rows

    # ------------------------------------------------------------ writes
    def call(self, fm: str, params: dict[str, Any]) -> dict:
        if fm not in FM_WHITELIST:
            raise SapError(f"Function module {fm} is not allowed")
        real = FM_WHITELIST[fm]
        if real is None:
            raise SapError(f"{fm} is a consultant/customising task and is not executed automatically in production")
        c = self.conn()
        mapped = _map_params(fm, params)
        res = c.call(real, **mapped)
        ret = res.get("RETURN")
        msgs = ret if isinstance(ret, list) else ([ret] if ret else [])
        bad = [m for m in msgs if m.get("TYPE") in ("E", "A")]
        if bad:
            c.call("BAPI_TRANSACTION_ROLLBACK")
            raise SapError("; ".join(m.get("MESSAGE", "") for m in bad))
        c.call("BAPI_TRANSACTION_COMMIT", WAIT="X")
        out = {"RETURN": {"TYPE": "S", "MESSAGE": "; ".join(m.get("MESSAGE", "") for m in msgs) or "OK"}}
        # surface the document numbers the UI expects
        for k in ("SALESDOCUMENT", "DELIVERY", "SUCCESS"):
            if k in res:
                out[k] = res[k]
        return out


def _coerce(field: str, v: str):
    if field in ("NETWR", "NETPR", "KWMENG", "WMENG", "BMENG", "LFIMG", "FKIMG", "LABST", "CLABS", "KLIMK", "SKFOR", "SSOBL", "MWSBK", "KBETR", "KWERT", "INSME", "RFMNG"):
        try:
            return float(v.replace(",", "")) if v else 0.0
        except ValueError:
            return v
    if field in ("ERDAT", "VDATU", "EDATU", "LFDAT", "WADAT", "WADAT_IST", "FKDAT", "DATAB", "DATBI", "BUDAT", "CREDAT") and len(v) == 8:
        return f"{v[:4]}-{v[4:6]}-{v[6:]}"
    return v


def _map_params(fm: str, p: dict) -> dict:
    """Translate the UI's compact parameter shapes into the real BAPI structures."""
    if fm == "BAPI_SALESORDER_CHANGE":
        hin = dict(p.get("ORDER_HEADER_IN", {})); hinx = dict(p.get("ORDER_HEADER_INX", {}), UPDATEFLAG="U")
        out = {"SALESDOCUMENT": p["SALESDOCUMENT"], "ORDER_HEADER_IN": hin, "ORDER_HEADER_INX": hinx}
        if p.get("LOGIC_SWITCH"):
            out["LOGIC_SWITCH"] = p["LOGIC_SWITCH"]
        return out
    if fm == "BAPI_SALESORDER_CREATEFROMDAT2":
        h = p["ORDER_HEADER_IN"]
        items = [{"ITM_NUMBER": f"{(i + 1) * 10:06d}", "MATERIAL": it["MATERIAL"], "TARGET_QTY": it["TARGET_QTY"], "PLANT": it["PLANT"]} for i, it in enumerate(p["ORDER_ITEMS_IN"])]
        itemsx = [{"ITM_NUMBER": it["ITM_NUMBER"], "UPDATEFLAG": "I", "MATERIAL": "X", "TARGET_QTY": "X", "PLANT": "X"} for it in items]
        return {
            "ORDER_HEADER_IN": {"DOC_TYPE": h.get("DOC_TYPE", "OR"), "SALES_ORG": h["SALES_ORG"], "DISTR_CHAN": h.get("DISTR_CHAN", "10"), "DIVISION": h.get("DIVISION", "00"), "PURCH_NO_C": h["PURCH_NO_C"], "REQ_DATE_H": h["REQ_DATE_H"].replace("-", "")},
            "ORDER_HEADER_INX": {"DOC_TYPE": "X", "SALES_ORG": "X", "DISTR_CHAN": "X", "DIVISION": "X", "PURCH_NO_C": "X", "REQ_DATE_H": "X"},
            "ORDER_ITEMS_IN": items, "ORDER_ITEMS_INX": itemsx,
            "ORDER_PARTNERS": [{"PARTN_ROLE": "AG", "PARTN_NUMB": h["KUNNR"]}, {"PARTN_ROLE": "WE", "PARTN_NUMB": h["KUNNR"]}],
            "ORDER_SCHEDULES_IN": [{"ITM_NUMBER": it["ITM_NUMBER"], "REQ_QTY": it["TARGET_QTY"]} for it in items],
        }
    if fm == "BAPI_OUTB_DELIVERY_CREATE_SLS":
        return {"SHIP_POINT": p["SHIP_POINT"], "DUE_DATE": p["DUE_DATE"].replace("-", ""),
                "SALES_ORDER_ITEMS": [{"REF_DOC": s["REF_DOC"], "REF_ITEM": s["REF_ITEM"], "DLV_QTY": s.get("DLV_QTY")} for s in p["SALES_ORDER_ITEMS"]]}
    if fm == "WS_DELIVERY_UPDATE":  # → BAPI_OUTB_DELIVERY_CONFIRM_DEC
        return {"HEADER_DATA": {"DELIV_NUMB": p["VBELN"]}, "HEADER_CONTROL": {"DELIV_NUMB": p["VBELN"], "POST_GI_FLG": "X"}, "DELIVERY": p["VBELN"]}
    if fm == "BAPI_BILLINGDOC_CREATEMULTIPLE":
        return {"BILLINGDATAIN": [{"REF_DOC": b["REF_DOC"], "REF_DOC_CA": b.get("REF_DOC_CA", "J")} for b in p["BILLINGDATAIN"]]}
    if fm == "BAPI_PRICES_CONDITIONS":
        return {"PI_INITIALMODE": "X", "TI_BAPICONDCT": [{"TABLE_NO": "305", "APPLICATIO": "V", "COND_TYPE": p["KSCHL"], "VARKEY": f"{p['VKORG']}{p['VTWEG']}{p['KUNNR']:>10}{p['MATNR']:<18}", "VALID_FROM": p["DATAB"].replace("-", ""), "VALID_TO": p["DATBI"].replace("-", "")}],
                "TI_BAPICONDHD": [{"COND_USAGE": "A", "TABLE_NO": "305", "APPLICATIO": "V", "COND_TYPE": p["KSCHL"]}],
                "TI_BAPICONDIT": [{"COND_TYPE": p["KSCHL"], "COND_VALUE": p["KBETR"], "CONDCURR": "INR", "COND_P_UNT": 1, "COND_UNIT": "EA"}]}
    if fm == "BAPI_CUSTOMER_CHANGEFROMDATA":  # → BAPI_CUSTOMER_CHANGEFROMDATA1
        d = {}; dx = {}
        if "SMTP_ADDR" in p: d["E_MAIL"] = p["SMTP_ADDR"]; dx["E_MAIL"] = "X"
        if "STCD3" in p: d["TAX_NO_3"] = p["STCD3"]; dx["TAX_NO_3"] = "X"
        return {"CUSTOMERNO": p["KUNNR"], "PI_PERSONALDATA": d, "PI_PERSONALDATAX": dx}
    return params  # Z wrappers take the UI parameters as-is
