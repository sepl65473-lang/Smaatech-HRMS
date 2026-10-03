# Smaatech HRMS — Android app

A native Android client for the existing Smaatech HRMS. It talks to the same Render API and the same MongoDB data as the web app, signs in with the same accounts, and is subject to the same server-side rules.

```
Mobile app ─┐
            ├─► Render API (server/) ─► MongoDB
Web app ────┘
```

The app never connects to MongoDB and contains no business rules of its own.

| | |
|---|---|
| Technology | Expo SDK 57, React Native 0.86, TypeScript, React Navigation 7, TanStack Query 5 |
| Android package | `com.smaatech.hrms` |
| Version | 1.0.0 (versionCode 1) |
| API | `https://smaatech-hrms-1.onrender.com/api/v1` |
| Build | EAS Build (`eas.json`), profiles `production-apk` and `production` |

## Status

Verified on the development machine:

- `npm run typecheck`, `npm run lint` and `npm run doctor` pass.
- The release JavaScript bundle builds (`expo export --platform android`).
- Server tests pass, including two new tests for the one backend change below.
- `server/src/routes/mobileClientContract.test.js` replays the app's exact request shapes (explicit refresh cookie, multipart punch, role scoping, leave and correction workflows) against the real server code and passes.

Not yet done, and required before rollout:

