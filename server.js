'use strict';

require('dotenv').config();
const path = require('path');
const express = require('express');
const { db, getSetting, setSetting } = require('./db');
const { checkAnswer, missionIsLive, parseAnswerKeys, normalizeAnswer } = require('./util');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'velocraft';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const DIFF_POINTS = { Easy: 5, Medium: 10, Hard: 15 };
const NO_HINT_BONUS = 5;
const FIRST_SOLVE_BONUS = 3;
const FIRST_ALL_BONUS = 10;
const HINT_TOKENS_DEFAULT = 3;
const SUBMIT_COOLDOWN_MS = 3000;

// ---------------------------------------------------------------- SSE plumbing
const sseClients = new Set();
function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch (_) { /* dropped on close */ }
  }
}

app.get('/api/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  res.flushHeaders && res.flushHeaders();
  res.write(`retry: 3000\n\n`);
  sseClients.add(res);
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) {} }, 25000);
  req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
});

// ---------------------------------------------------------------- clock
function clockState() {
  const state = getSetting('race_state', 'idle');
  const lengthSec = parseInt(getSetting('race_length_sec', '3600'), 10);
  const startTs = parseInt(getSetting('race_start_ts', '') || '0', 10);
  const endTs = parseInt(getSetting('race_end_ts', '') || '0', 10);
  let remainingSec = lengthSec;
  if (state === 'running' && startTs) {
    remainingSec = Math.max(0, lengthSec - Math.floor((Date.now() - startTs) / 1000));
  } else if (state === 'ended') {
    remainingSec = 0;
  }
  return { state, lengthSec, startTs: startTs || null, endTs: endTs || null, remainingSec };
}

function maybeAutoEnd() {
  const c = clockState();
  if (c.state === 'running' && c.remainingSec <= 0) {
    setSetting('race_state', 'ended');
    setSetting('race_end_ts', String(Date.now()));
    broadcast('update', { reason: 'race-ended' });
    return true;
  }
  return false;
}

function raceStarted() { return getSetting('race_state', 'idle') !== 'idle'; }
function raceRunning() { maybeAutoEnd(); return getSetting('race_state', 'idle') === 'running'; }

// ---------------------------------------------------------------- scoring
const liveMissionsStmt = db.prepare('SELECT * FROM missions ORDER BY ord, id');
function liveMissions() { return liveMissionsStmt.all().filter(missionIsLive); }

function teamBonus(teamId) {
  const row = db.prepare("SELECT 1 FROM bonuses WHERE key = 'first_all' AND team_id = ?").get(teamId);
  return row ? FIRST_ALL_BONUS : 0;
}

function teamScore(teamId) {
  const agg = db
    .prepare('SELECT COALESCE(SUM(points),0) AS pts, COUNT(*) AS solved, MAX(solved_at) AS last FROM solves WHERE team_id = ?')
    .get(teamId);
  return { points: agg.pts + teamBonus(teamId), solved: agg.solved, lastSolveAt: agg.last || null };
}

function standings() {
  const teams = db.prepare('SELECT * FROM teams ORDER BY id').all();
  const rows = teams.map((t) => {
    const s = teamScore(t.id);
    return { id: t.id, name: t.name, color: t.color, points: s.points, solved: s.solved, lastSolveAt: s.lastSolveAt };
  });
  rows.sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    if (b.solved !== a.solved) return b.solved - a.solved;
    return (a.lastSolveAt || Infinity) - (b.lastSolveAt || Infinity); // earliest finisher wins ties
  });
  const leaderPoints = rows.length ? rows[0].points : 0;
  rows.forEach((r, i) => { r.rank = i + 1; r.gap = leaderPoints - r.points; });
  return rows;
}

