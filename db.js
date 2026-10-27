'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'race.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS missions (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ord       INTEGER NOT NULL DEFAULT 0,
  title     TEXT NOT NULL,
  area      TEXT NOT NULL,
  difficulty TEXT NOT NULL DEFAULT 'Easy',
  points    INTEGER NOT NULL DEFAULT 5,
  minutes   INTEGER NOT NULL DEFAULT 10,
  tour      TEXT DEFAULT '',
  scenario  TEXT DEFAULT '',
  task      TEXT DEFAULT '',
  question  TEXT DEFAULT '',
  hint      TEXT DEFAULT '',
  answers   TEXT DEFAULT '',          -- pipe-separated accepted answers; empty = draft
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS teams (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  name      TEXT NOT NULL,
  code      TEXT NOT NULL UNIQUE,
  color     TEXT NOT NULL DEFAULT '#f4c430',
  hint_tokens INTEGER NOT NULL DEFAULT 3,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS attempts (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id   INTEGER NOT NULL,
  mission_id INTEGER NOT NULL,
  answer    TEXT NOT NULL,
  normalized TEXT NOT NULL,
  correct   INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE,
  FOREIGN KEY (mission_id) REFERENCES missions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS solves (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id   INTEGER NOT NULL,
  mission_id INTEGER NOT NULL,
  points    INTEGER NOT NULL,
  used_hint INTEGER NOT NULL DEFAULT 0,
  is_first  INTEGER NOT NULL DEFAULT 0,
  solved_at INTEGER NOT NULL,
  UNIQUE (team_id, mission_id),
  FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE,
  FOREIGN KEY (mission_id) REFERENCES missions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS hints (
  team_id   INTEGER NOT NULL,
  mission_id INTEGER NOT NULL,
  requested INTEGER NOT NULL DEFAULT 0,
  unlocked  INTEGER NOT NULL DEFAULT 0,
  requested_at INTEGER,
  PRIMARY KEY (team_id, mission_id),
  FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE,
  FOREIGN KEY (mission_id) REFERENCES missions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS bonuses (
  key       TEXT PRIMARY KEY,         -- e.g. 'first_all' once awarded
  team_id   INTEGER NOT NULL,
  awarded_at INTEGER NOT NULL
);
`);

// ---- settings helpers ----
const getSettingStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
const setSettingStmt = db.prepare(
  'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
);
function getSetting(key, fallback = null) {
  const row = getSettingStmt.get(key);
  return row ? row.value : fallback;
}
function setSetting(key, value) {
  setSettingStmt.run(key, value == null ? null : String(value));
}

// ---- one-time seed ----
function seed() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM missions').get().n;
  if (count > 0) return;
  const now = Date.now();

  setSetting('race_state', 'idle');          // idle | running | ended
  setSetting('race_length_sec', String(60 * 60));
  setSetting('race_start_ts', '');
  setSetting('race_end_ts', '');

  const insMission = db.prepare(`
    INSERT INTO missions (ord, title, area, difficulty, points, minutes, tour, scenario, task, question, hint, answers, created_at)
    VALUES (@ord, @title, @area, @difficulty, @points, @minutes, @tour, @scenario, @task, @question, @hint, @answers, @created_at)
  `);

  insMission.run({
    ord: 1,
    title: 'The Big Picture',
    area: 'Finance',
    difficulty: 'Easy',
    points: 5,
    minutes: 12,
    tour: 'Sales analysis / Sales volume by customer group',
    scenario:
      "CFO Anna Müller has an investor call tomorrow and needs a quick health check on sales: how are sales trending, which customer groups lead, and are the new e-bikes gaining traction?",
    task:
      "Follow the trial's sales analysis guided tour and review sales volume by customer group, then look up the billing document named in the question.",
    question: 'Who is the customer on billing document 90000003?',
    hint: 'Open the billing document list / Manage Billing Documents app and search for document 90000003 — the sold-to party is the customer.',
    answers: 'Century Cycles',
    created_at: now,
  });

  const drafts = [
    {
      title: 'Closing the Deal',
      area: 'Order Management',
      difficulty: 'Medium',
      points: 10,
      minutes: 12,
      tour: '(to be confirmed after trial testing)',
      scenario:
        'A VeloCraft sales colleague needs help turning a customer enquiry into a confirmed sales order in S/4HANA.',
    },
    {
      title: 'Running Low!',
      area: 'Sourcing & Purchasing',
      difficulty: 'Medium',
      points: 10,
      minutes: 12,
      tour: '(to be confirmed after trial testing)',
      scenario:
        'Stock of a key component is running low. Purchasing needs to find the right source and raise a purchase order.',
    },
    {
      title: "Know What You've Got",
      area: 'Supply Chain',
      difficulty: 'Medium',
      points: 10,
      minutes: 12,
      tour: '(to be confirmed after trial testing)',
      scenario:
        'The warehouse team wants a clear view of current stock on hand for the RX road-bike line.',
    },
    {
      title: 'The Bottom Line',
      area: 'Finance',
      difficulty: 'Hard',
      points: 15,
      minutes: 12,
      tour: '(to be confirmed after trial testing)',
      scenario:
        'Anna Müller wants a closer look at profitability — which product line is really carrying the margin?',
    },
  ];

  drafts.forEach((d, i) =>
    insMission.run({
      ord: i + 2,
      title: d.title,
      area: d.area,
      difficulty: d.difficulty,
      points: d.points,
      minutes: d.minutes,
      tour: d.tour,
      scenario: d.scenario,
      task: '',
      question: '',
      hint: '',
      answers: '', // draft: no answer yet, hidden from teams
      created_at: now,
    })
  );

  const insTeam = db.prepare(
    'INSERT INTO teams (name, code, color, hint_tokens, created_at) VALUES (?, ?, ?, 3, ?)'
  );
  const sampleTeams = [
    ['Peloton', 'PELO', '#f4c430'],
    ['Breakaway', 'BRK7', '#e4572e'],
    ['Domestiques', 'DOMS', '#1e88e5'],
    ['Sprinters', 'SPNT', '#2ecc71'],
  ];
  sampleTeams.forEach((t) => insTeam.run(t[0], t[1], t[2], now));
}

seed();

module.exports = { db, getSetting, setSetting };
