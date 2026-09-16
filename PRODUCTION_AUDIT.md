# Smaatech HRMS — Production Readiness Audit

**Date:** 2026-09-13
**Scope:** Full-stack audit, fix, test and re-audit of the existing HRMS.
**Method:** Source inspection first, then fix, then test, then a second
independent audit pass. Nothing in this document is claimed without either a
passing test, a runtime measurement, or a cited file and line.

---

## FINAL VERDICT

# 🟡 CONDITIONALLY READY

**Honest score: 7.5 / 10**

The codebase is now genuinely defensible: the data-loss bug, the salary/PII
exposure, the duplicate-payroll hole and the attendance fraud paths are closed
and each is held shut by a test. What stops this being PRODUCTION READY is not
code quality — it is that four things **cannot be verified from this
environment** and must be done on your infrastructure before go-live. They are
listed under *Production Blockers*.

---

## 1. VERIFICATION RESULTS

| Gate | Result |
|---|---|
| Server tests | ✅ **369 passing**, 27 files (baseline at session start: 99) |
| Client tests | ✅ 26 passing |
| Client lint | ✅ **0 errors** (was 1 real error), 4 pre-existing warnings |
| Client production build | ✅ succeeds |
| Runtime smoke (real `node src/index.js` over HTTP) | ✅ **32/32** |
| Load probe (measured) | ✅ 0 errors, real latencies captured |
| Production `npm audit` | 🟡 2 moderate, **0 high/critical** (was 5 high) |
| Docker build / compose | 🔍 **NOT VERIFIED — Docker not installed here** |

Test count more than tripled. The new tests are not padding: they target the
specific defects found, including concurrency races driven with real parallel
requests.

---

## 2. WHAT WAS FIXED

### P0 — the four named blockers

**1. Docker Compose was broken and shipped a public signing key** ✅
`docker-compose.yml` set `MONGO_URI`, but `server/src/db.js` reads
`MONGODB_URI` — the container booted, never connected, and served errors. It
also hardcoded `JWT_ACCESS_SECRET=production-jwt-secret-change-me`: anyone who
could read this repository could forge a valid login token for any account.
Fixed the variable name, moved every secret to required env with fail-fast
`${VAR:?}` guards, removed the **entirely unused** Redis service (no `redis`
reference exists anywhere in the source), switched Mongo to a single-node
replica set (transactions in `lib/transactionHelper.js` silently degrade
without one), added a persistent uploads volume and a healthcheck. The
Dockerfile now drops root (`USER node`) and uses `--omit=dev`.
*Held by:* `lib/startupChecks.test.js` — refuses that exact placeholder string.

**2. Serverless deployment was missing six API surfaces** ✅
`api/index.js` hand-rebuilt a **second** Express app with its own route list,
which had drifted. Missing in the deployed product but working locally and in
CI: `/face`, `/device-punch`, `/device-mappings`, `/health`, `/metrics`,
`/ai`. It also used `cors({ origin: true })` — reflecting **any** origin with
credentials. Now it imports the single shared app and adds only
serverless-specific config validation and connection reuse.
*Held by:* `src/routeParity.test.js` — asserts every route is mounted and that
the serverless entry declares no routes or CORS of its own.

**3. "Cloud storage" was a stub that DESTROYED every upload** ✅ — most serious
With `STORAGE_DRIVER=s3`, `lib/photoStorage.js` logged a line and returned a
**fabricated** `s3://bucket/ref` string *without ever uploading the bytes*.
`readPhoto()` then returned `null` for any such ref. Every attendance selfie,
face-enrolment photo and HR document was silently discarded while the caller
was told it succeeded. Replaced with a real `@aws-sdk/client-s3` client
(PUT/GET/DELETE + pre-signed URLs, private objects), every failure throws
rather than pretending, and the app now **refuses to start** if configured for
S3 without a bucket. Also added magic-byte sniffing and random storage
filenames.

**4. Nothing prevented duplicate payroll** ✅
No unique constraint existed. A double-clicked "Process payroll", a retry, or
two concurrent admins each produced another payable payslip. Added a unique
`(company, empId, cycle)` index enforced by the database, idempotency-key
replay, and post-disbursement locking (HR Director must explicitly unlock).
*Held by:* `payrollDuplication.test.js` — fires **6 simultaneous** creates and
asserts exactly 1 row, 5 conflicts.

### Security defects found during the audit

