# HRMS — Round 3: Peak-Load Optimisation, managerId Decision, Remaining Audit

**Date:** 2026-09-13
**Continues from** `AUDIT_ROUND2.md`. Every number below is measured on this
machine with `npm --prefix server run concurrency`.

---

## VERDICT

# 🟡 CONDITIONALLY READY — **7.5 / 10**

Up from 7. The peak-load blocker is **substantially fixed and re-measured**
(3.4× faster, and the realistic arrival pattern is now good). It is not higher
because 500 users degrades, five lifecycle stages and four payroll capabilities
still do not exist, backup/restore does not exist, and **no browser E2E has
been run**.

---

## 1. 🔴→🟢 PEAK LOAD — profiled, fixed, re-measured

### Profiling first (not guesswork)

| Stage | Cost | ×100 users |
|---|---|---|
| `bcryptjs` compare (cost=10) | 54 ms | **6.7 s** (124× serialised) |
| Face extraction | 196 ms CPU | **19.6 s** |
| | | **26.3 s of pure CPU on one thread** |

Face was **75%** of the work, bcrypt 25% — so face was attacked first.

Per-stage breakdown across every real capture in `uploads/`:

```
decode=3-12ms   tensor=0-1ms   detect(416)=54-105ms
```

Detection dominates; decode and tensor construction are noise.

### Three fixes, each evidence-backed

**1. Worker pool replaced per-request worker spawning** (`lib/faceWorkerPool.js`)
The old path called `new Worker()` **per request**, so every check-in spun up a
thread that re-imported TensorFlow and re-read three model files before looking
at the image — strictly worse than staying in-process. Workers are now
long-lived, load the model once, and take work from a queue with timeout, load
shedding and in-process fallback.

**2. Pool sizing follows the host, and is CLUSTER-AWARE**
It had been hard-capped at 4, leaving 12 of 16 cores idle. More importantly,
`getPool()` is per-process, so under `ENABLE_CLUSTER` **every cluster worker
was building its own full-size pool** — 8 workers × 15 = 120 TensorFlow threads
on a 16-core box. The host budget is now divided by the cluster size:

```
cluster=1 -> 8 face workers   (8 threads total)
cluster=4 -> 3 face workers   (12 threads total)
cluster=8 -> 1 face worker    (8 threads total)
```

**3. Detector input size 416 → 320** (`FACE_DETECTOR_INPUT_SIZE`)
Measured across every real photo in `uploads/`:

| inputSize | Detect time | Descriptor drift vs 416 |
|---|---|---|
| 416 | 54–105 ms | — |
| **320** | **30–70 ms** | **0.0000** |
| 224 | 48 ms | 0.0919 |

320 is ~35% faster and produces a **byte-identical descriptor** — the descriptor
comes from the aligned crop, so detector resolution does not change it once the
same box is found. **This does not weaken verification:** a lower resolution can
only make the detector MISS a face, which yields `NO_FACE` — a *rejection*. It
cannot cause a false accept; matching still runs at full precision against the
enrolled template at the same 0.5 threshold. 224 was rejected because it does
shift the descriptor.

### Re-measured: 100 concurrent, real faces, real model

| Config | Login p50 | Check-in p50 | Wall |
|---|---|---|---|
| **Before** (1 proc, per-request worker) | 9,231 ms | **23,121 ms** | 32.6 s |
| After fixes (1 proc) | 6,067 ms | **8,453 ms** | 14.6 s |
| After fixes + cluster 2 | 6,296 ms | 7,090 ms | 13.5 s |
| **After fixes + cluster 4** | 5,510 ms | **6,728 ms** | 12.4 s |

**23.1 s → 6.7 s = 3.4× faster.** 100/100 succeeded, **0 duplicates**, 0 errors
at every configuration.

### The number that actually matters: realistic arrival

100 employees do not arrive in the same millisecond. Spread over a 60-second
window (a real 9 a.m. rush), cluster=4:

| | Simultaneous | **Realistic (60 s)** |
|---|---|---|
| Login p50 | 5,510 ms | **86 ms** |
| Check-in p50 | 6,728 ms | **1,827 ms** |
| Event-loop lag | 4 ms | 8 ms |
| Duplicates | 0 | **0** |

