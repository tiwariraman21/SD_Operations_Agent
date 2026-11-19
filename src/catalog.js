/* =====================================================================
   SD ISSUE CATALOG
   One entry per recurring SD problem. Each entry knows how to DETECT the
   problem from SAP tables, what EVIDENCE to show, and the exact function
   module(s) that FIX it. The engine (app.js) handles approvals, consultant
   assignment, execution and verification generically.

   module      : which tab the issue lives on
   execRole    : what execute-right a user needs (see ROLES in data.js)
   approval    : approval kind required before execution (null = none)
   skill       : consultant skill used for assignment suggestions
   minutes     : key into MINUTES_SAVED
   detect()    : async -> array of issue drafts
   ===================================================================== */

MOCK_FM.ZSD_INBOX_UPDATE = ({ ID, STATUS, SALESDOCUMENT }) => { const p = DB.ZSD_PO_INBOX.find(r => r.ID === ID); if (!p) return err('Inbox record not found'); p.STATUS = STATUS; if (SALESDOCUMENT) p.VBELN = SALESDOCUMENT; return ok(`Inbox ${ID} set to ${STATUS}`); };

const custName = (k) => (DB.KNA1.find(c => c.KUNNR === k) || {}).NAME1 || k;
const matName = (m) => (DB.MAKT.find(c => c.MATNR === m) || {}).MAKTX || m;
const orgName = (v) => (DB.TVKO.find(c => c.VKORG === v) || {}).VTEXT || v;
const blockText = (t, code, f) => ((DB[t] || []).find(r => r[f] === code) || {}).VTEXT || code;
const ev = (h, lines) => ({ h, text: Array.isArray(lines) ? lines.join('\n') : lines });

