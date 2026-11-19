/* ---------- small helpers ---------- */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const n = (v) => Number(v || 0).toLocaleString('en-IN');
const inr = (v) => { v = Number(v || 0); const a = Math.abs(v); if (a >= 1e7) return '₹' + (v / 1e7).toFixed(2) + ' cr'; if (a >= 1e5) return '₹' + (v / 1e5).toFixed(1) + ' L'; return '₹' + v.toLocaleString('en-IN'); };
const inrFull = (v) => '₹' + Number(v || 0).toLocaleString('en-IN');
const dmy = (d) => { if (!d) return '—'; const [y, m, dd] = d.split('-'); return `${dd} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][+m - 1]}`; };
const daysBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000);
const ageDays = (d) => daysBetween(d, TODAY);
const addDays = (d, k) => { const x = new Date(d); x.setDate(x.getDate() + k); return x.toISOString().slice(0, 10); };
const hoursAgo = (iso) => { const h = Math.max(0, Math.round((Date.now() - new Date(iso)) / 36e5)); return h < 1 ? 'just now' : h < 48 ? h + ' h' : Math.round(h / 24) + ' d'; };
const uid = () => Math.random().toString(36).slice(2, 9);
const sumBy = (arr, f) => arr.reduce((s, x) => s + (f(x) || 0), 0);
const by = (k) => (a, b) => (a[k] > b[k] ? 1 : a[k] < b[k] ? -1 : 0);
/* deterministic sparkline values from a seed string */
function sparkVals(seed, len = 14) { let h = 0; for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0; const out = []; let v = 40 + (h % 30); for (let i = 0; i < len; i++) { h = (h * 1103515245 + 12345) >>> 0; v = Math.max(5, Math.min(95, v + ((h >> 8) % 21) - 9)); out.push(v); } return out; }
function sparkSVG(seed, color) { const vals = sparkVals(seed); const w = 120, h = 34; const pts = vals.map((v, i) => `${(i / (vals.length - 1) * w).toFixed(1)},${(h - 4 - v / 100 * (h - 8)).toFixed(1)}`); return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><defs><linearGradient id="g${seed}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity=".25"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs><path d="M0,${h} L${pts.join(' L')} L${w},${h} Z" fill="url(#g${seed})"/><polyline points="${pts.join(' ')}" fill="none" stroke="${color}" stroke-width="1.6"/></svg>`; }
/* icons (inline SVG, stroke-based) */
const ICONS = {
  grid: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
  bill: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 13h6M9 17h6"/></svg>',
  truck: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7h11v9H3zM14 10h4l3 3v3h-7z"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="18" r="2"/></svg>',
  send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 12 20 4l-4 16-5-6z"/><path d="m11 14 9-10"/></svg>',
  inbox: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16v16H4z"/><path d="M4 14h5l1.5 2h3L15 14h5"/></svg>',
  card: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18M7 15h4"/></svg>',
  ledger: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16v16H4z"/><path d="M8 4v16M4 9h16M4 14h16"/></svg>',
  tag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12V4h8l9 9-8 8z"/><circle cx="7.5" cy="8.5" r="1.5"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6 9 17l-5-5"/></svg>',
  users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.5 3-6 6.5-6s6.5 2.5 6.5 6"/><circle cx="17" cy="9" r="2.5"/><path d="M16 14c3 0 5.5 2 5.5 5"/></svg>',
  db: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/></svg>',
  warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3 2 21h20z"/><path d="M12 10v5M12 18h.01"/></svg>',
  spark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>',
  sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  out: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 4H5v16h5M14 8l4 4-4 4M18 12H9"/></svg>',
  arrow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  chev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6"/></svg>',
};
const ic = (k) => `<span class="ic">${ICONS[k] || ''}</span>`;
