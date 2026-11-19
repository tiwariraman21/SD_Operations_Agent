/* =====================================================================
   ENGINE + UI
   ===================================================================== */
const STATE_KEY = 'infrabeat.sd.agent.state.v1';
let S = { user: null, vkorg: 'all', theme: 'light', tab: 'overview', issues: {}, tasks: [], audit: [], actions: 0, minutes: 0, scannedAt: null, filter: 'open', q: '' };
let ISSUES = [];            // live merged issue list
let DRAWER = null;          // {type:'issue'|'order'|'chat', ...}
const LLM = { endpoint: '' }; // optional: POST {question, context} → {answer}; empty = built-in rule-based copilot

function loadState() { try { const s = JSON.parse(localStorage.getItem(STATE_KEY)); if (s && s.issues) S = { ...S, ...s }; } catch {} }
function saveState() { try { localStorage.setItem(STATE_KEY, JSON.stringify(S)); } catch {} }
const nowISO = () => new Date().toISOString();
const me = () => S.user;
const userName = (id) => (USERS.find(u => u.id === id) || CONSULTANTS.find(c => c.id === id) || { name: id }).name;
function audit(what, ref = '') { S.audit.unshift({ at: nowISO(), who: me() ? me().name : 'system', what, ref }); if (S.audit.length > 400) S.audit.length = 400; }

/* ---------- scanner ---------- */
async function scan() {
  const drafts = [];
  for (const c of CATALOG) {
    const defaults = { catalogId: c.id, catalogTitle: c.title, module: c.module, execRole: c.execRole, approval: c.approval, skill: c.skill, minutes: c.minutes };
    try { for (const d of await c.detect()) drafts.push({ ...defaults, ...d }); } catch (e) { console.error('detect failed', c.id, e); }
  }
  const seen = new Set();
  for (const d of drafts) {
    seen.add(d.key);
    if (!S.issues[d.key]) S.issues[d.key] = { key: d.key, status: 'open', createdAt: nowISO(), history: [{ at: nowISO(), who: 'Scanner', what: 'Detected: ' + d.title }] };
    const st = S.issues[d.key]; if (st.status === 'resolved' && !st.closedByTool) { st.status = 'open'; st.history.push({ at: nowISO(), who: 'Scanner', what: 'Re-detected: ' + d.title }); }
    st.snap = { title: d.title, detail: d.detail, module: d.module, ref: d.ref, kunnr: d.kunnr, vkorg: d.vkorg, value: d.value, refType: d.refType };
  }
  for (const [k, st] of Object.entries(S.issues)) if (!seen.has(k) && !['resolved', 'rejected'].includes(st.status)) { st.status = 'resolved'; st.resolvedAt = nowISO(); st.reason = st.reason || 'No longer reported by SAP'; st.history.push({ at: nowISO(), who: 'Scanner', what: 'Verified — SAP no longer reports this issue' }); }
  ISSUES = drafts.map(d => ({ ...d, ...S.issues[d.key] }));
  for (const [k, st] of Object.entries(S.issues)) if (!seen.has(k)) ISSUES.push({ ...(st.snap || {}), ...st, fix: null, evidence: [], explain: '' });
  S.scannedAt = nowISO(); saveState();
}
const inOrg = (i) => S.vkorg === 'all' || !i.vkorg || i.vkorg === S.vkorg;
const isLive = (i) => ['open', 'pending', 'approved', 'assigned'].includes(i.status);
const live = (mod) => ISSUES.filter(i => isLive(i) && inOrg(i) && (!mod || i.module === mod));
const syncIssues = () => ISSUES.forEach(i => { if (S.issues[i.key]) Object.assign(i, S.issues[i.key]); });
const issue = (key) => { const i = ISSUES.find(x => x.key === key); if (i && S.issues[key]) Object.assign(i, S.issues[key]); return i; };

/* ---------- permissions ---------- */
const role = () => ROLES[me().role];
const canExecute = (i) => role().execute.includes('*') || role().execute.includes(i.execRole) || i.assignee === me().id;
const canApprove = (i) => !!i.approval && role().approve.includes(i.approval) && i.proposedBy !== me().id;
const needsApproval = (i) => !!i.approval && i.status !== 'approved';
const canAssign = () => role().assign || me().role === 'cs';
const APPROVAL_LABEL = { block: 'SD Lead', billing_block: 'SD Lead', pricing: 'SD Lead', delivery: 'SD Lead', order: 'SD Lead', credit: 'Finance Controller', accounting: 'Finance Controller' };

/* ---------- actions ---------- */
function hist(i, what) { const st = S.issues[i.key]; st.history.push({ at: nowISO(), who: me().name, what }); }
function propose(key, note = '') { const i = issue(key); const st = S.issues[key]; st.status = 'pending'; st.proposedBy = me().id; st.proposedAt = nowISO(); st.note = note; hist(i, `Sent for ${APPROVAL_LABEL[i.approval]} approval: ${i.fix.label}${note ? ' — ' + note : ''}`); audit(`Proposed: ${i.fix.label}`, i.ref); saveState(); toast(`Sent to ${APPROVAL_LABEL[i.approval]} for approval`); refresh(); }
function decide(key, ok, note) { const i = issue(key); if (!canApprove(i)) return toast('You cannot approve this item', true); if (!note) return toast('A review reason is required', true); const st = S.issues[key]; st.status = ok ? 'approved' : 'rejected'; st.approvedBy = me().id; st.decisionNote = note; if (!ok) { st.reason = 'Rejected: ' + note; st.closedByTool = true; } hist(i, `${ok ? 'Approved' : 'Rejected'}: ${note}`); audit(`${ok ? 'Approved' : 'Rejected'}: ${i.fix ? i.fix.label : i.title}`, i.ref); saveState(); toast(ok ? 'Approved — ready to execute' : 'Rejected'); refresh(); }
function accept(key, note) { const i = issue(key); if (!(role().approve.includes(i.approval) || me().role === 'sdlead' || me().role === 'finance')) return toast('Only an approver can accept an issue as-is', true); const st = S.issues[key]; st.status = 'resolved'; st.resolvedAt = nowISO(); st.reason = 'Accepted as is: ' + note; st.closedByTool = true; hist(i, 'Accepted as is: ' + note); audit('Accepted as is', i.ref); saveState(); toast('Closed'); refresh(); }
function suggestConsultant(skill) { const load = consultantLoad(); return CONSULTANTS.filter(c => c.skills.includes(skill)).sort((a, b) => load[a.id] - load[b.id])[0] || CONSULTANTS.sort((a, b) => load[a.id] - load[b.id])[0]; }
function consultantLoad() { const l = { ...BASE_LOAD }; S.tasks.filter(t => t.status === 'open').forEach(t => { l[t.assignee] = (l[t.assignee] || 0) + 1; }); return l; }
function assign(key, cid, note) { const i = issue(key); const st = S.issues[key]; st.assignee = cid; if (st.status === 'open') st.status = 'assigned'; const title = (i.task && i.task.title) || i.title; S.tasks.unshift({ id: 'T-' + uid(), issueKey: key, title, assignee: cid, by: me().id, at: nowISO(), status: 'open', note }); hist(i, `Assigned to ${userName(cid)}${note ? ' — ' + note : ''}`); audit(`Assigned to ${userName(cid)}: ${title}`, i.ref); saveState(); toast(`Assigned to ${userName(cid)}`); refresh(); }
function taskDone(tid, note) { const t = S.tasks.find(x => x.id === tid); t.status = 'done'; t.doneAt = nowISO(); t.doneNote = note; const i = issue(t.issueKey); if (i) { hist(i, `Task completed by ${me().name}: ${note || ''}`); if (S.issues[t.issueKey].status === 'assigned') S.issues[t.issueKey].status = 'open'; } audit('Task completed: ' + t.title); saveState(); toast('Task marked done'); refresh(); }

async function execute(key, inputs = {}) {
  const i = issue(key);
  if (!i.fix) return toast('No automated fix for this issue', true);
  if (!canExecute(i)) return toast(`Your role cannot execute ${i.execRole} actions`, true);
  if (needsApproval(i)) return toast(`${APPROVAL_LABEL[i.approval]} approval is required first`, true);
  const st = S.issues[key]; let last = null; const done = [];
  try {
    for (const step of i.fix.steps) {
      const params = JSON.parse(JSON.stringify(step.params));
      for (const inp of [step.input, step.input2].filter(Boolean)) if (inputs[inp.name] !== undefined && inputs[inp.name] !== '') params[inp.name] = isNaN(inputs[inp.name]) ? inputs[inp.name] : Number(inputs[inp.name]);
      if (step.dynamic === 'po-lines') params.ORDER_ITEMS_IN = params.ORDER_ITEMS_IN.map(l => { if (l.MATERIAL) return l; const m = DB.KNMT.find(x => x.KUNNR === params.ORDER_HEADER_IN.KUNNR && x.KDMAT === l.KDMAT); return { ...l, MATERIAL: m ? m.MATNR : null, TARGET_QTY: l.CASES * (m ? m.UMREZ : 1) }; });
      if (step.dynamic === 'po-close' && last && last.SALESDOCUMENT) params.SALESDOCUMENT = last.SALESDOCUMENT;
      last = await SAP.call(step.fm, params); done.push(step.fm);
      hist(i, `${step.fm} → ${last.RETURN.MESSAGE}`);
    }
  } catch (e) { hist(i, `SAP error: ${e.message}`); audit(`Failed: ${i.fix.label} — ${e.message}`, i.ref); saveState(); toast('SAP: ' + e.message, true); refresh(); return; }
  await scan();
  const again = issue(key);
  if (again && isLive(again)) { S.issues[key].status = 'open'; hist(again, `Executed ${done.join(', ')}; SAP now reports: ${again.title}`); audit(`Executed: ${i.fix.label}`, i.ref); S.actions++; S.minutes += (MINUTES_SAVED[i.minutes] || 5); toast(`Done — next step: ${again.fix ? again.fix.label : 'review'}`); }
  else { const st2 = S.issues[key]; st2.status = 'resolved'; st2.resolvedAt = nowISO(); st2.reason = 'Fixed from here: ' + i.fix.label; st2.closedByTool = true; st2.history.push({ at: nowISO(), who: 'Scanner', what: 'Verified in SAP — issue cleared' }); S.actions++; S.minutes += (MINUTES_SAVED[i.minutes] || 5); audit(`Executed and verified: ${i.fix.label}`, i.ref); toast(`Done and verified in SAP${last && last.SALESDOCUMENT ? ' — order ' + last.SALESDOCUMENT : last && last.DELIVERY ? ' — delivery ' + last.DELIVERY : last && last.SUCCESS ? ' — invoice ' + last.SUCCESS.join(', ') : ''}`); }
  saveState(); closeDrawer(); refresh();
}
async function bulkExecute(keys) { for (const k of keys) { const i = issue(k); if (i && i.fix && !needsApproval(i) && canExecute(i)) await execute(k); } }