**1.8 s for a full face check-in (upload + inference + geocode + write) is good
UX.** The 6.7 s figure is the absolute ceiling, not the daily experience.

### 500 users — degraded, and the measurement is confounded

500 over a 300 s window, cluster=4: **499/500 succeeded, 1 failed**, p50 fine
(login 1,338 ms / check-in 1,639 ms) but the tail collapsed — p95 ~14 s and one
login hung **750 s**. Wall clock ran 922 s against a 300 s window.

**Honest limitation:** this one machine runs MongoDB, 4 cluster workers, the
face pools *and* the 500-user load client. I cannot separate server capacity
from client contention at that level. → **500 / 1K / 5K / 10K: NOT RUNTIME
VERIFIED — requires a separate load-generator host.**

### Still outstanding on load

`bcryptjs` 2.4.3 is **pure JavaScript**, so password hashing runs on the JS
thread (measured: 100 parallel compares serialise 124×). A native/Rust bcrypt
would move it to a thread pool. **NOT DONE** — it adds a native dependency with
real deploy risk on Render, and it is now the smaller half of the cost. Flagged
as a decision, not silently skipped. Password cost factor was **not** lowered.

---

## 2. 🟡 managerId — researched, decided, and narrowed

You told me twice not to convert `managerId` into an RBAC role. I had already
partly done so, including granting managers **full salary and PII visibility**
of their reports.

