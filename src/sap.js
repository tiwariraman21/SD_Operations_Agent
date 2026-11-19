/* =====================================================================
   SAP ADAPTER
   - mode 'mock' : works on the embedded tables (this file) — demo / offline
   - mode 'rfc'  : POSTs to the Python backend (backend/server.py) which
                   calls RFC_READ_TABLE / BAPIs through pyrfc, exactly like
                   the PP tool. The UI code never knows the difference.
   Every write goes through a named function module; nothing writes to a
   table directly (SD documents must be changed through BAPIs/FMs).
   ===================================================================== */
const SAP = {
  mode: 'mock',                 // 'mock' | 'rfc'
  endpoint: '/api/sap',         // backend route in rfc mode
  log: [],                      // call log shown in Data & connections

  /* ---- reads ---- */
  async read(table, where = {}, opts = {}) {
    const t0 = performance.now();
    let rows;
    if (this.mode === 'rfc') {
      rows = await this._post({ op: 'read', table, where, opts });
    } else {
      rows = (DB[table] || []).filter(r => Object.entries(where).every(([k, v]) => Array.isArray(v) ? v.includes(r[k]) : r[k] === v));
      rows = rows.map(r => ({ ...r }));
    }
    this._log('READ', table, where, rows.length, performance.now() - t0);
    return rows;
  },
  async one(table, where) { return (await this.read(table, where))[0] || null; },

  /* ---- writes: function module calls ---- */
  async call(fm, params = {}) {
    const t0 = performance.now();
    let res;
    if (this.mode === 'rfc') {
      res = await this._post({ op: 'call', fm, params });
    } else {
      const impl = MOCK_FM[fm];
      if (!impl) throw new Error(`Function module ${fm} is not implemented in mock mode`);
      res = impl(params);
      if (res.RETURN && res.RETURN.TYPE === 'E') { this._log('CALL', fm, params, 'ERROR: ' + res.RETURN.MESSAGE, performance.now() - t0); throw new Error(res.RETURN.MESSAGE); }
      MOCK_FM.BAPI_TRANSACTION_COMMIT();
    }
    this._log('CALL', fm, params, res.RETURN ? res.RETURN.MESSAGE : 'OK', performance.now() - t0);
    return res;
  },

  async _post(body) {
    const r = await fetch(this.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`SAP backend ${r.status}: ${await r.text()}`);
    return r.json();
  },
  _log(kind, name, params, result, ms) {
    this.log.unshift({ at: new Date().toISOString(), kind, name, params: JSON.stringify(params).slice(0, 160), result: String(result).slice(0, 160), ms: Math.round(ms) });
    if (this.log.length > 300) this.log.length = 300;
  },
};

/* ---------------------------------------------------------------------
   MOCK FUNCTION MODULES — same names and parameter shapes the backend
   will use with pyrfc, so swapping to RFC changes no UI code.
   --------------------------------------------------------------------- */
const ok = (msg) => ({ RETURN: { TYPE: 'S', MESSAGE: msg } });
const err = (msg) => ({ RETURN: { TYPE: 'E', MESSAGE: msg } });
const nextNo = (table, field, start) => { const max = DB[table].reduce((m, r) => Math.max(m, parseInt(r[field], 10) || 0), start); return String(max + 1); };

