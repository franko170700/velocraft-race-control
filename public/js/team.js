'use strict';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtClock = (sec) => { sec = Math.max(0, sec | 0); const m = Math.floor(sec / 60), s = sec % 60; return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`; };
const areaClass = (a) => ({ 'Sales': 'Sales', 'Finance': 'Finance', 'Order Management': 'Order', 'Sourcing & Purchasing': 'Sourcing', 'Supply Chain': 'Supply' }[a] || 'area');

// ---- theme ----
const themeBtn = $('#themeBtn');
const savedTheme = localStorage.getItem('vc-theme') || 'light';
document.documentElement.setAttribute('data-theme', savedTheme);
themeBtn.onclick = () => {
  const t = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', t);
  localStorage.setItem('vc-theme', t);
};

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 2600);
}

let session = JSON.parse(localStorage.getItem('vc-team') || 'null'); // {id, code, name, color}
let clockLocal = { state: 'idle', remainingSec: 0 };

// ---- login ----
let selectedTeam = null;
async function loadTeams() {
  const data = await fetch('/api/state').then((r) => r.json());
  const grid = $('#teamPicks');
  grid.innerHTML = data.teams.map((t) =>
    `<div class="team-pick" data-id="${t.id}"><span class="team-dot" style="background:${esc(t.color)}"></span>${esc(t.name)}</div>`).join('');
  $$('.team-pick', grid).forEach((el) => el.onclick = () => {
    $$('.team-pick').forEach((x) => x.classList.remove('sel'));
    el.classList.add('sel'); selectedTeam = { id: +el.dataset.id, name: el.textContent.trim(), color: el.querySelector('.team-dot').style.background };
  });
}

$('#joinBtn').onclick = async () => {
  const code = $('#codeInput').value.trim().toUpperCase();
  if (!selectedTeam) return ($('#loginMsg').textContent = 'Pick your team first.');
  if (code.length < 3) return ($('#loginMsg').textContent = 'Enter your team code.');
  const res = await fetch('/api/team/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ teamId: selectedTeam.id, code }) });
  const data = await res.json();
  if (!res.ok) return ($('#loginMsg').textContent = data.error || 'Could not join.');
  session = { id: data.team.id, code, name: data.team.name, color: data.team.color };
  localStorage.setItem('vc-team', JSON.stringify(session));
  $('#loginMsg').textContent = '';
  showGame();
};
$('#codeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#joinBtn').click(); });

$('#logoutBtn').onclick = () => { localStorage.removeItem('vc-team'); session = null; location.reload(); };

function showGame() {
  $('#login').classList.add('hidden');
  $('#game').classList.remove('hidden');
  $('#meName').textContent = session.name;
  $('#meDot').style.background = session.color;
  refresh();
}

// ---- render missions ----
function render(view) {
  clockLocal = view.clock;
  $('#sPoints').textContent = view.points;
  $('#sRank').textContent = view.rank ? `${view.rank}/${view.totalTeams}` : '–';
  $('#sSolved').textContent = view.solved;
  session.color = view.team.color; $('#meDot').style.background = view.team.color;
  paintClock();

  $('#missions').innerHTML = view.missions.map((m, i) => missionCard(m, i + 1)).join('') ||
    '<div class="card muted">No stages released yet — the facilitator will publish them as the race goes on.</div>';

  view.missions.forEach((m) => wireCard(m));
}

function missionCard(m, no) {
  const solved = m.solved;
  const canAnswer = !m.questionLocked && !solved && clockLocal.state === 'running';
  let qinner;
  if (m.questionLocked) {
    qinner = `<div class="q-locked">🔒 Questions unlock when the facilitator starts the race.</div>`;
  } else {
    qinner = `<div class="section-label">Verification question</div><div style="font-weight:600;margin:4px 0;">${esc(m.question)}</div>`;
    if (solved) {
      qinner += `<div class="solved-banner">✅ Solved — ${m.earnedPoints} pts</div>`;
    } else {
      qinner += `<div class="answer-row">
          <input type="text" id="ans-${m.id}" placeholder="Type the answer you found in SAP…" ${clockLocal.state === 'running' ? '' : 'disabled'} />
          <button class="btn" data-submit="${m.id}" ${canAnswer ? '' : 'disabled'}>Submit</button>
        </div>
        <div class="feedback" id="fb-${m.id}">${m.wrongTries > 0 ? `${m.wrongTries} wrong ${m.wrongTries === 1 ? 'try' : 'tries'} so far.` : ''}</div>`;
    }
  }
  return `<div class="card mission ${solved ? 'solved' : ''}">
    <div class="mission-head">
      <span class="mission-no">${no}</span>
      <div>
        <h3>${esc(m.title)}</h3>
        <div class="meta">
          <span class="chip ${areaClass(m.area)}">${esc(m.area)}</span>
          <span class="chip ${m.difficulty}">${esc(m.difficulty)} · ${m.points} pts</span>
          <span class="muted">· ~${m.minutes} min</span>
        </div>
      </div>
    </div>
    <div class="section-label">Guided tour to follow</div>
    <div class="tour">${esc(m.tour) || '—'}</div>
    <div class="section-label">Scenario</div>
    <div class="mtext">${esc(m.scenario)}</div>
    ${m.task ? `<div class="section-label">Your task</div><div class="mtext">${esc(m.task)}</div>` : ''}
    <div class="qbox">${qinner}</div>
  </div>`;
}

function wireCard(m) {
  const sb = $(`[data-submit="${m.id}"]`);
  if (sb) sb.onclick = () => submit(m.id);
  const inp = $(`#ans-${m.id}`);
  if (inp) inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(m.id); });
}