/* ---------- rendering ---------- */
function refresh() { if (!S.user) return renderLogin(); document.documentElement.setAttribute('data-theme', S.theme); render(); }
function toast(msg, isErr = false) { const t = document.createElement('div'); t.className = 'toast' + (isErr ? ' err' : ''); t.textContent = msg; $('#toasts').appendChild(t); setTimeout(() => t.remove(), 3800); }

function renderLogin() {
  $('#app').innerHTML = `<div class="login"><div class="box"><div class="logo"><span class="mark">Infra<span>Beat</span></span><div><div class="co">InfraBeat Technologies Pvt. Ltd.</div><div class="sub">SD operations agent</div></div></div>
  <h1 style="margin-top:18px">Sign in</h1><p class="mute small" style="margin:0 0 6px">Pick a user to see the workspace from that role. Approvals and execution rights follow the role.</p>
  <div class="users">${USERS.map(u => `<button onclick="signIn('${u.id}')"><span class="avatar">${u.name.split(' ').map(x => x[0]).join('')}</span><span><div class="nm">${u.name}</div><div class="rl">${u.title} · ${ROLES[u.role].approve.length ? 'approves ' + ROLES[u.role].approve.join(', ') : 'no approvals'}</div></span></button>`).join('')}</div>
  <p class="tiny mute" style="margin:16px 0 0">Demo build on synthetic SAP tables · connects to a live system through the RFC backend (see Data &amp; connections).</p></div></div>`;
}
async function signIn(id) { S.user = USERS.find(u => u.id === id); S.tab = 'overview'; audit('Signed in'); saveState(); await scan(); refresh(); }
function signOut() { audit('Signed out'); S.user = null; saveState(); closeDrawer(); refresh(); }

function render() {
  syncIssues();
  const counts = {}; Object.keys(MODULES).forEach(m => counts[m] = live(m).length);
  counts.approvals = ISSUES.filter(i => i.status === 'pending' && inOrg(i)).length; counts.tasks = S.tasks.filter(t => t.status === 'open').length;
  const tabs = Object.entries(MODULES).map(([k, m]) => `<button class="tab ${S.tab === k ? 'active' : ''}" onclick="go('${k}')">${ICONS[m.icon]}${m.label}${counts[k] ? `<span class="badge ${['tracker', 'billing', 'credit', 'accounting'].includes(k) && counts[k] ? 'r' : ''}">${counts[k]}</span>` : ''}</button>`).join('');
  $('#app').innerHTML = `
  <header class="top"><div class="logo"><span class="mark">Infra<span>Beat</span></span><div><div class="co">InfraBeat Technologies Pvt. Ltd.</div><div class="sub">SD operations agent</div></div></div>
    <div class="right row">
      <select class="pill" onchange="S.vkorg=this.value;saveState();refresh()">${['all', ...DB.TVKO.map(o => o.VKORG)].map(v => `<option value="${v}" ${S.vkorg === v ? 'selected' : ''}>${v === 'all' ? 'All sales orgs' : v + ' · ' + orgName(v)}</option>`).join('')}</select>
      <button class="pill" onclick="S.theme=S.theme==='light'?'dark':'light';saveState();refresh()">${S.theme === 'light' ? ICONS.moon : ICONS.sun}${S.theme === 'light' ? 'Light' : 'Dark'}</button>
      <button class="pill ask" onclick="openChat()">${ICONS.spark}Ask</button>
      <button class="pill" onclick="signOut()">${ICONS.out}Sign out</button>
      <button class="pill" style="border:0" onclick="go('data')"><span class="avatar">${me().name.split(' ').map(x => x[0]).join('')}</span>${me().name.split(' ')[0]} ${me().name.split(' ')[1][0]} ${ICONS.chev}</button>
    </div></header>
  <nav class="tabs">${tabs}</nav>
  <main class="main" id="main"></main>
  <div class="footer">Synthetic demo data · snapshot ${dmy(TODAY)} 2026 · last SAP scan ${S.scannedAt ? new Date(S.scannedAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : '—'} · SAP mode: ${SAP.mode}</div>`;
  $$('.tab .ic, .tab svg').forEach(s => { s.setAttribute('class', 'ic'); });
  const page = { overview: renderOverview, approvals: renderApprovals, tasks: renderTasks, data: renderData }[S.tab] || (() => renderModule(S.tab));
  $('#main').innerHTML = page();
}
function go(tab) { S.tab = tab; S.filter = 'open'; S.q = ''; saveState(); render(); window.scrollTo(0, 0); }

