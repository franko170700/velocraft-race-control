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
  answers   TEXT DEFAULT '',          -- pipe-separated accepted answers; empty = no answer key yet
  published INTEGER NOT NULL DEFAULT 0, -- 0 = hidden from teams, 1 = released
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

// ---- migrations (for databases created before a column existed) ----
function migrate() {
  const cols = db.prepare('PRAGMA table_info(missions)').all().map((c) => c.name);
  if (!cols.includes('published')) {
    db.exec('ALTER TABLE missions ADD COLUMN published INTEGER NOT NULL DEFAULT 0');
    // keep stages that were already visible (they had an answer) visible after upgrade
    db.exec("UPDATE missions SET published = 1 WHERE answers != ''");
  }
}
migrate();

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
    INSERT INTO missions (ord, title, area, difficulty, points, minutes, tour, scenario, task, question, hint, answers, published, created_at)
    VALUES (@ord, @title, @area, @difficulty, @points, @minutes, @tour, @scenario, @task, @question, @hint, @answers, @published, @created_at)
  `);

  const missions = [
    {
      title: 'Is the Indoor Bet Paying Off?',
      area: 'Sales',
      difficulty: 'Easy',
      points: 5,
      minutes: 12,
      tour: 'Sales Volume (Detailed Analysis)',
      scenario:
        "VeloCraft bet big on a new indoor Exercise Bike line. Half the board calls it the future; the other half wants it gone. Before Friday, prove whether the Exercise Bikes are a real business — by comparing their sales against the classic groups (Racing, E-Bikes, Youth).",
      task:
        "1. Sales tab → open the Sales Volume tile (Detailed Analysis).\n2. Set Display Currency to USD.\n3. Click + (bottom-left) to add an analysis step.\n4. Choose 'Sales Volume by Product Group'.\n5. Hover each bar to read its name, ID and USD volume — find the Exercise Bikes bar (just below Youth).",
      question: 'What is the Exercise Bikes product group ID, and how much sales volume (USD) did it generate?',
      answers: 'ZEXBK | 500,800,490.08 | 500800490.08 | 500,800,490.08 USD',
      published: 1,
    },
    {
      title: 'Where Are Our Bikes?',
      area: 'Order Management',
      difficulty: 'Medium',
      points: 10,
      minutes: 15,
      tour: 'Sales Order Fulfillment (Analyze and Resolve Issues)',
      scenario:
        "Grand Tour buzz means orders are flooding in — and some are stuck in delivery. Customer service is swamped, and the wrong cancellation could blow up in Friday's investor meeting. Lena wants to call the most important at-risk customer personally, before they walk.",
      task:
        "1. Sales tab → open Sales Order Fulfillment (Analyze and Resolve Issues).\n2. In 'Issues Total by Issue Category', click In Delivery.\n3. In 'Issues Total by Sales Organization', click Dom. Sales Org.\n4. Scroll right; in 'Issues by Week of Requested Delivery', click CW 48, then Go.\n5. Scroll to 'Sales Documents with Issues' and check the Net Value column.",
      question: 'Which customer has the stuck CW 48 order with the highest net value? Enter the customer name or ID.',
      answers: 'Westend Cycles | USCU_S07 | Westend Cycles (USCU_S07)',
      published: 0,
    },
    {
      title: 'Never Late Again',
      area: 'Sourcing & Purchasing',
      difficulty: 'Hard',
      points: 15,
      minutes: 18,
      tour: 'Manage Purchase Orders · Add from Document · ML Delivery Prediction',
      scenario:
        "A late supplier once delayed the EX-800 launch by three weeks, and Jonas won't risk the Grand Tour frames. New rule: every PO needs a SAP-predicted delivery date before approval. Build a PO and predict its date — then check one supplier in particular.",
      task:
        "1. Other tab → Manage Purchase Orders → Create.\n2. Supplier: USSU-VSF01.\n3. Items → Add from Document; set type Purchase Contract → Go.\n4. Select the contract → Add Items. Order Quantity 1 PC → Order. Note your PO number (45000#####).\n5. Home → Monitor Purchase Order Items. Search your PO, currency USD → Go.\n6. Select your PO row → Predict Delivery Date.\n\nFor the question: repeat steps 1–3 but choose type 'Purchase Order' and supplier 'Steel & Moore Inc.', then find the Y300 T Bike material.",
      question: "For supplier 'Steel & Moore Inc.', what is the Delivery Status of the Y300 T Bike material?",
      answers: 'On-time | On time | Ontime',
      published: 0,
    },
    {
      title: 'Stop Leaving Money on the Table',
      area: 'Finance',
      difficulty: 'Medium',
      points: 10,
      minutes: 15,
      tour: 'Accounts Payable Overview · Cash Discount Analysis',
      scenario:
        "Big Grand Tour supplier invoices mean Anna needs every euro. Many suppliers offer early-payment discounts the AP team keeps missing — and one supplier's offered discounts look suspiciously low. Find it, so Anna walks into Friday with a savings plan.",
      task:
        "(Company code 1710 · currency USD)\n1. Finance tab → Accounts Payable → Accounts Payable Overview.\n2. Set currency USD and enter company code 1710.\n3. Open Cash Discount Utilization; filter by Supplier.\n4. Settings tab → add the measure 'Offered Discounts' (alongside the ratio).\n5. Compare Offered Discounts across suppliers to spot the lowest.",
      question: 'Which supplier had the LOWEST Offered Cash Discounts?',
      answers: 'WaveCrest Labs | WaveCrest | Wavecrest Labs',
      published: 0,
    },
  ];

  missions.forEach((m, i) =>
    insMission.run({
      ord: i + 1,
      title: m.title,
      area: m.area,
      difficulty: m.difficulty,
      points: m.points,
      minutes: m.minutes,
      tour: m.tour,
      scenario: m.scenario,
      task: m.task,
      question: m.question,
      hint: '',
      answers: m.answers,
      published: m.published,
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
