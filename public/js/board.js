'use strict';
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtClock = (sec) => { sec = Math.max(0, sec | 0); const m = Math.floor(sec / 60), s = sec % 60; return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`; };
const ago = (ts) => { const s = Math.floor((Date.now() - ts) / 1000); if (s < 60) return `${s}s ago`; const m = Math.floor(s / 60); return `${m}m ago`; };

let clock = { state: 'idle', remainingSec: 0 };

function paintClock() {
  $('#clock').textContent = fmtClock(clock.remainingSec);
  $('#clockState').textContent = clock.state === 'running' ? 'Race on' : clock.state === 'ended' ? 'Finished' : 'Not started';
  $('#clockWrap').classList.toggle('ending', clock.state === 'running' && clock.remainingSec <= 60);
}

async function refresh() {
  const data = await fetch('/api/board').then((r) => r.json());
  clock = data.clock; paintClock();

  const n = data.missionCount || 0;
  $('#gc').innerHTML = data.teams.map((t) => {
    const jersey = t.rank === 1 && t.points > 0;
    const squares = (t.squares || []).map((s) => `<div class="sq ${s}"></div>`).join('') || Array.from({ length: n }, () => '<div class="sq none"></div>').join('');
    return `<div class="gc-row ${jersey ? 'jersey-row' : ''}">
      <div class="rank">${t.rank}</div>
      <div class="tname">${jersey ? '<span class="jersey-badge">🟡</span>' : `<span class="team-dot" style="background:${esc(t.color)}"></span>`}${esc(t.name)}</div>
      <div class="pts">${t.points}</div>
      <div class="gap">${t.rank === 1 ? 'LEADER' : '−' + t.gap + ' pts'}<br><span style="font-size:12px;">${t.solved}/${n} solved</span></div>
      <div class="squares">${squares}</div>
    </div>`;
  }).join('') || '<div class="radio-empty">No teams yet.</div>';

  $('#radio').innerHTML = (data.radio && data.radio.length)
    ? data.radio.map((r) => `<div class="radio-item">
        <span class="tag" style="color:${esc(r.color)}">${esc(r.team)}</span> solved <strong>${esc(r.mission)}</strong>
        ${r.first ? '<span class="first">First!</span>' : ''}
        <div class="muted" style="font-size:12px;">+${r.points} pts · ${ago(r.at)}</div>
      </div>`).join('')
    : '<div class="radio-empty">No solves yet — waiting for the first rider to attack.</div>';
}

const es = new EventSource('/api/events');
es.addEventListener('update', refresh);
es.addEventListener('tick', (e) => { clock = JSON.parse(e.data); paintClock(); });

refresh();
setInterval(refresh, 5000); // safety poll so "x ago" + squares stay fresh
