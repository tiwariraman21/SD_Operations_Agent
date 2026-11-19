const { chromium } = require('playwright');
const path = require('path');
const file = 'file://' + path.resolve(__dirname, '../dist/InfraBeat_SD_Operations_Agent.html');
(async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = []; p.on('pageerror', e => errs.push('PAGEERROR ' + e.message)); p.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  await p.goto(file); await p.waitForTimeout(500);
  await p.screenshot({ path: __dirname + '/s_login.png' });
  await p.click('text=Priya Sharma'); await p.waitForTimeout(800);
  await p.screenshot({ path: __dirname + '/s_overview.png', fullPage: true });
  for (const t of ['tracker', 'billing', 'delivery', 'output', 'po', 'credit', 'accounting', 'pricing', 'approvals', 'tasks', 'data']) {
    await p.evaluate(k => go(k), t); await p.waitForTimeout(300); await p.screenshot({ path: __dirname + `/s_${t}.png`, fullPage: t === 'credit' });
  }
  // counts
  const counts = await p.evaluate(() => Object.fromEntries(Object.keys(MODULES).map(m => [m, live(m).length])));
  console.log('counts', JSON.stringify(counts));
  console.log('issues', await p.evaluate(() => ISSUES.map(i => i.key + ' | ' + i.title).join('\n')));
  // drawer: issue
  await p.evaluate(() => { go('billing'); openIssue('SD-10:80001290'); }); await p.waitForTimeout(300); await p.screenshot({ path: __dirname + '/s_drawer_issue.png' });
  // order 360
  await p.evaluate(() => openOrder('50001291')); await p.waitForTimeout(300); await p.screenshot({ path: __dirname + '/s_drawer_order.png' });
  // execute a clean fix: bill delivery 80001290
  await p.evaluate(() => execute('SD-10:80001290')); await p.waitForTimeout(600);
  console.log('after bill:', await p.evaluate(() => JSON.stringify({ status: S.issues['SD-10:80001290'].status, reason: S.issues['SD-10:80001290'].reason, actions: S.actions, vbrk: DB.VBRK.length })));
  // approval flow: credit release proposed by priya, approved by meera, executed by meera
  await p.evaluate(() => propose('SD-50:50001286', 'customer paid 1.2L today')); await p.waitForTimeout(200);
  await p.evaluate(() => signIn('meera')); await p.waitForTimeout(600);
  await p.screenshot({ path: __dirname + '/s_meera_overview.png' });
  await p.evaluate(() => decide('SD-50:50001286', true, 'overdue minor, history good')); await p.waitForTimeout(200);
  await p.evaluate(() => execute('SD-50:50001286')); await p.waitForTimeout(600);
  console.log('after credit:', await p.evaluate(() => JSON.stringify({ status: S.issues['SD-50:50001286'].status, cmgst: DB.VBAK.find(o => o.VBELN === '50001286').CMGST })));
  // PO create
  await p.evaluate(() => signIn('rohan')); await p.waitForTimeout(600);
  await p.evaluate(() => execute('SD-40:PO-IN-0071')); await p.waitForTimeout(600);
  console.log('after po:', await p.evaluate(() => JSON.stringify({ status: S.issues['SD-40:PO-IN-0071'].status, reason: S.issues['SD-40:PO-IN-0071'].reason, orders: DB.VBAK.length, last: DB.VBAK[DB.VBAK.length - 1] })));
  // PGI with batch
  await p.evaluate(() => execute('SD-21:80001297')); await p.waitForTimeout(600);
  console.log('after pgi:', await p.evaluate(() => JSON.stringify({ status: S.issues['SD-21:80001297'].status, wbstk: DB.LIKP.find(d => d.VBELN === '80001297').WBSTK })));
  // output email fix with input
  await p.evaluate(() => execute('SD-30:90001292:RD00', { SMTP_ADDR: 'ap@meridian.example' })); await p.waitForTimeout(600);
  console.log('after output:', await p.evaluate(() => JSON.stringify({ status: S.issues['SD-30:90001292:RD00'].status })));
  // assign idoc to kiran, kiran executes
  await p.evaluate(() => assign('SD-31:0000000481223', 'kiran', 'please create WE20')); await p.waitForTimeout(200);
  await p.evaluate(() => { S.user = { id: 'kiran', name: 'Kiran Rao', role: 'consultant', title: 'EDI Consultant' }; }); // consultant not in USERS; test via sameer instead
  await p.evaluate(() => signIn('sameer')); await p.waitForTimeout(500);
  await p.evaluate(() => execute('SD-60:90001291')); await p.waitForTimeout(600);
  console.log('after vkoa (sameer, needs finance approval?):', await p.evaluate(() => JSON.stringify({ status: S.issues['SD-60:90001291'].status, rfbsk: DB.VBRK.find(v => v.VBELN === '90001291').RFBSK, vkoa: DB.VKOA.length })));
  // chat
  await p.evaluate(() => signIn('priya')); await p.waitForTimeout(500);
  console.log('chat:', await p.evaluate(() => copilotAnswer('Where is order 50001293?')));
  await p.evaluate(() => openChat('Why is 50001288 blocked?')); await p.waitForTimeout(400); await p.screenshot({ path: __dirname + '/s_chat.png' });
  await p.evaluate(() => { closeDrawer(); S.theme = 'dark'; refresh(); }); await p.waitForTimeout(300); await p.screenshot({ path: __dirname + '/s_dark.png' });
  console.log('ERRORS', errs);
  await b.close();
})();