| Defect | Evidence | Status |
|---|---|---|
| **Every employee could read every colleague's salary, bank account, IFSC, PAN, UAN, ESI number, DOB, personal email and emergency contacts** — `GET /employees` had no role gate at all | `routes/employees.js` | ✅ Field-level redaction; self + own-reports + HR/Finance only |
| **Every employee could read the company's live SMTP password, Twilio token and SendGrid key in cleartext** from `GET /settings` | `routes/settings.js` | ✅ Redacted everywhere, including audit-log `before`/`after` |
| `/api/v1/ai/*` and `/api/v1/metrics` **completely unauthenticated** — anyone could read host telemetry, or poison the anomaly baseline via `POST /ai/telemetry` | `routes/aiPredictorRoutes.js` | ✅ `requireInternalAccess`, constant-time token compare, input clamping |
| **CORS allowed `*.vercel.app`** with `credentials:true` — any attacker's free Vercel page could make authenticated calls as a logged-in victim | `app.js` | ✅ Scoped to this project's prefix |
| **Deactivated/terminated/demoted users kept full API access** for 15 minutes, and a valid 30-day refresh token no lifecycle path ever revoked | `middleware/auth.js` | ✅ `tokenVersion` kill-switch + refresh revocation on every exit path |
| **Self-approval**: HR filing their own leave/expense/correction could approve it themselves in one click | leave, expenses, corrections | ✅ Blocked in all three |
| **Mass assignment** — `req.body` passed straight into `findByIdAndUpdate`/`Object.assign` on 8 routes, allowing `company` (tenant move) and workflow-`status` bypass | leave, payroll, expenses, assets, jobs, recruitment, reviews, resignations | ✅ `lib/patchGuard.js` allow-lists |
| Candidate PII (applicants who don't work here) readable by all staff | `routes/recruitment.js` | ✅ HR-gated |
| **`trust proxy` unset** — behind Vercel/Render all traffic appears to come from the proxy, so rate limiting bucketed the entire internet into one 300/15min counter | `app.js` | ✅ Explicit hop count |
| 5 HIGH npm advisories in shipped deps, incl. multer file-size-limit bypass | `npm audit` | ✅ 0 high remaining |

*Held by:* `authorizationMatrix.test.js` (39 tests), `accessTermination.test.js`
(16), `secondPassHardening.test.js` (15).

### Attendance & face

- **Concurrent punch race** ✅ — the handler read the row, then ran face
  extraction and a geocode for hundreds of ms before a blind write. Two
  overlapping requests both passed the guard and both wrote. Now a conditional
  update; the database picks the winner. *Tested with 5 parallel requests.*
- **HR could mark themselves present from anywhere** ✅ — `isSelfService =
  !isAdmin` meant HR Manager/Director skipped face **and** geofence on their
  own row. The people who administer attendance were the only ones exempt from
  it. Now: same rules for everyone on their own row; HR override on *someone
  else's* row still works and is audited as such.
- **Real liveness implemented** ✅ — see the honesty note in §4.
- **Non-JPEG uploads crashed with a 500** ✅ — the filter accepted PNG/WebP but
  the decoder is `jpeg-js`; the throw was outside the try block.
- **Correction approval hardcoded `status = 'present'`** ✅ — a correction for
  11:30–14:00 against a 09:00–18:00 shift became a *full present day*, skipping
  the lateness/half-day/early-exit rules. Payroll LOP derives from these
  statuses, so this was a paid-time error. Now recalculated from the shift.
- **Missing checkout** ✅ — previously stayed `checkOut: null` forever and was
  paid as a full day. Now flagged nightly and the employee is prompted. It is
  *not* auto-completed: inventing an end time would be fabricating attendance.
- Timezone ✅ — `weekdayKeyOf` used **server-local** weekday, so a UTC host
  rostered the wrong day for every punch between 00:00–05:30 IST.

### Leave — built from nothing

There was **no server-side leave balance of any kind**. The figure shown to
employees was computed in the browser. Nothing on the server checked it, so an
employee with zero days left could file and have approved as much leave as they
liked. Built:

- `LeaveType` (per-company policy: quota, accrual, paid/unpaid, carry-forward)
- `LeaveBalance` (materialised, uniquely indexed)
- `LeaveLedger` (append-only, every movement, with actor)
- `lib/leaveLedger.js` — debits are a **single atomic conditional update**, so
  concurrent filings cannot both pass a sufficiency check
- Monthly accrual, year-end carry-forward with cap + lapse, HR adjustment
- **Holiday bug** ✅ — working-day calculation built its holiday set from raw
  display strings (`"7 Jun, Sun"`) and compared them to ISO dates, so **no
  holiday ever matched** and employees were charged leave for company holidays
- Reporting-manager approval stage, team-scoped; mandatory decline reasons

*Held by:* `leave.test.js` (36 tests), including 4 concurrent filings against a
2-day balance → exactly 1 succeeds.

### Payroll compliance

`lib/statutory.js` implements **EPF/EPS, ESI, Professional Tax and TDS** with
sourced FY 2025-26 rates. Previously the app carried PAN/UAN/ESI *identifier*
fields and computed nothing — HR typed amounts by hand. Identifiers are not
compliance. 22 tests verify against hand-worked examples (e.g. EPS capped at
₹1,250; ESI boundary at ₹21,000; Karnataka's February ₹300 top-up).

### Performance — measured, then fixed

`GET /attendance/summary` (the dashboard chart every user loads) hydrated
**15,000 Mongoose documents** per request and summed them in a JS loop. Moved
the aggregation into MongoDB:

| | Before | After |
|---|---|---|
| p50 @ concurrency 10 | 4,642 ms | **27 ms** |
| p95 @ concurrency 10 | 4,726 ms | **43 ms** |
| Throughput | 2 rps | **323 rps** |
| Process heap | 1,357 MB | **95 MB** |

*Held by:* 6 tests pinning the exact counting semantics (half-day counts as
both half-present and half-absent — the easiest part to get wrong).

### Found incidentally

- **`client/src/pages/MyDashboard.jsx` called `useEffect` without importing
  it** — a runtime crash on the employee self-service dashboard, and a lint
  *error* that was failing CI. Pre-existing, unrelated to this audit. ✅ Fixed.
- **The "payslip PDF" emitted a `.html` file.** An employee forwarding it to a
  bank sent a web page. ✅ Now a real PDF via the already-bundled jsPDF.

---

## 3. WHAT WAS ALREADY CORRECT

Credit where due — these were sound and were left alone:

- ✅ Refresh tokens: opaque random, SHA-256 hashed at rest, revocable
- ✅ bcrypt password hashing; per-account lockout after 5 failures
- ✅ Real email OTP for 2FA and password reset (Brevo HTTP API, with a correct
  documented reason for not using SMTP)
- ✅ Server-side face matching — the client's match was already UX-only
- ✅ Geofence re-derived server-side from raw coordinates, never trusting a
  client-reported `isInside`
- ✅ Overnight-shift handling (the `unwrap` trick in `lib/shifts.js`)
- ✅ Company scoping applied even to HR Director, with the reasoning documented
- ✅ Uploads-directory containment guard (the `uploads-evil` sibling case)
- ✅ Attendance unique `(empId, date)` index
- ✅ QR check-in tokens: server-issued, single-use, short-TTL

---

## 4. NOT VERIFIED / NOT IMPLEMENTED — stated plainly

These are the claims this system must **not** make.

**🔍 Docker build and Compose — NOT VERIFIED.** Docker is not installed in this
environment. The YAML parses and the Dockerfile is correct by inspection;
neither has been built or run.

**🔍 Scalability at 1K / 5K / 10K users — NOT RUNTIME VERIFIED.** The load
probe measured 500 employees / 15,000 rows on one machine against in-memory
Mongo. It shows *relative endpoint cost*, which is how the 4.6s defect was
found. It is **not** a capacity projection and no user-count figure should be
derived from it.

**🟡 Liveness — real, but bounded.** `lib/liveness.js` performs genuine
server-side challenge–response: a random unpredictable action (turn
left/right/blink), multi-frame capture, every frame matched against the
enrolled descriptor, static-replay detection, and landmark-verified motion. 18
tests, including spoof rejection. **It defeats a printed photo and a static
screen. It is NOT verified against video replay, deepfakes or 3D masks** —
that needs a trained PAD model and depth/IR hardware, neither of which exists
here. The stored audit record says exactly this rather than claiming
certification. Off by default (`Settings.livenessRequired`).

**🟡 TDS is an ESTIMATE.** New regime only, from salary income only. Old-regime
Chapter VI-A declarations, house-property loss, other income and surcharge are
**not modelled**. The function returns `estimateOnly: true`, old-regime
employees get `OLD_REGIME_NOT_MODELLED` rather than a guess, and the PDF says
so. PF/ESI/PT **are** fully computed.

**❌ SMS / WhatsApp / Push — NOT IMPLEMENTED.** No Twilio or push client
exists; these branches only ever wrote a `console.log`. HR can select them in
Settings, and the old code returned success — so a company could configure
"notify by SMS" and silently deliver nothing for months. Now reported as
`undelivered` with a warning; in-app (real) and email (real) still go out.

**❌ "Reporting Manager" was never a role.** The system has four roles: HR
Director, HR Manager, Finance Lead, Employee. `Employee.managerId` existed but
was used only for org-chart display. It is now implemented as an approval
*stage* resolved against `managerId`, with team-scoped visibility — not a
global role.

**❌ Not implemented at all:** Performance Management beyond basic review CRUD;
recruitment→offer→hire automation; bank-file/Tally export (logged as an audit
action, no generator); document retention policy; backup/restore automation.

---

## 5. PRODUCTION BLOCKERS — do these before go-live

| # | Blocker | Why | Verification needed |
|---|---|---|---|
| **P0-1** | Provision real S3/R2 and set `STORAGE_DRIVER=s3` + `S3_*` | Local disk on Render/Vercel is **ephemeral** — every attendance photo and document is lost on redeploy. The app warns loudly at boot but will still start. | Upload a document, redeploy, download it |
| **P0-2** | Use a **replica-set** MongoDB (Atlas is one by default) | `lib/transactionHelper.js` silently degrades to non-atomic on standalone — affects leave→attendance sync and F&F payout | `rs.status().ok` |
| **P0-3** | Generate real `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET`, set `CLIENT_ORIGIN` | Startup refuses placeholders and short secrets, but the values must exist | Boot in production mode |
| **P0-4** | `docker build` + `docker compose up` | **Never executed here** | Container reaches healthy |
| **P1-1** | Load test on target hardware | Only small-scale numbers exist | p95 under load |
| **P1-2** | If clustering (`ENABLE_CLUSTER`), set `SCHEDULER_WORKER_ID` | Otherwise in-memory stores (liveness challenges, QR tokens, idempotency, settings cache) are per-worker and behave inconsistently | Multi-worker test |
| **P1-3** | Configure database backup + **test a restore** | No backup automation exists | Restore drill |

---

## 6. REMAINING RISKS (accepted, not fixed)

| Priority | Issue | Note |
|---|---|---|
| **P1** | `reverseGeocode` awaited inline in the punch path — `routes/attendance.js:227,524` | External free Nominatim call (~1 req/sec policy cap) on every check-in. Should move to a background job. Adds latency and an external dependency to a critical path. |
| **P1** | In-memory stores break under multi-process clustering | `liveness.js`, `qrTokenStore.js`, `idempotency.js`, `cacheStore.js`. Redis was *removed* as unused — reintroduce it deliberately if you scale out. |
| **P2** | `GET /employees` unpaged returns the whole roster (356ms p50 @ conc 10, 500 employees) | Paginated path exists; the client's `loadAll()` hydrate still uses the unpaged one. |
| **P2** | 2 moderate `qs` advisories | Only fixable by Express 4→5, which is breaking. |
| **P2** | Client leave-type dropdown reads master data, not `/leaves/types` | The authoritative policy endpoint exists; the client hasn't been switched to it. |
| **P3** | `requireRole`'s `ROUTE_ACTION_MAP` is coarse | An action grant covers every method on that base path. |

---

## 7. HRMS MODULE STATUS

| Module | Status |
|---|---|
| Authentication / sessions / 2FA | ✅ Verified |
| Authorization (RBAC, tenant isolation) | ✅ Verified — 39 tests |
| Employee lifecycle | ✅ Verified |
| Attendance (punch, race, device, QR) | ✅ Verified |
| Face verification | ✅ Verified |
| Liveness | 🟡 Real, bounded (§4) |
| Leave (balance, ledger, accrual, approval) | ✅ Verified |
| Payroll (dedup, locking, PF/ESI/PT) | ✅ Verified |
| TDS | 🟡 Estimate only |
| Documents (storage, signed URLs, access) | ✅ Verified |
| Notifications — in-app, email | ✅ Verified |
| Notifications — SMS/WhatsApp/Push | ❌ Not implemented |
| Audit logging | ✅ Verified |
| Offboarding / F&F | ✅ Verified |
| Recruitment / Onboarding | 🟡 Basic CRUD |
| Performance Management | 🟡 Basic CRUD |
| Reports / Analytics / Exports | 🟡 Partial — no Tally/bank file |
| DevOps / deployment | 🟡 Config correct, Docker unverified |
| Scalability | 🔍 Not runtime verified |
| Backup / Recovery | ❌ Missing |

---

## 8. HOW TO RE-VERIFY

```bash
npm --prefix server test                    # 369 passing
npm --prefix server run smoke               # 32/32, real server over HTTP
npm --prefix server run loadprobe           # measured latencies, 0 errors
npm --prefix client run lint                # 0 errors
npm --prefix client run build
npm --prefix server audit --omit=dev        # 2 moderate, 0 high
```

CI runs all of these on every push (`.github/workflows/ci.yml`).

---

## Closing note on the score

7.5/10 reflects a system whose **critical defects are fixed and held shut by
tests**, but which has four unverifiable-from-here operational gates and three
genuinely missing capabilities (SMS/push, bank-file export, backup
automation). It is not 9/10, and calling it that would mean ignoring the
untested Docker path, the unmeasured real-world scale, and the modules that do
not exist. Clear P0-1 through P0-4 and this becomes defensibly PRODUCTION
READY.
---

## 9. Independent Re-Audit Addendum - 2026-09-13

This pass re-read the current source and re-ran verification instead of
trusting the report above.

### Code change made in this pass

- Fixed a frontend contract bug in `client/src/pages/Leave.jsx`: the leave
  list checked `currentUser.employeeId`, but `HRMSContext` exposes the linked
  employee id as `currentUser.empId`. Pending leave owners can now see/use
  owner actions consistently with backend authorization.

### Current verification evidence

| Gate | Current result |
|---|---|
| Server tests | PASS - 28 files, 383 tests |
| Client tests | PASS - 6 files, 26 tests |
| Client lint | PASS - 0 errors, 4 warnings |
| Production build | PASS |
| Runtime smoke | PASS - 32/32 real HTTP checks |
| Load probe | PASS - 500 employees, 15,000 attendance rows, 0 failed requests |
| Docker build/compose | NOT RUNTIME VERIFIED - Docker command unavailable |
| Real S3/R2 upload/download | NOT RUNTIME VERIFIED - no bucket credentials in this environment |
| Target MongoDB replica set | NOT RUNTIME VERIFIED - smoke used in-memory replica set only |
| Production JWT/CLIENT_ORIGIN | NOT RUNTIME VERIFIED - startup checks are tested, target env values not visible |
| Backup and restore | MISSING / NOT VERIFIED |

Commands run:

```bash
npm --prefix client run test
npm --prefix client run lint
npm run build
npm exec vitest run -- --maxWorkers=1 --pool=threads --testTimeout=30000
npm --prefix server run smoke
npm --prefix server run loadprobe
```

Notes:

- The root-scoped server test command also picked up client tests without the
  client Vite/jsdom config and produced five `document is not defined`
  failures. Rerunning from `server/` produced the valid server result:
  383/383 passing.
- Default 5s Vitest timeout was too low for the first Mongo-memory leave test
  on this Windows environment; with `--testTimeout=30000`, the leave suite
  passed 37/37.
- Docker is not installed or not on PATH here (`docker --version` failed), so
  Docker evidence remains static inspection only.

### India compliance source check in this pass

Current authoritative/near-authoritative references checked:

- Income Tax Department TDS rates: salary TDS is at normal slab rate under
  Section 192 / current salary TDS rules.
- Income Tax Department AY 2026-27 slab page: new regime slabs include nil up
  to Rs 4,00,000, then 5%, 10%, 15%, 20%, 25%, 30% bands.
- PIB, Ministry of Labour & Employment, 13-Jun-2019: ESI contribution reduced
  to 4% total, split employer 3.25% and employee 0.75%, effective 01-Jul-2019.
- ESIC Act text: contribution is payable by the principal employer for wage
  periods where wages are payable; wage ceiling is prescribed by rules.
- Professional Tax remains state-specific and capped at Rs 2,500 per year
  under Article 276 practice; state slabs must remain configurable/verified per
  operating state.

Compliance conclusion: PF/ESI/PT/TDS logic in `server/src/lib/statutory.js`
is a useful payroll engine, but TDS remains explicitly an estimate. The system
must not present payroll as legally filed compliance until company-specific
settings, declarations, state PT registrations, challans, returns, and target
production evidence are verified.

### Final status after this pass

CONDITIONALLY READY.

Reason: critical source-level and testable workflow issues checked in this
environment are passing, and one frontend/backend mismatch was fixed. The
system is still not PRODUCTION READY because external infrastructure gates
remain unverified: Docker runtime, real object storage persistence, target
MongoDB replica-set transactions, production environment secrets/origins,
backup/restore, and target load testing.
