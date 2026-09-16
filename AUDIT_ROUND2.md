# HRMS — Round 2 Audit: Attendance/Face, Location, Concurrency

**Date:** 2026-09-13
**Method:** Current source inspected first. No previous "fixed" claim trusted.
Every conclusion below has code, a passing test, or a measured number behind it.

---

## VERDICT

# 🟡 CONDITIONALLY READY — **7 / 10**

Functionally correct and security-verified. **One measured performance
finding is a genuine production blocker for the stated 100-user requirement**
(P0-A below), and several capability gaps remain unbuilt.

---

## 0. Verification gates

| Gate | Result |
|---|---|
| Server tests | ✅ **400 passing**, 29 files |
| Client tests | ✅ 26 passing |
| Client lint | ✅ 0 errors (4 pre-existing warnings) |
| Client production build | ✅ |
| Runtime smoke (real server, real HTTP) | ✅ 32/32 |
| **100-user concurrency** | ✅ **measured** — correctness passed, latency failed (§3) |
| Live-data verification (your Atlas DB) | ✅ 17/17 |

---

## 1. ATTENDANCE + FACE — the priority item

### The identity rule is now proven, not asserted

Requirement: *"Correct credentials + another employee's face = REJECT."*

`routes/attendance.js` compares the capture against
`FaceDescriptor.findOne({ userId: req.auth.sub })` — the **signed-in account's
own** template, never the roster at large and never an employee named in the
request body. That is the property that stops buddy-punching, and it is now
pinned by tests in `src/routes/faceIdentity.test.js` (**17 passing**):

| Scenario | Result |
|---|---|
| Alice signed in, Alice's face | ✅ ACCEPTED |
| **Alice signed in, Bob's face** | ✅ **REJECTED** `FACE_NOT_MATCHED` |
| **Bob signed in, Alice's face** | ✅ **REJECTED** (symmetric — not passing one way only) |
| Invalid token | ✅ REJECTED 401, no face processing at all |
| Deactivated account, matching face | ✅ REJECTED 403 |
| No enrolled face | ✅ REJECTED `NOT_ENROLLED` |
| **HR punching their OWN row** | ✅ **Verified like anyone else — no self-bypass** |
| HR override on someone else's row | ✅ Allowed, but recorded as `hr-override` with `face: null` — never looks like a biometric punch |

### FIXED: rejected attempts were invisible and the evidence was destroyed

**Before:** a failed face match wrote one line to `AuditLog` and threw the
photo away. `AuditLog` is HR-Director-only, so **the HR Managers who actually
run attendance could not see failed attempts at all**, and there was no count
anywhere — "this person failed six times then got in" was invisible.

**Now:** `models/VerificationAttempt.js` + `lib/verificationRecorder.js` record
every rejection — face mismatch, liveness failure, geofence, missing photo,
not-enrolled — with:

- the **captured photo retained as evidence**
- the signed-in `userId` (what makes "correct password, wrong face"
  reconstructable)
- face distance and confidence
- structured location + distance from office
- device, device id, IP, user agent
- a **90-day TTL** (`VERIFICATION_ATTEMPT_RETENTION_DAYS`) — biometric captures
  must not accumulate forever

`Attendance.failedVerificationCount` and an `anomalyFlags: 'failed-verification'`
now appear on the row itself.

### ADDED: repeated-rejection throttle

8 rejections in 15 minutes → `429`. Deliberately a **slow-down, not a lockout**:
a bad camera must not shut someone out of their own attendance, and they can
still ask HR.

### ADDED: HR verification dossier

`GET /api/v1/attendance/:id/verification` (HR Manager+) returns everything you
asked for in one response:

> Employee + ID + photo + time + verification result + location name + full
> address + PIN + coordinates + device + failed attempts

Plus `GET /api/v1/attendance/verification/attempts` as a company-wide feed, and
`GET /api/v1/files/verification-attempt/:id` which streams a rejected capture
**to HR only** (`private, no-store`, never a storage path).

Deliberate decision: the rejected-attempt photo is **not** shown to the
employee it was made against. If the attempt was an impersonation, the targeted
person is not automatically entitled to the would-be impersonator's photograph.
HR adjudicates.

---

## 2. LOCATION — now structured

**Before:** `reverseGeocode()` returned ONE flattened string
(`"MG Road, Indiranagar, Bengaluru, Karnataka - 560001"`). Nothing could sort,
filter or display place/city/PIN independently, and an auditor could not tell
which fragment was the postcode.