const CATALOG = [
  /* ================= 1. ORDER TRACKER ================= */
  {
    id: 'SD-01', module: 'tracker', title: 'Order on delivery block', execRole: 'order', approval: 'block', skill: 'order', minutes: 'blocked',
    async detect() {
      const out = [];
      for (const o of await SAP.read('VBAK')) {
        if (!o.LIFSK) continue;
        const reason = blockText('TVLST', o.LIFSK, 'LIFSP'); const age = ageDays(o.ERDAT);
        out.push({
          key: `SD-01:${o.VBELN}`, ref: o.VBELN, refType: 'order', kunnr: o.KUNNR, vkorg: o.VKORG, value: o.NETWR, severity: age > 3 ? 'r' : 'a',
          title: `Order ${o.VBELN} blocked for delivery — ${reason}`,
          detail: `${custName(o.KUNNR)} · ${inr(o.NETWR)} · requested ${dmy(o.VDATU)} · blocked ${age} days`,
          explain: `VBAK-LIFSK = '${o.LIFSK}' (${reason}). The delivery due list skips this order until the block is removed. ${o.LIFSK === 'Z1' ? 'Customer confirmation was pending at order entry — if the customer has confirmed, the block can be released.' : ''}`,
          evidence: [ev('VBAK', [`VBELN ${o.VBELN} · AUART ${o.AUART} · VKORG ${o.VKORG}`, `LIFSK ${o.LIFSK} (${reason}) · FAKSK '${o.FAKSK}' · CMGST '${o.CMGST}'`, `ERDAT ${o.ERDAT} · VDATU ${o.VDATU} · NETWR ${inrFull(o.NETWR)}`])],
          fix: { label: 'Release delivery block', steps: [{ fm: 'BAPI_SALESORDER_CHANGE', params: { SALESDOCUMENT: o.VBELN, ORDER_HEADER_IN: { DLV_BLOCK: '' }, ORDER_HEADER_INX: { DLV_BLOCK: 'X' } } }], effect: 'Clears VBAK-LIFSK; order becomes due for delivery on the next VL10 run.' },
        });
      }
      return out;
    },
  },
  {
    id: 'SD-02', module: 'tracker', title: 'Incomplete order', execRole: 'order', approval: null, skill: 'order', minutes: 'incomplete',
    async detect() {
      const out = []; const log = await SAP.read('VBUV');
      for (const vbeln of [...new Set(log.map(r => r.VBELN))]) {
        const o = await SAP.one('VBAK', { VBELN: vbeln }); const rows = log.filter(r => r.VBELN === vbeln); const kv = await SAP.one('KNVV', { KUNNR: o.KUNNR });
        const inco = kv && kv.INCO1 ? kv.INCO1 : 'FOR';
        out.push({
          key: `SD-02:${vbeln}`, ref: vbeln, refType: 'order', kunnr: o.KUNNR, vkorg: o.VKORG, value: o.NETWR, severity: 'a',
          title: `Order ${vbeln} incomplete — ${rows.map(r => r.FDTXT).join(', ')}`,
          detail: `${custName(o.KUNNR)} · ${inr(o.NETWR)} · cannot be delivered or billed until complete`,
          explain: `Incompletion log (VBUV) has ${rows.length} open field(s). Customer master (KNVV) has ${kv && kv.INCO1 ? `Incoterms ${kv.INCO1}` : 'no Incoterms'} — proposal uses ${inco} (customer-group default) and sold-to as ship-to.`,
          evidence: [ev('VBUV', rows.map(r => `${r.TBNAM}-${r.FDNAM}  ${r.FDTXT}`)), ev('KNVV', [`KUNNR ${o.KUNNR} · INCO1 '${kv ? kv.INCO1 : ''}' · ZTERM ${kv ? kv.ZTERM : ''}`])],
          fix: { label: 'Complete order with defaults', steps: [{ fm: 'BAPI_SALESORDER_CHANGE', params: { SALESDOCUMENT: vbeln, ORDER_HEADER_IN: { INCOTERMS1: inco }, ORDER_HEADER_INX: { INCOTERMS1: 'X' }, INCOMPLETE_FIELDS: rows.map(r => r.FDNAM) } }], effect: `Sets Incoterms ${inco}, copies sold-to as ship-to, clears the incompletion log.` },
        });
      }
      return out;
    },
  },
  {
    id: 'SD-03', module: 'tracker', title: 'Confirmed quantity short', execRole: 'order', approval: null, skill: 'stock', minutes: 'tracker',
    async detect() {
      const out = []; const eps = await SAP.read('VBEP');
      for (const o of await SAP.read('VBAK')) {
        const mine = eps.filter(e => e.VBELN === o.VBELN); const gap = sumBy(mine, e => e.WMENG - e.BMENG);
        if (gap <= 0 || o.LIFSK || o.CMGST === 'B') continue;
        const items = await SAP.read('VBAP', { VBELN: o.VBELN }); const alt = [];
        for (const it of items) { const e = mine.find(x => x.POSNR === it.POSNR); if (e.WMENG - e.BMENG <= 0) continue; const st = await SAP.read('MARD', { MATNR: it.MATNR }); alt.push(`${it.MATNR} short ${n(e.WMENG - e.BMENG)} at ${it.WERKS}: ` + st.map(s => `${s.WERKS} ${n(s.LABST)}`).join(' · ')); }
        out.push({
          key: `SD-03:${o.VBELN}`, ref: o.VBELN, refType: 'order', kunnr: o.KUNNR, vkorg: o.VKORG, value: o.NETWR, severity: ageDays(o.VDATU) >= 0 ? 'r' : 'a',
          title: `Order ${o.VBELN} — ${n(gap)} EA unconfirmed`, detail: `${custName(o.KUNNR)} · requested ${dmy(o.VDATU)} · ${inr(o.NETWR)}`,
          explain: `Schedule lines (VBEP) confirm less than ordered. Stock at the delivering plant is insufficient; other plants hold stock. Needs a planner decision (alternate plant, partial delivery or re-date) — not auto-fixed.`,
          evidence: [ev('VBEP', mine.map(e => `${e.POSNR} ordered ${n(e.WMENG)} · confirmed ${n(e.BMENG)} · ${e.EDATU}`)), ev('MARD unrestricted stock', alt)],
          fix: null, task: { skill: 'stock', title: `Resolve supply for ${o.VBELN} (${n(gap)} EA short)` },
        });
      }
      return out;
    },
  },

  /* ================= 2. BILLING BACKLOG ================= */
  {
    id: 'SD-10', module: 'billing', title: 'Delivered but not billed', execRole: 'billing', approval: null, skill: 'billing', minutes: 'billing',
    async detect() {
      const out = []; const vbrp = await SAP.read('VBRP');
      for (const d of await SAP.read('LIKP', { WBSTK: 'C' })) {
        if (vbrp.some(b => b.VGBEL === d.VBELN)) continue;
        const lines = await SAP.read('LIPS', { VBELN: d.VBELN }); const o = await SAP.one('VBAK', { VBELN: lines[0].VGBEL });
        const value = sumBy(lines, l => { const ap = DB.VBAP.find(a => a.VBELN === l.VGBEL && a.POSNR === l.VGPOS); return ap ? ap.NETPR * l.LFIMG : 0; });
        const days = ageDays(d.WADAT_IST); const blocked = !!o.FAKSK;
        out.push({
          key: `SD-10:${d.VBELN}`, ref: d.VBELN, refType: 'delivery', order: o.VBELN, kunnr: o.KUNNR, vkorg: o.VKORG, value, severity: blocked || days > 5 ? 'r' : 'a',
          title: blocked ? `Delivery ${d.VBELN} unbilled — order has billing block (${blockText('TVFST', o.FAKSK, 'FAKSP')})` : `Delivery ${d.VBELN} delivered ${days} days ago, not billed`,
          detail: `${custName(o.KUNNR)} · order ${o.VBELN} · ${inr(value)} · PGI ${dmy(d.WADAT_IST)}`,
          explain: blocked ? `VBAK-FAKSK = '${o.FAKSK}' keeps this delivery out of the billing due list (VF04). Removing the block needs SD Lead approval; billing then runs on the next pass.` : `Goods issue posted (LIKP-WBSTK = C) but no VBRP line references this delivery. Nothing blocks it — VF04 was simply not run for it. Safe to bill now.`,
          evidence: [ev('LIKP / LIPS', [`VBELN ${d.VBELN} · WBSTK ${d.WBSTK} · WADAT_IST ${d.WADAT_IST}`, ...lines.map(l => `${l.POSNR} ${l.MATNR} ${n(l.LFIMG)} EA ← ${l.VGBEL}/${l.VGPOS}`)]), ev('VBAK', [`FAKSK '${o.FAKSK}' · ZTERM ${(DB.KNVV.find(k => k.KUNNR === o.KUNNR) || {}).ZTERM}`])],
          ...(blocked
            ? { approval: 'billing_block', fix: { label: 'Remove billing block', steps: [{ fm: 'BAPI_SALESORDER_CHANGE', params: { SALESDOCUMENT: o.VBELN, ORDER_HEADER_IN: { BILL_BLOCK: '' }, ORDER_HEADER_INX: { BILL_BLOCK: 'X' } } }], effect: 'Clears VBAK-FAKSK; the delivery re-appears here as "ready to bill".' } }
            : { fix: { label: 'Create billing document', steps: [{ fm: 'BAPI_BILLINGDOC_CREATEMULTIPLE', params: { BILLINGDATAIN: [{ REF_DOC: d.VBELN, REF_DOC_CA: 'J' }] } }], effect: 'Creates an F2 invoice from the delivery, posts to FI if account determination succeeds, triggers invoice output and IRN.' } }),
        });
      }
      return out;
    },
  },

  /* ================= 3. DELIVERIES & PGI ================= */
  {
    id: 'SD-20', module: 'delivery', title: 'Due for delivery, no delivery created', execRole: 'delivery', approval: null, skill: 'delivery', minutes: 'delivery',
    async detect() {
      const out = []; const likp = await SAP.read('LIPS'); const eps = await SAP.read('VBEP');
      for (const o of await SAP.read('VBAK')) {
        if (o.LIFSK || o.CMGST === 'B' || likp.some(l => l.VGBEL === o.VBELN)) continue;
        const mine = eps.filter(e => e.VBELN === o.VBELN && e.EDATU <= addDays(TODAY, 1) && e.BMENG > 0); if (!mine.length) continue;
        if (DB.VBUV.some(v => v.VBELN === o.VBELN)) continue;
        const partial = mine.some(e => e.BMENG < e.WMENG); const items = await SAP.read('VBAP', { VBELN: o.VBELN });
        out.push({
          key: `SD-20:${o.VBELN}`, ref: o.VBELN, refType: 'order', kunnr: o.KUNNR, vkorg: o.VKORG, value: o.NETWR, severity: partial ? 'a' : 'r',
          title: partial ? `Order ${o.VBELN} due today — only ${n(sumBy(mine, e => e.BMENG))} of ${n(sumBy(mine, e => e.WMENG))} EA confirmed` : `Order ${o.VBELN} due ${dmy(mine[0].EDATU)} — delivery not created`,
          detail: `${custName(o.KUNNR)} · plant ${items[0].WERKS} · ${inr(o.NETWR)}`,
          explain: partial ? `Confirmed quantity covers part of the order. A partial delivery keeps the customer promise for the confirmed part; the shortfall stays open on the order. Partial deliveries need SD Lead approval.` : `All schedule lines are confirmed and due, no blocks, stock available — the delivery due list (VL10) has not been processed for this order.`,
          evidence: [ev('VBEP', mine.map(e => `${e.POSNR} due ${e.EDATU} · confirmed ${n(e.BMENG)} / ${n(e.WMENG)}`)), ev('Stock (MARD)', items.map(i => { const s = DB.MARD.find(m => m.MATNR === i.MATNR && m.WERKS === i.WERKS); return `${i.MATNR} @ ${i.WERKS}: ${s ? n(s.LABST) : 0} EA`; }))],
          approval: partial ? 'delivery' : null,
          fix: { label: partial ? 'Create partial delivery' : 'Create delivery', steps: [{ fm: 'BAPI_OUTB_DELIVERY_CREATE_SLS', params: { SHIP_POINT: items[0].WERKS, DUE_DATE: TODAY, SALES_ORDER_ITEMS: mine.map(e => ({ REF_DOC: o.VBELN, REF_ITEM: e.POSNR, DLV_QTY: e.BMENG })) } }], effect: 'Creates an LF delivery for the confirmed quantities; picking is complete (no WM); PGI remains a separate step.' },
        });
      }
      return out;
    },
  },
  {
    id: 'SD-21', module: 'delivery', title: 'Goods issue not posted', execRole: 'delivery', approval: null, skill: 'delivery', minutes: 'pgi',
    async detect() {
      const out = [];
      for (const d of await SAP.read('LIKP')) {
        if (d.WBSTK === 'C') continue;
        const lines = await SAP.read('LIPS', { VBELN: d.VBELN }); const o = await SAP.one('VBAK', { VBELN: lines[0].VGBEL });
        const noBatch = lines.filter(l => !l.CHARG); const steps = [];
        for (const l of noBatch) { const b = (await SAP.read('MCHB', { MATNR: l.MATNR, WERKS: l.WERKS })).filter(x => x.CLABS >= l.LFIMG).sort(by('VFDAT'))[0]; if (b) steps.push({ fm: 'BAPI_OUTB_DELIVERY_CHANGE', params: { DELIVERY: d.VBELN, ITEM_DATA: [{ DELIV_ITEM: l.POSNR, BATCH: b.CHARG }] }, note: `assign batch ${b.CHARG} (${n(b.CLABS)} EA, FEFO)` }); }
        steps.push({ fm: 'WS_DELIVERY_UPDATE', params: { VBELN: d.VBELN } });
        out.push({
          key: `SD-21:${d.VBELN}`, ref: d.VBELN, refType: 'delivery', order: o.VBELN, kunnr: o.KUNNR, vkorg: o.VKORG, value: o.NETWR, severity: d.PGI_ERR ? 'r' : 'a',
          title: d.PGI_ERR ? `Delivery ${d.VBELN} — PGI failed (batch determination)` : `Delivery ${d.VBELN} picked, goods issue pending`,
          detail: `${custName(o.KUNNR)} · order ${o.VBELN} · planned GI ${dmy(d.LFDAT)} · ${inr(o.NETWR)}`,
          explain: d.PGI_ERR ? `${d.PGI_ERR}. Batch stock (MCHB) at the plant has a batch with enough quantity — the strategy's minimum-remaining-shelf-life check excluded it. Proposal assigns the FEFO batch manually and posts PGI.` : `Picking status complete (KOSTK = C), goods movement status ${d.WBSTK}. Nothing blocks PGI — it was not posted after picking.`,
          evidence: [ev('LIKP', [`VBELN ${d.VBELN} · WBSTK '${d.WBSTK}' · KOSTK ${d.KOSTK} · LFDAT ${d.LFDAT}`, d.PGI_ERR ? `Last error: ${d.PGI_ERR}` : 'No error logged']), ev('LIPS', lines.map(l => `${l.POSNR} ${l.MATNR} ${n(l.LFIMG)} EA · ${l.WERKS}/${l.LGORT} · batch '${l.CHARG}'`))],
          fix: { label: d.PGI_ERR ? 'Assign batch and post goods issue' : 'Post goods issue', steps, effect: 'Posts the goods movement (601), sets LIKP-WBSTK = C, reduces plant stock; the delivery becomes due for billing.' },
        });
      }
      return out;
    },
  },

  /* ================= 4. OUTPUTS, IDOCS, E-INVOICE ================= */
  {
    id: 'SD-30', module: 'output', title: 'Output failed (NAST)', execRole: 'output', approval: null, skill: 'output', minutes: 'output',
    async detect() {
      const out = [];
      for (const r of await SAP.read('NAST', { VSTAT: '2' })) {
        let kunnr, vkorg, steps = [], label, explain, extra = [];
        if (r.NACHA === '5') { const inv = await SAP.one('VBRK', { VBELN: r.OBJKY }); kunnr = inv.KUNRG; vkorg = inv.VKORG; const k = await SAP.one('KNA1', { KUNNR: kunnr }); const po = DB.ZSD_PO_INBOX.find(p => p.KUNNR === kunnr);
          const guess = k.SMTP_ADDR || `ap@${k.NAME1.toLowerCase().split(' ')[0]}-${k.NAME1.toLowerCase().split(' ')[1] || 'co'}.example`;
          label = 'Maintain e-mail and resend invoice'; explain = `KNA1-SMTP_ADDR is empty for ${k.NAME1}, so the e-mail output cannot be sent. ${po ? `The customer's last PO came from an address we can use.` : 'Proposed address is derived from the customer name — confirm before sending.'}`;
          steps = [{ fm: 'BAPI_CUSTOMER_CHANGEFROMDATA', params: { KUNNR: kunnr, SMTP_ADDR: guess }, input: { name: 'SMTP_ADDR', label: 'Customer e-mail address', default: guess } }, { fm: 'RSNAST00', params: { OBJKY: r.OBJKY, KSCHL: r.KSCHL } }];
          extra = [ev('KNA1', [`KUNNR ${kunnr} · NAME1 ${k.NAME1} · SMTP_ADDR '${k.SMTP_ADDR}'`])];
        } else { const o = await SAP.one('VBAK', { VBELN: r.OBJKY }); kunnr = o.KUNNR; vkorg = o.VKORG; const alt = (DB.PRINTERS.find(p => p.STATUS === 'READY') || {}).PDEST;
          label = `Reprint on ${alt}`; explain = `Output device ${r.PDEST} is offline (SPAD). ${alt} is ready at the same location — proposal re-issues the output there.`;
          steps = [{ fm: 'RSNAST00', params: { OBJKY: r.OBJKY, KSCHL: r.KSCHL, PDEST: alt }, input: { name: 'PDEST', label: 'Output device', default: alt } }];
          extra = [ev('SPAD', DB.PRINTERS.map(p => `${p.PDEST} ${p.STATUS}`))];
        }
        out.push({ key: `SD-30:${r.OBJKY}:${r.KSCHL}`, ref: r.OBJKY, refType: r.KAPPL === 'V3' ? 'invoice' : 'order', kunnr, vkorg, value: 0, severity: 'a',
          title: `${r.KSCHL} output failed for ${r.KAPPL === 'V3' ? 'invoice' : 'order'} ${r.OBJKY}`, detail: `${custName(kunnr)} · ${r.ERRTXT}`, explain,
          evidence: [ev('NAST', [`KAPPL ${r.KAPPL} · OBJKY ${r.OBJKY} · KSCHL ${r.KSCHL} · NACHA ${r.NACHA} · VSTAT ${r.VSTAT}`, r.ERRTXT]), ...extra],
          fix: { label, steps, effect: 'Re-processes the NAST record (RSNAST00); status becomes 1 on success.' } });
      }
      return out;
    },
  },
  {
    id: 'SD-31', module: 'output', title: 'IDoc in error', execRole: 'config', approval: null, skill: 'idoc', minutes: 'idoc',
    async detect() {
      const out = [];
      for (const d of await SAP.read('EDIDC')) {
        if (!['29', '51', '26'].includes(d.STATUS)) continue;
        const inv = await SAP.one('VBRK', { VBELN: d.OBJKY }); const hasProfile = DB.WE20.some(w => w.PARNUM === d.RCVPRN && w.MESTYP === d.MESTYP);
        out.push({ key: `SD-31:${d.DOCNUM}`, ref: d.DOCNUM, refType: 'idoc', kunnr: d.RCVPRN, vkorg: inv ? inv.VKORG : '', value: inv ? inv.NETWR : 0, severity: 'r',
          title: `IDoc ${d.MESTYP} ${d.DOCNUM.replace(/^0+/, '')} — status ${d.STATUS}`, detail: `${custName(d.RCVPRN)} · invoice ${d.OBJKY} · ${d.STATXT}`,
          explain: hasProfile ? 'Partner profile now exists — the IDoc can be re-processed.' : `No outbound partner profile for ${d.RCVPRN}/${d.MESTYP} in WE20. This is a configuration task for the EDI consultant: create the profile (port, message control), then re-process the IDoc.`,
          evidence: [ev('EDIDC', [`DOCNUM ${d.DOCNUM} · MESTYP ${d.MESTYP} · IDOCTP ${d.IDOCTP} · RCVPRN ${d.RCVPRN} · STATUS ${d.STATUS}`, d.STATXT]), ev('WE20', DB.WE20.filter(w => w.PARNUM === d.RCVPRN).map(w => `${w.PARNUM} ${w.PARTYP} ${w.MESTYP}`).concat(hasProfile ? [] : [`(no ${d.MESTYP} entry for ${d.RCVPRN})`]))],
          task: hasProfile ? null : { skill: 'idoc', title: `Create WE20 partner profile ${d.RCVPRN}/${d.MESTYP} and re-process IDoc` },
          fix: { label: hasProfile ? 'Re-process IDoc' : 'Create partner profile and re-process', steps: [...(hasProfile ? [] : [{ fm: 'WE20_CREATE_PARTNER_PROFILE', params: { PARNUM: d.RCVPRN, PARTYP: 'KU', MESTYP: d.MESTYP }, note: 'configuration — consultant' }]), { fm: 'BD87_REPROCESS', params: { DOCNUM: d.DOCNUM } }], effect: 'IDoc passes to the port (status 03) and reaches the customer.' } });
      }
      return out;
    },
  },
  {
    id: 'SD-32', module: 'output', title: 'E-invoice (IRN) rejected', execRole: 'output', approval: null, skill: 'einvoice', minutes: 'einvoice',
    async detect() {
      const out = [];
      for (const e of await SAP.read('EINV', { IRN_STATUS: 'REJECTED' })) {
        const inv = await SAP.one('VBRK', { VBELN: e.VBELN }); const k = await SAP.one('KNA1', { KUNNR: inv.KUNRG });
        out.push({ key: `SD-32:${e.VBELN}`, ref: e.VBELN, refType: 'invoice', kunnr: inv.KUNRG, vkorg: inv.VKORG, value: inv.NETWR, severity: 'r',
          title: `IRN rejected for invoice ${e.VBELN} — error ${e.ERRCODE}`, detail: `${k.NAME1} · ${inr(inv.NETWR)} · ${e.ERRTXT}`,
          explain: `The IRP rejected the invoice because the recipient GSTIN on the customer master (KNA1-STCD3 = ${k.STCD3}) is cancelled or inactive. The customer must supply a valid GSTIN; then update the master and resubmit. Until the IRN exists the invoice cannot legally be dispatched.`,
          evidence: [ev('E-invoice', [`VBELN ${e.VBELN} · IRN_STATUS ${e.IRN_STATUS} · ${e.ERRCODE} ${e.ERRTXT} · submitted ${e.SUBMITTED}`]), ev('KNA1', [`KUNNR ${k.KUNNR} · STCD3 ${k.STCD3} · GSTIN valid: ${k.GSTIN_OK ? 'yes' : 'NO'}`])],
          fix: { label: 'Update GSTIN and resubmit IRN', steps: [{ fm: 'BAPI_CUSTOMER_CHANGEFROMDATA', params: { KUNNR: k.KUNNR, STCD3: '' }, input: { name: 'STCD3', label: 'Valid GSTIN (from customer)', default: '' } }, { fm: 'EINV_RESUBMIT', params: { VBELN: e.VBELN } }], effect: 'Updates KNA1-STCD3, re-submits the invoice to the IRP; IRN and QR code are stored on the invoice.' },
          task: { skill: 'einvoice', title: `Obtain valid GSTIN from ${k.NAME1} for invoice ${e.VBELN}` } });
      }
      return out;
    },
  },

  /* ================= 5. PO INBOX → ORDER CAPTURE ================= */
  {
    id: 'SD-40', module: 'po', title: 'Customer PO waiting to be captured', execRole: 'po', approval: null, skill: 'order', minutes: 'po',
    async detect() {
      const out = [];
      for (const p of await SAP.read('ZSD_PO_INBOX', { STATUS: 'New' })) {
        const k = await SAP.one('KNA1', { KUNNR: p.KUNNR }); const kv = await SAP.one('KNVV', { KUNNR: p.KUNNR });
        const dup = (await SAP.read('VBAK', { KUNNR: p.KUNNR, BSTNK: p.BSTNK }))[0];
        const lines = []; const unmapped = [];
        for (const l of p.LINES) {
          const m = DB.KNMT.find(x => x.KUNNR === p.KUNNR && x.KDMAT === l.KDMAT);
          if (!m) { const guess = DB.MAKT.find(x => l.KDMAT.toUpperCase().includes('DISH') && x.MAKTX.includes('Dish')) || DB.MAKT[0]; unmapped.push({ ...l, guess: guess.MATNR, guessName: guess.MAKTX }); lines.push({ ...l, MATNR: null }); continue; }
          const qty = l.CASES * m.UMREZ; const rec = DB.A305.find(a => a.KUNNR === p.KUNNR && a.MATNR === m.MATNR && a.DATAB <= TODAY && a.DATBI >= TODAY) || DB.A304.find(a => a.MATNR === m.MATNR && a.VKORG === p.VKORG);
          const sapPrice = rec ? rec.KBETR : 0; const poUnit = l.PRICE_ON_PO / m.UMREZ; const var_ = sapPrice ? ((poUnit - sapPrice) / sapPrice * 100) : 0;
          lines.push({ ...l, MATNR: m.MATNR, UMREZ: m.UMREZ, QTY: qty, SAP_PRICE: sapPrice, PO_UNIT: poUnit, VAR: var_ });
        }
        const plant = { '1000': '1100', '2000': '2100', '3000': '3100' }[p.VKORG];
        const draft = { key: `SD-40:${p.ID}`, ref: p.ID, refType: 'po', kunnr: p.KUNNR, vkorg: p.VKORG, value: sumBy(lines, l => (l.QTY || 0) * (l.SAP_PRICE || 0)), severity: dup ? 'r' : unmapped.length ? 'a' : 'g', po: p, lines, unmapped, dup };
        if (dup) Object.assign(draft, { title: `PO ${p.BSTNK} from ${k.NAME1} already exists as order ${dup.VBELN}`, detail: `Duplicate purchase order — received ${p.RECEIVED} via ${p.SOURCE}`, explain: `VBAK-BSTNK '${p.BSTNK}' for customer ${p.KUNNR} is already on sales order ${dup.VBELN} (created ${dup.ERDAT}). Creating it again would double-ship. Proposal: mark the inbox item as duplicate and reply to the customer with the existing order number.`,
          evidence: [ev('Inbox', [`${p.ID} · ${p.SOURCE} · received ${p.RECEIVED} · extraction confidence ${(p.CONFIDENCE * 100).toFixed(0)}%`]), ev('VBAK duplicate', [`VBELN ${dup.VBELN} · BSTNK ${dup.BSTNK} · ERDAT ${dup.ERDAT} · NETWR ${inrFull(dup.NETWR)}`])],
          fix: { label: 'Mark as duplicate (no order)', steps: [{ fm: 'ZSD_INBOX_UPDATE', params: { ID: p.ID, STATUS: 'Duplicate' } }], effect: 'No SAP document is created; inbox item closed with reference to the existing order.' } });
        else if (unmapped.length) Object.assign(draft, { title: `PO ${p.BSTNK} from ${k.NAME1} — ${unmapped.length} line(s) not mapped to a material`, detail: `${p.LINES.length} lines · received ${p.RECEIVED} · customer material '${unmapped.map(u => u.KDMAT).join("', '")}' has no KNMT record`,
          explain: `Customer material ${unmapped.map(u => u.KDMAT).join(', ')} is not in the customer-material info record (KNMT). Best match by description: ${unmapped.map(u => `${u.KDMAT} → ${u.guess} ${u.guessName}`).join('; ')}. Confirm the mapping; the tool creates the KNMT record and then the order.`,
          evidence: [ev('Extracted PO lines', p.LINES.map(l => `${l.KDMAT} · ${l.CASES} ${l.UOM} · ₹${l.PRICE_ON_PO}/case`)), ev('KNMT', DB.KNMT.filter(x => x.KUNNR === p.KUNNR).map(x => `${x.KDMAT} → ${x.MATNR} (×${x.UMREZ})`))],
          fix: { label: 'Map material and create order', steps: [...unmapped.map(u => ({ fm: 'KNMT_CREATE', params: { KUNNR: p.KUNNR, VKORG: p.VKORG, VTWEG: '10', KDMAT: u.KDMAT, MATNR: u.guess, UMREZ: 24 }, input: { name: 'MATNR', label: `SAP material for ${u.KDMAT}`, default: u.guess }, input2: { name: 'UMREZ', label: 'Units per case', default: 24 } })),
            { fm: 'BAPI_SALESORDER_CREATEFROMDAT2', params: { ORDER_HEADER_IN: { DOC_TYPE: 'OR', SALES_ORG: p.VKORG, DISTR_CHAN: '10', DIVISION: '00', KUNNR: p.KUNNR, PURCH_NO_C: p.BSTNK, REQ_DATE_H: p.REQ_DATE }, ORDER_ITEMS_IN: lines.map(l => ({ MATERIAL: l.MATNR, TARGET_QTY: l.QTY, PLANT: plant, KDMAT: l.KDMAT, CASES: l.CASES })) }, dynamic: 'po-lines' },
            { fm: 'ZSD_INBOX_UPDATE', params: { ID: p.ID, STATUS: 'Created' }, dynamic: 'po-close' }], effect: 'Creates the KNMT mapping, then a standard order (OR) with all lines; inbox item closed with the order number.' } });
        else Object.assign(draft, { title: `PO ${p.BSTNK} from ${k.NAME1} — ready to create (${lines.length} lines, ${inr(draft.value)})`, detail: `Received ${p.RECEIVED} via ${p.SOURCE} · requested ${dmy(p.REQ_DATE)} · all lines mapped · ${lines.some(l => Math.abs(l.VAR) > 2) ? 'price on PO differs from SAP price' : 'prices match SAP'}`,
          explain: `All customer materials map through KNMT; case quantities converted to EA. ${lines.some(l => Math.abs(l.VAR) > 2) ? 'One or more PO unit prices differ from the SAP condition by more than 2% — SAP pricing applies; the difference is flagged for the account manager.' : 'PO unit prices match SAP condition records within 2%.'} No duplicate PO number. Safe to create.`,
          evidence: [ev('Extracted PO lines → SAP', lines.map(l => `${l.KDMAT} → ${l.MATNR} · ${l.CASES} CS × ${l.UMREZ} = ${n(l.QTY)} EA · PO ₹${l.PO_UNIT.toFixed(0)}/EA vs SAP ₹${l.SAP_PRICE} (${l.VAR >= 0 ? '+' : ''}${l.VAR.toFixed(1)}%)`)), ev('Duplicate check', [`VBAK where KUNNR = ${p.KUNNR} and BSTNK = '${p.BSTNK}' → 0 rows`])],
          fix: { label: 'Create sales order', steps: [{ fm: 'BAPI_SALESORDER_CREATEFROMDAT2', params: { ORDER_HEADER_IN: { DOC_TYPE: 'OR', SALES_ORG: p.VKORG, DISTR_CHAN: '10', DIVISION: '00', KUNNR: p.KUNNR, PURCH_NO_C: p.BSTNK, REQ_DATE_H: p.REQ_DATE }, ORDER_ITEMS_IN: lines.map(l => ({ MATERIAL: l.MATNR, TARGET_QTY: l.QTY, PLANT: plant })) } }, { fm: 'ZSD_INBOX_UPDATE', params: { ID: p.ID, STATUS: 'Created' }, dynamic: 'po-close' }], effect: 'Creates a standard order (OR) with ATP check and pricing; order confirmation output is triggered by SAP.' } });
        out.push(draft);
      }
      return out;
    },
  },

  /* ================= 6. CREDIT BLOCKS ================= */
  {
    id: 'SD-50', module: 'credit', title: 'Order on credit block', execRole: 'credit', approval: 'credit', skill: 'credit', minutes: 'credit',
    async detect() {
      const out = [];
      for (const o of await SAP.read('VBAK', { CMGST: 'B' })) {
        const c = await SAP.one('KNKK', { KUNNR: o.KUNNR }); const k = await SAP.one('KNA1', { KUNNR: o.KUNNR });
        const util = c.SKFOR / c.KLIMK * 100; const over = c.SKFOR + o.NETWR - c.KLIMK; const risky = c.DPD > 15 || c.OVERDUE > 0.1 * c.SKFOR;
        out.push({ key: `SD-50:${o.VBELN}`, ref: o.VBELN, refType: 'order', kunnr: o.KUNNR, vkorg: o.VKORG, value: o.NETWR, severity: risky ? 'r' : 'a', credit: c, recommend: risky ? 'hold' : 'release',
          title: `Order ${o.VBELN} on credit block — ${k.NAME1} at ${util.toFixed(0)}% of limit`, detail: `${inr(o.NETWR)} order · exposure ${inr(c.SKFOR)} of ${inr(c.KLIMK)} · overdue ${inr(c.OVERDUE)} (${c.DPD} days)`,
          explain: risky ? `Recommendation: HOLD. Overdue ${inr(c.OVERDUE)} is ${(c.OVERDUE / c.SKFOR * 100).toFixed(0)}% of exposure and ${c.DPD} days past due; payment history is "${c.PAYHIST}". Releasing adds ${inr(o.NETWR)} on top of a limit already exceeded by ${inr(c.SKFOR - c.KLIMK)}. Ask collections to secure payment first.` : `Recommendation: RELEASE. The block is a dynamic limit check (exposure + this order exceeds the limit by ${inr(over)}), but overdue is only ${inr(c.OVERDUE)} at ${c.DPD} days and history is "${c.PAYHIST}". Finance Controller approval required (VKM1).`,
          evidence: [ev('KNKK / FSCM', [`KUNNR ${o.KUNNR} · KLIMK ${inrFull(c.KLIMK)} · SKFOR ${inrFull(c.SKFOR)} (${util.toFixed(0)}%)`, `OVERDUE ${inrFull(c.OVERDUE)} · DPD ${c.DPD} · last payment ${c.LASTPAY}`, `History: ${c.PAYHIST}`]), ev('VBAK', [`VBELN ${o.VBELN} · CMGST B (blocked, dynamic check) · NETWR ${inrFull(o.NETWR)} · VDATU ${o.VDATU}`])],
          fix: { label: 'Release credit block (VKM1)', steps: [{ fm: 'SD_ORDER_CREDIT_RELEASE', params: { VBELN: o.VBELN } }], effect: 'Sets credit status D (released); order proceeds to delivery. Exposure is updated by FSCM.' },
          task: risky ? { skill: 'credit', title: `Collections follow-up with ${k.NAME1} — ${inr(c.OVERDUE)} overdue before releasing ${o.VBELN}` } : null });
      }
      return out;
    },
  },

  /* ================= 7. ACCOUNTING RELEASE ================= */
  {
    id: 'SD-60', module: 'accounting', title: 'Invoice not released to accounting', execRole: 'accounting', approval: 'accounting', skill: 'accounting', minutes: 'accounting',
    async detect() {
      const out = [];
      for (const inv of await SAP.read('VBRK', { RFBSK: 'E' })) {
        const items = await SAP.read('VBRP', { VBELN: inv.VBELN }); const isVkoa = inv.ACC_ERR.includes('VKOA') || inv.ACC_ERR.includes('KI 235'); const isTax = inv.ACC_ERR.startsWith('FF 753');
        const gapMat = items.map(i => DB.MAKT.find(m => m.MATNR === i.MATNR)).find(m => m && !DB.VKOA.some(v => v.KTGRM === m.KTGRM && v.KVSL1 === 'ERL'));
        const configOpen = isVkoa ? !!gapMat : isTax ? !DB.TAXCODES_FIXED : false;
        const steps = []; let label, explain;
        if (configOpen && isVkoa) { steps.push({ fm: 'VKOA_MAINTAIN', params: { KTGRM: gapMat.KTGRM, KVSL1: 'ERL', SAKNR: '400040' }, input: { name: 'SAKNR', label: `Revenue G/L for account group ${gapMat.KTGRM} / ERL`, default: '400040' }, note: 'configuration — consultant' }); label = 'Maintain VKOA and release to accounting'; explain = `Account determination (VKOA) has no revenue account for material account-assignment group ${gapMat.KTGRM} with account key ERL — material ${gapMat.MATNR} ${gapMat.MAKTX} uses that group. Consultant maintains VKOA (transportable), then Finance releases the invoice.`; }
        else if (configOpen && isTax) { steps.push({ fm: 'FTXP_MAINTAIN', params: { MWSKZ: 'O1' }, note: 'configuration — consultant' }); label = 'Maintain tax code and release'; explain = `Tax code O1 was determined from the customer tax classification but is not defined in TAXINN. Consultant maintains the tax code (FTXP) or corrects the condition record; then release.`; }
        else { label = 'Release to accounting'; explain = 'The underlying configuration has been corrected — the invoice can be released (VF02 → Release to accounting).'; }
        steps.push({ fm: 'RV_INVOICE_RELEASE_TO_ACCOUNTING', params: { VBELN: inv.VBELN } });
        out.push({ key: `SD-60:${inv.VBELN}`, ref: inv.VBELN, refType: 'invoice', kunnr: inv.KUNRG, vkorg: inv.VKORG, value: inv.NETWR + inv.MWSBK, severity: 'r',
          title: `Invoice ${inv.VBELN} not posted to FI — ${isVkoa ? 'account determination' : isTax ? 'tax code' : 'posting error'}`, detail: `${custName(inv.KUNRG)} · ${inr(inv.NETWR + inv.MWSBK)} incl. tax · billed ${dmy(inv.FKDAT)} · ${ageDays(inv.FKDAT)} days unposted`,
          explain, evidence: [ev('VBRK', [`VBELN ${inv.VBELN} · FKART ${inv.FKART} · FKDAT ${inv.FKDAT} · RFBSK ${inv.RFBSK} · BELNR '${inv.BELNR}'`, inv.ACC_ERR]), ev('VBRP', items.map(i => `${i.POSNR} ${i.MATNR} ${matName(i.MATNR)} · KTGRM ${(DB.MAKT.find(m => m.MATNR === i.MATNR) || {}).KTGRM} · ${inrFull(i.NETWR)}`)), ev('VKOA (ERL)', DB.VKOA.filter(v => v.KVSL1 === 'ERL').map(v => `KTGRM ${v.KTGRM} → ${v.SAKNR}`))],
          task: configOpen ? { skill: 'accounting', title: `${isVkoa ? 'Maintain VKOA for KTGRM ' + gapMat.KTGRM : 'Maintain tax code O1 in TAXINN'} (invoice ${inv.VBELN})` } : null, configOpen,
          fix: { label, steps, effect: 'FI document is created (RFBSK = C); receivable appears in FBL5N; revenue recognised.' } });
      }
      return out;
    },
  },
  {
    id: 'SD-61', module: 'accounting', title: 'SD–FI amount mismatch', execRole: 'accounting', approval: null, skill: 'accounting', minutes: 'accounting',
    async detect() {
      const out = [];
      for (const inv of await SAP.read('VBRK', { RFBSK: 'C' })) {
        const fi = await SAP.one('BKPF', { AWKEY: inv.VBELN }); if (!fi) continue; const diff = fi.WRBTR - (inv.NETWR + inv.MWSBK); if (Math.abs(diff) < 1) continue;
        out.push({ key: `SD-61:${inv.VBELN}`, ref: inv.VBELN, refType: 'invoice', kunnr: inv.KUNRG, vkorg: inv.VKORG, value: Math.abs(diff), severity: 'a',
          title: `Invoice ${inv.VBELN} differs from FI document ${fi.BELNR} by ${inrFull(diff)}`, detail: `${custName(inv.KUNRG)} · SD ${inrFull(inv.NETWR + inv.MWSBK)} vs FI ${inrFull(fi.WRBTR)}`,
          explain: 'Billing document total (NETWR + MWSBK) does not equal the accounting document amount. Typical causes: manual FI change, tax rounding, or a cancelled-and-rebilled pair. Needs a finance review — no automatic correction.',
          evidence: [ev('VBRK', [`VBELN ${inv.VBELN} · NETWR ${inrFull(inv.NETWR)} · MWSBK ${inrFull(inv.MWSBK)} · total ${inrFull(inv.NETWR + inv.MWSBK)}`]), ev('BKPF', [`BELNR ${fi.BELNR} · AWKEY ${fi.AWKEY} · WRBTR ${inrFull(fi.WRBTR)} · BUDAT ${fi.BUDAT}`])],
          fix: null, task: { skill: 'accounting', title: `Reconcile invoice ${inv.VBELN} with FI ${fi.BELNR} (${inrFull(diff)})` } });
      }
      return out;
    },
  },

  /* ================= 8. PRICING ================= */
  {
    id: 'SD-70', module: 'pricing', title: 'Pricing error — no condition record', execRole: 'pricing', approval: 'pricing', skill: 'pricing', minutes: 'pricing',
    async detect() {
      const out = [];
      for (const o of await SAP.read('VBAK')) {
        const items = (await SAP.read('VBAP', { VBELN: o.VBELN })).filter(i => !i.NETPR); if (!items.length) continue;
        const it = items[0]; const recs = DB.A305.filter(a => a.KUNNR === o.KUNNR && a.MATNR === it.MATNR); const expired = recs.find(a => a.DATBI < TODAY); const listRec = DB.A304.find(a => a.MATNR === it.MATNR && a.VKORG === o.VKORG);
        const proposed = expired ? expired.KBETR : listRec ? listRec.KBETR : 0;
        out.push({ key: `SD-70:${o.VBELN}`, ref: o.VBELN, refType: 'order', kunnr: o.KUNNR, vkorg: o.VKORG, value: it.KWMENG * proposed, severity: 'r',
          title: `Order ${o.VBELN} — item ${it.POSNR} has no price (PR00 missing)`, detail: `${custName(o.KUNNR)} · ${it.MATNR} ${matName(it.MATNR)} · ${n(it.KWMENG)} EA · order value ₹0`,
          explain: expired ? `Condition analysis: access A305 (customer/material) found record ${expired.KBETR} valid only until ${expired.DATBI} — expired. The customer-specific price was not extended. Proposal: extend the same price from today to ${addDays(TODAY, 140)} and re-run pricing on the order.` : `No customer/material record; list price ${proposed} would apply. Create the customer record or accept list price.`,
          evidence: [ev('PRCD_ELEMENTS (KONV)', DB.PRCD_ELEMENTS.filter(p => p.KNUMV === o.KNUMV).map(p => `${p.STUNR} ${p.KSCHL} ${p.KBETR} → ${p.STATUS}`)), ev('A305 condition records', recs.map(a => `${a.KSCHL} ${a.KUNNR}/${a.MATNR} ${a.DATAB}–${a.DATBI} ₹${a.KBETR}${a.DATBI < TODAY ? '  (EXPIRED)' : ''}`)), ev('A304 list price', listRec ? [`${listRec.MATNR} ₹${listRec.KBETR}`] : ['none'])],
          fix: { label: 'Extend price record and re-price order', steps: [{ fm: 'BAPI_PRICES_CONDITIONS', params: { KSCHL: 'PR00', VKORG: o.VKORG, VTWEG: '10', KUNNR: o.KUNNR, MATNR: it.MATNR, DATAB: TODAY, DATBI: addDays(TODAY, 140), KBETR: proposed }, input: { name: 'KBETR', label: 'Price per EA (₹)', default: proposed } }, { fm: 'BAPI_SALESORDER_CHANGE', params: { SALESDOCUMENT: o.VBELN, LOGIC_SWITCH: { PRICING: 'B' } } }], effect: 'Creates the PR00 record (VK11 equivalent) and carries out new pricing (type B) on the order; NETWR is updated.' } });
      }
      return out;
    },
  },
  {
    id: 'SD-71', module: 'pricing', title: 'Manual discount outside usual range', execRole: 'pricing', approval: 'pricing', skill: 'pricing', minutes: 'pricing',
    async detect() {
      const out = [];
      for (const p of await SAP.read('PRCD_ELEMENTS', { KMPRS: 'X' })) {
        const o = DB.VBAK.find(v => v.KNUMV === p.KNUMV); if (!o) continue; const it = DB.VBAP.find(i => i.VBELN === o.VBELN && i.POSNR === p.KPOSN);
        const hist = DB.PRICE_HISTORY.find(h => h.KUNNR === o.KUNNR && h.MATNR === it.MATNR); if (!hist || Math.abs(p.KBETR) <= Math.abs(hist.MAX_K007)) continue;
        out.push({ key: `SD-71:${o.VBELN}:${p.KPOSN}`, ref: o.VBELN, refType: 'order', kunnr: o.KUNNR, vkorg: o.VKORG, value: Math.abs(p.KWERT), severity: 'a',
          title: `Order ${o.VBELN} — manual ${p.KSCHL} ${p.KBETR}% vs usual ${hist.AVG_K007}% for this customer`, detail: `${custName(o.KUNNR)} · ${it.MATNR} · discount value ${inrFull(Math.abs(p.KWERT))} · last ${hist.N} orders ranged ${hist.MIN_K007}% to ${hist.MAX_K007}%`,
          explain: `A manually entered discount (KMPRS = X) exceeds the historical range for this customer/material. Either approve it (SD Lead) or reset the item to standard pricing, which re-determines K007 from condition records.`,
          evidence: [ev('PRCD_ELEMENTS', [`${p.STUNR} ${p.KSCHL} ${p.KBETR}% · KWERT ${inrFull(p.KWERT)} · manual`]), ev('Last 10 orders', [`avg ${hist.AVG_K007}% · min ${hist.MIN_K007}% · max ${hist.MAX_K007}%`])],
          fix: { label: 'Reset to standard pricing', steps: [{ fm: 'BAPI_SALESORDER_CHANGE', params: { SALESDOCUMENT: o.VBELN, LOGIC_SWITCH: { PRICING: 'B' } } }], effect: 'Removes the manual condition and re-prices the item from condition records.' }, acceptable: true });
      }
      return out;
    },
  },
];

