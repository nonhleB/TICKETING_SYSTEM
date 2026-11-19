# TicketAI — Smart Service Desk

AI-powered ticket classification & response system built with Node.js, Express, **SQLite**, and the Groq API.

---

## Features

- **Registration + Login** — anyone can create an account
- **Role-based accounts**:
  - **Admin** — must register with an email ending in `@ticket.com` (e.g. `jane@ticket.com`)
  - **User** — can register with any valid email, sees only their own tickets
  - **Agent** — provisioned by an admin (not self-registered)
- **SQLite database** (`ticketai.db`) — all users, tickets, comments and audit logs persist between restarts
- **AI classification** — category, priority, confidence score, keywords
- **AI response generator** — Formal / Friendly / Urgent tone
- **Category sidebar filters**
- **Delete closed tickets** — Admin only, single or bulk
- **Comments** on tickets
- **Agent assignment**
- **Activity log** — full audit trail (Admin only)
- **AI Insight panel** on the dashboard
- **Charts** — category, priority, status and 7-day trend

---

## 1. Install Node.js

Download the LTS version from https://nodejs.org (v18 or higher recommended).

Verify:
```bash
node -v
npm -v
```

---

## 2. Get a free Groq API key

Sign up at https://console.groq.com → API Keys → Create API Key

---

## 3. Install project dependencies (including SQLite)

```bash
cd ticketai
npm install
```

This installs everything needed, including:

- **`better-sqlite3`** — the SQLite database driver (fast, synchronous, no extra setup)
- **`bcryptjs`** — for securely hashing passwords
- all other existing packages (express, groq-sdk, etc.)

> **No separate SQLite installation is required.** `better-sqlite3` ships with
> a precompiled binary for your platform, downloaded automatically during
> `npm install`. SQLite itself is a single embedded file-based database — there
> is no server process to install or run.

### If `npm install` fails to build `better-sqlite3`

This usually only happens on machines without internet access to download the
prebuilt binary, or very old Node versions. Fixes, in order of preference:

```bash
# 1. Make sure you're on a recent Node LTS (v18+), then retry:
npm install

# 2. If it still fails, force a rebuild from source (requires build tools):
npm rebuild better-sqlite3 --build-from-source

# 3. On Windows, ensure you have the "Desktop development with C++"
#    workload from Visual Studio Build Tools, then retry npm install.

# 4. On macOS, ensure Xcode command line tools are installed:
xcode-select --install

# 5. On Linux (Debian/Ubuntu), ensure build essentials are present:
sudo apt-get install -y build-essential python3
```

---

## 4. Configure environment variables

```bash
cp .env.example .env
```

Open `.env` and add your Groq key:
```
GROQ_API_KEY=gsk_xxxxxxxxxxxxxxxxxxxx
PORT=3000
```

---

## 5. Run the app

```bash
npm start
```

Open **http://localhost:3000**

On first run, the app automatically creates `ticketai.db` in the project root
with all required tables (`users`, `tickets`, `comments`, `audit_log`, `sessions`).
This file is your entire database — no separate database server needed.

For live-reload during development:
```bash
npm run dev
```

---

## 6. Creating your first accounts

There are **no pre-seeded accounts** — everyone registers via the **Create Account**
tab on the login screen.

### To register as a User
- Choose **User**
- Use any valid email address (e.g. `jane@gmail.com`)

### To register as an Admin
- Choose **Admin**
- Your email **must end in `@ticket.com`**, e.g. `jane@ticket.com`
- If you use any other domain, registration will be rejected with an error
  explaining the requirement

### Agents
Agent accounts aren't self-registered through this screen. An admin can be
added directly to the database (or you can extend the registration form to
allow an "agent" role with your own invite-code logic).

---

## Database file

| File | Purpose |
|---|---|
| `ticketai.db` | Main SQLite database (auto-created) |
| `ticketai.db-wal` / `ticketai.db-shm` | SQLite Write-Ahead-Log helper files (auto-managed) |

These files are already excluded from version control via `.gitignore`.
To start with a completely fresh database, stop the server and delete
`ticketai.db` (and any `-wal`/`-shm` files) — it will be recreated empty
on the next `npm start`.

---

## Permissions summary

| Action | Admin | Agent | User |
|---|---|---|---|
| Register / Login | ✅ | (provisioned) | ✅ |
| Submit ticket | ✅ | ✅ | ✅ |
| View own tickets | ✅ | ✅ | ✅ |
| View all tickets | ✅ | ✅ | ❌ |
| Generate AI response | ✅ | ✅ | ❌ |
| Change ticket status | ✅ | ✅ | ❌ |
| Assign to agent | ✅ | ✅ | ❌ |
| Comment on ticket | ✅ | ✅ | own tickets only |
| Delete closed ticket(s) | ✅ | ❌ | ❌ |
| View activity/audit log | ✅ | ❌ | ❌ |
