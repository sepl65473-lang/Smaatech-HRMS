# Smaatech HRMS — People Operations (React + Vite)

Production-ready HRMS dashboard. Original static HTML prototype ko **React.js** app me port kiya gaya hai with **real CRUD operations** (Create, Read, Update, Delete) jo data ko persist karte hain.

> Design 1:1 same rakha gaya hai — wahi warm "paper" aesthetic (Fraunces + Geist + JetBrains Mono).

---

## 🚀 Quick start

Repo `client/` (frontend) aur `server/` (backend) do alag folders me hai, root sirf dono ko orchestrate karta hai:

```bash
npm install                  # root orchestrator deps (concurrently)
npm --prefix client install  # frontend deps
npm --prefix server install  # backend deps
npm run dev                  # client (http://localhost:5173) + server (http://localhost:4000) dono start
```

Production build:

```bash
npm run build    # client/dist/ me optimized build
npm run preview  # build ko locally preview karo
```

> **Node 18+** chahiye.

---

## ✨ Features (sab functional, sirf UI nahi)

| Module | CRUD operations |
|---|---|
| **Employees** | Add / Edit / Delete + search + department filter (full validation) |
| **Attendance** | Check-in / Check-out, late detection (>09:30), status update |
| **Leave** | New request, Approve / Decline, Delete history, status filters |
| **Payroll** | Process payroll, Mark as paid, auto gross/deduction/net calc |
| **Celebrations** | Send wishes (persist + counter), holidays list |
| **Recruitment** | Kanban — candidate add/delete, stage move (Applied→Hired) |
| **Performance** | Live rating adjust (saved), auto-sorted leaderboard |
| **Settings** | Org config, notification/security toggles, **reset all data** |
| **Dashboard** | Live stats from actual data, attendance chart, quick actions |

Saara data **localStorage** me persist hota hai — refresh karne par bhi bana rehta hai. Settings → Danger Zone se reset kar sakte ho (fresh seed reload).

---

## 🏗️ Architecture

```
src/
├── main.jsx                # BrowserRouter > HRMSProvider > App
├── App.jsx                 # Routes (react-router-dom v6)
├── index.css               # Original design verbatim + supplemental styles
│
├── data/
│   ├── seed.js             # Coherent demo dataset (14 employees + sab linked data)
│   └── store.js            # ⭐ DATA LAYER — async REST-jaisa API (localStorage)
│
├── context/
│   └── HRMSContext.jsx     # Saara state + CRUD actions + toast system (useHRMS hook)
│
├── lib/helpers.js          # initials, formatINR, dates, leave types, etc.
│
├── components/             # Sidebar, Topbar, Layout, Modal, Forms, Avatar, Toasts...
└── pages/                  # Dashboard, Employees, Attendance, Leave, Payroll...
```

### Data flow
```
Page  →  useHRMS() action  →  store.js API (async)  →  localStorage
                ↓                                          ↓
          React state update  ←──────────── persisted data
```

---

## 🔌 Real backend kaise lagayein

Poora data layer **ek hi jagah** isolated hai: `src/data/store.js`.

Har collection ka API same shape follow karta hai:

```js
employeesApi.list()          // GET    /employees
employeesApi.get(id)         // GET    /employees/:id
employeesApi.create(data)    // POST   /employees
employeesApi.update(id, data)// PATCH  /employees/:id
employeesApi.remove(id)      // DELETE /employees/:id
```

Sab functions already **async (Promise-based)** hain. REST backend pe shift karne ke liye sirf `store.js` ke andar `localStorage` calls ko `fetch()` se replace karo — **baaki poori app same rahegi**, kyunki context aur pages already async await karte hain.

Example:
```js
// abhi (localStorage):
async list() { return readDB()[collection]; }

// baad me (real API):
async list() { return (await fetch(`/api/${collection}`)).json(); }
```

---

## 🛠️ Tech stack

- **React 18** + **Vite 5** (fast dev + optimized build)
- **react-router-dom v6** (client-side routing)
- **Context API** (global state — koi external state lib nahi)
- **localStorage** persistence (swappable data layer)
- Zero UI framework — original CSS verbatim preserve kiya hua

---

## 📝 Notes

- StrictMode on hai (double-invoke safe).
- Demo dataset Indian context me hai (INR salary, IST names/locations).
- Pehli baar app khulte hi seed data auto-load ho jaata hai.
