require("dotenv").config();
const express = require("express");
const cors    = require("cors");
const { v4: uuidv4 } = require("uuid");
const bcrypt  = require("bcryptjs");
const Groq    = require("groq-sdk");
const path    = require("path");
const db      = require("./db");

const app  = express();
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "../public")));

// ── CONSTANTS ────────────────────────────────────────────────
const ADMIN_DOMAIN = "@ticket.com"; // admins must register with username@ticket.com

// ── PREPARED STATEMENTS ──────────────────────────────────────
const stmts = {
  findUserByUsername: db.prepare("SELECT * FROM users WHERE username = ?"),
  findUserByEmail:    db.prepare("SELECT * FROM users WHERE email = ?"),
  findUserById:       db.prepare("SELECT * FROM users WHERE id = ?"),
  insertUser:         db.prepare("INSERT INTO users (id, username, email, password_hash, role, name, avatar) VALUES (?, ?, ?, ?, ?, ?, ?)"),
  listStaff:          db.prepare("SELECT id, name, role FROM users WHERE role IN ('admin','agent')"),

  insertSession:      db.prepare("INSERT INTO sessions (token, user_id) VALUES (?, ?)"),
  findSession:        db.prepare("SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?"),
  deleteSession:      db.prepare("DELETE FROM sessions WHERE token = ?"),

  insertTicket: db.prepare(`INSERT INTO tickets
    (id, uid, title, description, submitted_by, submitted_by_user_id, category, priority, confidence, summary, keywords, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Open', datetime('now'), datetime('now'))`),
  findTicketByUid:    db.prepare("SELECT * FROM tickets WHERE uid = ?"),
  countTickets:       db.prepare("SELECT COUNT(*) AS n FROM tickets"),
  maxTicketNumber:    db.prepare("SELECT id FROM tickets ORDER BY rowid DESC LIMIT 1"),

  updateStatus:   db.prepare("UPDATE tickets SET status = ?, updated_at = datetime('now') WHERE uid = ?"),
  updateAssign:   db.prepare("UPDATE tickets SET assigned_to = ?, updated_at = datetime('now') WHERE uid = ?"),
  updateResponse: db.prepare("UPDATE tickets SET response = ?, tone = ?, status = 'Responded', responded_by = ?, updated_at = datetime('now') WHERE uid = ?"),
  deleteTicket:   db.prepare("DELETE FROM tickets WHERE uid = ?"),
  deleteClosed:   db.prepare("DELETE FROM tickets WHERE status = 'Closed'"),
  countClosed:    db.prepare("SELECT COUNT(*) AS n FROM tickets WHERE status = 'Closed'"),

  insertComment: db.prepare("INSERT INTO comments (id, ticket_uid, text, author, role, avatar, created_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))"),
  listComments:  db.prepare("SELECT * FROM comments WHERE ticket_uid = ? ORDER BY created_at ASC"),

  insertAudit: db.prepare("INSERT INTO audit_log (id, action, by_name, role, detail, at) VALUES (?, ?, ?, ?, ?, datetime('now'))"),
  listAudit:   db.prepare("SELECT * FROM audit_log ORDER BY at DESC LIMIT 80"),
};

// ── HELPERS ──────────────────────────────────────────────────
function audit(action, user, detail) {
  stmts.insertAudit.run(uuidv4(), action, user.name, user.role, detail);
}

function ticketFromRow(row) {
  return {
    id: row.id,
    uid: row.uid,
    title: row.title,
    description: row.description,
    submittedBy: row.submitted_by,
    submittedByUserId: row.submitted_by_user_id,
    classification: {
      category: row.category,
      priority: row.priority,
      confidence: row.confidence,
      summary: row.summary,
      keywords: JSON.parse(row.keywords || "[]"),
    },
    status: row.status,
    response: row.response,
    tone: row.tone,
    respondedBy: row.responded_by,
    assignedTo: row.assigned_to,
    comments: stmts.listComments.all(row.uid).map(c => ({
      id: c.id, text: c.text, author: c.author, role: c.role, avatar: c.avatar, at: c.created_at,
    })),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function nextTicketId() {
  const last = stmts.maxTicketNumber.get();
  if (!last) return "TKT-1001";
  const n = parseInt(last.id.split("-")[1], 10) || 1000;
  return `TKT-${n + 1}`;
}

function avatarFromName(name) {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] || "") + (parts[1]?.[0] || "")).toUpperCase() || "U";
}