/* ---------- overview ---------- */
function renderOverview() {
  const mine = live(); const h = new Date().getHours(); const greet = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  const unbilled = sumBy(live('billing'), i => i.value); const credit = live('credit'); const outs = live('output'); const pos = live('po'); const acc = live('accounting'); const pend = ISSUES.filter(i => i.status === 'pending' && canApprove(i) && inOrg(i));
  const biggest = [...pos].sort((a, b) => b.value - a.value)[0];
  const top3 = [...mine].filter(i => i.severity === 'r').sort((a, b) => b.value - a.value).slice(0, 3);
  const quick = mine.filter(i => i.fix && !needsApproval(i) && canExecute(i) && !i.fix.steps.some(s => s.input && s.input.default === '')).sort((a, b) => b.value - a.value);
  const load = consultantLoad();
  const tilesHTML = ['tracker', 'billing', 'delivery', 'output', 'po', 'credit', 'accounting', 'pricing'].map(m => { const M = MODULES[m]; const L = live(m); const v = sumBy(L, i => i.value); const col = { r: 'var(--red)', a: 'var(--amber)', b: 'var(--blue)', g: 'var(--green)' }[L.length ? M.color : 'g'];
    const s2 = { tracker: `${L.filter(i => i.catalogId === 'SD-01').length} blocked · ${L.filter(i => i.catalogId === 'SD-03').length} short`, billing: `${L.filter(i => !i.approval).length} can be billed now`, delivery: `${L.filter(i => i.catalogId === 'SD-21').length} waiting for PGI`, output: `${L.filter(i => i.catalogId === 'SD-31').length} IDoc · ${L.filter(i => i.catalogId === 'SD-32').length} IRN`, po: `${L.filter(i => i.severity === 'g').length} ready in one click`, credit: `${L.filter(i => i.recommend === 'release').length} recommended for release`, accounting: `${L.filter(i => i.configOpen).length} need config fix`, pricing: `${L.filter(i => i.catalogId === 'SD-70').length} without price` }[m];
    return `<div class="tile" onclick="go('${m}')"><span class="ic ${L.length ? M.color : 'g'}">${ICONS[M.icon]}</span><div class="lbl">${M.tile}</div><div class="num">${L.length}</div><div class="s1">${v ? inr(v) : L.length ? '—' : 'nothing open'}</div><div class="s2" style="color:${col}">${L.length ? s2 : 'all clear'}</div>${sparkSVG(m + L.length, col)}</div>`; }).join('');
  return `
  <section class="hero"><div>
    <span class="stamp"><i></i>Checked at ${new Date(S.scannedAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })} · ${CATALOG.length} checks across VBAK, LIKP, VBRK, NAST, EDIDC, KNKK</span>
    <h1>${greet}, ${me().name.split(' ')[0]}. ${mine.length} SD issue${mine.length === 1 ? '' : 's'} waiting for you${pend.length ? `, ${pend.length} need your approval` : ''}</h1>
    <p>${inr(unbilled)} is delivered but not billed. ${credit.length} order${credit.length === 1 ? ' sits' : 's sit'} on credit block worth ${inr(sumBy(credit, i => i.value))}. ${outs.length} output${outs.length === 1 ? '' : 's'}/IDocs failed. ${acc.length} invoice${acc.length === 1 ? '' : 's'} did not post to FI. ${pos.length} customer PO${pos.length === 1 ? '' : 's'} waiting to be captured${biggest ? `, the largest worth ${inr(biggest.value)}` : ''}.</p>
    <div class="top3">${top3.map((i, k) => `<button onclick="openIssue('${i.key}')"><span class="n ${['', 'a', 'b'][k]}">${k + 1}</span><span><div class="t">${esc(i.ref)} · ${inr(i.value)}</div><div class="d">${esc(custName(i.kunnr))} · ${esc(MODULES[i.module].label.toLowerCase())} · ${hoursAgo(i.createdAt)} old</div></span></button>`).join('')}</div>
  </div><div class="ring">${ringSVG(S.actions)}<div><div class="k">${S.actions} action${S.actions === 1 ? '' : 's'}</div><div class="l">done from here today instead of in SAP · ~${S.minutes} min saved</div><a href="#" onclick="go('data');return false">See everything you did</a></div></div></section>
  <div class="tiles">${tilesHTML}</div>
  <div class="grid2">
    <div class="card"><div class="hd"><span class="ic">${ICONS.check}</span><div><h3>${pend.length ? 'Waiting for your approval' : 'Ready to fix in one click'}</h3><div class="sub">${pend.length ? 'review the evidence, then approve or reject with a reason' : 'no approval needed for these — the fix runs through the standard BAPI and is verified afterwards'}</div></div>${!pend.length && quick.length > 1 ? `<button class="btn p s right" onclick="bulkExecute(${JSON.stringify(quick.slice(0, 6).map(i => i.key)).replace(/"/g, '&quot;')})">Fix all ${Math.min(6, quick.length)}</button>` : ''}</div>
      ${(pend.length ? pend : quick).length ? `<table class="t"><thead><tr><th>Document</th><th>Issue</th><th class="r">Value</th><th>Waiting</th><th></th></tr></thead><tbody>${(pend.length ? pend : quick).slice(0, 8).map(i => `<tr class="click" onclick="openIssue('${i.key}')"><td><div class="k">${esc(i.ref)}</div><div class="k2">${esc(custName(i.kunnr))}</div></td><td><div>${esc(i.fix ? i.fix.label : i.title)}</div><div class="k2">${esc(MODULES[i.module].label)}${i.proposedBy ? ' · by ' + esc(userName(i.proposedBy)) : ''}</div></td><td class="r b">${i.value ? inr(i.value) : '—'}</td><td><span class="tag ${hoursAgo(i.createdAt).endsWith('d') ? '' : 'a'}">${hoursAgo(i.createdAt)}</span></td><td><button class="btn s ${pend.length ? '' : 'p'}" onclick="event.stopPropagation();${pend.length ? `openIssue('${i.key}')` : `execute('${i.key}')`}">${pend.length ? 'Review' : 'Fix now'}</button></td></tr>`).join('')}</tbody></table>` : `<div class="empty"><b>Nothing waiting</b>All issues need either a decision or a consultant.</div>`}
    </div>
    <div class="card"><div class="hd"><span class="ic" style="background:var(--red-bg);color:var(--red)">${ICONS.warn}</span><div><h3>Problems found</h3><div class="sub">most urgent first · ${mine.length} open</div></div></div>
      <ul class="list">${[...mine].sort((a, b) => (a.severity === 'r' ? 0 : 1) - (b.severity === 'r' ? 0 : 1) || b.value - a.value).slice(0, 6).map((i, k) => `<li style="cursor:pointer" onclick="openIssue('${i.key}')"><span class="n ${i.severity === 'r' ? '' : 'a'}">${k + 1}</span><span class="grow"><div class="t">${esc(i.title)}</div><div class="d">${esc(i.detail)}</div></span>${i.fix ? `<span class="tag ${i.severity === 'r' ? '' : 'a'}" style="flex:none">${needsApproval(i) ? 'needs ' + APPROVAL_LABEL[i.approval].split(' ')[0] : 'I can fix'}</span>` : `<span class="chip" style="flex:none">consultant</span>`}</li>`).join('')}</ul>
    </div>
  </div>
  <div class="grid2" style="grid-template-columns:1fr 1.35fr">
    <div class="card"><div class="hd"><span class="ic" style="background:var(--blue-bg);color:var(--blue)">${ICONS.users}</span><div><h3>Consultant load</h3><div class="sub">open tasks per consultant · suggestions use skill + load</div></div></div><div class="bd">${CONSULTANTS.map(c => `<div style="margin-bottom:10px"><div class="row"><b>${c.name}</b><span class="mute small">${c.skills.join(', ')}</span><span class="right b">${load[c.id]} / ${c.capacity}</span></div><div class="bar"><i class="${load[c.id] >= c.capacity ? '' : load[c.id] >= c.capacity * .7 ? 'a' : 'b'}" style="width:${Math.min(100, load[c.id] / c.capacity * 100)}%"></i></div></div>`).join('')}</div></div>
    <div class="card"><div class="hd"><span class="ic" style="background:var(--green-bg);color:var(--green)">${ICONS.clock}</span><div><h3>Done from here</h3><div class="sub">actions executed through the tool and verified in SAP</div></div></div><div class="bd">${S.audit.filter(a => /Executed|Approved|Assigned|Rejected|Accepted/.test(a.what)).slice(0, 6).map(a => `<div class="row" style="padding:6px 0;border-bottom:1px solid var(--line2)"><span class="mute small" style="width:70px">${hoursAgo(a.at)}</span><span class="grow">${esc(a.what)}${a.ref ? ` <span class="chip">${esc(a.ref)}</span>` : ''}</span><span class="mute small">${esc(a.who)}</span></div>`).join('') || '<div class="empty"><b>Nothing yet</b>Fix an issue and it shows here with the SAP result.</div>'}</div></div>
  </div>`;
}
function ringSVG(k) { const pct = Math.min(100, k * 10); const r = 38, c = 2 * Math.PI * r; return `<svg viewBox="0 0 92 92"><circle cx="46" cy="46" r="${r}" fill="none" stroke="rgba(255,255,255,.15)" stroke-width="7"/><circle cx="46" cy="46" r="${r}" fill="none" stroke="#4dd6a8" stroke-width="7" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - pct / 100)}" stroke-linecap="round" transform="rotate(-90 46 46)"/><text x="46" y="50" text-anchor="middle" fill="#fff" font-size="12" font-weight="700">${S.minutes} min</text></svg>`; }

