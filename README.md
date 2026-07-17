# Smaatech HRMS — People Operations (React + Express + MongoDB)

Production HRMS dashboard. Two workspaces: **`client/`** (React + Vite frontend) and **`server/`** (Express + MongoDB backend with real JWT auth and server-side face verification). The root `package.json` just orchestrates both.

---

## 🔑 Demo login accounts

Seeded by `server/src/seed.js` (`npm run seed:server` from the repo root). Use any of these on the login screen:

| Role | Email | Password |
|---|---|---|
| HR Director (admin) | `admin@smaatech.co` | `Admin@123` |
| HR Manager | `hr.manager@smaatech.co` | `Manager@123` |
| Finance Lead | `finance.lead@smaatech.co` | `Finance@123` |
| Employee | `priya.sharma@smaatech.co` | `Employee@123` |

> Re-running the seed script **wipes and recreates** these accounts (and the demo employee roster) — don't run it against a database with real data you want to keep.

---

## 🚀 Local dev

```bash
npm install                  # root orchestrator deps (concurrently)
npm --prefix client install  # frontend deps
npm --prefix server install  # backend deps

cp server/.env.example server/.env   # fill in MONGODB_URI, JWT secrets, SMTP creds
npm run seed:server                  # first time only — creates the demo accounts above

npm run dev                  # client (http://localhost:5173) + server (http://localhost:4000)
```

Requires **Node 18+**. The client dev server proxies `/api/*` to `localhost:4000` automatically (`client/vite.config.js`) — no extra config needed locally.

---

## 🏗️ Architecture

```
client/                     # React 18 + Vite — talks to the server over /api/v1
├── src/lib/apiClient.js    # fetch wrapper: JWT access token in memory, httpOnly refresh cookie
├── src/data/store.js       # REST calls for server-backed resources + localStorage for local-only settings
├── src/context/HRMSContext.jsx
└── src/pages/, src/components/

server/                     # Express + Mongoose, MongoDB Atlas
├── src/index.js            # app wiring, mounts all /api/v1/* routers
├── src/routes/             # auth, employees, attendance, leave, payroll, recruitment, ...
├── src/models/             # Mongoose schemas
└── src/lib/faceEngine.js   # loads face-api.js models from public/models at boot

public/models/               # face-api.js model weights (shared by client UX + server verification)
```

Employees, attendance, leave, payroll, recruitment, reviews, expenses, assets, jobs, holidays and celebrations all live in MongoDB via the server's REST API. Only org-level `Settings` (branding, notification templates, login-profile face descriptors) still persists client-side in `localStorage`.

Auth: password (or face) login returns a short-lived JWT access token (kept in memory only) plus an httpOnly refresh cookie; `apiClient.js` retries once via `/auth/refresh` on a 401.

---

## ☁️ Deploying (Vercel + Render)

The server needs a persistent Node process (it loads face-api.js/TensorFlow models at startup and keeps refresh-token sessions), so it can't run on Vercel's serverless functions. Split deploy:

- **Server → [Render](https://render.com)** (free tier, persistent web service)
- **Client → [Vercel](https://vercel.com)** (static Vite build)
- **Database → MongoDB Atlas** (already set up — reuse the same `MONGODB_URI` you use locally so the demo accounts above carry over)

### 1. Deploy the server to Render
1. In the Render dashboard: **New → Blueprint**, connect the `sepl65473-lang/Smaatech-HRMS` GitHub repo. Render reads `render.yaml` at the repo root and proposes a `smaatech-hrms-api` web service.
2. Fill in the prompted environment variables (values from your local `server/.env`): `MONGODB_URI`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `SMTP_USER`, `SMTP_PASS`. Leave `CLIENT_ORIGIN` for step 3.
3. Deploy. Note the resulting URL, e.g. `https://smaatech-hrms-api.onrender.com`.
4. **MongoDB Atlas → Network Access → Add IP Address → Allow Access from Anywhere (`0.0.0.0/0`)** — Render's free tier has no static IP, so Atlas needs to accept connections from any IP.

### 2. Deploy the client to Vercel
1. In the Vercel dashboard: **Add New → Project**, import the same GitHub repo.
2. Set **Root Directory** to `client`. Vercel auto-detects Vite; `client/vercel.json` adds the SPA fallback rewrite (needed because the app uses client-side routing) — no extra config needed.
3. Add an environment variable: `VITE_API_BASE_URL` = `https://smaatech-hrms-api.onrender.com/api/v1` (your Render URL from step 1, with `/api/v1` appended).
4. Deploy. Note the resulting URL, e.g. `https://smaatech-hrms.vercel.app`.

### 3. Connect them
1. Back in Render, set the server's `CLIENT_ORIGIN` env var to your Vercel URL from step 2 (e.g. `https://smaatech-hrms.vercel.app`), then let it redeploy/restart.
2. Open the Vercel URL and log in with a demo account above.

> **Render free tier spins down after ~15 min idle.** The first request after a while can take 30–60 seconds to wake back up — if login seems to hang right after opening the site cold, that's the server waking up, not a bug. Subsequent requests are fast.

---

## ✨ Features

| Module | CRUD operations |
|---|---|
| **Employees** | Add / Edit / Delete + search + department filter (full validation) |
| **Attendance** | Check-in / Check-out with geofence + face verification, late detection |
| **Leave** | New request, Approve / Decline, delete history, status filters |
| **Payroll** | Process payroll, mark as paid, auto gross/deduction/net calc |
| **Celebrations** | Send wishes, birthday/anniversary detection from real employee data |
| **Recruitment** | Kanban — candidate add/delete, stage move (Applied → Hired) |
| **Performance** | Reviews + ratings, auto-sorted leaderboard |
| **Expenses / Assets / Jobs** | Full CRUD, status workflows |
| **Settings** | Org config, users & role access, geofence/shift config, notification toggles |
| **Dashboard** | Live stats from real data, attendance chart, quick actions |

---

## 🛠️ Tech stack

- **Client**: React 18, Vite 5, react-router-dom v6, Context API
- **Server**: Express 4, Mongoose 8 (MongoDB Atlas), JWT auth (jsonwebtoken + bcryptjs), face-api.js + TensorFlow.js (WASM) for server-side face verification, Nodemailer (OTP emails)