// Award a solve for a team on a mission (used by /submit and manual entry).
const awardSolve = db.transaction((team, mission, atTime) => {
  const existing = db.prepare('SELECT 1 FROM solves WHERE team_id = ? AND mission_id = ?').get(team.id, mission.id);
  if (existing) return { ok: false, reason: 'already-solved' };

  const hintRow = db.prepare('SELECT requested FROM hints WHERE team_id = ? AND mission_id = ?').get(team.id, mission.id);
  const usedHint = hintRow && hintRow.requested ? 1 : 0;

  const priorSolvers = db.prepare('SELECT COUNT(*) AS n FROM solves WHERE mission_id = ?').get(mission.id).n;
  const isFirst = priorSolvers === 0 ? 1 : 0;

  const base = mission.points || DIFF_POINTS[mission.difficulty] || 0;
  let points = base;
  if (!usedHint) points += NO_HINT_BONUS;
  if (isFirst) points += FIRST_SOLVE_BONUS;

  db.prepare('INSERT INTO solves (team_id, mission_id, points, used_hint, is_first, solved_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(team.id, mission.id, points, usedHint, isFirst, atTime);

  let firstAll = false;
  const live = liveMissions();
  if (live.length > 0) {
    const solvedCount = db
      .prepare(`SELECT COUNT(*) AS n FROM solves WHERE team_id = ? AND mission_id IN (${live.map(() => '?').join(',')})`)
      .get(team.id, ...live.map((m) => m.id)).n;
    if (solvedCount === live.length) {
      const already = db.prepare("SELECT 1 FROM bonuses WHERE key = 'first_all'").get();
      if (!already) {
        db.prepare("INSERT INTO bonuses (key, team_id, awarded_at) VALUES ('first_all', ?, ?)").run(team.id, atTime);
        firstAll = true;
      }
    }
  }
  return { ok: true, points, firstSolve: isFirst === 1, firstAll, usedHint: usedHint === 1 };
});

// ---------------------------------------------------------------- helpers
function verifyTeam(teamId, code) {
  if (!teamId || !code) return null;
  const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(teamId);
  if (!team) return null;
  return team.code.toUpperCase() === String(code).trim().toUpperCase() ? team : null;
}

function requireAdmin(req, res, next) {
  const pw = req.get('x-admin-password') || (req.body && req.body.password);
  if (pw && pw === ADMIN_PASSWORD) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}

function publicMission(m) {
  const started = raceStarted();
  return {
    id: m.id, ord: m.ord, title: m.title, area: m.area, difficulty: m.difficulty,
    points: m.points, minutes: m.minutes, tour: m.tour, scenario: m.scenario, task: m.task,
    question: started ? m.question : null, questionLocked: !started,
  };
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function genCode() {
  for (let tries = 0; tries < 50; tries++) {
    let c = '';
    for (let i = 0; i < 4; i++) c += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    if (!db.prepare('SELECT 1 FROM teams WHERE code = ?').get(c)) return c;
  }
  return 'T' + Date.now().toString().slice(-3);
}
const TEAM_COLORS = ['#f4c430', '#e4572e', '#1e88e5', '#2ecc71', '#9b59b6', '#ff7043', '#00acc1', '#ec407a'];
function nextColor() {
  const n = db.prepare('SELECT COUNT(*) AS n FROM teams').get().n;
  return TEAM_COLORS[n % TEAM_COLORS.length];
}

// ================================================================ PUBLIC API
app.get('/api/state', (req, res) => {
  maybeAutoEnd();
  res.json({
    clock: clockState(),
    missions: liveMissions().map(publicMission),
    teams: db.prepare('SELECT id, name, color FROM teams ORDER BY name').all(),
  });
});

app.post('/api/team/login', (req, res) => {
  const { teamId, code } = req.body || {};
  const team = verifyTeam(teamId, code);
  if (!team) return res.status(401).json({ error: 'Wrong team code.' });
  res.json({ ok: true, team: { id: team.id, name: team.name, color: team.color } });
});

app.get('/api/team/:id/view', (req, res) => {
  const team = verifyTeam(req.params.id, req.query.code);
  if (!team) return res.status(401).json({ error: 'Wrong team code.' });
  maybeAutoEnd();

  const missions = liveMissions();
  const score = teamScore(team.id);
  const all = standings();
  const myStanding = all.find((s) => s.id === team.id);

  const perMission = missions.map((m) => {
    const solve = db.prepare('SELECT * FROM solves WHERE team_id = ? AND mission_id = ?').get(team.id, m.id);
    const tries = db.prepare('SELECT COUNT(*) AS n FROM attempts WHERE team_id = ? AND mission_id = ? AND correct = 0').get(team.id, m.id).n;
    const hint = db.prepare('SELECT requested, unlocked FROM hints WHERE team_id = ? AND mission_id = ?').get(team.id, m.id) || { requested: 0, unlocked: 0 };
    return {
      ...publicMission(m),
      solved: !!solve, earnedPoints: solve ? solve.points : 0,
      solvedWithHint: solve ? !!solve.used_hint : false, wrongTries: tries,
      hintRequested: !!hint.requested, hintUnlocked: !!hint.unlocked,
      hintText: hint.unlocked ? m.hint : null,
    };
  });

  res.json({
    team: { id: team.id, name: team.name, color: team.color, hintTokens: team.hint_tokens },
    clock: clockState(), points: score.points, solved: score.solved,
    rank: myStanding ? myStanding.rank : null, totalTeams: all.length, missions: perMission,
  });
});

const lastSubmit = new Map();
app.post('/api/submit', (req, res) => {
  const { teamId, code, missionId, answer } = req.body || {};
  const team = verifyTeam(teamId, code);
  if (!team) return res.status(401).json({ error: 'Wrong team code.' });

  const now = Date.now();
  const last = lastSubmit.get(team.id) || 0;
  if (now - last < SUBMIT_COOLDOWN_MS) {
    return res.status(429).json({ error: 'Slow down a moment before trying again.', cooldownMs: SUBMIT_COOLDOWN_MS - (now - last) });
  }
  lastSubmit.set(team.id, now);

  const mission = db.prepare('SELECT * FROM missions WHERE id = ?').get(missionId);
  if (!mission || !missionIsLive(mission)) return res.status(404).json({ error: 'Mission not found.' });
  if (!raceStarted()) return res.status(403).json({ error: 'The race has not started yet.' });

  if (db.prepare('SELECT 1 FROM solves WHERE team_id = ? AND mission_id = ?').get(team.id, mission.id)) {
    return res.status(409).json({ error: 'You already solved this stage.' });
  }

  const correct = checkAnswer(mission.answers, answer);
  db.prepare('INSERT INTO attempts (team_id, mission_id, answer, normalized, correct, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(team.id, mission.id, String(answer || ''), normalizeAnswer(answer), correct ? 1 : 0, now);

  if (!correct) {
    const tries = db.prepare('SELECT COUNT(*) AS n FROM attempts WHERE team_id = ? AND mission_id = ? AND correct = 0').get(team.id, mission.id).n;
    broadcast('update', { reason: 'attempt' });
    return res.json({ correct: false, wrongTries: tries });
  }

  if (!raceRunning()) {
    db.prepare('INSERT INTO solves (team_id, mission_id, points, used_hint, is_first, solved_at) VALUES (?, ?, 0, 0, 0, ?)').run(team.id, mission.id, now);
    broadcast('update', { reason: 'solve-late' });
    return res.json({ correct: true, points: 0, note: 'Correct — but the race has ended, so no points.' });
  }

  const result = awardSolve(team, mission, now);
  broadcast('update', { reason: 'solve', teamName: team.name, missionTitle: mission.title, firstSolve: result.firstSolve });
  res.json({ correct: true, points: result.points, firstSolve: result.firstSolve, firstAll: result.firstAll });
});

app.post('/api/hint/request', (req, res) => {
  const { teamId, code, missionId } = req.body || {};
  const team = verifyTeam(teamId, code);
  if (!team) return res.status(401).json({ error: 'Wrong team code.' });
  const mission = db.prepare('SELECT * FROM missions WHERE id = ?').get(missionId);
  if (!mission || !missionIsLive(mission)) return res.status(404).json({ error: 'Mission not found.' });

  const existing = db.prepare('SELECT * FROM hints WHERE team_id = ? AND mission_id = ?').get(team.id, mission.id);
  if (existing && existing.requested) return res.json({ ok: true, alreadyRequested: true, unlocked: !!existing.unlocked });
  if (team.hint_tokens <= 0) return res.status(400).json({ error: 'No hint tokens left.' });

  db.transaction(() => {
    db.prepare('UPDATE teams SET hint_tokens = hint_tokens - 1 WHERE id = ?').run(team.id);
    db.prepare(`INSERT INTO hints (team_id, mission_id, requested, unlocked, requested_at) VALUES (?, ?, 1, 0, ?)
                ON CONFLICT(team_id, mission_id) DO UPDATE SET requested = 1, requested_at = excluded.requested_at`)
      .run(team.id, mission.id, Date.now());
  })();
  broadcast('update', { reason: 'hint-request' });
  res.json({ ok: true, tokensLeft: team.hint_tokens - 1 });
});

// ================================================================ BOARD API
app.get('/api/board', (req, res) => {
  maybeAutoEnd();
  const missions = liveMissions();
  const rows = standings().map((t) => {
    const squares = missions.map((m) => {
      const solve = db.prepare('SELECT used_hint FROM solves WHERE team_id = ? AND mission_id = ?').get(t.id, m.id);
      if (solve) return solve.used_hint ? 'hint' : 'solved';
      const tries = db.prepare('SELECT COUNT(*) AS n FROM attempts WHERE team_id = ? AND mission_id = ? AND correct = 0').get(t.id, m.id).n;
      return tries > 0 ? 'wrong' : 'none';
    });
    return { ...t, squares };
  });

  const radio = db.prepare(`
    SELECT s.solved_at AS at, s.is_first AS first, s.points AS points, s.used_hint AS usedHint,
           t.name AS team, t.color AS color, m.title AS mission
    FROM solves s JOIN teams t ON t.id = s.team_id JOIN missions m ON m.id = s.mission_id
    ORDER BY s.solved_at DESC LIMIT 12`).all();

  res.json({
    clock: clockState(), missionCount: missions.length,
    missions: missions.map((m) => ({ id: m.id, title: m.title, area: m.area })),
    teams: rows, radio,
  });
});

// ================================================================ HOST API
app.post('/api/host/login', (req, res) => {
  if (((req.body && req.body.password) || '') === ADMIN_PASSWORD) return res.json({ ok: true });
  res.status(401).json({ error: 'Wrong password.' });
});

app.get('/api/host/overview', requireAdmin, (req, res) => {
  const missions = db.prepare('SELECT * FROM missions ORDER BY ord, id').all();
  const plannedMinutes = missions.filter(missionIsLive).reduce((s, m) => s + (m.minutes || 0), 0);
  res.json({
    clock: clockState(), plannedMinutes, targetMinutes: 60,
    missions: missions.map((m) => ({ ...m, live: missionIsLive(m), answerCount: parseAnswerKeys(m.answers).length })),
    teams: db.prepare('SELECT * FROM teams ORDER BY id').all(),
    standings: standings(),
  });
});

app.post('/api/host/clock', requireAdmin, (req, res) => {
  const { action, lengthSec } = req.body || {};
  const now = Date.now();
  switch (action) {
    case 'set':
      setSetting('race_length_sec', String(Math.max(60, parseInt(lengthSec, 10) || 3600))); break;
    case 'start':
      setSetting('race_state', 'running'); setSetting('race_start_ts', String(now)); setSetting('race_end_ts', ''); break;
    case 'add5': {
      setSetting('race_length_sec', String(parseInt(getSetting('race_length_sec', '3600'), 10) + 300));
      if (getSetting('race_state') === 'ended') { setSetting('race_state', 'running'); setSetting('race_end_ts', ''); }
      break;
    }
    case 'end':
      setSetting('race_state', 'ended'); setSetting('race_end_ts', String(now)); break;
    case 'reset':
      db.exec('DELETE FROM solves; DELETE FROM attempts; DELETE FROM hints; DELETE FROM bonuses;');
      db.prepare('UPDATE teams SET hint_tokens = ?').run(HINT_TOKENS_DEFAULT);
      setSetting('race_state', 'idle'); setSetting('race_start_ts', ''); setSetting('race_end_ts', ''); break;
    default:
      return res.status(400).json({ error: 'Unknown action.' });
  }
  broadcast('update', { reason: 'clock', action });
  res.json({ ok: true, clock: clockState() });
});

function missionFromBody(b) {
  return {
    title: (b.title || '').trim() || 'Untitled stage',
    area: b.area || 'Finance',
    difficulty: ['Easy', 'Medium', 'Hard'].includes(b.difficulty) ? b.difficulty : 'Easy',
    points: Number.isFinite(parseInt(b.points, 10)) && parseInt(b.points, 10) >= 0 ? parseInt(b.points, 10) : (DIFF_POINTS[b.difficulty] || 5),
    minutes: Number.isFinite(parseInt(b.minutes, 10)) && parseInt(b.minutes, 10) >= 0 ? parseInt(b.minutes, 10) : 10,
    tour: b.tour || '', scenario: b.scenario || '', task: b.task || '',
    question: b.question || '', hint: b.hint || '', answers: (b.answers || '').trim(),
  };
}

app.post('/api/host/missions', requireAdmin, (req, res) => {
  const m = missionFromBody(req.body || {});
  const maxOrd = db.prepare('SELECT COALESCE(MAX(ord),0) AS o FROM missions').get().o;
  const info = db.prepare(`INSERT INTO missions (ord, title, area, difficulty, points, minutes, tour, scenario, task, question, hint, answers, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(maxOrd + 1, m.title, m.area, m.difficulty, m.points, m.minutes, m.tour, m.scenario, m.task, m.question, m.hint, m.answers, Date.now());
  broadcast('update', { reason: 'missions' });
  res.json({ ok: true, id: info.lastInsertRowid });
});

app.put('/api/host/missions/:id', requireAdmin, (req, res) => {
  if (!db.prepare('SELECT 1 FROM missions WHERE id = ?').get(req.params.id)) return res.status(404).json({ error: 'Not found.' });
  const m = missionFromBody(req.body || {});
  db.prepare(`UPDATE missions SET title=?, area=?, difficulty=?, points=?, minutes=?, tour=?, scenario=?, task=?, question=?, hint=?, answers=? WHERE id=?`)
    .run(m.title, m.area, m.difficulty, m.points, m.minutes, m.tour, m.scenario, m.task, m.question, m.hint, m.answers, req.params.id);
  broadcast('update', { reason: 'missions' });
  res.json({ ok: true });
});

app.delete('/api/host/missions/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM missions WHERE id = ?').run(req.params.id);
  broadcast('update', { reason: 'missions' });
  res.json({ ok: true });
});

app.post('/api/host/missions/reorder', requireAdmin, (req, res) => {
  const { order } = req.body || {};
  if (!Array.isArray(order)) return res.status(400).json({ error: 'order[] required.' });
  const upd = db.prepare('UPDATE missions SET ord = ? WHERE id = ?');
  db.transaction(() => order.forEach((id, i) => upd.run(i + 1, id)))();
  broadcast('update', { reason: 'missions' });
  res.json({ ok: true });
});

app.post('/api/host/teams', requireAdmin, (req, res) => {
  const name = ((req.body && req.body.name) || '').trim() || 'New Team';
  const code = genCode();
  const color = nextColor();
  const info = db.prepare('INSERT INTO teams (name, code, color, hint_tokens, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(name, code, color, HINT_TOKENS_DEFAULT, Date.now());
  broadcast('update', { reason: 'teams' });
  res.json({ ok: true, id: info.lastInsertRowid, code, color });
});

app.put('/api/host/teams/:id', requireAdmin, (req, res) => {
  const { name, color, hintTokens } = req.body || {};
  const t = db.prepare('SELECT * FROM teams WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found.' });
  db.prepare('UPDATE teams SET name = ?, color = ?, hint_tokens = ? WHERE id = ?')
    .run((name || t.name).trim(), color || t.color, Number.isInteger(hintTokens) ? hintTokens : t.hint_tokens, req.params.id);
  broadcast('update', { reason: 'teams' });
  res.json({ ok: true });
});

app.delete('/api/host/teams/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM teams WHERE id = ?').run(req.params.id);
  broadcast('update', { reason: 'teams' });
  res.json({ ok: true });
});

app.get('/api/host/hints', requireAdmin, (req, res) => {
  const teams = db.prepare('SELECT id, name, color FROM teams ORDER BY id').all();
  const missions = db.prepare('SELECT * FROM missions ORDER BY ord, id').all().filter(missionIsLive).map((m) => ({ id: m.id, title: m.title }));
  const cells = db.prepare('SELECT team_id, mission_id, requested, unlocked FROM hints').all();
  res.json({ teams, missions, cells });
});

app.post('/api/host/hint/unlock', requireAdmin, (req, res) => {
  const { teamId, missionId, lock } = req.body || {};
  db.prepare(`INSERT INTO hints (team_id, mission_id, requested, unlocked, requested_at) VALUES (?, ?, 1, ?, ?)
              ON CONFLICT(team_id, mission_id) DO UPDATE SET unlocked = excluded.unlocked`)
    .run(teamId, missionId, lock ? 0 : 1, Date.now());
  broadcast('update', { reason: 'hint-unlock' });
  res.json({ ok: true });
});

app.post('/api/host/manual', requireAdmin, (req, res) => {
  const { teamId, missionId, answer } = req.body || {};
  const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(teamId);
  const mission = db.prepare('SELECT * FROM missions WHERE id = ?').get(missionId);
  if (!team || !mission) return res.status(404).json({ error: 'Team or mission not found.' });
  if (!missionIsLive(mission)) return res.status(400).json({ error: 'Mission is a draft (no answer key).' });

  const now = Date.now();
  const correct = checkAnswer(mission.answers, answer);
  db.prepare('INSERT INTO attempts (team_id, mission_id, answer, normalized, correct, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(team.id, mission.id, String(answer || ''), normalizeAnswer(answer), correct ? 1 : 0, now);

  if (!correct) { broadcast('update', { reason: 'manual' }); return res.json({ correct: false }); }
  if (db.prepare('SELECT 1 FROM solves WHERE team_id = ? AND mission_id = ?').get(team.id, mission.id)) return res.json({ correct: true, note: 'Already solved.' });

  if (getSetting('race_state') !== 'running') {
    db.prepare('INSERT INTO solves (team_id, mission_id, points, used_hint, is_first, solved_at) VALUES (?, ?, 0, 0, 0, ?)').run(team.id, mission.id, now);
    broadcast('update', { reason: 'manual-late' });
    return res.json({ correct: true, points: 0, note: 'Recorded with 0 points (race not running).' });
  }
  const result = awardSolve(team, mission, now);
  broadcast('update', { reason: 'solve', teamName: team.name, missionTitle: mission.title, firstSolve: result.firstSolve });
  res.json({ correct: true, points: result.points, firstSolve: result.firstSolve, firstAll: result.firstAll });
});

// ---------------------------------------------------------------- page routes
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'team.html')));
app.get('/board', (req, res) => res.sendFile(path.join(__dirname, 'public', 'board.html')));
app.get('/host', (req, res) => res.sendFile(path.join(__dirname, 'public', 'host.html')));

// Tick once a second so boards stay in sync and the race auto-ends on time.
setInterval(() => {
  const ended = maybeAutoEnd();
  broadcast('tick', clockState());
  if (ended) broadcast('update', { reason: 'race-ended' });
}, 1000);

app.listen(PORT, () => {
  console.log(`VeloCraft Race Control running on http://localhost:${PORT}`);
  console.log(`  Team view    : http://localhost:${PORT}/`);
  console.log(`  Leaderboard  : http://localhost:${PORT}/board`);
  console.log(`  Facilitator  : http://localhost:${PORT}/host`);
});
