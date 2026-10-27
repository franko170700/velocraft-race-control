# 🚴 VeloCraft Race Control

A live, gamified **cycling-race scoreboard** for a 2-hour **SAP S/4HANA Public Cloud** hands-on training session (built for Accenture graduates). Teams work through SAP tasks dressed up as race *stages*, log their answers, and climb the *general classification* on a big projector leaderboard. The leader wears the **yellow jersey**. 🟡

Everything updates **live** via Server-Sent Events — no page refreshes, no build step.

---

## Views

| View | URL | Who | What |
|------|-----|-----|------|
| **Team** | `/` | Each team's laptop | Pick team + code, solve stages |
| **Leaderboard** | `/board` | Projector | General classification + "Race Radio" solve feed. Auto-updates. |
| **Facilitator** | `/host` | You (password) | Clock, stage CRUD + reorder, team CRUD, manual entry |

---

## Quick start (local)

Requires **Node.js 20+** (tested on 24 LTS).

```bash
# 1. install dependencies
npm install

# 2. create your config (copy the example and set a password)
cp .env.example .env
#   then edit .env → ADMIN_PASSWORD=something-only-you-know

# 3. run
npm start
```

Then open:

- Team view → http://localhost:3000/
- Leaderboard → http://localhost:3000/board
- Facilitator → http://localhost:3000/host  (log in with `ADMIN_PASSWORD`)

Use `npm run dev` for auto-restart on file changes.

The SQLite database is created automatically at `data/race.db` on first run and seeded with a demo stage and four sample teams.

---

## Running a session

1. Open **`/host`** and log in.
2. **Set the clock** length (default 60 min) and leave it idle until you're ready.
3. **Build your stages.** New stages start **hidden**. Add the accepted answer(s) in the stage editor — separate alternatives with `|` (e.g. `Century Cycles|Century-Cycles`). Answers are matched case-, accent- and punctuation-insensitively.
4. Reorder stages with ↑/↓. The planned-minutes total (of published stages) shows against the ~60 min target.
5. Share each team's **name + 4-character code** (shown in the Teams table) with that table of trainees.
6. Put **`/board`** on the projector.
7. Hit **▶ Start**. The clock counts down and published stages become answerable.
8. **Release stages one at a time** by clicking **Publish** on a stage (click **Hide** to pull it back). Teams only ever see published stages. Use **+5 min** for more time, **■ End now** to stop early. No points are awarded after the clock ends.
9. **↺ Reset scores** wipes all solves/attempts for a fresh run (teams and stages stay).

### Scoring

| Rule | Points |
|------|--------|
| Easy / Medium / Hard stage (base, editable per stage) | 5 / 10 / 15 |
| First team to solve a given stage | +3 |

Ties broken by stages solved, then earliest last-solve time.

---

## Deploy (Render / Railway)

Single Node service, no separate frontend. SQLite lives on disk, so attach a **persistent disk/volume** if you want data to survive restarts.

### Render

1. Push this folder to a Git repo.
2. New → **Web Service** → connect the repo.
3. Settings:
   - **Build command:** `npm install`
   - **Start command:** `npm start`
4. **Environment** → add:
   - `ADMIN_PASSWORD` = your password
   - (Render sets `PORT` automatically — the app reads it.)
5. (Recommended) **Disks** → add a disk mounted at `/opt/render/project/src/data` so the SQLite file persists across deploys.
6. Deploy. Your URLs are `https://<app>.onrender.com/`, `/board`, `/host`.

### Railway

1. New Project → **Deploy from GitHub repo**.
2. Railway auto-detects Node and runs `npm install` → `npm start`.
3. **Variables** → add `ADMIN_PASSWORD`. (`PORT` is injected automatically.)
4. (Recommended) add a **Volume** mounted at `/app/data` for database persistence.
5. Generate a domain under **Settings → Networking**.

> Without a persistent disk the database resets on every redeploy — fine for a one-off session, not for anything you want to keep.

---

## Configuration (`.env`)

| Key | Default | Purpose |
|-----|---------|---------|
| `ADMIN_PASSWORD` | `velocraft` | Facilitator login + `/api/host/*` auth. **Change this.** |
| `PORT` | `3000` | Port to listen on (host platforms override this). |

---

## How it works

- **Server:** Node + Express, `better-sqlite3` (synchronous, WAL mode, foreign keys).
- **Live updates:** one SSE stream (`/api/events`) broadcasting `update` (state changed) and `tick` (clock, every second) events. The server auto-ends the race when the clock hits zero.
- **Auth:** teams authenticate with `teamId` + shared 4-char `code` on each mutating request; the facilitator sends the admin password in an `x-admin-password` header. No user accounts.
- **Answer matching:** normalized server-side — lowercased, Unicode-decomposed with combining marks stripped, non-alphanumerics removed.
- **Anti-spam:** one submission per team per 3 seconds.

### Project layout

```
server.js            Express app, API, SSE, clock loop
db.js                SQLite schema + seed
util.js              answer normalization & matching
public/
  team.html  js/team.js      team view
  board.html js/board.js     projector leaderboard
  host.html  js/host.js      facilitator console
  css/styles.css             theme (light + dark, projector media query)
data/race.db                 created at runtime (gitignored)
.env / .env.example / .gitignore
```

---

Built for a single training room. Keep the admin password off the projector. 🏁