/* ---------- module pages ---------- */
const FILTERS = [['open', 'Open'], ['pending', 'Pending approval'], ['assigned', 'Assigned'], ['resolved', 'Resolved'], ['all', 'All']];
function listFor(mod) { let L = ISSUES.filter(i => i.module === mod && inOrg(i)); if (S.filter === 'open') L = L.filter(i => isLive(i)); else if (S.filter !== 'all') L = L.filter(i => i.status === S.filter || (S.filter === 'resolved' && i.status === 'rejected')); if (S.q) { const q = S.q.toLowerCase(); L = L.filter(i => [i.ref, i.title, i.detail, custName(i.kunnr)].join(' ').toLowerCase().includes(q)); } return L.sort((a, b) => (a.severity === 'r' ? 0 : 1) - (b.severity === 'r' ? 0 : 1) || b.value - a.value); }
function signal(i) {
  switch (i.module) {
    case 'tracker': return i.catalogId === 'SD-01' ? `<span class="chip r">Delivery block</span>` : i.catalogId === 'SD-02' ? `<span class="chip a">Incomplete</span>` : `<span class="chip a">Qty short</span>`;
    case 'billing': return i.approval ? `<span class="chip r">Billing block</span>` : `<span class="chip g">Clean — bill now</span>`;
    case 'delivery': return i.catalogId === 'SD-21' ? (i.severity === 'r' ? `<span class="chip r">PGI failed</span>` : `<span class="chip a">PGI pending</span>`) : (i.approval ? `<span class="chip a">Partial</span>` : `<span class="chip g">Create delivery</span>`);
    case 'output': return `<span class="chip ${i.catalogId === 'SD-30' ? 'a' : 'r'}">${{ 'SD-30': 'Output', 'SD-31': 'IDoc', 'SD-32': 'e-Invoice' }[i.catalogId]}</span>`;
    case 'po': return i.severity === 'g' ? `<span class="chip g">Ready</span>` : i.severity === 'a' ? `<span class="chip a">Mapping needed</span>` : `<span class="chip r">Duplicate</span>`;
    case 'credit': return i.recommend === 'release' ? `<span class="chip g">Recommend release</span>` : `<span class="chip r">Recommend hold</span>`;
    case 'accounting': return i.catalogId === 'SD-61' ? `<span class="chip a">SD–FI mismatch</span>` : i.configOpen ? `<span class="chip r">Config fix</span>` : `<span class="chip g">Ready to release</span>`;
    case 'pricing': return i.catalogId === 'SD-70' ? `<span class="chip r">No price</span>` : `<span class="chip a">Manual discount</span>`;
  } return '';
}
function statusChip(i) { return { open: '<span class="chip">Open</span>', pending: '<span class="chip a">Pending approval</span>', approved: '<span class="chip b">Approved</span>', assigned: `<span class="chip p">Assigned · ${esc(userName(i.assignee || ''))}</span>`, resolved: '<span class="chip g">Resolved</span>', rejected: '<span class="chip r">Rejected</span>' }[i.status] || ''; }
function actionButton(i) {
  if (!isLive(i)) return '';
  if (i.status === 'pending') return canApprove(i) ? `<button class="btn s p" onclick="event.stopPropagation();openIssue('${i.key}')">Review</button>` : `<span class="mute small">with ${APPROVAL_LABEL[i.approval]}</span>`;
  if (!i.fix) return `<button class="btn s" onclick="event.stopPropagation();openIssue('${i.key}')">${i.assignee ? 'Open' : 'Assign'}</button>`;
  if (needsApproval(i)) return `<button class="btn s" onclick="event.stopPropagation();openIssue('${i.key}')">Propose</button>`;
  const needsInput = i.fix.steps.some(s => s.input && s.input.default === '');
  return canExecute(i) ? `<button class="btn s p" onclick="event.stopPropagation();${needsInput ? `openIssue('${i.key}')` : `execute('${i.key}')`}">${esc(i.fix.label.split(' and ')[0])}</button>` : `<button class="btn s" onclick="event.stopPropagation();openIssue('${i.key}')">Open</button>`;
}
function renderModule(mod) {
  const M = MODULES[mod]; const L = listFor(mod); const all = ISSUES.filter(i => i.module === mod && inOrg(i));
  const quick = L.filter(i => i.fix && !needsApproval(i) && canExecute(i) && !i.fix.steps.some(s => s.input && s.input.default === ''));
  const extra = mod === 'tracker' ? `<div class="card" style="margin-bottom:14px"><div class="bd row wrap"><div class="search grow">${ICONS.search}<input id="trk" placeholder="Order, delivery, invoice, customer PO or customer name — e.g. 50001291 or Aster" onkeydown="if(event.key==='Enter')track()"></div><button class="btn p" onclick="track()">Track</button><span class="mute small">Answers "where is my order" with the full document flow — VBAK → LIKP → VBRK → FI — and explains any block in plain words.</span></div></div>` : mod === 'credit' ? renderCreditPanel() : '';
  return `<div class="ph"><div><h2>${M.label}</h2><div class="sub">${M.sub}</div></div><div class="right toolbar"><div class="search">${ICONS.search}<input placeholder="Filter…" value="${esc(S.q)}" oninput="S.q=this.value;render();const e=document.querySelector('.search input');e.focus();e.setSelectionRange(e.value.length,e.value.length)"></div><div class="seg">${FILTERS.map(([k, l]) => `<button class="${S.filter === k ? 'on' : ''}" onclick="S.filter='${k}';render()">${l}${k === 'open' ? ` (${all.filter(isLive).length})` : ''}</button>`).join('')}</div>${quick.length > 1 ? `<button class="btn p" onclick="bulkExecute(${JSON.stringify(quick.map(i => i.key)).replace(/"/g, '&quot;')})">Fix all ${quick.length} clean</button>` : ''}</div></div>
  ${extra}
  <div class="card">${L.length ? `<table class="t"><thead><tr><th>Document</th><th>Signal</th><th>Issue</th><th class="r">Value</th><th>Age</th><th>Status</th><th></th></tr></thead><tbody>${L.map(i => `<tr class="click" onclick="openIssue('${i.key}')"><td><div class="k">${esc(i.ref)}</div><div class="k2">${esc(custName(i.kunnr))}${i.order ? ' · order ' + esc(i.order) : ''}</div></td><td>${signal(i)}</td><td><div>${esc(i.title)}</div><div class="k2">${esc(i.detail)}</div></td><td class="r b">${i.value ? inr(i.value) : '—'}</td><td class="mute small">${hoursAgo(i.createdAt)}</td><td>${statusChip(i)}</td><td>${actionButton(i)}</td></tr>`).join('')}</tbody></table>` : `<div class="empty"><b>Nothing ${S.filter === 'open' ? 'open' : 'here'}</b>${S.filter === 'open' ? 'SAP reports no ' + M.label.toLowerCase() + ' issues for the selected sales organisations.' : 'Try another filter.'}</div>`}</div>`;
}
function renderCreditPanel() { const rows = DB.KNKK.filter(c => S.vkorg === 'all' || (DB.KNVV.find(k => k.KUNNR === c.KUNNR) || {}).VKORG === S.vkorg); return `<div class="card" style="margin-bottom:14px"><div class="hd"><span class="ic" style="background:var(--blue-bg);color:var(--blue)">${ICONS.card}</span><div><h3>Credit exposure by customer</h3><div class="sub">KNKK / FSCM — limit utilisation and overdue; blocked orders are listed below</div></div></div><div class="bd" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:10px 24px">${rows.map(c => { const u = c.SKFOR / c.KLIMK * 100; return `<div><div class="row"><b>${esc(custName(c.KUNNR))}</b><span class="right small ${u > 100 ? 'red b' : u > 85 ? 'amber b' : 'mute'}">${u.toFixed(0)}%</span></div><div class="bar"><i class="${u > 100 ? '' : u > 85 ? 'a' : 'g'}" style="width:${Math.min(100, u)}%"></i></div><div class="tiny mute">exposure ${inr(c.SKFOR)} of ${inr(c.KLIMK)}${c.OVERDUE ? ` · <span class="red">overdue ${inr(c.OVERDUE)} (${c.DPD} d)</span>` : ' · nothing overdue'}</div></div>`; }).join('')}</div></div>`; }