// ── MIDDLEWARE ───────────────────────────────────────────────
function auth(req, res, next) {
  const row = stmts.findSession.get(req.headers["x-session-token"]);
  if (!row) return res.status(401).json({ error: "Unauthorised. Please log in." });
  req.user = { id: row.id, username: row.username, email: row.email, role: row.role, name: row.name, avatar: row.avatar };
  next();
}
function adminOnly(req, res, next) {
  if (req.user.role !== "admin") return res.status(403).json({ error: "Admin access required." });
  next();
}
function staffOnly(req, res, next) {
  if (!["admin", "agent"].includes(req.user.role)) return res.status(403).json({ error: "Staff access required." });
  next();
}

// ── AI PROMPTS ───────────────────────────────────────────────
const CLASSIFY_PROMPT = `You are a professional IT service desk classifier. Respond ONLY with valid JSON — no extra text, no markdown:
{
  "category": "<HR | IT | Finance | Operations>",
  "priority": "<Low | Medium | High | Critical>",
  "confidence": <integer 0-100>,
  "summary": "<one sentence summary>",
  "keywords": ["<kw1>", "<kw2>", "<kw3>"]
}
Category rules:
  HR         → payroll, leave, onboarding, offboarding, benefits, contracts, recruitment
  IT         → software, hardware, access, passwords, network, devices, bugs, installations
  Finance    → invoices, expenses, budgets, payments, reimbursements, procurement
  Operations → facilities, logistics, maintenance, office, supply chain
Priority rules:
  Critical   → system down, security breach, payroll failure, work completely stopped
  High       → major functionality broken, multiple users affected
  Medium     → partial issue, single user, workaround exists
  Low        → minor, cosmetic, informational`;

const RESPOND_PROMPT = `You are a professional service desk analyst writing a response to a support ticket.
Rules:
  1. Acknowledge the specific issue by name
  2. Provide clear actionable next steps
  3. Give a realistic timeline or owner
  4. Close professionally
Tone guide:
  formal   → corporate, structured language
  friendly → warm, first-name, encouraging
  urgent   → direct, action-first, no small talk
Output: plain message body only — no subject line, no JSON, 3–5 paragraphs max.`;

const INSIGHT_PROMPT = `You are a service desk analytics AI. Given a list of support tickets, write exactly 3 sentences:
1. What the overall workload looks like right now.
2. The most common or urgent issue type.
3. One specific, actionable recommendation.
Plain text only — no bullet points, no headers, no markdown.`;

