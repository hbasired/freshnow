// Self-contained operations dashboard served by the API. No build step, no CDN.
// Layout follows operational-dashboard practice: decision-critical KPIs first, detail
// tables below, a prominent data-freshness timestamp, and <=9 headline metrics.
//
// NOTE: this is a JS template literal, so the embedded browser script must not use
// backticks or ${...}. It uses string concatenation throughout.
export const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>FreshNow Operations</title>
<style>
  :root{--bg:#0d1117;--fg:#e6edf3;--mut:#8b949e;--acc:#3fb950;--warn:#d29922;--crit:#f85149;
        --card:#161b22;--bd:#30363d;--accbg:#0f2a17;--blue:#58a6ff}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);
       font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
  header{padding:11px 16px;border-bottom:1px solid var(--bd);position:sticky;top:0;background:var(--bg);z-index:20}
  .htop{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
  h1{font-size:1.02rem;margin:0;font-weight:650}
  .badge{background:var(--warn);color:#000;font-weight:700;border-radius:6px;padding:2px 8px;font-size:.63rem}
  .live{color:var(--acc);font-size:.72rem;margin-top:4px}
  .synth{background:#3a2d00;color:var(--warn);border:1px solid #6b5200;border-radius:4px;padding:0 4px;font-size:.6rem}
  main{max-width:1240px;margin:0 auto;padding:14px 16px 70px}
  select,input,button{background:#1f2630;color:var(--fg);border:1px solid var(--bd);
                      border-radius:8px;padding:8px 10px;font-size:.92rem;font-family:inherit}
  button{cursor:pointer;font-weight:600} button:hover{border-color:var(--acc)}
  .primary{background:var(--accbg);border-color:var(--acc);color:var(--acc)}
  .kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin:14px 0 4px}
  .kpi{background:var(--card);border:1px solid var(--bd);border-radius:10px;padding:11px 13px;cursor:pointer}
  .kpi:hover{border-color:var(--blue)}
  .kpi b{display:block;font-size:1.7rem;line-height:1.15}
  .kpi span{color:var(--mut);font-size:.71rem}
  .kpi.alert{border-color:var(--crit)} .kpi.alert b{color:var(--crit)}
  .kpi.warn{border-color:var(--warn)} .kpi.warn b{color:var(--warn)}
  .kpi.good b{color:var(--acc)}
  /* Navigation: a grouped sidebar on a wide screen, a two-row grid on a phone.
     A single scrolling strip of pills hid half the tabs off the right edge — on the
     device this is actually read on, that is the same as not having them. */
  .shell{display:grid;grid-template-columns:186px 1fr;gap:20px;align-items:start}
  nav{position:sticky;top:96px}
  .navgrp{margin-bottom:14px}
  .navgrp h3{font-size:.63rem;text-transform:uppercase;letter-spacing:.9px;color:var(--mut);
             margin:0 0 5px 9px;font-weight:700}
  nav button{display:flex;width:100%;align-items:center;gap:8px;text-align:left;
             background:transparent;border:1px solid transparent;border-radius:8px;
             padding:7px 9px;font-size:.87rem;color:var(--fg);margin-bottom:1px}
  nav button:hover{background:var(--card);border-color:var(--bd)}
  nav button.on{background:var(--accbg);border-color:var(--acc);color:var(--acc);font-weight:650}
  nav button .c{margin-left:auto;font-size:.72rem;color:var(--mut);background:#1f2630;
                border-radius:20px;padding:0 7px;min-width:20px;text-align:center}
  nav button.on .c{background:#10391d;color:var(--acc)}
  nav button .c.hot{background:#4a1210;color:#ff9b95}
  .crumb{display:flex;align-items:baseline;gap:9px;margin-bottom:4px}
  .crumb h2{margin:0;font-size:1.16rem;color:var(--fg)}
  .crumb span{color:var(--mut);font-size:.82rem}
  section{display:none} section.on{display:block}
  @media (max-width:899px){
    .shell{grid-template-columns:1fr;gap:8px}
    nav{position:static;display:grid;grid-template-columns:repeat(4,1fr);gap:5px;margin-bottom:12px}
    .navgrp{display:contents}
    .navgrp h3{display:none}
    nav button{flex-direction:column;gap:2px;justify-content:center;text-align:center;
               font-size:.74rem;padding:8px 4px;border-color:var(--bd);background:var(--card)}
    nav button .c{margin-left:0}
  }
  h2{font-size:.92rem;margin:20px 0 8px;color:var(--fg);display:flex;align-items:center;gap:8px}
  h2 .n{background:#1f2630;border:1px solid var(--bd);border-radius:20px;padding:0 9px;font-size:.72rem;color:var(--mut)}
  table{border-collapse:collapse;width:100%;margin-bottom:6px;font-size:.87rem}
  th{background:#1f2630;text-align:left;padding:7px 9px;border:1px solid var(--bd);font-size:.76rem;
     text-transform:uppercase;letter-spacing:.4px;color:var(--mut);position:sticky;top:0}
  td{border:1px solid var(--bd);padding:7px 9px;vertical-align:top}
  tr.row{cursor:pointer} tr.row:hover td{background:#161b22}
  .words{color:var(--fg);background:#010409;border-radius:5px;padding:6px 8px;margin-top:5px;
         white-space:pre-wrap;word-break:break-word;font-size:.86rem}
  .sev{font-size:.65rem;font-weight:800;text-transform:uppercase;border-radius:4px;padding:1px 6px}
  .sev.critical{background:#4a1210;color:#ff9b95}.sev.high{background:#3a2d00;color:#f0c674}
  .sev.medium{background:#12283a;color:#88c0f0}.sev.low{background:#1f2630;color:var(--mut)}
  .pill{font-size:.68rem;border:1px solid var(--bd);border-radius:20px;padding:1px 8px;color:var(--mut);white-space:nowrap}
  .age{font-weight:700} .age.old{color:var(--crit)} .age.mid{color:var(--warn)}
  .empty{color:var(--mut);padding:14px;text-align:center;border:1px dashed var(--bd);border-radius:9px;font-size:.88rem}
  .q{background:var(--card);border:1px solid var(--bd);border-radius:10px;padding:14px}
  .q pre{background:#010409;border:1px solid var(--bd);border-radius:8px;padding:10px;
         overflow-x:auto;font-size:.78rem;white-space:pre-wrap;word-break:break-word}
  .muted{color:var(--mut);font-size:.8rem}
  .ok{color:var(--acc)}.bad{color:var(--crit)}
  .card{background:var(--card);border:1px solid var(--bd);border-radius:10px;padding:13px 15px;margin-bottom:10px}
  .card.b-l{border-left:3px solid var(--acc)}
  .grp{color:var(--blue);font-size:.8rem;font-weight:700;margin:16px 0 6px;
       border-bottom:1px solid var(--bd);padding-bottom:4px}
  .flow{margin-bottom:24px}
  .step{display:flex;gap:11px;align-items:flex-start;position:relative;padding-bottom:15px}
  .step::before{content:'';position:absolute;left:14px;top:30px;bottom:0;width:2px;background:var(--bd)}
  .step:last-child::before{display:none}
  .num{flex:0 0 30px;height:30px;border-radius:50%;display:flex;align-items:center;justify-content:center;
       font-weight:800;font-size:.78rem;border:2px solid;z-index:1;background:var(--bg)}
  .who-emp .num{border-color:#3b82c4;color:#88c0f0}
  .who-ceo .num{border-color:var(--acc);color:var(--acc)}
  .who-sys .num{border-color:var(--mut);color:var(--mut)}
  .sdesc{color:var(--mut);font-size:.83rem;margin-top:2px}
  .tbl{display:inline-block;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.69rem;
       background:#0d2818;color:#7ee2a8;border:1px solid #1d5334;border-radius:5px;padding:1px 6px;margin:5px 5px 0 0}
</style></head><body>
<header>
  <div class="htop">
    <h1>FreshNow Operations</h1><span class="badge">DEMO</span>
    <span style="flex:1"></span>
    <input type="date" id="date" title="Which day to show">
    <select id="viewer" title="See the data exactly as this person sees it"></select>
    <button onclick="load()">↻</button>
  </div>
  <div class="live" id="live">connecting…</div>
</header>
<main>
  <div class="kpis" id="kpis"></div>
  <div class="shell">
  <nav>
    <div class="navgrp"><h3>Today</h3>
      <button data-t="today" class="on">📋 <span>Status</span><span class="c" id="c-today">·</span></button>
      <button data-t="carry">🕓 <span>Carry-over</span><span class="c" id="c-carry">·</span></button>
    </div>
    <div class="navgrp"><h3>Work</h3>
      <button data-t="assign">📌 <span>Assignments</span><span class="c" id="c-assign">·</span></button>
      <button data-t="eod">📊 <span>End of day</span><span class="c" id="c-eod">·</span></button>
    </div>
    <div class="navgrp"><h3>Records</h3>
      <button data-t="people">👥 <span>People</span><span class="c" id="c-people">·</span></button>
      <button data-t="activity">📜 <span>Activity</span><span class="c" id="c-activity">·</span></button>
    </div>
    <div class="navgrp"><h3>Tools</h3>
      <button data-t="ask">🔎 <span>Ask</span><span class="c"> </span></button>
      <button data-t="flow">🗺 <span>How it works</span><span class="c"> </span></button>
    </div>
  </nav>
  <div>
  <div class="crumb"><h2 id="crumb-t">Status</h2><span id="crumb-s"></span></div>

  <section id="s-today" class="on">
    <h2>✅ Completed <span class="n" id="n-done">0</span></h2><div id="t-done"></div>
    <h2>⏳ Pending / in progress <span class="n" id="n-pend">0</span></h2><div id="t-pend"></div>
    <h2>🚫 Blockers <span class="n" id="n-blk">0</span></h2><div id="t-blk"></div>
    <h2>❓ Could not be read — needs a human <span class="n" id="n-rev">0</span></h2><div id="t-rev"></div>
  </section>

  <section id="s-carry">
    <p class="muted">Everything still open, grouped by the day it was raised. Anything above
      today is carried over — the age column is how long it has been waiting.</p>
    <div id="t-carry"></div>
  </section>

  <section id="s-assign"><div id="t-assign"></div></section>

  <section id="s-eod">
    <div style="margin-bottom:12px">
      <button class="primary" onclick="genEod()">Generate end-of-day reports</button>
      <span class="muted" id="eod-msg"></span>
    </div>
    <div id="t-eod"></div>
  </section>

  <section id="s-people"><div id="t-people"></div></section>
  <section id="s-activity"><div id="t-activity"></div></section>

  <section id="s-ask">
    <div class="q">
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <input id="question" style="flex:1;min-width:220px" placeholder="e.g. what did Hemanth say about his task?">
        <button class="primary" onclick="ask()">Ask</button>
      </div>
      <div id="answer" class="muted" style="margin-top:10px">
        The model writes SQL, Postgres computes the answer, and a gate checks every number
        against the returned rows. The SQL is always shown.
      </div>
    </div>
  </section>

  <section id="s-flow">
    <div class="flow">
      <h2>A · A new employee joins</h2>
      <div class="step who-ceo"><div class="num">1</div><div><b>CEO creates an invite code</b>
        <div class="sdesc">Types only a NAME. The CEO never needs the employee's Telegram id.</div>
        <span class="tbl">invite_code</span></div></div>
      <div class="step who-emp"><div class="num">2</div><div><b>Employee sends /start, enters the code</b>
        <div class="sdesc">Checking the code does not consume it — consent comes first.</div></div></div>
      <div class="step who-sys"><div class="num">3</div><div><b>Consent, then link — one transaction</b>
        <div class="sdesc">Employee row created and bound to that Telegram id; the code is burned;
          consent stored. All three together, so a double redeem cannot make two identities.</div>
        <span class="tbl">employee</span><span class="tbl">consent_record</span></div></div>
      <div class="step who-emp"><div class="num">4</div><div><b>They answer 4 questions about their job</b>
        <span class="tbl">employee</span></div></div>
    </div>
    <div class="flow">
      <h2>B · A problem reaches the CEO</h2>
      <div class="step who-emp"><div class="num">1</div><div><b>Employee reports — tap, type, or voice note</b>
        <div class="sdesc">Their exact words are saved BEFORE the model is called, so an outage
          cannot lose them.</div><span class="tbl">task_update.note_raw</span></div></div>
      <div class="step who-sys"><div class="num">2</div><div><b>The message is understood in context</b>
        <div class="sdesc">The model resolves which task they mean from their own open tasks and
          recent reports, and every id it returns is validated against that list — it cannot
          invent a task or a person.</div><span class="tbl">blocker</span></div></div>
      <div class="step who-sys"><div class="num">3</div><div><b>Routing — a table lookup, not a model call</b>
        <div class="sdesc">"Why did this go to X?" is answered by a row you can point at, and it is
          the same answer every time.</div><span class="tbl">routing_rule</span></div></div>
      <div class="step who-ceo"><div class="num">4</div><div><b>CEO is alerted with the person's own words</b>
        <div class="sdesc">Queued in the outbox and delivered by the worker, so a restart cannot
          lose or duplicate it. Acknowledging stops the escalation timer.</div>
        <span class="tbl">notification_outbox</span></div></div>
    </div>
    <div class="card b-l"><b>Every step writes an audit row</b> carrying the same correlation id —
      which is how any number here traces back to the exact message and rule that produced it.</div>
  </section>
  </div>
  </div>
</main>
<script>
var $ = function(id){ return document.getElementById(id); };
function esc(s){ return String(s == null ? '' : s).replace(/[&<>]/g, function(c){
  return c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'; }); }
function synth(v){ return v ? ' <span class="synth">DEMO</span>' : ''; }
function hhmm(t){ return t ? new Date(t).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}) : ''; }
function dstr(t){ return t ? new Date(t).toLocaleDateString([], {day:'2-digit',month:'short'}) : ''; }
async function j(url, opts){ var r = await fetch(url, opts); if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); }

var TABS = ['today','carry','assign','eod','people','activity','ask','flow'];
var TITLES = {
  today:    ['Status',       'what everyone reported on this date'],
  carry:    ['Carry-over',   'still open, grouped by the day it was raised'],
  assign:   ['Assignments',  'who was given what, and whether it arrived'],
  eod:      ['End of day',   'one stored report per person per day'],
  people:   ['People',       'everyone this viewer is allowed to see'],
  activity: ['Activity',     'the audit trail, newest first'],
  ask:      ['Ask',          'a question answered by SQL, with the SQL shown'],
  flow:     ['How it works', 'what happens between a message and an alert']
};
function showTab(t){
  if(TABS.indexOf(t) < 0) t = 'today';
  Array.prototype.forEach.call(document.querySelectorAll('nav button'), function(x){
    x.classList.toggle('on', x.dataset.t === t); });
  TABS.forEach(function(k){ $('s-'+k).classList.toggle('on', k === t); });
  $('crumb-t').textContent = TITLES[t][0];
  $('crumb-s').textContent = TITLES[t][1];
  // Keep the tab in the URL so a refresh, a bookmark or a shared link lands back here.
  if(location.hash !== '#' + t) history.replaceState(null, '', '#' + t);
}
Array.prototype.forEach.call(document.querySelectorAll('nav button'), function(b){
  b.onclick = function(){ showTab(b.dataset.t); };
});
window.addEventListener('hashchange', function(){ showTab(location.hash.slice(1)); });

// Counts on the nav itself, so you can see where the work is without opening each tab.
function navCount(tab, n, hot){
  var el = $('c-' + tab); if(!el) return;
  el.textContent = n;
  el.classList.toggle('hot', !!hot && n > 0);
}

// A table where clicking a row reveals the person's full words.
function table(el, rows, cols, emptyMsg){
  if(!rows || !rows.length){ $(el).innerHTML = '<div class="empty">' + emptyMsg + '</div>'; return; }
  var h = '<table><tr>' + cols.map(function(c){ return '<th>'+c.h+'</th>'; }).join('') + '</tr>';
  rows.forEach(function(r, i){
    var note = r.note_raw || r.last_note || '';
    h += '<tr class="row" onclick="tgl(this)">' +
      cols.map(function(c){ return '<td>' + c.f(r) + '</td>'; }).join('') + '</tr>';
    if(note){
      h += '<tr style="display:none"><td colspan="' + cols.length + '">' +
           '<div class="words">' + esc(note) + '</div>' +
           (r.summary ? '<div class="muted" style="margin-top:5px">read as: ' + esc(r.summary) + '</div>' : '') +
           '</td></tr>';
    }
  });
  $(el).innerHTML = h + '</table>';
}
function tgl(tr){
  var n = tr.nextElementSibling;
  if(n && n.querySelector('.words')) n.style.display = (n.style.display === 'none' ? '' : 'none');
}

function person(r){ return esc(r.employee_name || '') + (r.department ? ' <span class="pill">'+esc(r.department)+'</span>' : ''); }
function taskCell(r){
  return esc(r.task_title || '—') + (r.note_raw ? ' 💬' : '') +
         (r.files > 0 ? ' <span class="pill">📎 ' + r.files + '</span>' : '');
}

async function load(){
  var v = $('viewer').value || 'ceo';
  var d = $('date').value || new Date().toISOString().slice(0,10);
  var q = '?viewer=' + v + '&date=' + d;
  $('live').textContent = 'refreshing…';
  try{
    var r = await Promise.all([
      j('/dashboard/day' + q),
      j('/dashboard/open-tasks' + q),
      j('/dashboard/assignments' + q),
      j('/dashboard/eod' + q).catch(function(){ return []; }),
      j('/dashboard/employees' + q),
      j('/dashboard/activity' + q).catch(function(){ return []; }),
      j('/dashboard/needs-review' + q).catch(function(){ return []; }),
      j('/dashboard/blockers' + q).catch(function(){ return []; })
    ]);
    var day=r[0], open=r[1], asg=r[2], eod=r[3], emps=r[4], act=r[5], rev=r[6], allBlk=r[7];

    var done = day.filter(function(x){ return x.status==='done'; });
    var pend = day.filter(function(x){ return x.status==='pending'||x.status==='in_progress'; });
    var blk  = day.filter(function(x){ return x.status==='blocker'; });
    var openBlk = allBlk.filter(function(b){ return b.status==='open'; });
    var urgent = openBlk.filter(function(b){ return b.severity==='critical'||b.severity==='high'; });
    var overdue = open.filter(function(t){ return t.age_days > 0; });

    // KPIs — decision-critical first, and each one jumps to its detail.
    $('kpis').innerHTML =
      kpi(urgent.length,'urgent open', urgent.length?'alert':'', 'today') +
      kpi(openBlk.length,'open blockers', openBlk.length?'warn':'', 'today') +
      kpi(overdue.length,'carried over', overdue.length?'warn':'', 'carry') +
      kpi(pend.length,'pending today','', 'today') +
      kpi(done.length,'completed today','good','today') +
      kpi(rev.length,'need a human', rev.length?'alert':'', 'today') +
      kpi(asg.length,'assignments','', 'assign') +
      kpi(emps.length,'people visible','', 'people');

    $('n-done').textContent=done.length; $('n-pend').textContent=pend.length;
    $('n-blk').textContent=blk.length;  $('n-rev').textContent=rev.length;

    navCount('today', day.length, blk.length > 0);
    navCount('carry', overdue.length, overdue.length > 0);
    navCount('assign', asg.length, false);
    navCount('eod', eod.length, false);
    navCount('people', emps.length, false);
    navCount('activity', act.length, false);

    table('t-done', done, [
      {h:'Who', f:person}, {h:'Task', f:taskCell}, {h:'At', f:function(x){return hhmm(x.submitted_at);}},
      {h:'', f:function(x){return synth(x.is_synthetic);}}
    ], 'Nobody has completed anything on this date.');

    table('t-pend', pend, [
      {h:'Who', f:person}, {h:'Task', f:taskCell}, {h:'At', f:function(x){return hhmm(x.submitted_at);}},
      {h:'', f:function(x){return synth(x.is_synthetic);}}
    ], 'Nothing pending reported on this date.');

    table('t-blk', blk, [
      {h:'Severity', f:function(x){ return x.severity ? '<span class="sev '+esc(x.severity)+'">'+esc(x.severity)+'</span>' : '—'; }},
      {h:'Who', f:person}, {h:'Task', f:taskCell},
      {h:'Category', f:function(x){return esc(x.category||'—');}},
      {h:'State', f:function(x){return '<span class="pill">'+esc(x.blocker_status||'—')+'</span>';}},
      {h:'At', f:function(x){return hhmm(x.submitted_at);}}
    ], 'No blockers on this date. 🎉');

    table('t-rev', rev, [
      {h:'Who', f:function(x){return esc(x.employee_name);}},
      {h:'At', f:function(x){return hhmm(x.submitted_at);}},
      {h:'Their message', f:function(x){return esc(String(x.note_raw||'').slice(0,80));}}
    ], 'Nothing waiting on a human. 👍');

    // Carry-over, grouped by the day the work was raised.
    var groups = {};
    open.forEach(function(t){ (groups[t.opened_on] = groups[t.opened_on] || []).push(t); });
    var keys = Object.keys(groups).sort().reverse();
    if(!keys.length){ $('t-carry').innerHTML = '<div class="empty">Nothing outstanding. 🎉</div>'; }
    else {
      var html = '';
      keys.forEach(function(k, i){
        var rows = groups[k];
        html += '<div class="grp">' + dstr(k) + ' — ' + rows.length + ' open' +
                (rows[0].age_days>0 ? ' · ' + rows[0].age_days + ' day(s) ago' : ' · today') + '</div>' +
                '<div id="cg'+i+'"></div>';
      });
      $('t-carry').innerHTML = html;
      keys.forEach(function(k, i){
        table('cg'+i, groups[k], [
          {h:'Who', f:person}, {h:'Task', f:function(x){return esc(x.title)+(x.last_note?' 💬':'');}},
          {h:'State', f:function(x){return '<span class="pill">'+esc(x.status)+'</span>';}},
          {h:'Age', f:function(x){ var c = x.age_days>=3?'old':(x.age_days>=1?'mid':'');
            return '<span class="age '+c+'">'+x.age_days+'d</span>'; }},
          {h:'Last reported', f:function(x){return x.last_reported_at?dstr(x.last_reported_at)+' '+hhmm(x.last_reported_at):'never';}},
          {h:'', f:function(x){return synth(x.is_synthetic);}}
        ], 'none');
      });
    }

    table('t-assign', asg, [
      {h:'When', f:function(x){return dstr(x.created_at)+' '+hhmm(x.created_at);}},
      {h:'From', f:function(x){return esc(x.assigned_by);}},
      {h:'To', f:function(x){return '<b>'+esc(x.assigned_to)+'</b>';}},
      {h:'Task', f:function(x){return esc(x.task_title||x.note||'—');}},
      {h:'Files', f:function(x){ return x.files > 0
        ? '<span class="pill" title="'+esc(x.file_names||'')+'">📎 '+x.files+'</span>' : '—'; }},
      {h:'State', f:function(x){return '<span class="pill">'+esc(x.status)+'</span>';}},
      {h:'Task now', f:function(x){return '<span class="pill">'+esc(x.task_status||'—')+'</span>';}}
    ], 'No assignments yet.');

    if(!eod.length){ $('t-eod').innerHTML = '<div class="empty">No reports for this date yet — press Generate.</div>'; }
    else {
      $('t-eod').innerHTML = eod.map(function(e){
        var d = e.detail || {};
        return '<div class="card b-l"><div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px">' +
          '<b>' + esc(e.employee_name) + synth(e.is_synthetic) + '</b>' +
          '<span class="muted">✅ '+e.completed+' · ⏳ '+e.pending+' · 🚫 '+e.blockers+'</span></div>' +
          '<div style="margin-top:7px">' + esc(e.summary || '') + '</div>' +
          ((d.openTasks && d.openTasks.length) ? '<div class="muted" style="margin-top:6px">Still open: ' +
             d.openTasks.map(esc).join(' · ') + '</div>' : '') + '</div>';
      }).join('');
    }

    table('t-people', emps, [
      {h:'Name', f:function(x){return esc(x.display_name)+synth(x.is_synthetic);}},
      {h:'Role', f:function(x){return esc(x.role_title||'—');}},
      {h:'Dept', f:function(x){return esc(x.department||'—');}},
      {h:'Site', f:function(x){return esc(x.site||'—');}},
      {h:'Shift', f:function(x){return esc(x.shift||'—');}},
      {h:'State', f:function(x){return '<span class="pill">'+esc(x.status)+'</span>';}}
    ], 'No people visible to you.');

    table('t-activity', act, [
      {h:'When', f:function(x){return dstr(x.created_at)+' '+hhmm(x.created_at);}},
      {h:'Action', f:function(x){return esc(x.action);}},
      {h:'Actor', f:function(x){return esc(x.actor);}},
      {h:'Entity', f:function(x){return esc(x.entity||'—');}}
    ], 'No activity recorded.');

    $('live').innerHTML = '<span class="ok">● live</span> · ' + d + ' · updated ' +
      new Date().toLocaleTimeString() + ' · showing exactly what this viewer is allowed to see';
  }catch(err){
    $('live').innerHTML = '<span class="bad">● cannot reach the API — is it running?</span>';
  }
}

function kpi(n, label, cls, tab){
  return '<div class="kpi ' + cls + '" onclick="showTab(\\'' + tab + '\\')"><b>' + n + '</b><span>' + label + '</span></div>';
}

async function genEod(){
  $('eod-msg').textContent = ' generating…';
  try{
    var r = await j('/dashboard/eod/generate', {method:'POST'});
    $('eod-msg').textContent = ' generated ' + r.generated + ' report(s)';
    await load();
  }catch(e){ $('eod-msg').textContent = ' failed — check the API log'; }
}

async function loadViewers(){
  var emps = await j('/dashboard/employees?viewer=ceo');
  $('viewer').innerHTML = '<option value="ceo">👑 CEO (sees everything)</option>' +
    emps.map(function(e){ return '<option value="'+e.id+'">👤 '+esc(e.display_name)+'</option>'; }).join('');
  $('viewer').onchange = load;
  $('date').onchange = load;
}

async function ask(){
  var q = $('question').value.trim(); if(q.length < 3) return;
  $('answer').innerHTML = '<span class="muted">Thinking…</span>';
  try{
    var r = await j('/dashboard/query', {method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({question:q})});
    var gate = r.gate && r.gate.numericSanity;
    $('answer').innerHTML = '<div style="font-size:1.02rem;margin-bottom:6px">' + esc(r.answer) + '</div>' +
      '<div class="muted">' + r.rowCount + ' row(s) · numeric-sanity gate: <span class="' +
      (gate?'ok':'bad') + '">' + (gate?'passed':'FAILED') + '</span>' + (r.abstained?' · abstained':'') + '</div>' +
      (r.sql ? '<pre>' + esc(r.sql) + '</pre>' : '');
  }catch(e){ $('answer').innerHTML = '<span class="bad">Query failed.</span>'; }
}

$('date').value = new Date().toISOString().slice(0,10);
showTab(location.hash.slice(1) || 'today');
loadViewers().then(load).catch(function(){
  $('live').innerHTML = '<span class="bad">● cannot reach the API</span>';
});
setInterval(load, 15000);
</script></body></html>`;