**Now** `lib/geocode.js` returns a structured object and
`Attendance.checkInLocation` / `checkOutLocation` persist it:

```
placeName · fullAddress · pincode · area · city · district · state · country
lat · lng · accuracy · source · resolvedAt
```

Coordinates are **kept, never replaced** — the geofence decision and any later
dispute rest on the raw fix. Also added a 24h position cache (Nominatim's
policy is ~1 req/sec and the same office repeats on every punch), and
geocoding now runs **before** verification so a *rejected* attempt also records
where it happened.

---

## 3. 🔴 P0-A — 100 CONCURRENT USERS: correct, but far too slow

Measured with `npm --prefix server run concurrency` — 100 distinct seeded
employees, real enrolled faces, **real face model** (not mocked), real
multipart upload, distinct `X-Forwarded-For` per user (the app trusts one proxy
hop, so 100 phones are genuinely 100 addresses).

### Correctness: PASSED

| | Result |
|---|---|
| Logins succeeded | **100 / 100** |
| Face check-ins succeeded | **100 / 100** |
| Duplicate employee-day rows | **0** — unique index held |
| Errors / transport failures | **0** |

### Latency: FAILED

| Config | Wall | Login p50 | Check-in p50 | Event-loop lag |
|---|---|---|---|---|
| 1 process | 32.6 s | 9.2 s | **23.1 s** | 26 ms |
| 4 cluster workers | 18.0 s | 6.2 s | **11.0 s** | 4 ms |
| 8 cluster workers | 16.0 s | 4.2 s | **10.6 s** | 16 ms |

Capacity curve on one process (25 → 50 → 100 users): check-in p50 **9.1 s →
9.9 s → 23.1 s**. Latency scales with concurrency — classic CPU saturation.

**Root cause — two CPU-bound stages on a single-threaded runtime:**

1. **`bcryptjs` 2.4.3 is pure JavaScript**, not a native binding. It runs on
   the JS thread. 100 concurrent compares ≈ 10 CPU-seconds, which matches the
   observed 9.2 s login p50 almost exactly.
2. **Face extraction costs 110–350 ms of CPU per photo** (measured directly on
   your real enrollment images).

**FIXED along the way:** the old worker path called `new Worker()` **per
request**, so every check-in spun up a thread that re-imported TensorFlow and
re-read three model files before looking at the image — strictly worse than
staying in-process. Replaced with `lib/faceWorkerPool.js`: a bounded pool of
long-lived workers that load the model **once**, with a queue, timeout, load
shedding and in-process fallback. Event-loop lag dropped 51 ms → 4 ms.

**Honest framing:** "100 users in the same instant" is a worst case (a 9:00
shift change). 100 employees checking in across a normal 15-minute window is
~0.1 req/s and entirely untroubled. But if simultaneous check-in is a real
scenario for you, **10.6 s is not acceptable UX** and this is a blocker.

**Required fix (in order of impact):**
1. Run clustered — `ENABLE_CLUSTER=true`, `WEB_CONCURRENCY=4`,
   `SCHEDULER_WORKER_ID=1`. Measured ~2× improvement. ⚠️ Do this **only after**
   moving the in-memory stores (liveness challenges, QR tokens, idempotency,
   settings cache) to shared storage — they are per-worker today.
2. Replace `bcryptjs` with a native/Rust bcrypt so hashing leaves the JS
   thread. **NOT DONE** — adds a native dependency with real deploy risk on
   Render; your call.
3. 500 / 1K / 5K / 10K → **NOT RUNTIME VERIFIED.** This machine runs the load
   client, the server and MongoDB together; those levels need separate
   infrastructure to mean anything.

---

## 4. Lifecycle & payroll gaps — searched, confirmed MISSING

Not inferred — `grep` over `src/models` and `src/routes`:

```
probation : 0    transfer        : 0    overtime     : 0
confirmation : 0 promotion       : 0    variable pay : 0
offer letter : 0 salary revision : 0    bonus/arrears: 0
```

**All MISSING.** These are **REQUIRED CAPABILITY / BUSINESS DECISION**, not
bugs — they were never built. I have not invented them.

**Correction to my previous report:** I wrote "no Tally export". **That was
wrong.** `client/src/lib/tally.js` contains a real Tally XML voucher generator
with statutory ledger mapping. Bank file is still missing.

---

## 5. 🟡 BUSINESS DECISION REQUIRED — `managerId`

