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
      minutes: 5,
      tour: 'Mission 1',
      scenario:
        "Lena Hoffmann storms into your office with two coffees and hands you one. The Grand Tour organisers want a partner that is growing. Last year, VeloCraft took a big bet: an indoor Exercise Bike line for training days when riders can't get out on the road.\n\nHalf the board thinks it's the future. The other half wants to kill it and stick to classic road and mountain bikes. Before Friday, Max needs proof: are the Exercise Bikes a real business, or an expensive hobby?\n\nLena, on her way out: \"Tip: don't stare at the grand total. Break the sales down by product group and look closely: not every bar has a label.\"",
      task:
        "1. Search for the Sales Volume tile\n2. Add a new analysis step\n3. Break the sales volume down by product group\n4. Visualize it in a way that lets you read the sales volume of each product group",
      question: "What is the sales volume of the 'Exercise Bike' product group? (Round to the nearest million, e.g. 126 million or 126 M)",
      answers: '501 Million | 501m | 501M | 501 Million USD | 501 million USD | 501',
      published: 1,
    },
    {
      title: 'Where Are Our Bikes?',
      area: 'Order Management',
      difficulty: 'Easy',
      points: 5,
      minutes: 5,
      tour: 'Mission 2',
      scenario:
        "Success has a downside. Thanks to the Grand Tour buzz, orders are flooding in, and some of them are stuck. Bikes that were promised for next week haven't left the warehouse.\n\nCustomer service is drowning in angry calls. If the wrong customer cancels this week, it lands in front of the investors and the race organisers on Friday. Lena wants to call the most important one personally, before they walk away.\n\nLena, picking up the phone: \"Tip: the fulfillment app shows where every order is stuck. Check the delivery issues for week 48. CostClub is the one I need.\"",
      task:
        "1. Open Sales Order Fulfillment to find where the process is stuck.\n2. Narrow the issues down to orders stuck in delivery\n3. Focus on the domestic sales organisation and requested delivery week CW 48\n4. Find CostClub in the list of sales documents with issues",
      question: "CostClub has a sales order (valued at $1220) with fulfillment issues in CW 48. What is its sales document number?",
      answers: '323496',
      published: 0,
    },
    {
      title: 'Never Late Again',
      area: 'Sourcing & Procurement',
      difficulty: 'Medium',
      points: 10,
      minutes: 5,
      tour: 'Mission 3',
      scenario:
        "Jonas Becker has had enough. Last quarter a critical supplier delivered 200 bike frames 3 weeks late, and the EX-800 e-bike launch had to be postponed. Now the same problem threatens the bikes VeloCraft has promised for the Grand Tour.\n\nHis new rule, effective immediately: ALL new purchase orders must include a SAP-predicted delivery date before they can be approved. No exceptions. And before VeloCraft orders the frames for the Grand Tour bikes, he wants to check one supplier in particular.\n\nJonas, already at the door: \"Tip: we already have a contract with this supplier, so build the order from it. And write down your PO number: you'll need it to track the order.\"",
      task:
        "1. Create a new purchase order for supplier USSU-VSF01\n2. Add the item from the supplier's existing purchase contract and order 1 PC\n3. Copy your PO number before you leave the order\n4. Find your order among the purchase order items to monitor (in USD) and let SAP predict its delivery",
      question: "Create a purchase order for 1 PC from supplier 'USSU-VSF01' from its existing purchase contract. What delivery status does SAP predict?\n\nCopy your PO number (45000#####): you need it to monitor the order",
      answers: 'On Time | ontime | OnTime | On-Time | on-time',
      published: 0,
    },
    {
      title: 'Stop Leaving Money on the Table',
      area: 'Finance',
      difficulty: 'Medium',
      points: 10,
      minutes: 5,
      tour: 'Mission 4',
      scenario:
        "Building bikes for the Grand Tour means big supplier invoices, and Anna Müller needs every euro. VeloCraft pays tens of thousands of euros in supplier invoices every month. Many suppliers offer early-payment discounts, but the AP team has been missing them.\n\nOne supplier in particular stands out: their offered discounts are the lowest in the portfolio, suggesting something isn't right. Anna wants to walk into Friday's meeting with a savings plan that proves VeloCraft's finances are race-ready.\n\nAnna, over her glasses: \"Tip: start with the big picture of everything we owe our suppliers. And the board wants dollars, so make sure the report is in USD.\"",
      task:
        "1. You want an overview of accounts payable: find the right app\n2. Make sure the report shows USD (company code 1710)\n3. Look at how well cash discounts are being used, per supplier\n4. Add the Offered Discounts measure and compare the suppliers",
      question: "Which supplier had the lowest Offered Discounts?\n\nShow the report in USD",
      answers: 'WaveCrest Labs | wavecrest labs | Wavecrest labs | Wavecrest Labs | wavecrest Labs',
      published: 0,
    },
    {
      title: 'The Final Climb',
      area: 'Supply Chain',
      difficulty: 'Hard',
      points: 15,
      minutes: 10,
      tour: '',
      scenario:
        "Friday, 6:45 AM. Two hours before the board meeting, Jonas Becker calls. The race organisers' logistics team has flagged the Cruise E-Bike as a slow-moving good in plant 1710. If bikes are gathering dust in the warehouse, the investors will ask why.\n\nJonas needs one number before 9:00: how much Cruise E-Bike stock VeloCraft will still be holding next quarter. No guided tour this time. You've learned the system all week. Now prove it.\n\nJonas, before he hangs up: \"Tip: SAP has an app made for slow movers. Plant 1710, today's date, USD. Then look ahead to next quarter.\"",
      task: "No Guide for this task :)",
      question: "The Cruise E-Bike is reported as a slow-moving good in plant 1710 at its warehouse location. What is its stock quantity for the next quarter?\n\nShow the report in USD",
      answers: '7011 | 7,011 pc | 7,011 PC | 7011 pc | 7011 PC',
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
    ['Breakaway',   'BRK-26', '#e4572e'],
    ['Peloton',     'PEL-26', '#f4c430'],
    ['Domestiques', 'DOM-26', '#1e88e5'],
    ['Sprinters',   'SPR-26', '#2ecc71'],
    ['Climbers',    'CLM-26', '#e53935'],
  ];
  sampleTeams.forEach((t) => insTeam.run(t[0], t[1], t[2], now));
}

seed();

module.exports = { db, getSetting, setSetting };