- **A release APK was built with EAS on 2026-10-03** (build `d2e64eca-4193-4b5e-bc5a-b48d2f898d41`, project `@smaatech/smaatech-hrms-mobile`, 1.0.0 / versionCode 1). The signing keystore is held in the `smaatech` Expo account; download a backup with `eas credentials`. Build artifacts on EAS expire after two weeks.
- **Nothing has run on a phone.** Sign-in, camera, GPS, face check-in, downloads and notifications are untested on a device. Work through [Device test checklist](#device-test-checklist) on a real Android phone before distributing.

## Why Expo / React Native

The web client is React, so the team's existing skills and the API client's conventions carry over. Every native capability the HRMS needs has a maintained Expo module: camera, GPS, Keystore-backed secure storage, notifications, PDF generation, file download and opening. Face recognition runs on the server, so the app needs no on-device ML, which is the usual reason to leave Expo. EAS produces a signed release APK without a local Android toolchain.

A WebView was not used anywhere.

## What the audit found

These facts about the existing HRMS shaped the app. File references are relative to the repository root.

- **Roles** are `HR Director` (the admin), `HR Manager`, `Finance Lead` and `Employee` (`server/src/models/User.js`, `server/src/middleware/auth.js`). HR Director bypasses permission checks within its company. There is no separate "Admin" model.
- **Sign-in** is by email or by registered mobile number, with the same password (`/auth/login`, `/auth/login-mobile`). Five wrong attempts lock the account for 15 minutes. An account on a temporary password can do nothing but change it.
- **Sessions**: a 15-minute access token, plus a 30-day refresh token delivered as an httpOnly cookie scoped to `/api/v1/auth` and rotated on every refresh (`server/src/lib/tokens.js`).
- **Face verification is entirely server-side.** The client uploads a JPEG; the server detects the face, compares it to the signed-in account's enrolled face only, and decides (`server/src/routes/attendance.js` `handlePunch`). The web client's face detection is framing feedback and nothing more.
- **Every self check-in/out must carry GPS coordinates**, whether or not geofencing is on. With geofencing on, the server also rejects a fix older than 30 s, less accurate than 100 m, or outside the radius.
- **Liveness** is optional per company (`Settings.livenessRequired`): a server-issued challenge (turn left, turn right, blink) answered with a burst of 3–8 frames.
- **General-shift check-out** is refused before 6:00 PM IST.
- **Leave** balance, working days, holidays, overlap and approval stages are computed by the server. Approval stages come from settings; reporting managers can decide their reports' requests.
- **Payslips** are not stored files. The web client renders a PDF from the payroll row; the app does the same.
- **Notifications** are in-app rows plus email. There is no push provider.
- **Documents** are downloaded through an authenticated route that re-checks visibility; there are no public file URLs.
- **`/attendance` is rate limited** to 40 requests per user per 15 minutes, reads included.

## Web to mobile matrix

| Web function | API | Roles | On mobile | Screen |
|---|---|---|---|---|
| Sign in (email or mobile) | `POST /auth/login`, `/auth/login-mobile` | All | Yes | Login |
| Forgot password (email OTP) | `/auth/forgot-password`, `/auth/reset-password` | All except HR Director | Yes | Reset password |
| Forced / voluntary password change | `POST /auth/change-password` | All | Yes | Change password |
| Face sign-in | `POST /auth/face-login` | All | No. The session persists securely, so it adds nothing on a personal phone | — |
| Self check-in / check-out | `POST /attendance/:id/check-in`, `check-out` | Anyone with an employee profile | Yes, primary feature | Check in / Check out |
| Liveness challenge | `GET /attendance/liveness/challenge` | Same | Yes, when the company requires it | Check in / Check out |
| Face enrolment and re-verification | `POST /face/enroll`, `GET /face/access/me` | Same | Yes | Profile → Face verification |
| QR check-in | `POST /attendance/qr-checkin` | Employee | No. Needs the office display; face check-in covers the phone | — |
| Own attendance history | `GET /attendance` | Same | Yes | Attendance |
| Attendance correction request | `POST /attendance-corrections` | Same | Yes | Attendance correction |
| Leave balance, apply, withdraw, cancel | `/leaves`, `/leaves/balance`, `/leaves/types`, `/leaves/:id/withdraw` | Same | Yes. A request that needs a supporting document must be filed on the web | Leave, Apply for leave |
| Decide a direct report's leave | `POST /leaves/:id/approve`, `decline` | Reporting manager | Yes | Leave |
| Payslips | `GET /payroll` | Same | Yes, with PDF open and share | Payslips |
| Documents | `GET /documents`, `/documents/:id/download` | All | View and open. Upload and edit stay on web | Documents |
| Holidays | `GET /holidays` | All | View | Holidays |
| Notifications | `GET /notifications`, mark read | All | Yes | Alerts |
| Own profile | `GET /employees/:id` | Same | View. Editing stays on web | Profile |
| Company attendance today | `GET /attendance?date=` | HR | Monitoring, with exceptions filter | Attendance today |
| Manual attendance override, verification dossier, rejected-attempt photos | `/attendance` CRUD, `/attendance/:id/verification` | HR | No. Evidence review and overrides are desk tasks | — |
| Employee directory | `GET /employees` | HR | Search and view | People, Employee |
| Create, edit, import, offboard employees | `/employees`, `/lifecycle`, `/resignations` | HR | No | — |
| Leave approval | `/leaves/:id/approve`, `decline` | HR | Yes | Approvals |
| Attendance correction review | `/attendance-corrections/:id/approve`, `reject` | HR | Yes | Approvals |
| Analytics | `GET /analytics/overview` | HR, Finance | Monthly summary. Charts and exports stay on web | Reports |
| Payroll list | `GET /payroll?cycle=` | HR, Finance | View rows and payslips | Payroll |
| Run, edit, pay, unlock payroll; salary structures; variable pay | `/payroll`, `/pay-components` | HR, Finance | No. High-consequence desk tasks | — |
| Expenses, assets, recruitment, performance, celebrations, roster planning | Various | Various | No in 1.0. Either desk tasks or low mobile value | — |
| Users, roles, settings, audit logs, integrations, leave policy | `/users`, `/roles`, `/settings`, `/audit-logs` | HR Director | No. Administration stays on web | — |

## Screens by role

Bottom tabs change with the signed-in role. The API still authorises every request; hiding a tab is not the control.

**Employee** — Home · Attendance · Leave · Alerts · Profile

**HR Manager and HR Director (Admin)** — Home · People · Approvals · Alerts · More

**Finance Lead** — Home · Payroll · Alerts · More

Stack screens reached from those tabs: Check in / Check out / Enrol face, Attendance correction, Apply for leave, Payslips, Documents, Holidays, Change password, My attendance, My leave, Attendance today, Employee, Reports, Payroll.

HR, Admin and Finance users who have an employee profile get the same check-in card on Home and reach their own attendance, leave and payslips from More. The server verifies their punches exactly as it does anyone else's.

Admin (HR Director) sees the same mobile screens as HR Manager. The powers that distinguish the role on the web (users, roles, settings, audit log, payroll unlock) are all web-only by design.

## Folder layout

```
app.json             App identity, permissions, plugins
app.config.ts        Adds the API URL to app.json
eas.json             Build profiles
App.tsx              Providers and root navigator
assets/              Icons and logo, generated from ../public/logo.jpg
src/
  config/            Environment (API URL, timeouts)
  theme/             Brand colours and type, taken from the web client
  types/             API response shapes
  storage/           Secure storage (refresh token, device id)
  services/          API client and endpoint list
  auth/              Session state and role capabilities
  permissions/       Location acquisition
  attendance/        Photo preparation and punch submission
  notifications/     Local notifications
  hooks/             Shared queries
  navigation/        Stack and role-based tabs
  components/        UI kit, today card, leave decision sheet
  utils/             Dates, formatting, files and PDF, pickers
  screens/
    auth/            Login, reset password, change password
    employee/        Home, attendance, face capture, correction, leave, payslips
    common/          Notifications, documents, holidays, profile
    hr/              Workspace home, people, employee, attendance today, approvals, reports, payroll
```

## How the important parts work

### Sign-in and session

The app posts credentials to the existing login routes. The password is never stored. The refresh token arrives in the `Set-Cookie` header; the app reads it, keeps it in `expo-secure-store` (Android Keystore), and sends it back as a `Cookie` header on `/auth` calls only. The platform cookie jar is not used. The access token lives in memory.

On start the app exchanges the stored refresh token for a new session. If the server refuses it, the user is signed out; if the server is unreachable, the session is kept and a retry screen is shown. A 401 on any request triggers one refresh and a replay. Sign-out revokes the refresh token on the server and clears cached data, downloaded documents and generated payslips from the phone.

### Check-in and check-out

1. Home or Attendance shows today's record and the one action that applies.
2. The capture screen asks for camera and location permission and starts a GPS fix.
3. The employee takes a photo. If the company requires liveness, the app fetches a challenge, shows the prompt and captures a burst.
4. Each frame is re-rendered to an upright 720 px JPEG, because the server's decoder ignores EXIF rotation.
5. The app uploads the photo, raw coordinates, accuracy, fix time and a per-install device id.
6. The server matches the face against the signed-in account, checks liveness and geofence, applies shift rules and records the time.
7. The app shows "Checked in" only from the server's success response, with the recorded time and address. Any rejection shows the server's reason and what to do about it.

If the connection drops after upload, the app asks the server whether the punch was recorded rather than assuming either outcome.

Someone else's face cannot be accepted: the server compares the photo with the enrolled face of the account that holds the session, and nothing the app sends can change which account that is.

### Notifications

The inbox is the HRMS's own notification list, refreshed every two minutes while the app is open and on pull-to-refresh. When a refresh finds new unread items the app raises a local Android notification. An optional daily check-in reminder is scheduled on the device.

**Remote push is not implemented**, because the backend has no push provider. A leave approval reaches the phone when the app next refreshes, not instantly. Adding real push needs a Firebase project, a device-token endpoint on the API, and a send step in `server/src/lib/notificationService.js`.

### Documents and payslips

Documents download through `GET /documents/:id/download` with the bearer token into the app's private cache, then open in the phone's viewer through a temporary read grant. Payslip PDFs are rendered on the phone from the payroll row, with the same content as the web payslip.

## Backend change

One additive change was made to the API. Nothing else in `server/` or `client/` was touched.

**`GET /api/v1/attendance` accepts `?empId=` for HR roles** (`server/src/routes/attendance.js`).

- Why: for HR the list is company-wide, so "my own attendance" and "this employee's attendance" meant paging through everyone, against a limit of 40 attendance requests per 15 minutes.
- Safety: applied only when the caller is HR Manager or HR Director. For everyone else the server already pins the query to their own record, and the parameter is ignored. An invalid id returns 400. The web client does not send the parameter, so its behaviour is unchanged.
- Tests: two added in `server/src/routes/attendance.test.js` (HR can narrow; an employee cannot widen).
- Deployment: **the app works against the current production API without this change.** It detects an API that ignores the parameter and pages instead, capped at four requests, and says so when the result is incomplete. Deploying the change removes that limitation for HR users.
- Release decision for 1.0.0: **not deployed.** The APK does not depend on it, so the production backend was left untouched for the first release. The fallback returns a complete month for a company of up to about 26 employees and a complete "today" for up to 200; beyond that HR users see a notice that the list is partial. Deploy the change (push `server/src/routes/attendance.js` to the branch Render builds from) when HR's own history or per-employee attendance on mobile needs to be complete for a larger roster.

## Security

- Passwords are never stored. Only the revocable refresh token and a random install id are kept, both in Keystore-backed storage.
- No secrets, keys or credentials are in this folder. The API URL is the only configuration and it is public.
- Release builds refuse to start with a non-HTTPS or private-network API URL, and cleartext traffic is disabled.
- Requested permissions: camera, location while in use, notifications. Microphone, background location and storage are explicitly blocked.
- Authorisation is the server's. The app's role checks only decide what to display.
- Downloaded files stay in private app storage and are deleted on sign-out.
- A mock-location app blocks check-in on the device. This is a courtesy check; the server's geofence is the control.
- The app logs nothing.

## Development

Requires Node 20 or later. Native modules mean Expo Go cannot run this app.

```bash
cd "Mobile Application"
npm install
npm run typecheck && npm run lint && npm run doctor

# One-time: a development build installed on a phone
npx eas-cli@latest build --platform android --profile development
npx expo start --dev-client
```

A development build uses `EXPO_PUBLIC_API_BASE_URL` from `.env` if set, otherwise production. Pointing a development build at production means real data: check-ins and leave requests made while testing are real records.

## Building the APK

The release APK is built by EAS in the cloud. It needs an Expo account and nothing installed locally.

```bash
cd "Mobile Application"
npx eas-cli@latest login
EAS_NO_VCS=1 npx eas-cli@latest build --platform android --profile production-apk
```

`EAS_NO_VCS=1` uploads only this folder, so the server and web code are not sent to Expo. The project is already linked (`owner` and `extra.eas.projectId` in `app.json`).

On the first build EAS offers to generate an Android keystore and stores it with the Expo account. **Download a backup of that keystore** (`eas credentials`): every future update must be signed with it.

The build page gives a download link for the `.apk`. The `production` profile builds an `.aab` for Google Play instead.

For each release, raise `version` and `android.versionCode` in `app.json`.

Code minification (R8) is left off for 1.0 because no release build has been run on a device yet. Turn it on through `expo-build-properties` once a release build is verified.

A local Gradle build (`npm run build:apk:local`) needs JDK 17 and the Android SDK, and a machine that allows the Hermes compiler to run.

## Device test checklist

Run on at least one real Android phone, once per role, before distributing. Emulators cannot stand in for camera, face and GPS.

**All roles**
- [ ] Sign in by email, and by mobile number. Wrong password shows the server's message.
- [ ] Close and reopen the app: the session is restored without signing in.
- [ ] Sign in with a temporary password: only the change-password screen is reachable.
- [ ] Airplane mode: screens show an error with Try again, and recover when back online.
- [ ] First request after the API has been idle: the app waits and then loads.
- [ ] Sign out, then confirm the previous user's data is gone after another user signs in.
- [ ] Android back button behaves on every screen; the keyboard does not cover form buttons.

**Employee**
- [ ] Enrol face from Profile.
- [ ] Check in: camera and location prompts, capture, server-confirmed time and address.
- [ ] Check in with another person's face: rejected.
- [ ] Deny camera, then location: clear message and a way to settings.
- [ ] Check in twice: second attempt is refused.
- [ ] Check out before 6:00 PM on the General shift: refused with the server's message.
- [ ] With geofencing on: outside the radius is refused.
- [ ] With liveness on: each of the three prompts, in the correct direction.
- [ ] Attendance history by month; request a correction.
- [ ] Apply for leave, half-day leave, overlapping leave (refused), withdraw.
- [ ] Open and share a payslip PDF.
- [ ] Open a document.
- [ ] Notifications list, mark read, mark all read.
- [ ] Daily reminder fires at the set time.

**HR Manager / HR Director**
- [ ] Home counts match the web attendance page.
- [ ] Attendance today: filters, search, exceptions.
- [ ] People search and employee detail.
- [ ] Approve and reject leave; approve and reject a correction; the employee sees the result.
- [ ] Reports match the web analytics for the same month.
- [ ] Own check-in works and is face-verified.

**Finance Lead**
- [ ] Payroll list by month; open a payslip.
- [ ] Reports.
- [ ] No People or Approvals tabs. Calling an HR-only endpoint returns 403.

Two points to watch on the first device run, because they could not be exercised without a phone:

- **Refresh-token handling.** Sign in, wait 20 minutes, then use the app. It should continue without a sign-in prompt. If it signs out, the `Set-Cookie` header is not reaching the app on that device.
- **Liveness direction.** With liveness on, confirm "turn left" is accepted when turning left. The web client has no liveness flow to compare against.