**Research:** enterprise manager-self-service exposes compensation to a line
manager *inside a specific workflow* — a merit-increase or promotion cycle,
within HR-set guardrails — rather than as always-visible directory data, and
some organisations restrict it to director level or above entirely.
([Outsail](https://www.outsail.co/post/manager-self-service-in-hris-reduce-administrative-burden),
[HRMS World](https://www.hrmsworld.com/hrms-salary-management-the-fundamentals-of-compensation-862.html),
[Microsoft Dynamics 365 MSS](https://learn.microsoft.com/en-us/dynamics365/human-resources/mss-overview))

**This product has no compensation-review workflow**, so there was no basis for
always-on access. **Removed.**

| `managerId` grants a direct report's manager | Status |
|---|---|
| See report's leave requests | ✅ Kept — line management |
| Approve/decline report's leave | ✅ Kept — line management |
| Set report's working status (one field) | ✅ Kept — needed by the approval flow |
| See report's leave balance | ✅ Kept — line management |
| See report's working details (name, role, dept, dob, phone) | ✅ Kept |
| **See report's salary / basic / bank / PAN / UAN / ESI** | ❌ **REMOVED** |
| Read report's payslip | ❌ Never granted (verified by test) |

There are still exactly **four roles**. `managerId` remains an **organisational
relationship** that carries line-management authority — not a role, and not a
pay grant. Pinned by 6 new tests in `authorizationMatrix.test.js`.

> **BUSINESS DECISION REQUIRED:** if Smaatech wants managers to see their
> reports' pay, that is a legitimate choice — but it should be explicit, and
> ideally scoped to an appraisal/increment cycle rather than permanent. Say so
> and it is a one-line change at `MANAGER_HIDDEN_FIELDS`.

---

## 3. Remaining module audit — evidence, not assumption

| Module | Finding | Status |
|---|---|---|
| **Performance Management** | `Review` model is real: `cycleName`, `selfRating`, `selfComments`, `managerRating`, `managerComments`, `goals[]`, status `pending → self-submitted → completed`. A genuine two-sided review cycle. No calibration, no 360°, no rating distribution. | 🟡 **PARTIAL — functional** |
| **Reports / Analytics** | **No server-side analytics endpoint exists.** `Analytics.jsx` computes everything client-side from `useHRMS()` state, which is capped (100-row defaults). Numbers will silently under-report once data exceeds those caps. | ⚠️ **RISKY at scale** |
| **Shifts / Work schedules** | `shifts`, `roster`, `employeeShifts` are `Schema.Types.Mixed` on Settings — no schema, no validation, no dedicated model. Functionally used by `resolveShiftForToday()`, but unvalidated. | 🟡 **PARTIAL — untyped** |
| Recruitment / Offer / Hiring | `Candidate` has `title`, `candidate`, `stage`, `onboarding[]`. Stage tracking only — no offer letter, no hire→employee conversion. | 🟡 **PARTIAL** |
| **Probation, Confirmation, Transfer, Promotion, Salary Revision** | `grep` over models+routes: **0 files each** | ❌ **MISSING** |
| **Overtime, Variable Pay, Bonus, Arrears** | `grep`: **0 files each** | ❌ **MISSING** |
| **Backup / Restore** | Nothing exists | ❌ **MISSING** |
| Monitoring | `/health` public, `/metrics` token-gated, Prometheus format, **face queue depth + busy workers now exposed** | ✅ |
| Tally export | `client/src/lib/tally.js` — real XML voucher generator with statutory ledger mapping | ✅ (bank file still missing) |

For each MISSING item: these are **REQUIRED CAPABILITY / BUSINESS DECISION**,
not bugs. They were never built, and I have not invented them.

---

## 4. Verification gates

| Gate | Result |
|---|---|
| Server tests | ✅ **406 passing**, 29 files |
| Client tests | ✅ 26 passing |
| Client lint | ✅ 0 errors |
| Client production build | ✅ |
| Runtime smoke (real process, real HTTP) | ✅ 32/32 |
| 100-user concurrency, simultaneous | ✅ 100/100, 0 duplicates, p50 6.7 s |
| 100-user concurrency, realistic 60 s | ✅ 100/100, 0 duplicates, **p50 1.8 s** |
| 500-user | ⚠️ 499/500, tail collapse — confounded |
| Live-data verification (your Atlas) | ✅ 17/17 |

---

## 5. 🔍 NOT VERIFIED — stated plainly

- **FRONTEND RUNTIME NOT VERIFIED.** No browser driver has been run. API
  contracts are verified per role (`clientContract.test.js`, 22 tests replaying
  the client's exact call shapes), and the Vite dev server serves the app, but
  **no one has clicked through Login → Employee Creation → Attendance → Leave →
  Payroll → Resignation in a real browser.** Backend passing ≠ feature complete.
- **Docker build / compose** — Docker not installed here.
- **500 / 1K / 5K / 10K** — needs a separate load host.
- **Backup / restore** — nothing to test.
- **Liveness vs video replay / deepfake / 3D mask** — defeats printed photo and
  static screen only.
- **TDS** — new-regime estimate from salary income. **Not "compliant."**
  PF/ESI/PT are computed and tested.

---

## 6. Production blockers

| # | Blocker | Status |
|---|---|---|
| **P0-A** | Peak latency | 🟢 **Largely fixed** — 3.4× faster; realistic pattern 1.8 s |
| **P0-B** | In-memory stores are per-worker → clustering unsafe | 🔴 **OPEN** — `liveness.js`, `qrTokenStore.js`, `idempotency.js`, `cacheStore.js`. Must fix **before** enabling cluster, which is the main load lever |
| **P0-C** | Real S3/R2 not provisioned | 🔴 OPEN |
| **P0-D** | Docker never built | 🔴 OPEN |
| **P1-A** | No backup/restore | 🔴 OPEN |
| **P1-B** | No browser E2E | 🔴 OPEN |
| **P1-C** | Analytics computed client-side from capped data | 🟡 OPEN |

---

## 7. Re-verify

```bash
npm --prefix server test                                    # 406
npm --prefix server run smoke                               # 32/32
npm --prefix server run concurrency 100                      # simultaneous
ARRIVAL_WINDOW_S=60 CLUSTER_WORKERS=4 npm --prefix server run concurrency 100
npm --prefix client run lint && npm --prefix client run build
```

---

## Why 7.5 and not higher

**Earned:** peak load profiled and fixed with measured evidence; a real
cluster-oversubscription bug found and fixed; managerId researched, narrowed and
documented as a business decision; 406 tests.

**Withheld:** 500 users degrades; clustering — the main scaling lever — is
**unsafe until P0-B is fixed**; no browser E2E at all; nine capabilities do not
exist; backup/restore does not exist; Analytics will silently under-report at
scale.

**Next, in order of value:** (1) fix P0-B so clustering is safe, (2) browser
E2E of the six workflows, (3) server-side Analytics, (4) decide the lifecycle
gaps.