const MODULES = {
  overview:   { label: 'Overview',            icon: 'grid' },
  tracker:    { label: 'Order tracker',       icon: 'search', sub: 'Where is my order, why is it blocked, what happens next', tile: 'Orders stuck', color: 'r' },
  billing:    { label: 'Billing',     icon: 'bill',   sub: 'Delivered but not billed — bill the clean ones, route the blocked ones', tile: 'Delivered, not billed', color: 'r' },
  delivery:   { label: 'Deliveries',    icon: 'truck',  sub: 'Due list not processed and goods issues that failed', tile: 'Due, not shipped', color: 'a' },
  output:     { label: 'Outputs & IDocs',     icon: 'send',   sub: 'Invoice / order outputs, EDI IDocs and e-invoice rejections', tile: 'Outputs failed', color: 'a' },
  po:         { label: 'PO inbox',            icon: 'inbox',  sub: 'Customer purchase orders extracted from e-mail and portal exports, ready to become sales orders', tile: 'POs to capture', color: 'b' },
  credit:     { label: 'Credit blocks',       icon: 'card',   sub: 'Orders held by credit check with the evidence Finance needs to decide', tile: 'On credit block', color: 'r' },
  accounting: { label: 'Accounting',  icon: 'ledger', sub: 'Invoices that did not post to FI, and SD–FI mismatches', tile: 'Not posted to FI', color: 'r' },
  pricing:    { label: 'Pricing',             icon: 'tag',    sub: 'Missing condition records and out-of-range manual discounts', tile: 'Pricing issues', color: 'a' },
  approvals:  { label: 'Approvals',           icon: 'check' },
  tasks:      { label: 'Team tasks',          icon: 'users' },
  data:       { label: 'Data',  icon: 'db' },
};