// ── AUTH: REGISTER ───────────────────────────────────────────
app.post("/api/auth/register", (req, res) => {
  let { username, email, password, name, role } = req.body;
  username = (username || "").trim().toLowerCase();
  email    = (email || "").trim().toLowerCase();
  name     = (name || "").trim();
  role     = role === "admin" ? "admin" : "user"; // only admin or user can self-register; agents are provisioned separately

  if (!username || !email || !password || !name)
    return res.status(400).json({ error: "All fields are required." });

  if (password.length < 6)
    return res.status(400).json({ error: "Password must be at least 6 characters." });

  if (!/^[a-zA-Z0-9_.-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(email))
    return res.status(400).json({ error: "Please enter a valid email address." });

  // Admin registration requires @ticket.com domain
  if (role === "admin" && !email.endsWith(ADMIN_DOMAIN)) {
    return res.status(400).json({ error: `Admin accounts must register with an email ending in "${ADMIN_DOMAIN}" (e.g. yourname${ADMIN_DOMAIN}).` });
  }

  // Prevent a "user" role from registering with an @ticket.com email pretending not to be admin —
  // optional safeguard: if email matches admin domain but role chosen is "user", still allow (they're staff using personal accounts is unusual but not blocked here).

  if (stmts.findUserByUsername.get(username))
    return res.status(409).json({ error: "That username is already taken." });
  if (stmts.findUserByEmail.get(email))
    return res.status(409).json({ error: "That email is already registered." });

  const id   = uuidv4();
  const hash = bcrypt.hashSync(password, 10);
  const avatar = avatarFromName(name);

  stmts.insertUser.run(id, username, email, hash, role, name, avatar);
  audit("REGISTER", { name, role }, `${name} registered as ${role} (${email})`);

  const token = uuidv4();
  stmts.insertSession.run(token, id);

  res.json({ token, user: { id, name, role, avatar, username, email } });
});

// ── AUTH: LOGIN ──────────────────────────────────────────────
app.post("/api/auth/login", (req, res) => {
  const { username, password } = req.body;
  const u = stmts.findUserByUsername.get((username || "").trim().toLowerCase());
  if (!u || !bcrypt.compareSync(password || "", u.password_hash))
    return res.status(401).json({ error: "Incorrect username or password." });

  const token = uuidv4();
  stmts.insertSession.run(token, u.id);
  audit("LOGIN", u, `${u.name} signed in`);
  res.json({ token, user: { id: u.id, name: u.name, role: u.role, avatar: u.avatar, username: u.username, email: u.email } });
});

app.post("/api/auth/logout", auth, (req, res) => {
  audit("LOGOUT", req.user, `${req.user.name} signed out`);
  stmts.deleteSession.run(req.headers["x-session-token"]);
  res.json({ ok: true });
});

app.get("/api/auth/me", auth, (req, res) => {
  const u = req.user;
  res.json({ user: { id: u.id, name: u.name, role: u.role, avatar: u.avatar, username: u.username, email: u.email } });
});

// ── CLASSIFY ─────────────────────────────────────────────────
app.post("/api/classify", auth, async (req, res) => {
  const { title, description, submittedBy } = req.body;
  if (!title || !description) return res.status(400).json({ error: "Title and description are required." });
  try {
    const c = await groq.chat.completions.create({
      model: "openai/gpt-oss-120b",
      messages: [
        { role: "system", content: CLASSIFY_PROMPT },
        { role: "user",   content: `Ticket Title: ${title}\n\nDescription: ${description}` },
      ],
      temperature: 0.1,
      max_tokens: 300,
    });
    const raw = c.choices[0].message.content.trim();
    let cl;
    try { cl = JSON.parse(raw); }
    catch { const m = raw.match(/\{[\s\S]*\}/); cl = m ? JSON.parse(m[0]) : null; }
    if (!cl) return res.status(500).json({ error: "AI returned an unreadable response. Try again." });

    const id  = nextTicketId();
    const uid = uuidv4();
    stmts.insertTicket.run(
      id, uid, title, description,
      submittedBy || req.user.name, req.user.id,
      cl.category, cl.priority, cl.confidence, cl.summary, JSON.stringify(cl.keywords || [])
    );
    audit("TICKET_CREATED", req.user, `Created ${id}: ${title}`);
    const ticket = ticketFromRow(stmts.findTicketByUid.get(uid));
    res.json({ ticket });
  } catch (e) {
    console.error("classify error:", e.message);
    res.status(500).json({ error: "Classification failed. Verify your GROQ_API_KEY." });
  }
});

// ── RESPOND ──────────────────────────────────────────────────
app.post("/api/respond/:uid", auth, staffOnly, async (req, res) => {
  const { tone = "formal" } = req.body;
  const row = stmts.findTicketByUid.get(req.params.uid);
  if (!row) return res.status(404).json({ error: "Ticket not found." });

  const toneDesc = { formal: "formal and corporate", friendly: "warm and friendly", urgent: "urgent and action-focused" };
  try {
    const c = await groq.chat.completions.create({
      model: "openai/gpt-oss-120b",
      messages: [
        { role: "system", content: RESPOND_PROMPT },
        { role: "user",   content: `Tone: ${toneDesc[tone] || "formal"}\nTicket ID: ${row.id}\nCategory: ${row.category}\nPriority: ${row.priority}\nTitle: ${row.title}\nDescription: ${row.description}\nSubmitted by: ${row.submitted_by}` },
      ],
      temperature: 0.65,
      max_tokens: 600,
    });
    const response = c.choices[0].message.content.trim();
    stmts.updateResponse.run(response, tone, req.user.name, req.params.uid);
    audit("RESPONDED", req.user, `${row.id} — ${tone} tone response`);
    const ticket = ticketFromRow(stmts.findTicketByUid.get(req.params.uid));
    res.json({ response, ticket });
  } catch (e) {
    console.error("respond error:", e.message);
    res.status(500).json({ error: "Response generation failed." });
  }
});

// ── TICKETS LIST ─────────────────────────────────────────────
app.get("/api/tickets", auth, (req, res) => {
  const { category, status, priority, search } = req.query;
  let sql = "SELECT * FROM tickets WHERE 1=1";
  const params = [];

  if (req.user.role === "user") { sql += " AND submitted_by_user_id = ?"; params.push(req.user.id); }
  if (category && category !== "all") { sql += " AND category = ?"; params.push(category); }
  if (status   && status   !== "all") { sql += " AND status = ?";   params.push(status); }
  if (priority && priority !== "all") { sql += " AND priority = ?"; params.push(priority); }
  if (search) {
    sql += " AND (title LIKE ? OR id LIKE ? OR description LIKE ?)";
    const q = `%${search}%`;
    params.push(q, q, q);
  }
  sql += " ORDER BY created_at DESC";

  const rows = db.prepare(sql).all(...params);
  const tickets = rows.map(ticketFromRow);
  res.json({ tickets, total: tickets.length });
});

app.get("/api/tickets/:uid", auth, (req, res) => {
  const row = stmts.findTicketByUid.get(req.params.uid);
  if (!row) return res.status(404).json({ error: "Ticket not found." });
  if (req.user.role === "user" && row.submitted_by_user_id !== req.user.id)
    return res.status(403).json({ error: "Access denied." });
  res.json({ ticket: ticketFromRow(row) });
});

// ── UPDATE STATUS ─────────────────────────────────────────────
app.patch("/api/tickets/:uid/status", auth, staffOnly, (req, res) => {
  const row = stmts.findTicketByUid.get(req.params.uid);
  if (!row) return res.status(404).json({ error: "Ticket not found." });
  const valid = ["Open", "In Progress", "Responded", "Resolved", "Closed"];
  if (!valid.includes(req.body.status)) return res.status(400).json({ error: "Invalid status value." });
  stmts.updateStatus.run(req.body.status, req.params.uid);
  audit("STATUS_CHANGE", req.user, `${row.id}: ${row.status} → ${req.body.status}`);
  res.json({ ticket: ticketFromRow(stmts.findTicketByUid.get(req.params.uid)) });
});

// ── ASSIGN ────────────────────────────────────────────────────
app.patch("/api/tickets/:uid/assign", auth, staffOnly, (req, res) => {
  const row = stmts.findTicketByUid.get(req.params.uid);
  if (!row) return res.status(404).json({ error: "Ticket not found." });
  const assignedTo = req.body.assignedTo || null;
  stmts.updateAssign.run(assignedTo, req.params.uid);
  audit("ASSIGNED", req.user, `${row.id} → ${assignedTo || "Unassigned"}`);
  res.json({ ticket: ticketFromRow(stmts.findTicketByUid.get(req.params.uid)) });
});

// ── COMMENTS ─────────────────────────────────────────────────
app.post("/api/tickets/:uid/comments", auth, (req, res) => {
  const row = stmts.findTicketByUid.get(req.params.uid);
  if (!row) return res.status(404).json({ error: "Ticket not found." });
  if (req.user.role === "user" && row.submitted_by_user_id !== req.user.id)
    return res.status(403).json({ error: "Access denied." });
  const text = (req.body.text || "").trim();
  if (!text) return res.status(400).json({ error: "Comment cannot be empty." });
  stmts.insertComment.run(uuidv4(), req.params.uid, text, req.user.name, req.user.role, req.user.avatar);
  audit("COMMENT", req.user, `Comment on ${row.id}`);
  const ticket = ticketFromRow(stmts.findTicketByUid.get(req.params.uid));
  res.json({ comment: ticket.comments[ticket.comments.length - 1], ticket });
});

// ── DELETE SINGLE CLOSED TICKET (admin only) ─────────────────
app.delete("/api/tickets/:uid", auth, adminOnly, (req, res) => {
  const row = stmts.findTicketByUid.get(req.params.uid);
  if (!row) return res.status(404).json({ error: "Ticket not found." });
  if (row.status !== "Closed") return res.status(400).json({ error: "Only Closed tickets can be deleted." });
  stmts.deleteTicket.run(req.params.uid);
  audit("DELETE", req.user, `Deleted ${row.id}: ${row.title}`);
  res.json({ ok: true, deletedId: row.id });
});

// ── BULK DELETE ALL CLOSED (admin only) ──────────────────────
app.delete("/api/tickets", auth, adminOnly, (req, res) => {
  const before = stmts.countClosed.get().n;
  stmts.deleteClosed.run();
  audit("BULK_DELETE", req.user, `Purged ${before} closed tickets`);
  res.json({ ok: true, deleted: before });
});

// ── STATS ─────────────────────────────────────────────────────
app.get("/api/stats", auth, (req, res) => {
  let sql = "SELECT * FROM tickets WHERE 1=1";
  const params = [];
  if (req.user.role === "user") { sql += " AND submitted_by_user_id = ?"; params.push(req.user.id); }
  const rows = db.prepare(sql).all(...params);

  const s = {
    total: rows.length,
    byCategory: { HR: 0, IT: 0, Finance: 0, Operations: 0 },
    byPriority:  { Low: 0, Medium: 0, High: 0, Critical: 0 },
    byStatus:    { Open: 0, "In Progress": 0, Responded: 0, Resolved: 0, Closed: 0 },
    responded:   rows.filter(r => r.response).length,
    avgConf:     rows.length ? Math.round(rows.reduce((a, r) => a + (r.confidence || 0), 0) / rows.length) : 0,
  };
  rows.forEach(r => {
    if (s.byCategory[r.category] !== undefined) s.byCategory[r.category]++;
    if (s.byPriority[r.priority] !== undefined) s.byPriority[r.priority]++;
    if (s.byStatus[r.status]     !== undefined) s.byStatus[r.status]++;
  });
  res.json(s);
});

// ── AI INSIGHT (staff only) ───────────────────────────────────
app.get("/api/insight", auth, staffOnly, async (req, res) => {
  const rows = db.prepare("SELECT * FROM tickets ORDER BY created_at DESC LIMIT 40").all();
  if (!rows.length) return res.json({ insight: "No tickets in the system yet. Submit some to see AI insights." });
  const snap = rows.map(r => `[${r.id}] ${r.category}/${r.priority} — "${r.title}" (${r.status})`).join("\n");
  try {
    const c = await groq.chat.completions.create({
      model: "openai/gpt-oss-120b",
      messages: [{ role: "system", content: INSIGHT_PROMPT }, { role: "user", content: snap }],
      temperature: 0.4,
      max_tokens: 180,
    });
    res.json({ insight: c.choices[0].message.content.trim() });
  } catch {
    res.json({ insight: "AI insights temporarily unavailable." });
  }
});

// ── AUDIT LOG (admin only) ────────────────────────────────────
app.get("/api/audit", auth, adminOnly, (req, res) => {
  const log = stmts.listAudit.all().map(r => ({ id: r.id, action: r.action, by: r.by_name, role: r.role, detail: r.detail, at: r.at }));
  res.json({ log });
});

// ── AGENTS LIST (staff only) ──────────────────────────────────
app.get("/api/agents", auth, staffOnly, (req, res) => {
  res.json({ agents: stmts.listStaff.all() });
});

// ── CATCH-ALL ─────────────────────────────────────────────────
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "../public/index.html")));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀  TicketAI is running → http://localhost:${PORT}`);
  console.log(`    Database: ticketai.db (SQLite)`);
  console.log(`    GROQ_API_KEY: ${process.env.GROQ_API_KEY ? "✅ loaded" : "❌ NOT SET — add it to .env"}`);
  console.log(`\n    Registration rules:`);
  console.log(`    - Users register with any valid email`);
  console.log(`    - Admins MUST register with an email ending in "${ADMIN_DOMAIN}"`);
  console.log(`      e.g. jane${ADMIN_DOMAIN}\n`);
});