You warned me not to quietly turn `managerId` into an RBAC role. **I had
already partly done so.** Stating it plainly — today `managerId` grants a
direct report's manager:

1. **Full salary and PII visibility** of that report (`routes/employees.js:42`)
2. Visibility of their leave requests
3. Authority to approve/decline their leave
4. Authority to set their `status` (one field only)
5. Visibility of their leave balance

Items 2–5 are ordinary line-management. **Item 1 is the one I should have
asked about**: in most enterprise HRMS, a line manager does **not** see a
report's compensation — that sits with HR/Finance.

`managerId` remains an **organisational relationship**, not a role. There are
still exactly four roles. But it now carries authorization, and **whether a
manager may see a report's salary is your policy call, not mine.** Say the word
and I will remove salary from manager visibility in one change.

---

## 6. Status by area

| Area | Status |
|---|---|
| Face identity (wrong face = reject) | ✅ **VERIFIED** — 17 tests |
| Failed-attempt capture + retention | ✅ VERIFIED |
| HR verification dossier | ✅ VERIFIED |
| Structured location (name/address/PIN/coords) | ✅ VERIFIED |
| No HR/Admin bypass | ✅ VERIFIED |
| Attendance concurrency (no duplicates) | ✅ **MEASURED** at 100 users |
| 100-user latency | 🔴 **FAILED** — see P0-A |
| 500 / 1K / 5K / 10K | 🔍 **NOT RUNTIME VERIFIED** |
| Liveness | 🟡 Real challenge-response; defeats printed photo + static screen. **NOT** verified against video replay / deepfake / 3D mask |
| PF / ESI / PT | ✅ Computed + tested |
| TDS | 🟡 **ESTIMATE ONLY** — new regime, salary income only. Not "compliant" |
| Probation/Confirmation/Transfer/Promotion/Salary revision | ❌ **MISSING** |
| Overtime / Variable pay / Bonus / Arrears | ❌ **MISSING** |
| Backup / Restore | ❌ **MISSING** — not built, not tested |
| Performance Mgmt, Reports/Analytics | 🔍 **NOT VERIFIED** — not yet audited |
| Frontend browser/E2E runtime | 🔍 **FRONTEND RUNTIME NOT VERIFIED** — API contracts verified per role; no browser driver run |
| Docker build / compose | 🔍 **NOT VERIFIED** — Docker not installed here |
| MongoDB replica set | ✅ **VERIFIED** — your Atlas URI has `replicaSet=atlas-…` |

---

## 7. Production blockers

| # | Blocker | Evidence | Verification needed |
|---|---|---|---|
| **P0-A** | 100 simultaneous check-ins: p50 10.6 s even clustered | Measured, §3 | Decide if simultaneous burst is real; cluster + native bcrypt; re-measure |
| **P0-B** | In-memory stores are per-worker — **clustering is unsafe until fixed** | `liveness.js`, `qrTokenStore.js`, `idempotency.js`, `cacheStore.js` | Move to shared store, then cluster |
| **P0-C** | Real S3/R2 not provisioned | Local disk on Render is ephemeral | Upload → redeploy → download |
| **P0-D** | Docker build never executed | Docker absent here | `docker compose up` reaches healthy |
| **P1-A** | No backup/restore | Nothing exists | Run a restore drill |
| **P1-B** | Browser E2E never run | Only API verified | Playwright/manual run of the 6 workflows |

---

## 8. Live-data observations (your Atlas DB)

- **3 of 6 users have no linked employee profile** → their ESS/leave/attendance
  is empty. Needs linking.
- Stray `settings` document `_id: "singleton"` beside the real `"Smaatech"`.
- 2FA is **ON** — login requires an email OTP.

---

## 9. How to re-verify

```bash
npm --prefix server test           # 400 passing
npm --prefix server run smoke      # 32/32 against the real process
npm --prefix server run concurrency 100   # measured; CLUSTER_WORKERS=4 to compare
npm --prefix server run loadprobe  # per-endpoint latency
npm --prefix client run lint && npm --prefix client run build
```

---

## Why 7/10 and not higher

Up from 6.5: the highest-priority area (face identity, evidence capture,
structured location, HR visibility) is now genuinely done and tested, and the
100-user requirement is **measured** rather than guessed.

Not higher because: a measured latency blocker stands, five lifecycle stages
and four payroll capabilities do not exist, backup/restore does not exist,
three modules are still unaudited, no browser E2E has been run, and one
authorization decision is legitimately yours to make.