async function submit(missionId) {
  const inp = $(`#ans-${missionId}`); const fb = $(`#fb-${missionId}`);
  const answer = inp.value.trim();
  if (!answer) { fb.className = 'feedback no'; fb.textContent = 'Type an answer first.'; return; }
  const res = await fetch('/api/submit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ teamId: session.id, code: session.code, missionId, answer }) });
  const data = await res.json();
  if (res.status === 429) { fb.className = 'feedback no'; fb.textContent = data.error; return; }
  if (!res.ok) { fb.className = 'feedback no'; fb.textContent = data.error || 'Error.'; return; }
  if (data.correct) {
    fb.className = 'feedback ok';
    fb.textContent = data.note ? data.note : `✅ Correct! +${data.points} pts${data.firstSolve ? ' · first to solve!' : ''}`;
    if (!data.note || data.points) toast(`Correct! +${data.points} pts`);
    refresh();
  } else {
    fb.className = 'feedback no';
    fb.textContent = `❌ Not quite — ${data.wrongTries} wrong ${data.wrongTries === 1 ? 'try' : 'tries'} so far.`;
    inp.select();
  }
}

async function refresh() {
  if (!session) return;
  const res = await fetch(`/api/team/${session.id}/view?code=${encodeURIComponent(session.code)}`);
  if (res.status === 401) { localStorage.removeItem('vc-team'); session = null; return location.reload(); }
  const view = await res.json();
  render(view);
}

function paintClock() {
  $('#sClock').textContent = fmtClock(clockLocal.remainingSec);
  $('#sClockState').textContent = clockLocal.state === 'running' ? 'Race on' : clockLocal.state === 'ended' ? 'Finished' : 'Not started';
}

// ---- live updates ----
const es = new EventSource('/api/events');
es.addEventListener('update', () => refresh());
es.addEventListener('tick', (e) => {
  const c = JSON.parse(e.data); const wasState = clockLocal.state;
  clockLocal = c; paintClock();
  if (wasState !== c.state) refresh(); // reveal questions on start / lock on end
});

// ---- boot ----
loadTeams().then(() => { if (session) showGame(); });
