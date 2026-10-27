'use strict';
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtClock = (sec) => { sec = Math.max(0, sec | 0); const m = Math.floor(sec / 60), s = sec % 60; return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`; };

// ---- theme ----
const savedTheme = localStorage.getItem('vc-theme') || 'light';
document.documentElement.setAttribute('data-theme', savedTheme);
$('#themeBtn').onclick = () => {
  const t = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', t);
  localStorage.setItem('vc-theme', t);
};

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 2600);
}

let pw = sessionStorage.getItem('vc-admin') || '';
let state = null; // latest overview

// ---- authenticated fetch ----
async function api(path, opts = {}) {
  opts.headers = Object.assign({ 'Content-Type': 'application/json', 'x-admin-password': pw }, opts.headers || {});
  const res = await fetch(path, opts);
  if (res.status === 401) { sessionStorage.removeItem('vc-admin'); pw = ''; showLogin(); throw new Error('unauthorized'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

// ---- login ----
function showLogin() { $('#login').classList.remove('hidden'); $('#console').classList.add('hidden'); }
function showConsole() { $('#login').classList.add('hidden'); $('#console').classList.remove('hidden'); refresh(); }

$('#loginBtn').onclick = async () => {
  const val = $('#pw').value;
  const res = await fetch('/api/host/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: val }) });
  if (!res.ok) { $('#loginMsg').textContent = 'Wrong password.'; return; }
  pw = val; sessionStorage.setItem('vc-admin', pw); $('#loginMsg').textContent = ''; showConsole();
};
$('#pw').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#loginBtn').click(); });

// ---- clock controls ----
$('#setLen').onclick = async () => { await api('/api/host/clock', { method: 'POST', body: JSON.stringify({ action: 'set', lengthSec: (+$('#lenMin').value || 60) * 60 }) }); toast('Clock length set.'); refresh(); };
$('#startBtn').onclick = async () => { await api('/api/host/clock', { method: 'POST', body: JSON.stringify({ action: 'start' }) }); toast('Race started! 🚴'); refresh(); };
$('#add5Btn').onclick = async () => { await api('/api/host/clock', { method: 'POST', body: JSON.stringify({ action: 'add5' }) }); toast('+5 minutes.'); refresh(); };
$('#endBtn').onclick = async () => { if (!confirm('End the race now?')) return; await api('/api/host/clock', { method: 'POST', body: JSON.stringify({ action: 'end' }) }); toast('Race ended.'); refresh(); };
$('#resetBtn').onclick = async () => { if (!confirm('Reset ALL scores and the clock? This clears every solve and attempt.')) return; await api('/api/host/clock', { method: 'POST', body: JSON.stringify({ action: 'reset' }) }); toast('Everything reset.'); refresh(); };

function paintClock() {
  const c = state.clock;
  $('#hClock').textContent = fmtClock(c.remainingSec);
  $('#hState').textContent = c.state === 'running' ? 'Race on' : c.state === 'ended' ? 'Finished' : 'Idle';
  if (document.activeElement !== $('#lenMin')) $('#lenMin').value = Math.round((c.lengthSec || 3600) / 60);
  const planned = state.plannedMinutes || 0, target = state.targetMinutes || 60;
  $('#plannedMin').textContent = `Planned stage time: ${planned} min (target ≈ ${target} min)` + (planned > target ? ' ⚠ over target' : '');
  $('#plannedMin').style.color = planned > target ? 'var(--danger)' : '';
}

// ---- missions ----
function renderMissions() {
  $('#missionTable tbody').innerHTML = state.missions.map((m, i) => `
    <tr data-id="${m.id}">
      <td class="ord">${i + 1}</td>
      <td>
        <strong>${esc(m.title)}</strong>
        <div class="muted" style="font-size:12px;">${esc(m.area)} · ${esc(m.difficulty)} · ${m.points} pts · ~${m.minutes}m
          ${m.published ? '<span class="pill live">PUBLISHED</span>' : '<span class="pill draft">HIDDEN</span>'}
          ${m.published && m.answerCount === 0 ? '<span class="pill draft">⚠ no answer</span>' : ''}
          · ${m.answerCount} answer${m.answerCount === 1 ? '' : 's'}</div>
      </td>
      <td class="rowflex" style="gap:4px;">
        <button class="btn ghost sm" data-up="${m.id}" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button class="btn ghost sm" data-down="${m.id}" ${i === state.missions.length - 1 ? 'disabled' : ''}>↓</button>
        <button class="btn ${m.published ? 'ghost' : ''} sm" data-pub="${m.id}">${m.published ? 'Hide' : 'Publish'}</button>
        <button class="btn sm" data-edit="${m.id}">Edit</button>
      </td>
    </tr>`).join('') || '<tr><td class="muted">No stages yet. Add one.</td></tr>';

  state.missions.forEach((m) => {
    const e = $(`[data-edit="${m.id}"]`); if (e) e.onclick = () => openMission(m);
    const u = $(`[data-up="${m.id}"]`); if (u) u.onclick = () => move(m.id, -1);
    const d = $(`[data-down="${m.id}"]`); if (d) d.onclick = () => move(m.id, +1);
    const pub = $(`[data-pub="${m.id}"]`);
    if (pub) pub.onclick = async () => {
      if (!m.published && m.answerCount === 0 && !confirm('This stage has no accepted answer yet, so teams won’t be able to score it. Publish anyway?')) return;
      await api('/api/host/missions/' + m.id + '/publish', { method: 'POST', body: JSON.stringify({ publish: !m.published }) });
      toast(m.published ? 'Stage hidden.' : 'Stage published.'); refresh();
    };
  });
}

async function move(id, dir) {
  const ids = state.missions.map((m) => m.id);
  const i = ids.indexOf(id), j = i + dir;
  if (j < 0 || j >= ids.length) return;
  ids.splice(j, 0, ids.splice(i, 1)[0]);
  await api('/api/host/missions/reorder', { method: 'POST', body: JSON.stringify({ order: ids }) });
  refresh();
}

const dlg = $('#missionDlg');
let editingId = null;
function openMission(m) {
  editingId = m ? m.id : null;
  $('#dlgTitle').textContent = m ? 'Edit stage' : 'New stage';
  $('#f_title').value = m ? m.title : '';
  $('#f_area').value = m ? m.area : 'Finance';
  $('#f_difficulty').value = m ? m.difficulty : 'Medium';
  $('#f_points').value = m ? m.points : 10;
  $('#f_minutes').value = m ? m.minutes : 12;
  $('#f_tour').value = m ? (m.tour || '') : '';
  $('#f_scenario').value = m ? (m.scenario || '') : '';
  $('#f_task').value = m ? (m.task || '') : '';
  $('#f_question').value = m ? (m.question || '') : '';
  $('#f_answers').value = m ? (m.answers || '') : '';
  $('#dlgDelete').style.display = m ? '' : 'none';
  dlg.showModal();
}
$('#addMission').onclick = () => openMission(null);

dlg.addEventListener('close', async () => {
  const v = dlg.returnValue;
  if (v === 'cancel' || v === '') return;
  if (v === 'delete') {
    if (editingId && confirm('Delete this stage?')) { await api('/api/host/missions/' + editingId, { method: 'DELETE' }); toast('Stage deleted.'); refresh(); }
    return;
  }
  const body = {
    title: $('#f_title').value.trim(), area: $('#f_area').value, difficulty: $('#f_difficulty').value,
    points: +$('#f_points').value || 0, minutes: +$('#f_minutes').value || 0, tour: $('#f_tour').value.trim(),
    scenario: $('#f_scenario').value.trim(), task: $('#f_task').value.trim(), question: $('#f_question').value.trim(),
    answers: $('#f_answers').value.trim(),
  };
  if (!body.title) return toast('Title is required.');
  if (editingId) await api('/api/host/missions/' + editingId, { method: 'PUT', body: JSON.stringify(body) });
  else await api('/api/host/missions', { method: 'POST', body: JSON.stringify(body) });
  toast('Stage saved.'); refresh();
});

// ---- teams ----
function renderTeams() {
  $('#teamTable tbody').innerHTML = state.teams.map((t) => `
    <tr data-id="${t.id}">
      <td><span class="team-dot" style="background:${esc(t.color)}"></span></td>
      <td><input class="cellinp" data-name="${t.id}" value="${esc(t.name)}" /></td>
      <td><span class="codebox">${esc(t.code)}</span></td>
      <td><input type="color" class="cellinp" data-color="${t.id}" value="${esc(t.color)}" style="width:44px;padding:2px;" /></td>
      <td class="rowflex" style="gap:4px;">
        <button class="btn ghost sm" data-save="${t.id}">Save</button>
        <button class="btn danger sm" data-del="${t.id}">✕</button>
      </td>
    </tr>`).join('') || '<tr><td class="muted">No teams yet.</td></tr>';

  state.teams.forEach((t) => {
    $(`[data-save="${t.id}"]`).onclick = async () => {
      await api('/api/host/teams/' + t.id, { method: 'PUT', body: JSON.stringify({
        name: $(`[data-name="${t.id}"]`).value.trim(),
        color: $(`[data-color="${t.id}"]`).value,
      }) });
      toast('Team saved.'); refresh();
    };
    $(`[data-del="${t.id}"]`).onclick = async () => {
      if (!confirm('Delete team "' + t.name + '"? Their solves are removed too.')) return;
      await api('/api/host/teams/' + t.id, { method: 'DELETE' }); toast('Team deleted.'); refresh();
    };
  });
}

$('#addTeam').onclick = async () => {
  const name = prompt('New team name?'); if (!name) return;
  const data = await api('/api/host/teams', { method: 'POST', body: JSON.stringify({ name: name.trim() }) });
  toast(`Team added — code ${data.code || ''}.`); refresh();
};

// ---- manual entry ----
function renderManualPickers() {
  $('#mTeam').innerHTML = state.teams.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('');
  $('#mMission').innerHTML = state.missions.map((m) => `<option value="${m.id}">${esc(m.title)}</option>`).join('');
}
$('#mSubmit').onclick = async () => {
  const teamId = +$('#mTeam').value, missionId = +$('#mMission').value, answer = $('#mAnswer').value.trim();
  if (!teamId || !missionId || !answer) { $('#mMsg').textContent = 'Pick team, stage and answer.'; return; }
  try {
    const data = await api('/api/host/manual', { method: 'POST', body: JSON.stringify({ teamId, missionId, answer }) });
    $('#mMsg').textContent = data.correct ? `✅ Recorded (+${data.points} pts).` : '❌ Answer did not match — nothing scored.';
    $('#mAnswer').value = ''; refresh();
  } catch (e) { $('#mMsg').textContent = e.message; }
};

// ---- refresh ----
async function refresh() {
  try { state = await api('/api/host/overview'); } catch { return; }
  paintClock(); renderMissions(); renderTeams(); renderManualPickers();
}

// ---- live ----
const es = new EventSource('/api/events');
es.addEventListener('update', () => { if (pw) { refresh(); } });
es.addEventListener('tick', (e) => { if (state) { state.clock = JSON.parse(e.data); paintClock(); } });

// ---- boot ----
if (pw) {
  fetch('/api/host/overview', { headers: { 'x-admin-password': pw } }).then((r) => { if (r.ok) showConsole(); else { sessionStorage.removeItem('vc-admin'); pw = ''; showLogin(); } });
} else showLogin();