const MOCK_FM = {
  BAPI_TRANSACTION_COMMIT() { persistDB(); return ok('Committed'); },

  /* ---- sales order ---- */
  BAPI_SALESORDER_CHANGE({ SALESDOCUMENT, ORDER_HEADER_IN = {}, ORDER_HEADER_INX = {}, LOGIC_SWITCH = {}, INCOMPLETE_FIELDS = [] }) {
    const o = DB.VBAK.find(r => r.VBELN === SALESDOCUMENT);
    if (!o) return err(`Sales document ${SALESDOCUMENT} does not exist`);
    if (ORDER_HEADER_INX.DLV_BLOCK) o.LIFSK = ORDER_HEADER_IN.DLV_BLOCK || '';
    if (ORDER_HEADER_INX.BILL_BLOCK) o.FAKSK = ORDER_HEADER_IN.BILL_BLOCK || '';
    if (ORDER_HEADER_INX.INCOTERMS1) { const kv = DB.KNVV.find(r => r.KUNNR === o.KUNNR); if (kv) kv.INCO1 = ORDER_HEADER_IN.INCOTERMS1; }
    INCOMPLETE_FIELDS.forEach(f => { DB.VBUV = DB.VBUV.filter(r => !(r.VBELN === SALESDOCUMENT && r.FDNAM === f)); });
    if (LOGIC_SWITCH.PRICING === 'B') { // carry out new pricing
      DB.VBAP.filter(i => i.VBELN === SALESDOCUMENT).forEach(i => {
        const rec = DB.A305.find(a => a.KUNNR === o.KUNNR && a.MATNR === i.MATNR && a.VKORG === o.VKORG && a.DATAB <= TODAY && a.DATBI >= TODAY) || DB.A304.find(a => a.MATNR === i.MATNR && a.VKORG === o.VKORG);
        if (rec) { i.NETPR = rec.KBETR; i.NETWR = rec.KBETR * i.KWMENG; }
        const pe = DB.PRCD_ELEMENTS.find(p => p.KNUMV === o.KNUMV && p.KPOSN === i.POSNR && p.KSCHL === 'PR00'); if (pe && rec) { pe.KBETR = rec.KBETR; pe.KWERT = i.NETWR; pe.STATUS = 'OK'; }
      });
      o.NETWR = DB.VBAP.filter(i => i.VBELN === SALESDOCUMENT).reduce((s, i) => s + i.NETWR, 0);
    }
    return ok(`Sales document ${SALESDOCUMENT} has been saved`);
  },
  BAPI_SALESORDER_CREATEFROMDAT2({ ORDER_HEADER_IN, ORDER_ITEMS_IN = [], ORDER_PARTNERS = [] }) {
    const dup = DB.VBAK.find(r => r.KUNNR === ORDER_HEADER_IN.KUNNR && r.BSTNK === ORDER_HEADER_IN.PURCH_NO_C);
    if (dup) return err(`V1 190: Purchase order ${ORDER_HEADER_IN.PURCH_NO_C} already exists in sales document ${dup.VBELN}`);
    const vbeln = nextNo('VBAK', 'VBELN', 50001303);
    const knumv = 'K' + vbeln.slice(-4);
    let netwr = 0;
    ORDER_ITEMS_IN.forEach((it, idx) => {
      const posnr = String((idx + 1) * 10).padStart(6, '0');
      const rec = DB.A305.find(a => a.KUNNR === ORDER_HEADER_IN.KUNNR && a.MATNR === it.MATERIAL && a.DATAB <= TODAY && a.DATBI >= TODAY) || DB.A304.find(a => a.MATNR === it.MATERIAL && a.VKORG === ORDER_HEADER_IN.SALES_ORG);
      const price = rec ? rec.KBETR : 0; const val = price * it.TARGET_QTY; netwr += val;
      DB.VBAP.push({ VBELN: vbeln, POSNR: posnr, MATNR: it.MATERIAL, KWMENG: it.TARGET_QTY, NETPR: price, NETWR: val, WERKS: it.PLANT, LGORT: '0001', ABGRU: '' });
      const st = DB.MARD.find(m => m.MATNR === it.MATERIAL && m.WERKS === it.PLANT); const conf = Math.min(it.TARGET_QTY, st ? st.LABST : 0);
      DB.VBEP.push({ VBELN: vbeln, POSNR: posnr, ETENR: '0001', EDATU: ORDER_HEADER_IN.REQ_DATE_H, WMENG: it.TARGET_QTY, BMENG: conf });
      DB.PRCD_ELEMENTS.push({ KNUMV: knumv, KPOSN: posnr, STUNR: '010', KSCHL: 'PR00', KBETR: price, KWERT: val, KINAK: '', KMPRS: '', STATUS: rec ? 'OK' : 'No condition record found' });
    });
    DB.VBAK.push({ VBELN: vbeln, AUART: ORDER_HEADER_IN.DOC_TYPE || 'OR', VKORG: ORDER_HEADER_IN.SALES_ORG, KUNNR: ORDER_HEADER_IN.KUNNR, BSTNK: ORDER_HEADER_IN.PURCH_NO_C, ERDAT: TODAY, VDATU: ORDER_HEADER_IN.REQ_DATE_H, NETWR: netwr, LIFSK: '', FAKSK: '', CMGST: '', GBSTK: 'A', KNUMV: knumv });
    return { ...ok(`Standard Order ${vbeln} has been saved`), SALESDOCUMENT: vbeln };
  },
  SD_ORDER_CREDIT_RELEASE({ VBELN }) { // VKM1 release
    const o = DB.VBAK.find(r => r.VBELN === VBELN); if (!o) return err('Document not found');
    o.CMGST = 'D'; return ok(`Credit release for ${VBELN} carried out (status D)`);
  },

  /* ---- delivery ---- */
  BAPI_OUTB_DELIVERY_CREATE_SLS({ SALES_ORDER_ITEMS = [], SHIP_POINT, DUE_DATE }) {
    const vbeln = nextNo('LIKP', 'VBELN', 80001303);
    const first = DB.VBAK.find(r => r.VBELN === SALES_ORDER_ITEMS[0].REF_DOC);
    const lines = []; let posnr = 10;
    for (const it of SALES_ORDER_ITEMS) {
      const ep = DB.VBEP.find(e => e.VBELN === it.REF_DOC && e.POSNR === it.REF_ITEM); const ap = DB.VBAP.find(a => a.VBELN === it.REF_DOC && a.POSNR === it.REF_ITEM);
      const qty = Math.min(it.DLV_QTY || ep.BMENG, ep.BMENG);
      if (qty <= 0) return err(`VL 150: No confirmed quantity for item ${it.REF_ITEM} of ${it.REF_DOC}`);
      lines.push({ VBELN: vbeln, POSNR: String(posnr).padStart(6, '0'), VGBEL: it.REF_DOC, VGPOS: it.REF_ITEM, MATNR: ap.MATNR, LFIMG: qty, WERKS: ap.WERKS, LGORT: ap.LGORT, CHARG: (DB.MCHB.find(b => b.MATNR === ap.MATNR && b.WERKS === ap.WERKS && b.CLABS >= qty) || {}).CHARG || 'B2611-09' });
      posnr += 10;
    }
    DB.LIKP.push({ VBELN: vbeln, LFART: 'LF', VSTEL: SHIP_POINT, KUNNR: first.KUNNR, LFDAT: DUE_DATE || TODAY, WADAT_IST: '', WBSTK: 'A', KOSTK: 'C', ERDAT: TODAY, PGI_ERR: '' });
    DB.LIPS.push(...lines); first.GBSTK = 'B';
    return { ...ok(`Delivery ${vbeln} created`), DELIVERY: vbeln };
  },
  BAPI_OUTB_DELIVERY_CHANGE({ DELIVERY, ITEM_DATA = [] }) { // used to assign batch
    ITEM_DATA.forEach(d => { const l = DB.LIPS.find(r => r.VBELN === DELIVERY && r.POSNR === d.DELIV_ITEM); if (l) l.CHARG = d.BATCH; });
    const h = DB.LIKP.find(r => r.VBELN === DELIVERY); if (h) h.PGI_ERR = '';
    return ok(`Delivery ${DELIVERY} changed`);
  },
  WS_DELIVERY_UPDATE({ VBELN }) { // post goods issue (BAPI_OUTB_DELIVERY_CONFIRM_DEC in production)
    const h = DB.LIKP.find(r => r.VBELN === VBELN); if (!h) return err('Delivery not found');
    const items = DB.LIPS.filter(r => r.VBELN === VBELN);
    for (const it of items) {
      if (!it.CHARG) { h.PGI_ERR = `VL 609: Batch determination failed — no batch assigned to item ${it.POSNR}`; return err(h.PGI_ERR); }
      const st = DB.MARD.find(m => m.MATNR === it.MATNR && m.WERKS === it.WERKS && m.LGORT === it.LGORT);
      if (!st || st.LABST < it.LFIMG) { h.PGI_ERR = `M7 021: Deficit of SL Unrestricted-use ${it.LFIMG} EA : ${it.MATNR} ${it.WERKS} ${it.LGORT}`; return err(h.PGI_ERR); }
    }
    items.forEach(it => { const st = DB.MARD.find(m => m.MATNR === it.MATNR && m.WERKS === it.WERKS && m.LGORT === it.LGORT); st.LABST -= it.LFIMG; });
    h.WBSTK = 'C'; h.WADAT_IST = TODAY; h.PGI_ERR = '';
    return ok(`Goods issue posted for delivery ${VBELN}`);
  },

  /* ---- billing ---- */
  BAPI_BILLINGDOC_CREATEMULTIPLE({ BILLINGDATAIN = [] }) {
    const created = [];
    for (const b of BILLINGDATAIN) {
      const dlv = DB.LIKP.find(r => r.VBELN === b.REF_DOC); if (!dlv) return err(`Delivery ${b.REF_DOC} not found`);
      if (dlv.WBSTK !== 'C') return err(`VF 044: Delivery ${b.REF_DOC} — goods issue not yet posted`);
      const lines = DB.LIPS.filter(r => r.VBELN === b.REF_DOC);
      const ord = DB.VBAK.find(r => r.VBELN === lines[0].VGBEL);
      if (ord.FAKSK) return err(`VF 042: Sales document ${ord.VBELN} is blocked for billing (${ord.FAKSK})`);
      const vbeln = nextNo('VBRK', 'VBELN', 90001303);
      let netwr = 0; const items = [];
      lines.forEach(l => { const ap = DB.VBAP.find(a => a.VBELN === l.VGBEL && a.POSNR === l.VGPOS); const val = ap.NETPR * l.LFIMG; netwr += val;
        items.push({ VBELN: vbeln, POSNR: l.POSNR, VGBEL: l.VBELN, VGPOS: l.POSNR, AUBEL: l.VGBEL, AUPOS: l.VGPOS, MATNR: l.MATNR, FKIMG: l.LFIMG, NETWR: val }); });
      // account determination check (VKOA) decides whether FI posting succeeds
      const gap = items.find(i => { const m = DB.MAKT.find(x => x.MATNR === i.MATNR); return !DB.VKOA.find(v => v.KTGRM === m.KTGRM && v.KVSL1 === 'ERL'); });
      const posted = !gap;
      DB.VBRK.push({ VBELN: vbeln, FKART: 'F2', FKDAT: TODAY, KUNRG: ord.KUNNR, VKORG: ord.VKORG, NETWR: netwr, MWSBK: Math.round(netwr * 0.18), RFBSK: posted ? 'C' : 'E', FKSTO: '', BELNR: posted ? nextNo('BKPF', 'BELNR', 1400022900) : '', ACC_ERR: posted ? '' : `KI 235: account determination (VKOA) for account key ERL / material account assignment group ${DB.MAKT.find(x => x.MATNR === gap.MATNR).KTGRM} returned no G/L account` });
      if (posted) DB.BKPF.push({ BELNR: DB.VBRK[DB.VBRK.length - 1].BELNR, AWKEY: vbeln, WRBTR: Math.round(netwr * 1.18), BUDAT: TODAY });
      DB.VBRP.push(...items); ord.GBSTK = 'C';
      DB.NAST.push({ KAPPL: 'V3', OBJKY: vbeln, KSCHL: 'RD00', NACHA: '5', VSTAT: '1', ERDAT: TODAY, PDEST: '', ERRTXT: '' });
      DB.EINV.push({ VBELN: vbeln, IRN_STATUS: 'GENERATED', ERRCODE: '', ERRTXT: '', SUBMITTED: TODAY });
      created.push(vbeln);
    }
    return { ...ok(`Billing document(s) ${created.join(', ')} saved`), SUCCESS: created };
  },
  RV_INVOICE_RELEASE_TO_ACCOUNTING({ VBELN }) { // VF02 → Release to accounting
    const inv = DB.VBRK.find(r => r.VBELN === VBELN); if (!inv) return err('Billing document not found');
    const items = DB.VBRP.filter(r => r.VBELN === VBELN);
    const gap = items.find(i => { const m = DB.MAKT.find(x => x.MATNR === i.MATNR); return !DB.VKOA.find(v => v.KTGRM === m.KTGRM && v.KVSL1 === 'ERL'); });
    if (inv.ACC_ERR.startsWith('FF 753') && !DB.TAXCODES_FIXED) return err(inv.ACC_ERR);
    if (gap) return err(inv.ACC_ERR || 'Account determination error');
    inv.RFBSK = 'C'; inv.ACC_ERR = ''; inv.BELNR = nextNo('BKPF', 'BELNR', 1400022900);
    DB.BKPF.push({ BELNR: inv.BELNR, AWKEY: VBELN, WRBTR: inv.NETWR + inv.MWSBK, BUDAT: TODAY });
    return ok(`Document ${VBELN} released to accounting — FI document ${inv.BELNR}`);
  },

  /* ---- output / EDI / e-invoice ---- */
  RSNAST00({ OBJKY, KSCHL, PDEST }) { // reprocess output
    const n = DB.NAST.find(r => r.OBJKY === OBJKY && r.KSCHL === KSCHL); if (!n) return err('Output record not found');
    if (n.NACHA === '5') { const inv = DB.VBRK.find(r => r.VBELN === OBJKY); const k = DB.KNA1.find(r => r.KUNNR === inv.KUNRG); if (!k.SMTP_ADDR) return err(n.ERRTXT); }
    if (n.NACHA === '1') { const dest = PDEST || n.PDEST; const p = DB.PRINTERS.find(r => r.PDEST === dest); if (!p || p.STATUS !== 'READY') return err(`Output device ${dest} not available`); n.PDEST = dest; }
    n.VSTAT = '1'; n.ERRTXT = ''; return ok(`Output ${KSCHL} for ${OBJKY} processed successfully`);
  },
  BAPI_CUSTOMER_CHANGEFROMDATA({ KUNNR, SMTP_ADDR, STCD3 }) {
    const k = DB.KNA1.find(r => r.KUNNR === KUNNR); if (!k) return err('Customer not found');
    if (SMTP_ADDR !== undefined) k.SMTP_ADDR = SMTP_ADDR; if (STCD3 !== undefined) { k.STCD3 = STCD3; k.GSTIN_OK = true; }
    return ok(`Customer ${KUNNR} changed`);
  },
  BD87_REPROCESS({ DOCNUM }) { // reprocess IDoc
    const d = DB.EDIDC.find(r => r.DOCNUM === DOCNUM); if (!d) return err('IDoc not found');
    if (!DB.WE20.find(w => w.PARNUM === d.RCVPRN && w.MESTYP === d.MESTYP)) return err(d.STATXT);
    d.STATUS = '03'; d.STATXT = ''; return ok(`IDoc ${DOCNUM} passed to port (status 03)`);
  },
  WE20_CREATE_PARTNER_PROFILE({ PARNUM, PARTYP, MESTYP }) { DB.WE20.push({ PARNUM, PARTYP, MESTYP }); return ok(`Partner profile ${PARNUM}/${MESTYP} created`); },
  EINV_RESUBMIT({ VBELN }) {
    const e = DB.EINV.find(r => r.VBELN === VBELN); const inv = DB.VBRK.find(r => r.VBELN === VBELN); const k = DB.KNA1.find(r => r.KUNNR === inv.KUNRG);
    if (!k.GSTIN_OK) return err(`IRP ${e.ERRCODE}: ${e.ERRTXT}`);
    e.IRN_STATUS = 'GENERATED'; e.ERRCODE = ''; e.ERRTXT = ''; e.SUBMITTED = TODAY; return ok(`IRN generated for ${VBELN}`);
  },

  /* ---- pricing & customising ---- */
  BAPI_PRICES_CONDITIONS({ KSCHL, VKORG, VTWEG, KUNNR, MATNR, DATAB, DATBI, KBETR }) {
    DB.A305.push({ KSCHL, VKORG, VTWEG, KUNNR, MATNR, DATAB, DATBI, KBETR }); return ok(`Condition record ${KSCHL} ${KUNNR}/${MATNR} valid ${DATAB}–${DATBI} created`);
  },
  VKOA_MAINTAIN({ KTGRM, KVSL1, SAKNR }) { DB.VKOA.push({ KTOPL: 'INT', KTGRM, KVSL1, SAKNR }); return ok(`VKOA: ${KTGRM}/${KVSL1} → G/L ${SAKNR} maintained (transport request created)`); },
  FTXP_MAINTAIN({ MWSKZ }) { DB.TAXCODES_FIXED = true; DB.VBRK.filter(v => v.ACC_ERR.startsWith('FF 753')).forEach(v => { /* error clears on release */ }); return ok(`Tax code ${MWSKZ} maintained in TAXINN`); },
  KNMT_CREATE({ KUNNR, VKORG, VTWEG, KDMAT, MATNR, UMREZ }) { DB.KNMT.push({ KUNNR, VKORG, VTWEG, KDMAT, MATNR, UMREZ }); return ok(`Customer-material info ${KDMAT} → ${MATNR} created`); },
};

/* ---- persistence of the mock DB (browser local storage) ---- */
const DB_KEY = 'infrabeat.sd.agent.db.v1';
let DB = null;
function loadDB() { try { const s = JSON.parse(localStorage.getItem(DB_KEY)); DB = s && s.VBAK ? s : JSON.parse(JSON.stringify(SAP_TABLES)); } catch { DB = JSON.parse(JSON.stringify(SAP_TABLES)); } }
function persistDB() { try { localStorage.setItem(DB_KEY, JSON.stringify(DB)); } catch { /* storage unavailable: in-memory only */ } }
function resetDB() { DB = JSON.parse(JSON.stringify(SAP_TABLES)); try { localStorage.removeItem(DB_KEY); } catch {} }