/* ---------- approvals / tasks / data ---------- */
function renderApprovals() {
  const pend = ISSUES.filter(i => i.status === 'pending' && inOrg(i)); const mine = pend.filter(canApprove); const done = ISSUES.filter(i => ['approved', 'rejected'].includes(i.status) || (i.status === 'resolved' && i.approvedBy)).filter(inOrg);
  const tbl = (L, empty) => L.length ? `<table class="t"><thead><tr><th>Document</th><th>Proposed action</th><th>Module</th><th class="r">Value</th><th>Proposed by</th><th>Status</th><th></th></tr></thead><tbody>${L.map(i => `<tr class="click" onclick="openIssue('${i.key}')"><td><div class="k">${esc(i.ref)}</div><div class="k2">${esc(custName(i.kunnr))}</div></td><td><div>${esc(i.fix ? i.fix.label : i.title)}</div><div class="k2">${esc(i.title)}</div></td><td>${esc(MODULES[i.module].label)}</td><td class="r b">${i.value ? inr(i.value) : '—'}</td><td>${esc(userName(i.proposedBy || ''))}<div class="k2">${i.proposedAt ? hoursAgo(i.proposedAt) + ' ago' : ''}</div></td><td>${statusChip(i)}</td><td>${canApprove(i) && i.status === 'pending' ? `<button class="btn s p" onclick="event.stopPropagation();openIssue('${i.key}')">Review</button>` : ''}</td></tr>`).join('')}</tbody></table>` : `<div class="empty"><b>${empty}</b></div>`;
  return `<div class="ph"><div><h2>Approvals</h2><div class="sub">Maker–checker: the person who proposes cannot approve. Every decision needs a reason and is written to the audit log.</div></div></div>
  <div class="card"><div class="hd"><h3>Waiting for ${me().name.split(' ')[0]}</h3><span class="badge ${mine.length ? 'r' : ''}">${mine.length}</span></div>${tbl(mine, 'Nothing for you to approve')}</div>
  <div class="card" style="margin-top:14px"><div class="hd"><h3>All pending</h3><span class="badge">${pend.length}</span></div>${tbl(pend, 'No pending approvals')}</div>
  <div class="card" style="margin-top:14px"><div class="hd"><h3>Decided</h3><span class="badge">${done.length}</span></div>${tbl(done, 'No decisions yet')}</div>`;
}
function renderTasks() {
  const load = consultantLoad(); const open = S.tasks.filter(t => t.status === 'open'); const done = S.tasks.filter(t => t.status === 'done');
  const unassigned = live().filter(i => !i.fix && !i.assignee);
  const tbl = (L) => L.length ? `<table class="t"><thead><tr><th>Task</th><th>Consultant</th><th>Raised by</th><th>When</th><th>Status</th><th></th></tr></thead><tbody>${L.map(t => { const i = issue(t.issueKey); return `<tr class="click" onclick="openIssue('${t.issueKey}')"><td><div class="k">${esc(t.title)}</div><div class="k2">${i ? esc(i.ref) + ' · ' + esc(custName(i.kunnr)) : ''}${t.note ? ' · ' + esc(t.note) : ''}</div></td><td>${esc(userName(t.assignee))}</td><td>${esc(userName(t.by))}</td><td class="mute small">${hoursAgo(t.at)} ago</td><td>${t.status === 'open' ? '<span class="chip a">Open</span>' : `<span class="chip g">Done</span><div class="k2">${esc(t.doneNote || '')}</div>`}</td><td>${t.status === 'open' && (me().id === t.assignee || me().role === 'sdlead') ? `<button class="btn s" onclick="event.stopPropagation();askNote('Mark task done','What was done?',v=>taskDone('${t.id}',v))">Mark done</button>` : ''}</td></tr>`; }).join('')}</tbody></table>` : '<div class="empty"><b>No tasks</b></div>';
  return `<div class="ph"><div><h2>Team tasks</h2><div class="sub">Issues that need a consultant — assigned by skill and current load, tracked to closure</div></div></div>
  <div class="grid3" style="margin-top:0">${CONSULTANTS.map(c => `<div class="card"><div class="bd"><div class="row"><span class="avatar">${c.name.split(' ').map(x => x[0]).join('')}</span><div><b>${c.name}</b><div class="small mute">${c.skills.join(' · ')}</div></div><span class="right b" style="font-size:18px">${load[c.id]}<span class="mute small"> / ${c.capacity}</span></span></div><div class="bar"><i class="${load[c.id] >= c.capacity ? '' : load[c.id] >= c.capacity * .7 ? 'a' : 'b'}" style="width:${Math.min(100, load[c.id] / c.capacity * 100)}%"></i></div><div class="tiny mute">${BASE_LOAD[c.id]} from other tickets · ${load[c.id] - BASE_LOAD[c.id]} from this tool</div></div></div>`).join('')}</div>
  ${unassigned.length ? `<div class="card" style="margin-top:14px"><div class="hd"><span class="ic">${ICONS.warn}</span><div><h3>Needs a consultant, not yet assigned</h3><div class="sub">no automated fix exists — assign with the suggested consultant</div></div></div><table class="t"><tbody>${unassigned.map(i => { const s = suggestConsultant(i.skill); return `<tr class="click" onclick="openIssue('${i.key}')"><td><div class="k">${esc(i.ref)}</div><div class="k2">${esc(custName(i.kunnr))}</div></td><td>${esc(i.title)}</td><td class="mute small">suggest ${esc(s.name)} (${i.skill}, load ${load[s.id]})</td><td><button class="btn s p" onclick="event.stopPropagation();assign('${i.key}','${s.id}','auto-suggested by skill and load')">Assign to ${esc(s.name.split(' ')[0])}</button></td></tr>`; }).join('')}</tbody></table></div>` : ''}
  <div class="card" style="margin-top:14px"><div class="hd"><h3>Open tasks</h3><span class="badge a">${open.length}</span></div>${tbl(open)}</div>
  <div class="card" style="margin-top:14px"><div class="hd"><h3>Completed</h3><span class="badge">${done.length}</span></div>${tbl(done)}</div>`;
}
function renderData() {
  const counts = CATALOG.map(c => ({ c, n: ISSUES.filter(i => i.catalogId === c.id && isLive(i)).length }));
  return `<div class="ph"><div><h2>Data &amp; connections</h2><div class="sub">How the tool reads and writes SAP, what it checked, and everything that was done from here</div></div></div>
  <div class="grid2" style="margin-top:0;grid-template-columns:1fr 1fr">
    <div class="card"><div class="hd"><span class="ic" style="background:var(--blue-bg);color:var(--blue)">${ICONS.db}</span><div><h3>SAP connection</h3><div class="sub">same adapter, two modes</div></div></div><div class="bd">
      <div class="seg"><button class="${SAP.mode === 'mock' ? 'on' : ''}" onclick="SAP.mode='mock';toast('Mock mode — embedded tables');render()">Embedded demo tables</button><button class="${SAP.mode === 'rfc' ? 'on' : ''}" onclick="SAP.mode='rfc';toast('RFC mode — calls the Python backend at '+SAP.endpoint);render()">Live SAP via RFC backend</button></div>
      <div class="row" style="margin-top:10px"><span class="mute small" style="width:70px">Endpoint</span><input class="grow mono" value="${esc(SAP.endpoint)}" onchange="SAP.endpoint=this.value"></div>
      <div class="note" style="margin-top:12px">In RFC mode every <span class="mono">SAP.read(table, where)</span> becomes <span class="mono">RFC_READ_TABLE</span> (or a Z-RFC join) and every <span class="mono">SAP.call(fm, params)</span> becomes a <span class="mono">pyrfc</span> call to the same function module, followed by <span class="mono">BAPI_TRANSACTION_COMMIT</span>. The backend skeleton is in <span class="mono">backend/</span>. The UI code does not change.</div>
      <div class="row" style="margin-top:10px"><button class="btn" onclick="scan().then(()=>{toast('Re-scanned');render()})">Re-run all checks now</button><button class="btn" onclick="if(confirm('Reset the demo tables and all workflow state?')){resetDB();S={...S,issues:{},tasks:[],audit:[],actions:0,minutes:0};saveState();scan().then(()=>{toast('Demo reset');render()})}">Reset demo data</button></div>
      <div class="row" style="margin-top:10px"><span class="mute small" style="width:70px">Copilot LLM</span><input class="grow mono" placeholder="optional: https://…/answer (POST {question, context})" value="${esc(LLM.endpoint)}" onchange="LLM.endpoint=this.value"></div>
    </div></div>
    <div class="card"><div class="hd"><h3>Checks in the catalog</h3><div class="sub">${CATALOG.length} detections · last run ${new Date(S.scannedAt).toLocaleTimeString('en-IN')}</div></div><table class="t"><thead><tr><th>ID</th><th>Check</th><th>Fix via</th><th>Approval</th><th class="r">Open</th></tr></thead><tbody>${counts.map(({ c, n }) => `<tr><td class="mono">${c.id}</td><td>${esc(c.title)}<div class="k2">${esc(MODULES[c.module].label)}</div></td><td class="small">${esc(c.execRole)}</td><td class="small">${c.approval ? APPROVAL_LABEL[c.approval] : '—'}</td><td class="r b">${n}</td></tr>`).join('')}</tbody></table></div>
  </div>
  <div class="card" style="margin-top:14px"><div class="hd"><h3>Audit log</h3><div class="sub">who did what, with the SAP result</div></div>${S.audit.length ? `<table class="t"><thead><tr><th>When</th><th>Who</th><th>What</th><th>Ref</th></tr></thead><tbody>${S.audit.slice(0, 60).map(a => `<tr><td class="mute small">${new Date(a.at).toLocaleString('en-IN')}</td><td>${esc(a.who)}</td><td>${esc(a.what)}</td><td class="mono">${esc(a.ref)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty"><b>Empty</b></div>'}</div>
  <div class="card" style="margin-top:14px"><div class="hd"><h3>SAP call log</h3><div class="sub">last ${Math.min(60, SAP.log.length)} reads and function-module calls</div></div>${SAP.log.length ? `<table class="t"><thead><tr><th>Kind</th><th>Name</th><th>Params</th><th>Result</th><th class="r">ms</th></tr></thead><tbody>${SAP.log.slice(0, 60).map(l => `<tr><td><span class="chip ${l.kind === 'CALL' ? 'b' : ''}">${l.kind}</span></td><td class="mono">${esc(l.name)}</td><td class="mono tiny">${esc(l.params)}</td><td class="small">${esc(l.result)}</td><td class="r mute small">${l.ms}</td></tr>`).join('')}</tbody></table>` : ''}</div>`;
}

/* ---------- drawer: issue ---------- */
function openDrawer(html, footer = '') { $('#drawer').innerHTML = html + (footer ? `<div class="df">${footer}</div>` : ''); $('#drawer').classList.add('open'); $('#scrim').classList.add('on'); }
function closeDrawer() { $('#drawer').classList.remove('open'); $('#scrim').classList.remove('on'); DRAWER = null; }
function openIssue(key) {
  const i = issue(key); if (!i) return; DRAWER = { type: 'issue', key };
  const head = `<div class="dh"><div class="grow"><div class="row small" style="margin-bottom:4px"><span class="chip">${esc(MODULES[i.module].label)}</span>${signal(i)}${statusChip(i)}<span class="mute">${esc(i.catalogId)}</span></div><h3>${esc(i.title)}</h3><div class="mute small">${esc(i.detail)}</div></div><button class="btn s" onclick="closeDrawer()">${ICONS.x}</button></div>`;
  const inputs = i.fix ? i.fix.steps.flatMap(s => [s.input, s.input2].filter(Boolean)) : [];
  const fixCard = i.fix ? `<div class="card" style="margin-top:12px"><div class="hd"><span class="ic" style="background:var(--green-bg);color:var(--green)">${ICONS.spark}</span><div><h3>Proposed action — ${esc(i.fix.label)}</h3><div class="sub">${esc(i.fix.effect || '')}</div></div></div><div class="bd">
      <ol style="margin:0 0 8px 18px;padding:0" class="small">${i.fix.steps.map(s => `<li><span class="mono">${esc(s.fm)}</span>${s.note ? ` <span class="mute">— ${esc(s.note)}</span>` : ''}</li>`).join('')}<li><span class="mono">BAPI_TRANSACTION_COMMIT</span> <span class="mute">— then re-read and verify</span></li></ol>
      ${inputs.length ? `<div class="stack" style="margin-top:8px">${inputs.map(inp => `<label class="small"><div class="mute">${esc(inp.label)}</div><input class="mono" style="width:100%" data-inp="${esc(inp.name)}" value="${esc(inp.default)}" placeholder="${inp.default === '' ? 'required' : ''}"></label>`).join('')}</div>` : ''}
      ${needsApproval(i) ? `<div class="note a" style="margin:10px 0 0">Needs ${APPROVAL_LABEL[i.approval]} approval before it runs${i.status === 'pending' ? ` — proposed by ${esc(userName(i.proposedBy))}${i.note ? ': ' + esc(i.note) : ''}` : ''}.</div>` : i.status === 'approved' ? `<div class="note g" style="margin:10px 0 0">Approved by ${esc(userName(i.approvedBy))}: ${esc(i.decisionNote || '')}. Ready to execute.</div>` : ''}
    </div></div>` : `<div class="note a" style="margin-top:12px"><b>No automated fix.</b> This needs a person — ${i.task ? esc(i.task.title) : 'assign to a consultant'}. Suggested: ${esc(suggestConsultant(i.skill).name)} (${esc(i.skill)}).</div>`;
  const body = `<div class="db">
    ${i.explain ? `<div class="note">${esc(i.explain)}</div>` : ''}
    ${i.refType === 'order' || i.order ? `<button class="btn link small" onclick="openOrder('${i.order || i.ref}')">Open order ${esc(i.order || i.ref)} — full document flow ${ICONS.arrow}</button>` : ''}
    ${(i.evidence || []).map(e => `<div class="ev"><div class="h">${esc(e.h)}</div><pre>${esc(e.text)}</pre></div>`).join('')}
    ${fixCard}
    ${i.assignee ? `<div class="note" style="margin-top:12px">Assigned to <b>${esc(userName(i.assignee))}</b>${i.task ? ' — ' + esc(i.task.title) : ''}</div>` : ''}
    <h4 style="margin:16px 0 6px;font-size:13px">History</h4><ul class="timeline">${(i.history || []).slice().reverse().map(h => `<li><div>${esc(h.what)}</div><div class="w">${esc(h.who)} · ${new Date(h.at).toLocaleString('en-IN')}</div></li>`).join('')}</ul>
  </div>`;
  const btns = [];
  if (isLive(i)) {
    if (i.fix) {
      if (i.status === 'pending') { if (canApprove(i)) btns.push(`<button class="btn g" onclick="askNote('Approve','Review reason (required)',v=>decide('${key}',true,v))">Approve</button><button class="btn d" onclick="askNote('Reject','Reason for rejection (required)',v=>decide('${key}',false,v))">Reject</button>`); else btns.push(`<span class="mute small">Waiting for ${APPROVAL_LABEL[i.approval]}${i.proposedBy === me().id ? ' — you proposed this, so you cannot approve it' : ''}</span>`); }
      else if (needsApproval(i)) btns.push(`<button class="btn p" onclick="askNote('Send for approval','Note for the approver (optional)',v=>propose('${key}',v),false)">Send to ${APPROVAL_LABEL[i.approval]}</button>`);
      else if (canExecute(i)) btns.push(`<button class="btn p" onclick="executeFromDrawer('${key}')">${esc(i.fix.label)}</button>`);
      else btns.push(`<span class="mute small">Your role (${esc(role().title)}) cannot execute ${esc(i.execRole)} actions — assign or ask ${esc(suggestConsultant(i.skill).name)}</span>`);
      if (i.acceptable && (me().role === 'sdlead')) btns.push(`<button class="btn" onclick="askNote('Accept as is','Why is this acceptable?',v=>accept('${key}',v))">Accept as is</button>`);
    } else if (me().role === 'sdlead' || me().role === 'finance') btns.push(`<button class="btn" onclick="askNote('Close','Reason for closing without action',v=>accept('${key}',v))">Close as reviewed</button>`);
    if (!i.assignee) { const s = suggestConsultant(i.skill); btns.push(`<button class="btn" onclick="assignDialog('${key}')">Assign to consultant <span class="mute">(suggest ${esc(s.name.split(' ')[0])})</span></button>`); }
  } else btns.push(`<span class="mute small">${esc(i.reason || 'Closed')}</span>`);
  openDrawer(head + body, btns.join(''));
}
function executeFromDrawer(key) { const inputs = {}; $$('#drawer [data-inp]').forEach(e => inputs[e.dataset.inp] = e.value.trim()); const i = issue(key); const missing = i.fix.steps.flatMap(s => [s.input, s.input2].filter(Boolean)).find(inp => inp.default === '' && !inputs[inp.name]); if (missing) return toast(`${missing.label} is required`, true); execute(key, inputs); }
function assignDialog(key) { const i = issue(key); const load = consultantLoad(); const s = suggestConsultant(i.skill); modal('Assign to consultant', `<p class="small mute" style="margin:0 0 10px">Suggested by skill <b>${esc(i.skill)}</b> and current load.</p><div class="users">${CONSULTANTS.map(c => `<button onclick="assign('${key}','${c.id}',document.getElementById('asgNote').value);closeModal()"><span class="avatar">${c.name.split(' ').map(x => x[0]).join('')}</span><span class="grow"><div class="nm">${c.name} ${c.id === s.id ? '<span class="chip g">suggested</span>' : ''}</div><div class="rl">${c.skills.join(', ')} · load ${load[c.id]} / ${c.capacity}</div></span></button>`).join('')}</div><label class="small" style="display:block;margin-top:10px"><div class="mute">Note</div><input id="asgNote" style="width:100%" placeholder="context for the consultant"></label>`, ''); }

/* ---------- drawer: order 360 ---------- */
function track() { const q = ($('#trk').value || '').trim(); if (!q) return; const up = q.toUpperCase(); let o = DB.VBAK.find(v => v.VBELN === q || v.BSTNK.toUpperCase() === up); if (!o) { const d = DB.LIKP.find(x => x.VBELN === q); if (d) o = DB.VBAK.find(v => v.VBELN === (DB.LIPS.find(l => l.VBELN === d.VBELN) || {}).VGBEL); } if (!o) { const inv = DB.VBRP.find(x => x.VBELN === q); if (inv) o = DB.VBAK.find(v => v.VBELN === inv.AUBEL); } if (!o) { const k = DB.KNA1.find(c => c.NAME1.toLowerCase().includes(q.toLowerCase())); if (k) return openCustomer(k.KUNNR); } if (!o) return toast('Nothing found for ' + q, true); openOrder(o.VBELN); }
function orderFlow(o) {
  const items = DB.VBAP.filter(i => i.VBELN === o.VBELN); const eps = DB.VBEP.filter(e => e.VBELN === o.VBELN); const conf = sumBy(eps, e => e.BMENG), ord = sumBy(eps, e => e.WMENG);
  const dl = DB.LIPS.filter(l => l.VGBEL === o.VBELN); const dlv = [...new Set(dl.map(l => l.VBELN))].map(v => DB.LIKP.find(h => h.VBELN === v)); const inv = [...new Set(DB.VBRP.filter(b => b.AUBEL === o.VBELN).map(b => b.VBELN))].map(v => DB.VBRK.find(h => h.VBELN === v));
  const blocks = []; if (o.LIFSK) blocks.push(`delivery block ${o.LIFSK} (${blockText('TVLST', o.LIFSK, 'LIFSP')})`); if (o.FAKSK) blocks.push(`billing block ${o.FAKSK} (${blockText('TVFST', o.FAKSK, 'FAKSP')})`); if (o.CMGST === 'B') blocks.push('credit block (dynamic credit check)'); if (DB.VBUV.some(v => v.VBELN === o.VBELN)) blocks.push('incomplete (' + DB.VBUV.filter(v => v.VBELN === o.VBELN).map(v => v.FDTXT).join(', ') + ')');
  const st = [
    { l: 'Order', v: o.VBELN, m: `${dmy(o.ERDAT)} · ${inr(o.NETWR)}`, c: blocks.length ? 'bad' : 'ok' },
    { l: 'Confirmed', v: `${n(conf)} / ${n(ord)} EA`, m: conf < ord ? `${n(ord - conf)} short` : 'fully confirmed', c: conf === 0 ? 'bad' : conf < ord ? 'warn' : 'ok' },
    { l: 'Delivery', v: dlv.length ? dlv.map(d => d.VBELN).join(', ') : '—', m: dlv.length ? dmy(dlv[0].LFDAT) : (blocks.length ? 'blocked' : 'not created'), c: dlv.length ? 'ok' : blocks.length ? 'bad' : 'todo' },
    { l: 'Goods issue', v: dlv.length ? (dlv.every(d => d.WBSTK === 'C') ? 'posted' : 'pending') : '—', m: dlv.length ? (dlv[0].WADAT_IST ? dmy(dlv[0].WADAT_IST) : dlv[0].PGI_ERR ? 'failed' : 'picked') : '', c: !dlv.length ? 'todo' : dlv.every(d => d.WBSTK === 'C') ? 'ok' : dlv.some(d => d.PGI_ERR) ? 'bad' : 'warn' },
    { l: 'Invoice', v: inv.length ? inv.map(i => i.VBELN).join(', ') : '—', m: inv.length ? dmy(inv[0].FKDAT) + ' · ' + inr(sumBy(inv, i => i.NETWR)) : dlv.some(d => d.WBSTK === 'C') ? (o.FAKSK ? 'billing blocked' : 'due for billing') : '', c: inv.length ? 'ok' : dlv.some(d => d.WBSTK === 'C') ? (o.FAKSK ? 'bad' : 'warn') : 'todo' },
    { l: 'Accounting', v: inv.length ? (inv.every(i => i.RFBSK === 'C') ? inv.map(i => i.BELNR).join(', ') : 'not posted') : '—', m: inv.length ? (inv.every(i => i.RFBSK === 'C') ? 'FI document' : 'posting error') : '', c: !inv.length ? 'todo' : inv.every(i => i.RFBSK === 'C') ? 'ok' : 'bad' },
    { l: 'Output / IRN', v: inv.length ? ((DB.NAST.find(x => x.OBJKY === inv[0].VBELN) || {}).VSTAT === '1' ? 'sent' : 'failed') : (DB.NAST.find(x => x.OBJKY === o.VBELN && x.VSTAT === '2') ? 'order conf. failed' : '—'), m: inv.length ? 'IRN ' + ((DB.EINV.find(e => e.VBELN === inv[0].VBELN) || {}).IRN_STATUS || '—').toLowerCase() : '', c: inv.length ? ((DB.NAST.find(x => x.OBJKY === inv[0].VBELN) || {}).VSTAT === '1' && (DB.EINV.find(e => e.VBELN === inv[0].VBELN) || {}).IRN_STATUS !== 'REJECTED' ? 'ok' : 'bad') : DB.NAST.find(x => x.OBJKY === o.VBELN && x.VSTAT === '2') ? 'bad' : 'todo' },
  ];
  return { items, eps, conf, ord, dlv, inv, blocks, st };
}
function relatedToOrder(i, vbeln) { if (i.ref === vbeln || i.order === vbeln) return true; const dl = DB.LIPS.filter(l => l.VGBEL === vbeln).map(l => l.VBELN); const inv = DB.VBRP.filter(b => b.AUBEL === vbeln).map(b => b.VBELN); const idoc = DB.EDIDC.filter(d => inv.includes(d.OBJKY)).map(d => d.DOCNUM); return [...dl, ...inv, ...idoc].includes(i.ref); }
function orderNarrative(o) {
  const f = orderFlow(o); const k = custName(o.KUNNR); let s = `Order ${o.VBELN} for ${k} (${inr(o.NETWR)}, customer PO ${o.BSTNK}) was created on ${dmy(o.ERDAT)} for delivery by ${dmy(o.VDATU)}. `;
  if (f.blocks.length) s += `It is currently held: ${f.blocks.join('; ')}. `;
  if (f.conf < f.ord) s += `Only ${n(f.conf)} of ${n(f.ord)} EA are confirmed. `;
  if (!f.dlv.length) s += f.blocks.length ? `No delivery can be created until the block is cleared.` : f.conf ? `No delivery has been created yet.` : '';
  else { const d = f.dlv[0]; s += `Delivery ${d.VBELN} was created on ${dmy(d.ERDAT)}; goods issue ${d.WBSTK === 'C' ? `posted on ${dmy(d.WADAT_IST)}` : d.PGI_ERR ? `FAILED (${d.PGI_ERR.split('—')[0].trim()})` : 'is still pending'}. `;
    if (f.inv.length) { const i = f.inv[0]; s += `Invoice ${i.VBELN} (${inr(i.NETWR)} + tax) dated ${dmy(i.FKDAT)} ${i.RFBSK === 'C' ? `is posted to accounting as ${i.BELNR}` : `has NOT posted to accounting: ${i.ACC_ERR.split('—')[0]}`}. `; const nast = DB.NAST.find(x => x.OBJKY === i.VBELN); const ei = DB.EINV.find(e => e.VBELN === i.VBELN); if (nast && nast.VSTAT === '2') s += `The invoice output failed (${nast.ERRTXT.split(':')[0]}). `; if (ei && ei.IRN_STATUS === 'REJECTED') s += `The e-invoice IRN was rejected (${ei.ERRCODE}). `; }
    else if (d.WBSTK === 'C') s += o.FAKSK ? `It cannot be billed because of the billing block.` : `It is due for billing but no invoice exists yet.`; }
  const open = ISSUES.filter(i => isLive(i) && relatedToOrder(i, o.VBELN)); if (open.length) s += ` ${open.length} open item${open.length > 1 ? 's' : ''} in this tool: ${open.map(i => i.fix ? i.fix.label : i.title).join('; ')}.`;
  return s;
}
function openOrder(vbeln) {
  const o = DB.VBAK.find(v => v.VBELN === vbeln); if (!o) return toast('Order not found', true); DRAWER = { type: 'order', vbeln }; const f = orderFlow(o); const kv = DB.KNVV.find(k => k.KUNNR === o.KUNNR) || {};
  const open = ISSUES.filter(i => isLive(i) && relatedToOrder(i, vbeln));
  openDrawer(`<div class="dh"><div class="grow"><div class="row small" style="margin-bottom:4px"><span class="chip b">Order 360°</span><span class="mute">${esc(o.AUART)} · ${esc(orgName(o.VKORG))}</span></div><h3>Order ${esc(vbeln)} · ${esc(custName(o.KUNNR))}</h3><div class="mute small">PO ${esc(o.BSTNK)} · ${inr(o.NETWR)} · created ${dmy(o.ERDAT)} · requested ${dmy(o.VDATU)}</div></div><button class="btn s" onclick="closeDrawer()">${ICONS.x}</button></div>
  <div class="db"><div class="flow">${f.st.map(s => `<div class="st ${s.c}"><div class="l">${s.l}</div><div class="v">${esc(s.v)}</div><div class="m">${esc(s.m)}</div></div>`).join('')}</div>
  <div class="note">${esc(orderNarrative(o))}</div>
  <dl class="kv" style="margin:12px 0"><dt>Customer</dt><dd>${esc(custName(o.KUNNR))} (${o.KUNNR}) · ${esc((DB.KNA1.find(c => c.KUNNR === o.KUNNR) || {}).ORT01)}</dd><dt>Payment terms</dt><dd>${esc(kv.ZTERM || '—')} · Incoterms ${esc(kv.INCO1 || '—')}</dd><dt>Status</dt><dd>${f.blocks.length ? f.blocks.map(b => `<span class="chip r">${esc(b)}</span>`).join(' ') : '<span class="chip g">no blocks</span>'} ${o.CMGST === 'D' ? '<span class="chip g">credit released</span>' : ''}</dd></dl>
  <table class="t"><thead><tr><th>Item</th><th>Material</th><th class="r">Ordered</th><th class="r">Confirmed</th><th class="r">Delivered</th><th class="r">Billed</th><th class="r">Net</th></tr></thead><tbody>${f.items.map(it => { const e = f.eps.filter(x => x.POSNR === it.POSNR); const d = sumBy(DB.LIPS.filter(l => l.VGBEL === vbeln && l.VGPOS === it.POSNR && (DB.LIKP.find(h => h.VBELN === l.VBELN) || {}).WBSTK === 'C'), l => l.LFIMG); const b = sumBy(DB.VBRP.filter(x => x.AUBEL === vbeln && x.AUPOS === it.POSNR), x => x.FKIMG); return `<tr><td class="mono">${it.POSNR}</td><td>${esc(it.MATNR)}<div class="k2">${esc(matName(it.MATNR))} · plant ${it.WERKS}</div></td><td class="r">${n(it.KWMENG)}</td><td class="r ${sumBy(e, x => x.BMENG) < it.KWMENG ? 'amber b' : ''}">${n(sumBy(e, x => x.BMENG))}</td><td class="r">${n(d)}</td><td class="r">${n(b)}</td><td class="r">${it.NETPR ? inrFull(it.NETWR) : '<span class="red b">no price</span>'}</td></tr>`; }).join('')}</tbody></table>
  ${open.length ? `<h4 style="margin:16px 0 6px;font-size:13px">Open items for this order</h4><ul class="list" style="border:1px solid var(--line);border-radius:8px">${open.map(i => `<li style="cursor:pointer" onclick="openIssue('${i.key}')"><span class="n ${i.severity === 'r' ? '' : 'a'}">!</span><span class="grow"><div class="t">${esc(i.title)}</div><div class="d">${i.fix ? esc(i.fix.label) : 'needs consultant'} · ${statusChip(i)}</div></span></li>`).join('')}</ul>` : '<div class="note g" style="margin-top:12px">No open issues on this order.</div>'}
  </div>`, `<button class="btn" onclick="openChat('Where is order ${vbeln}?')">${ICONS.spark} Ask the copilot about this order</button>`);
}
function openCustomer(kunnr) { const k = DB.KNA1.find(c => c.KUNNR === kunnr); const orders = DB.VBAK.filter(o => o.KUNNR === kunnr).sort((a, b) => b.ERDAT.localeCompare(a.ERDAT)); const c = DB.KNKK.find(x => x.KUNNR === kunnr); const open = ISSUES.filter(i => isLive(i) && i.kunnr === kunnr);
  openDrawer(`<div class="dh"><div class="grow"><div class="row small" style="margin-bottom:4px"><span class="chip b">Customer</span></div><h3>${esc(k.NAME1)} · ${kunnr}</h3><div class="mute small">${esc(k.ORT01)} · ${orders.length} orders · ${open.length} open issues</div></div><button class="btn s" onclick="closeDrawer()">${ICONS.x}</button></div><div class="db">
  ${c ? `<dl class="kv"><dt>Credit limit</dt><dd>${inrFull(c.KLIMK)}</dd><dt>Exposure</dt><dd class="${c.SKFOR > c.KLIMK ? 'red' : ''}">${inrFull(c.SKFOR)} (${(c.SKFOR / c.KLIMK * 100).toFixed(0)}%)</dd><dt>Overdue</dt><dd class="${c.OVERDUE ? 'red' : ''}">${inrFull(c.OVERDUE)} · ${c.DPD} days</dd><dt>Payment history</dt><dd>${esc(c.PAYHIST)}</dd></dl>` : ''}
  <table class="t" style="margin-top:12px"><thead><tr><th>Order</th><th>PO</th><th>Created</th><th class="r">Value</th><th>Stage</th></tr></thead><tbody>${orders.map(o => { const f = orderFlow(o); const last = [...f.st].reverse().find(s => s.c === 'ok'); const bad = f.st.find(s => s.c === 'bad'); return `<tr class="click" onclick="openOrder('${o.VBELN}')"><td class="k">${o.VBELN}</td><td>${esc(o.BSTNK)}</td><td>${dmy(o.ERDAT)}</td><td class="r">${inr(o.NETWR)}</td><td>${bad ? `<span class="chip r">${esc(bad.l)}: ${esc(bad.m || bad.v)}</span>` : `<span class="chip g">${esc(last ? last.l : 'Order')}</span>`}</td></tr>`; }).join('')}</tbody></table></div>`);
}

/* ---------- copilot ---------- */
let CHAT = [];
function openChat(q) { DRAWER = { type: 'chat' }; if (!CHAT.length) CHAT.push({ a: true, t: `Hi ${me().name.split(' ')[0]}. Ask me about any order, delivery, invoice or customer, or what is waiting for you. I answer from the SAP tables the tool just read${LLM.endpoint ? ' and the connected language model' : ''}.` }); renderChat(); if (q) chatSend(q); }
function renderChat() { openDrawer(`<div class="dh"><div class="grow"><h3 class="row">${ICONS.spark} SD copilot</h3><div class="mute small">grounded on your scoped SAP data · ${LLM.endpoint ? 'LLM connected' : 'rule-based (connect an LLM endpoint in Data & connections)'}</div></div><button class="btn s" onclick="closeDrawer()">${ICONS.x}</button></div><div class="db"><div class="chat" id="chat">${CHAT.map(m => `<div class="msg ${m.a ? 'a' : 'u'}">${esc(m.t)}</div>`).join('')}</div><div class="sugg" style="margin-top:12px">${['Where is order 50001291?', 'Why is 50001286 blocked?', 'What is delivered but not billed?', 'Which IDocs failed?', 'Who is free to take a task?', 'What needs my approval?'].map(s => `<button onclick="chatSend('${s.replace(/'/g, "\\'")}')">${s}</button>`).join('')}</div></div>`, `<input id="chatIn" class="grow" placeholder="Ask about an order, customer, invoice…" onkeydown="if(event.key==='Enter')chatSend(this.value)"><button class="btn p" onclick="chatSend(document.getElementById('chatIn').value)">Send</button>`); const c = $('#chat'); if (c) c.scrollTop = 1e6; const inp = $('#chatIn'); if (inp) inp.focus(); }
async function chatSend(q) { q = (q || '').trim(); if (!q) return; CHAT.push({ a: false, t: q }); renderChat(); let a; try { a = LLM.endpoint ? (await (await fetch(LLM.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: q, context: copilotContext() }) })).json()).answer : copilotAnswer(q); } catch (e) { a = 'LLM endpoint failed (' + e.message + '). Falling back:\n\n' + copilotAnswer(q); } CHAT.push({ a: true, t: a }); audit('Copilot: ' + q); saveState(); renderChat(); }
function copilotContext() { return { user: me().name, role: role().title, openIssues: live().map(i => ({ key: i.key, title: i.title, detail: i.detail, status: i.status })), orders: DB.VBAK.map(o => ({ ...o, narrative: orderNarrative(o) })) }; }
function copilotAnswer(q) {
  const t = q.toLowerCase(); const num = q.match(/\b(5000\d{4}|8000\d{4}|9000\d{4})\b/); const L = live();
  if (num) { let o; if (num[1].startsWith('5000')) o = DB.VBAK.find(v => v.VBELN === num[1]); else if (num[1].startsWith('8000')) { const l = DB.LIPS.find(x => x.VBELN === num[1]); o = l && DB.VBAK.find(v => v.VBELN === l.VGBEL); } else { const b = DB.VBRP.find(x => x.VBELN === num[1]); o = b && DB.VBAK.find(v => v.VBELN === b.AUBEL); }
    if (!o) return `I cannot find ${num[1]} in the sales organisations you are authorised for.`; const open = L.filter(i => relatedToOrder(i, o.VBELN)); return orderNarrative(o) + (open.length ? `\n\nNext step: ${open[0].fix ? open[0].fix.label + (needsApproval(open[0]) ? ` (needs ${APPROVAL_LABEL[open[0].approval]})` : canExecute(open[0]) ? ' — you can do it from the issue' : '') : 'assign to ' + suggestConsultant(open[0].skill).name}.` : '\n\nNothing is waiting on this order.'); }
  const cust = DB.KNA1.find(k => t.includes(k.NAME1.split(' ')[0].toLowerCase())); if (cust) { const os = DB.VBAK.filter(o => o.KUNNR === cust.KUNNR); const open = L.filter(i => i.kunnr === cust.KUNNR); const c = DB.KNKK.find(x => x.KUNNR === cust.KUNNR); return `${cust.NAME1}: ${os.length} orders worth ${inr(sumBy(os, o => o.NETWR))}; credit exposure ${inr(c.SKFOR)} of ${inr(c.KLIMK)}${c.OVERDUE ? `, ${inr(c.OVERDUE)} overdue (${c.DPD} days)` : ', nothing overdue'}.\n\n${open.length ? `Open items (${open.length}):\n` + open.map(i => `• ${i.title}`).join('\n') : 'No open issues.'}`; }
  if (/block/.test(t)) { const b = L.filter(i => ['SD-01', 'SD-50'].includes(i.catalogId)); return b.length ? `${b.length} orders are blocked:\n` + b.map(i => `• ${i.title} — ${i.explain.split('.')[0]}.`).join('\n') : 'No orders are blocked right now.'; }
  if (/bill|invoice backlog|not billed|unbilled/.test(t)) { const b = L.filter(i => i.module === 'billing'); return b.length ? `${inr(sumBy(b, i => i.value))} is delivered but not billed across ${b.length} deliveries. ${b.filter(i => !i.approval).length} can be billed now with one click; ${b.filter(i => i.approval).length} need a billing block removed first (SD Lead).\n` + b.map(i => `• ${i.ref} ${custName(i.kunnr)} ${inr(i.value)} — ${i.approval ? 'blocked' : 'clean'}`).join('\n') : 'Everything delivered has been billed.'; }
  if (/credit/.test(t)) { const b = L.filter(i => i.module === 'credit'); return b.length ? b.map(i => `• ${i.title}\n  ${i.explain}`).join('\n\n') : 'No credit blocks.'; }
  if (/idoc|output|e-?invoice|irn|edi/.test(t)) { const b = L.filter(i => i.module === 'output'); return b.length ? b.map(i => `• ${i.title} — ${i.detail}`).join('\n') : 'All outputs and IDocs are fine.'; }
  if (/approv/.test(t)) { const p = ISSUES.filter(i => i.status === 'pending' && inOrg(i)); const mine = p.filter(canApprove); return `${p.length} items are pending approval, ${mine.length} are for you.` + (mine.length ? '\n' + mine.map(i => `• ${i.fix.label} — ${i.ref} ${custName(i.kunnr)} ${inr(i.value)}, proposed by ${userName(i.proposedBy)}`).join('\n') : ''); }
  if (/free|load|consultant|who can/.test(t)) { const l = consultantLoad(); return CONSULTANTS.sort((a, b) => l[a.id] - l[b.id]).map(c => `• ${c.name} — ${l[c.id]} / ${c.capacity} open tasks (${c.skills.join(', ')})`).join('\n') + `\n\n${CONSULTANTS[0].name} has the most room.`; }
  if (/\bpo\b|inbox|purchase order/.test(t)) { const b = L.filter(i => i.module === 'po'); return b.length ? b.map(i => `• ${i.title}`).join('\n') : 'The PO inbox is empty.'; }
  if (/pric/.test(t)) { const b = L.filter(i => i.module === 'pricing'); return b.length ? b.map(i => `• ${i.title}\n  ${i.explain}`).join('\n\n') : 'No pricing issues.'; }
  if (/account|post|fi\b/.test(t)) { const b = L.filter(i => i.module === 'accounting'); return b.length ? b.map(i => `• ${i.title}\n  ${i.explain}`).join('\n\n') : 'All invoices are posted.'; }
  if (/wait|open|issue|today|summary|what/.test(t)) return `${L.length} open issues: ` + Object.keys(MODULES).filter(m => live(m).length).map(m => `${live(m).length} ${MODULES[m].label.toLowerCase()}`).join(', ') + `.\n\nMost urgent:\n` + [...L].filter(i => i.severity === 'r').slice(0, 5).map(i => `• ${i.title}`).join('\n');
  return `I can answer about a specific document (give me the order, delivery or invoice number), a customer by name, or a topic: blocked orders, billing backlog, credit, outputs/IDocs, PO inbox, pricing, accounting, approvals, consultant load.`;
}

/* ---------- modal helpers ---------- */
function modal(title, body, footer) { $('#modal').innerHTML = `<div class="box"><div class="mh">${title}</div><div class="mb">${body}</div><div class="mf"><button class="btn" onclick="closeModal()">Cancel</button>${footer}</div></div>`; $('#modal').classList.add('on'); }
function closeModal() { $('#modal').classList.remove('on'); }
function askNote(title, label, cb, required = true) { modal(title, `<label class="small"><div class="mute">${esc(label)}</div><textarea id="noteIn" rows="3" style="width:100%"></textarea></label>`, `<button class="btn p" onclick="const v=document.getElementById('noteIn').value.trim();if(${required}&&!v){toast('A reason is required',true);return}closeModal();(${cb.toString()})(v)">Confirm</button>`); setTimeout(() => $('#noteIn').focus(), 50); }

/* ---------- boot ---------- */
(async function boot() {
  loadDB(); loadState(); document.documentElement.setAttribute('data-theme', S.theme);
  if (S.user) { S.user = USERS.find(u => u.id === S.user.id) || null; }
  if (S.user) { await scan(); }
  refresh();
})();
