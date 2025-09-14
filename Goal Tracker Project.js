/**
 * GoalTrack — Fullstack Goal Tracker
 * Single-file project (Node.js + Express + SQLite + Embedded Frontend)
 *
 * Usage:
 *   npm install express sqlite3 body-parser
 *   node server.js
 *   Open http://localhost:3000
 */

const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const bodyParser = require("body-parser");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;

// --- Database ---
if (!fs.existsSync("data")) fs.mkdirSync("data");
const db = new sqlite3.Database("data/goals.db");

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS goals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT,
    cadence TEXT NOT NULL CHECK (cadence IN ('daily','weekly','monthly')),
    target_value INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    goal_id INTEGER NOT NULL,
    entry_date DATE NOT NULL,
    value INTEGER DEFAULT 1,
    note TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(goal_id) REFERENCES goals(id) ON DELETE CASCADE
  )`);
});

// --- Middleware ---
app.use(bodyParser.json());

// --- Utility functions ---
function runQuery(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}

function getGoal(id) {
  return new Promise((resolve, reject) => {
    db.get("SELECT * FROM goals WHERE id = ?", [id], (err, row) =>
      err ? reject(err) : resolve(row)
    );
  });
}

function countEntries(goal_id, start, end) {
  return new Promise((resolve, reject) => {
    db.get(
      "SELECT COALESCE(SUM(value),0) as sumv FROM logs WHERE goal_id = ? AND entry_date BETWEEN ? AND ?",
      [goal_id, start, end],
      (err, row) => (err ? reject(err) : resolve(row))
    );
  });
}

function getPeriodBounds(cadence, ref = null) {
  const d = ref ? new Date(ref) : new Date();
  if (cadence === "daily") {
    const s = d.toISOString().slice(0, 10);
    return [s, s];
  } else if (cadence === "weekly") {
    const day = d.getDay();
    const mondayOffset = day === 0 ? -6 : 1 - day;
    const start = new Date(d);
    start.setDate(d.getDate() + mondayOffset);
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    return [start.toISOString().slice(0, 10), end.toISOString().slice(0, 10)];
  } else {
    const start = new Date(d.getFullYear(), d.getMonth(), 1);
    const end = new Date(d.getFullYear(), d.getMonth() + 1, 0);
    return [start.toISOString().slice(0, 10), end.toISOString().slice(0, 10)];
  }
}

async function computeStats(goal) {
  const [start, end] = getPeriodBounds(goal.cadence);
  const counts = await countEntries(goal.id, start, end);
  const progress = Math.min(
    100,
    Math.round((counts.sumv / Math.max(goal.target_value || 1, 1)) * 100)
  );
  return { period_start: start, period_end: end, progress_percent: progress };
}

// --- API Routes ---
app.get("/api/goals", async (req, res) => {
  try {
    const rows = await runQuery("SELECT * FROM goals ORDER BY created_at DESC");
    const goals = [];
    for (const r of rows) {
      const stats = await computeStats(r);
      goals.push({ ...r, stats });
    }
    res.json({ goals });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/goals", (req, res) => {
  const { title, description = "", cadence = "daily", target_value = 1 } =
    req.body;
  if (!title) return res.status(400).json({ error: "title required" });
  db.run(
    "INSERT INTO goals (title, description, cadence, target_value) VALUES (?,?,?,?)",
    [title, description, cadence, target_value],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      getGoal(this.lastID).then(async (g) => {
        const stats = await computeStats(g);
        res.status(201).json({ ...g, stats });
      });
    }
  );
});

app.post("/api/logs", (req, res) => {
  const { goal_id, entry_date, value = 1, note = "" } = req.body;
  const date = entry_date || new Date().toISOString().slice(0, 10);
  db.run(
    "INSERT INTO logs (goal_id, entry_date, value, note) VALUES (?,?,?,?)",
    [goal_id, date, value, note],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.status(201).json({ id: this.lastID, ok: true });
    }
  );
});

app.get("/api/logs", async (req, res) => {
  const rows = await runQuery(
    "SELECT * FROM logs ORDER BY entry_date DESC LIMIT 50"
  );
  res.json({ logs: rows });
});

// --- Frontend (embedded HTML/JS/CSS) ---
const frontendHTML = `
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>GoalTrack</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet">
<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
</head>
<body class="p-4">
<h2>Goal Tracker</h2>
<form id="goalForm" class="mb-3">
  <input class="form-control mb-2" id="title" placeholder="Goal title" required>
  <select class="form-select mb-2" id="cadence">
    <option value="daily">Daily</option>
    <option value="weekly">Weekly</option>
    <option value="monthly">Monthly</option>
  </select>
  <input class="form-control mb-2" id="target" type="number" value="1" min="1">
  <button class="btn btn-primary">Add Goal</button>
</form>
<div id="goals"></div>
<h4 class="mt-4">Logs</h4>
<div id="logs"></div>
<script>
async function load(){
  const g = await fetch('/api/goals').then(r=>r.json());
  const l = await fetch('/api/logs').then(r=>r.json());
  render(g.goals, l.logs);
}
function render(goals, logs){
  const c = document.getElementById('goals'); c.innerHTML='';
  goals.forEach(g=>{
    c.innerHTML += \`<div class="card mb-2 p-2">
      <b>\${g.title}</b> (\${g.cadence}) — \${g.stats.progress_percent}% this period
      <button class="btn btn-sm btn-success ms-2" onclick="log(\${g.id})">Log</button>
    </div>\`;
  });
  const lc = document.getElementById('logs'); lc.innerHTML='';
  logs.forEach(l=>{
    lc.innerHTML += \`<div>\${l.entry_date}: Goal #\${l.goal_id} (+\${l.value}) \${l.note||''}</div>\`;
  });
}
document.getElementById('goalForm').onsubmit=async(e)=>{
  e.preventDefault();
  await fetch('/api/goals',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({title:title.value,cadence:cadence.value,target_value:target.value})});
  load();
}
async function log(goal_id){
  await fetch('/api/logs',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({goal_id, value:1})});
  load();
}
load();
</script>
</body>
</html>
`;

app.get("/", (req, res) => res.send(frontendHTML));

// --- Start server ---
app.listen(PORT, () =>
  console.log("GoalTrack running → http://localhost:" + PORT)
);
