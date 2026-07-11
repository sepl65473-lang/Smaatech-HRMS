"""
Generates Smaatech-HRMS-Backend-API-Spec.pdf at the project root.

Run with:  python scripts/generate_backend_spec_pdf.py
Requires:  pip install reportlab
"""

import datetime
import os

from reportlab.lib.pagesizes import LETTER
from reportlab.lib.units import inch
from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.enums import TA_LEFT, TA_CENTER
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, PageBreak, Table, TableStyle,
    Preformatted, ListFlowable, ListItem,
)
from reportlab.platypus.tableofcontents import TableOfContents
from reportlab.pdfgen import canvas as pdfcanvas

# ─────────────────────────────────────────────────────────────
#  Page / style setup
# ─────────────────────────────────────────────────────────────

PAGE_W, PAGE_H = LETTER
MARGIN = 0.75 * inch
OUTPUT_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                            "Smaatech-HRMS-Backend-API-Spec.pdf")

base = getSampleStyleSheet()

styles = {
    "CoverTitle": ParagraphStyle("CoverTitle", parent=base["Title"], fontSize=30, leading=36,
                                  alignment=TA_CENTER, spaceAfter=10),
    "CoverSubtitle": ParagraphStyle("CoverSubtitle", parent=base["Normal"], fontSize=16, leading=22,
                                     alignment=TA_CENTER, textColor=colors.HexColor("#444444"), spaceAfter=6),
    "CoverMeta": ParagraphStyle("CoverMeta", parent=base["Normal"], fontSize=11, leading=16,
                                 alignment=TA_CENTER, textColor=colors.HexColor("#666666")),
    "H1": ParagraphStyle("H1Style", parent=base["Heading1"], fontSize=18, leading=22,
                          spaceBefore=18, spaceAfter=10, textColor=colors.HexColor("#1a1a1a")),
    "H2": ParagraphStyle("H2Style", parent=base["Heading2"], fontSize=14, leading=18,
                          spaceBefore=14, spaceAfter=6, textColor=colors.HexColor("#222222")),
    "H3": ParagraphStyle("H3Style", parent=base["Heading3"], fontSize=11.5, leading=15,
                          spaceBefore=10, spaceAfter=4, textColor=colors.HexColor("#4a4a4a")),
    "Body": ParagraphStyle("BodyStyle", parent=base["Normal"], fontSize=10, leading=14.5,
                            spaceAfter=4, alignment=TA_LEFT),
    "BodyBold": ParagraphStyle("BodyBoldStyle", parent=base["Normal"], fontSize=10, leading=14.5,
                                spaceAfter=4, fontName="Helvetica-Bold"),
    "Cell": ParagraphStyle("CellStyle", parent=base["Normal"], fontSize=8.7, leading=11.5),
    "CellHead": ParagraphStyle("CellHeadStyle", parent=base["Normal"], fontSize=8.8, leading=11.5,
                                fontName="Helvetica-Bold", textColor=colors.white),
    "Mono": ParagraphStyle("MonoStyle", parent=base["Normal"], fontName="Courier", fontSize=8.3, leading=11.5),
}

TOC_STYLES = [
    ParagraphStyle("TOCH1", fontName="Helvetica-Bold", fontSize=12, leftIndent=0,
                    firstLineIndent=0, spaceBefore=8, leading=15),
    ParagraphStyle("TOCH2", fontName="Helvetica", fontSize=10, leftIndent=18,
                    firstLineIndent=0, spaceBefore=2, leading=13, textColor=colors.HexColor("#333333")),
]

FOOTER_TEXT = "Smaatech HRMS - Backend API Specification - Confidential"


# ─────────────────────────────────────────────────────────────
#  Small content-building helpers (keep the section content below readable)
# ─────────────────────────────────────────────────────────────

story = []


def h1(text):
    story.append(Paragraph(text, styles["H1"]))


def h2(text):
    story.append(Paragraph(text, styles["H2"]))


def h3(text):
    story.append(Paragraph(text, styles["H3"]))


def p(text):
    story.append(Paragraph(text, styles["Body"]))


def bullets(items):
    story.append(ListFlowable(
        [ListItem(Paragraph(i, styles["Body"]), spaceBefore=2) for i in items],
        bulletType="bullet", leftIndent=16,
    ))
    story.append(Spacer(1, 6))


def spacer(h=8):
    story.append(Spacer(1, h))


def page_break():
    story.append(PageBreak())


def code(text):
    tbl = Table(
        [[Preformatted(text.strip("\n"), styles["Mono"])]],
        colWidths=[PAGE_W - 2 * MARGIN],
    )
    tbl.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#f4f4f2")),
        ("BOX", (0, 0), (-1, -1), 0.5, colors.HexColor("#dcdcd8")),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    story.append(tbl)
    story.append(Spacer(1, 8))


def callout(label, text, color="#8a6d00", bg="#fff8e1"):
    tbl = Table(
        [[Paragraph("<b>%s:</b> %s" % (label, text), styles["Body"])]],
        colWidths=[PAGE_W - 2 * MARGIN],
    )
    tbl.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor(bg)),
        ("BOX", (0, 0), (-1, -1), 0.5, colors.HexColor(color)),
        ("LEFTPADDING", (0, 0), (-1, -1), 10),
        ("RIGHTPADDING", (0, 0), (-1, -1), 10),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    story.append(tbl)
    story.append(Spacer(1, 8))


def endpoint_table(rows):
    """rows: list of (METHOD, path, description)"""
    header = [Paragraph("Method", styles["CellHead"]), Paragraph("Path", styles["CellHead"]),
               Paragraph("Description", styles["CellHead"])]
    data = [header]
    for method, path, desc in rows:
        data.append([Paragraph("<b>%s</b>" % method, styles["Cell"]),
                      Paragraph(path, styles["Cell"]),
                      Paragraph(desc, styles["Cell"])])
    tbl = Table(data, colWidths=[0.7 * inch, 2.1 * inch, PAGE_W - 2 * MARGIN - 2.8 * inch])
    tbl.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#33424f")),
        ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#d8d8d4")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f7f7f5")]),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    story.append(tbl)
    story.append(Spacer(1, 8))


def two_col_table(rows, col1="Role", col2="Access", widths=None):
    header = [Paragraph(col1, styles["CellHead"]), Paragraph(col2, styles["CellHead"])]
    data = [header]
    for a, b in rows:
        data.append([Paragraph(a, styles["Cell"]), Paragraph(b, styles["Cell"])])
    if widths is None:
        widths = [1.6 * inch, PAGE_W - 2 * MARGIN - 1.6 * inch]
    tbl = Table(data, colWidths=widths)
    tbl.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#33424f")),
        ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#d8d8d4")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f7f7f5")]),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    story.append(tbl)
    story.append(Spacer(1, 8))


def three_col_table(rows, headers, widths=None):
    data = [[Paragraph(x, styles["CellHead"]) for x in headers]]
    for row in rows:
        data.append([Paragraph(x, styles["Cell"]) for x in row])
    if widths is None:
        n = len(headers)
        widths = [(PAGE_W - 2 * MARGIN) / n] * n
    tbl = Table(data, colWidths=widths)
    tbl.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#33424f")),
        ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#d8d8d4")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f7f7f5")]),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    story.append(tbl)
    story.append(Spacer(1, 8))


def module_header(title):
    h2(title)


# ─────────────────────────────────────────────────────────────
#  COVER PAGE
# ─────────────────────────────────────────────────────────────

story.append(Spacer(1, 2.2 * inch))
story.append(Paragraph("Smaatech HRMS", styles["CoverTitle"]))
story.append(Paragraph("Backend API Specification", styles["CoverSubtitle"]))
story.append(Spacer(1, 0.4 * inch))
story.append(Paragraph("Prepared for: Backend Developer", styles["CoverMeta"]))
story.append(Paragraph("Version 1.0 - %s" % datetime.date.today().isoformat(), styles["CoverMeta"]))
story.append(Paragraph("Confidential - Internal Handoff Document", styles["CoverMeta"]))
page_break()

# ─────────────────────────────────────────────────────────────
#  TABLE OF CONTENTS
# ─────────────────────────────────────────────────────────────

h1("Table of Contents")
toc = TableOfContents()
toc.levelStyles = TOC_STYLES
story.append(toc)
page_break()

# ─────────────────────────────────────────────────────────────
#  1. EXECUTIVE OVERVIEW
# ─────────────────────────────────────────────────────────────

h1("1. Executive Overview")

p("Smaatech HRMS is currently a fully client-side React application. There is no backend "
  "server today: every screen reads and writes through a single mock data-access module "
  "(<font face='Courier'>src/data/store.js</font>) that persists everything to the browser's "
  "localStorage and returns Promises, so the rest of the app already treats data access as "
  "asynchronous. The code was written with a real backend in mind from day one - the store's "
  "own comments say so directly.")

callout("Core contract", "Every collection in <font face='Courier'>store.js</font> "
        "(<font face='Courier'>employeesApi</font>, <font face='Courier'>payrollApi</font>, etc.) "
        "exposes exactly four methods: <font face='Courier'>list / get / create / update / remove</font>. "
        "Each one maps to a single REST verb. If your API returns the same JSON shapes the frontend "
        "already expects, no frontend component code needs to change - only the five functions inside "
        "<font face='Courier'>store.js</font> get rewritten to call <font face='Courier'>fetch()</font> "
        "instead of localStorage.")

h3("What already exists and works end-to-end today (frontend only)")
bullets([
    "19 fully-built pages: Dashboard, My Dashboard (employee self-service), Employees, Org Chart, "
    "Attendance, Leave, Holidays, Payroll, Celebrations, Recruitment, Performance, Documents, "
    "Analytics, Settings, Integrations, Expenses, Assets, Workflows, and Login.",
    "Real CRUD, search, filter, sort, pagination, forms with manual validation, modals and "
    "confirm dialogs, role-based navigation and route guarding for 4 roles.",
    "A single React Context (<font face='Courier'>HRMSContext.jsx</font>) that every page reads "
    "and writes through - this is effectively the 'client SDK' your API needs to support.",
])

h3("What is simulated today and needs real backend (and sometimes frontend) work")
bullets([
    "Login / sessions - 4 hardcoded plaintext email+password pairs, no server verification.",
    "OTP / two-factor - a fake code is shown to the user in a toast notification.",
    "QR check-in - a cosmetic QR graphic that auto-succeeds on a timer, nothing is decoded.",
    "Biometric device sync - fully randomized, no real device protocol is spoken.",
    "SMS / Email / WhatsApp sending - templates and credential fields exist, nothing is ever sent.",
    "Resume upload (Recruitment) and expense receipts - hardcoded text / pasted URLs, not real files.",
    "GPS geofence check-in - validated only in the browser, trivially bypassable today.",
])
p("Section 7 covers every one of these in a single reference table with exactly what needs to change.")

page_break()

# ─────────────────────────────────────────────────────────────
#  2. TECH STACK & MIGRATION STRATEGY
# ─────────────────────────────────────────────────────────────

h1("2. Tech Stack and Migration Strategy")

h2("2.1 Current frontend stack")
bullets([
    "React 18.3 with plain JavaScript (JSX) - no TypeScript.",
    "Build tool: Vite 5. Routing: react-router-dom v6.",
    "State: one global React Context, no Redux/Zustand.",
    "Styling: a single hand-written stylesheet, no UI component library.",
    "face-api.js for client-side face-recognition login (runs entirely in the browser).",
    "No axios, no fetch calls, no environment variables configured yet - a clean slate for wiring up a real API base URL (e.g. <font face='Courier'>VITE_API_BASE_URL</font>).",
])

h2("2.2 Suggested backend approach")
p("This document's examples use <b>Node.js + Express</b>, matching the request for this handoff. "
  "The choice of database is left to you; given how relational the data is (employees "
  "self-reference a manager, and leaves/attendance/payroll/reviews/expenses all foreign-key "
  "into employees), a relational database such as PostgreSQL or MySQL is a natural fit, though "
  "a document store like MongoDB will also work since most records are simple flat objects. "
  "The Express examples below use Mongoose-style pseudocode "
  "(<font face='Courier'>Model.find()</font>, <font face='Courier'>Model.create()</font>) purely "
  "as illustrative shorthand - swap in your ORM/query builder of choice.")

h2("2.3 Migration approach")
p("Replace the five functions returned by <font face='Courier'>createResource()</font> in "
  "<font face='Courier'>src/data/store.js</font> one collection at a time. Keep the exact same "
  "async/Promise signature so nothing else in the app has to change:")
code(
    """// BEFORE (src/data/store.js) - localStorage version
list: () => wait(clone(db[collection])),

// AFTER - real backend version, same call signature
list: () => fetch(`${API_BASE}/${collection}`).then(r => r.json()),"""
)

h2("2.4 Minimal Express app skeleton")
code(
    """// server.js
const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

app.use('/api/v1/auth', require('./routes/auth'));
app.use('/api/v1/employees', require('./routes/employees'));
app.use('/api/v1/leaves', require('./routes/leaves'));
app.use('/api/v1/attendance', require('./routes/attendance'));
app.use('/api/v1/payroll', require('./routes/payroll'));
app.use('/api/v1/recruitment', require('./routes/recruitment'));
app.use('/api/v1/reviews', require('./routes/reviews'));
app.use('/api/v1/expenses', require('./routes/expenses'));
app.use('/api/v1/assets', require('./routes/assets'));
app.use('/api/v1/settings', require('./routes/settings'));
app.use('/api/v1/files', require('./routes/files'));

app.listen(process.env.PORT || 4000);"""
)

page_break()

# ─────────────────────────────────────────────────────────────
#  3. AUTHENTICATION & AUTHORIZATION
# ─────────────────────────────────────────────────────────────

h1("3. Authentication and Authorization Design")

p("Today's login has no server component at all: 4 demo profiles with plaintext passwords live in "
  "<font face='Courier'>src/lib/permissions.js</font>, OTP is a fake code shown in a toast, "
  "'forgot password' resets the password directly in browser state, and the logged-in session is "
  "just an object written to localStorage that is never re-checked against anything. All of this "
  "needs a real implementation.")

h2("3.1 Endpoints")
endpoint_table([
    ("POST", "/api/v1/auth/login", "Body: email, password. Returns a session/token, or requiresOtp: true"),
    ("POST", "/api/v1/auth/otp/verify", "Body: email, code. Completes login after 2FA"),
    ("POST", "/api/v1/auth/otp/resend", "Body: email. Re-sends the one-time code"),
    ("POST", "/api/v1/auth/logout", "Invalidates the current session/refresh token"),
    ("GET", "/api/v1/auth/me", "Returns the authenticated user's profile and role"),
    ("POST", "/api/v1/auth/forgot-password", "Body: email. Sends a real reset link/email"),
    ("POST", "/api/v1/auth/reset-password", "Body: token, newPassword"),
])

h2("3.2 Session strategy - pick one")
p("<b>Option A - JWT:</b> short-lived access token (about 15 minutes) kept in memory on the "
  "frontend, plus an httpOnly refresh cookie (7-30 days). Scales cleanly to a future mobile app "
  "or additional services, and avoids ever putting a long-lived token where client-side "
  "JavaScript can read it.")
p("<b>Option B - Server session cookie:</b> simpler to implement and to revoke immediately "
  "(just delete the session row), fine for this app's scale. No token-replay surface to think about.")
p("Either is acceptable for this project; JWT is the slightly more future-proof default if you "
  "have no strong preference.")

h2("3.3 Role to permission mapping")
p("Today's frontend only checks <i>which page</i> a role can open "
  "(<font face='Courier'>canAccess()</font> in <font face='Courier'>src/lib/permissions.js</font>). "
  "A finer-grained action table (<font face='Courier'>canDo()</font>) exists in the same file but "
  "is never actually called anywhere in the app - so the backend cannot inherit real per-action "
  "authorization from the frontend. Use the table below (assembled from what each page actually "
  "does) as the source of truth for server-side authorization instead:")
two_col_table([
    ("HR Director", "Full access to every endpoint (superuser)."),
    ("HR Manager", "Employees, Attendance, Leave, Holidays, Celebrations, Recruitment, "
                   "Performance, Assets, Workflows - full read/write. Expenses - read only. "
                   "No Payroll, no Settings write."),
    ("Finance Lead", "Payroll, Documents, Expenses (approve/decline), Assets, Analytics - full "
                     "read/write. No Employee record write, no Leave approval."),
    ("Employee", "Own records only: own leave requests, own attendance check-in/out, own payroll "
                 "(read-only), own expense claims, own performance self-review."),
])

h2("3.4 Migrating the existing 4 demo accounts")
p("Seed a real <font face='Courier'>users</font> table with the same 4 identities so the demo "
  "experience keeps working end-to-end after go-live: an HR Director, an HR Manager, a Finance "
  "Lead, and an Employee account linked to an existing employee record. "
  "<b>Hash every password with bcrypt or argon2 before storing it</b> - never carry the plaintext "
  "passwords from <font face='Courier'>permissions.js</font> into the new database or into any "
  "shared document; ask whoever owns the frontend for the current demo credentials directly.")

h2("3.5 Face-recognition login")
p("Face matching runs entirely client-side today via face-api.js, comparing a live webcam "
  "capture against a 128-number face descriptor stored per profile in the browser. This can stay "
  "fully client-side. If you want server-side verification instead, add a "
  "<font face='Courier'>user_face_descriptors</font> table (userId, descriptor as a JSON float "
  "array) and an endpoint to fetch/store it - treat this as optional, not a launch blocker.")

h2("3.6 Express example - login route")
code(
    """// routes/auth.js
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const user = await User.findOne({ email });
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    return res.status(401).json({ error: { code: 'INVALID_CREDENTIALS', message: 'Wrong email or password' } });
  }
  if (user.twoFactorEnabled) {
    await sendOtp(user.email);          // real SMS/email provider, see Section 7
    return res.json({ requiresOtp: true });
  }
  const token = jwt.sign({ sub: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '15m' });
  res.json({ token, user: { id: user.id, name: user.name, role: user.role } });
});"""
)

page_break()

# ─────────────────────────────────────────────────────────────
#  4. CORE REST CONVENTIONS
# ─────────────────────────────────────────────────────────────

h1("4. Core REST Conventions")

h2("4.1 Base path")
p("All endpoints in this document are relative to <font face='Courier'>/api/v1</font>.")

h2("4.2 The generic collection pattern")
p("Every simple collection (celebrations, holidays, jobs, assets, and the base shape of "
  "employees/leaves/attendance/payroll/recruitment/reviews/expenses) follows the same five-route "
  "pattern, matching the five methods already used throughout the frontend's data layer:")
endpoint_table([
    ("GET", "/{collection}", "List records (supports ?page= and ?pageSize=)"),
    ("GET", "/{collection}/:id", "Fetch a single record by id"),
    ("POST", "/{collection}", "Create a new record"),
    ("PATCH", "/{collection}/:id", "Partially update a record"),
    ("DELETE", "/{collection}/:id", "Remove a record"),
])

h2("4.3 Pagination")
p("The frontend currently paginates client-side (e.g. the Employees list slices 6 records per "
  "page in the browser), so it can safely ignore pagination metadata it doesn't yet use. Still, "
  "build every list endpoint to accept <font face='Courier'>?page=&amp;pageSize=</font> and "
  "return an envelope so the frontend can move to server-side pagination later without an API "
  "version bump:")
code('{ "data": [ /* records */ ], "page": 1, "pageSize": 20, "total": 137 }')

h2("4.4 Error envelope")
p("Use a consistent error shape on every 4xx/5xx response so the frontend can show one generic "
  "error handler everywhere:")
code('{ "error": { "code": "NOT_FOUND", "message": "Employee not found" } }')

h2("4.5 IDs and timestamps")
p("The frontend does not care what format ids are in (today's mock layer generates strings like "
  "<font face='Courier'>emp_a1b2c3</font>) - UUIDs or auto-increment integers-as-strings are both "
  "fine. Recommend adding <font face='Courier'>createdAt</font> / <font face='Courier'>updatedAt</font> "
  "to every table even though the current frontend doesn't display them yet - useful for the audit "
  "log feature in Settings, and cheap to add now versus retrofitting later.")

page_break()

# ─────────────────────────────────────────────────────────────
#  5. PER-MODULE ENDPOINT REFERENCE
# ─────────────────────────────────────────────────────────────

h1("5. Per-Module Endpoint Reference")
p("Every module below follows the same shape: Endpoints, then the request/response JSON, who's "
  "allowed to call it, and any business logic the frontend currently does client-side that the "
  "backend must now own. Modules that add nothing beyond the generic pattern in Section 4 are "
  "noted as such rather than repeated in full.")

# ---- 5.1 Employees ----
module_header("5.1 Employees")
endpoint_table([
    ("GET", "/employees", "List all employees"),
    ("GET", "/employees/:id", "Get one employee"),
    ("POST", "/employees", "Create an employee"),
    ("PATCH", "/employees/:id", "Update an employee"),
    ("DELETE", "/employees/:id", "Remove an employee"),
    ("POST", "/employees/import", "Bulk-create from a validated CSV row array"),
])
h3("Record shape")
code(
    """{
  "id": "emp_a1b2c3", "name": "Ananya Nair", "role": "Senior SDE", "dept": "Engineering",
  "loc": "Bengaluru", "email": "ananya.nair@smaatech.co", "phone": "+91 98000 00001",
  "status": "active",        // active | remote | on-leave
  "joinDate": "2019-03-11", "salary": 236666, "rating": 4.9,
  "managerId": "emp_x9y8z7", "bankAccount": "", "ifsc": ""
}"""
)
h3("Roles")
p("Read: HR Director, HR Manager, Finance Lead (list/read only). Own record: Employee, via "
  "/ess. Create / update / delete: HR Director and HR Manager only.")
h3("Business logic to own")
bullets([
    "On create: also create today's attendance row (absent, or leave if status is on-leave) and "
    "a payroll row for the current cycle (deductions = 30% of gross as a placeholder - confirm "
    "the real statutory calculation with Finance before treating this as final).",
    "On update: if name or department changes, cascade the change onto that employee's "
    "denormalized name/dept copies in attendance, payroll and leave rows.",
    "On update: if salary changes, decide (with the product owner) whether to recompute future "
    "payroll cycles only, or also rewrite already-paid historical cycles - today's frontend "
    "rewrites everything including paid cycles, which is likely not the desired real-world behavior.",
    "On delete: cascade-delete that employee's attendance/payroll/leave/review rows, null out "
    "managerId on any direct reports, and unlink any login account pointed at them.",
    "/employees/import: validate every row server-side (required name/role, dept must exist in "
    "settings.departments, valid email, non-negative numeric salary, optional managerName "
    "resolved to a managerId) and return a per-row success/failure result - do not just loop "
    "individual creates blindly.",
])

# ---- 5.2 Leave ----
module_header("5.2 Leave")
endpoint_table([
    ("GET", "/leaves", "List leave requests"),
    ("POST", "/leaves", "Create a leave request"),
    ("PATCH", "/leaves/:id", "Update status (approve/decline) or edit"),
    ("DELETE", "/leaves/:id", "Remove a leave request"),
])
h3("Record shape")
code(
    """{
  "id": "lv_9f8e7d", "empId": "emp_a1b2c3", "name": "Priya Sharma", "dept": "Engineering",
  "type": "sick",             // sick | earned | casual
  "start": "2026-06-02", "end": "2026-06-04",
  "status": "pending",        // pending | approved | declined
  "reason": "Fever and rest advised by doctor."
}"""
)
h3("Roles")
p("Create: Employee (self) or HR Manager/Director on anyone's behalf. Approve/decline/delete: "
  "HR Manager, HR Director only.")
h3("Business logic to own")
bullets([
    "When status changes to approved and today falls within start/end: set that employee's "
    "status to on-leave and set today's attendance row to status leave with checkIn/checkOut "
    "cleared. No side effect on decline.",
    "Multi-step approval chains are not implemented anywhere in the current frontend - see "
    "Section 8 (Workflows is a saved-but-unused setting today). Treat as optional/v2.",
])

# ---- 5.3 Attendance ----
module_header("5.3 Attendance")
endpoint_table([
    ("GET", "/attendance", "List today's (or a date range of) attendance rows"),
    ("PATCH", "/attendance/:id", "Manual status override by HR"),
    ("POST", "/attendance/:id/check-in", "Employee self check-in"),
    ("POST", "/attendance/:id/check-out", "Employee self check-out"),
    ("POST", "/attendance/qr-token", "HR-only: generate a short-lived signed QR token"),
])
h3("Record shape")
code(
    """{
  "id": "att_112233", "empId": "emp_a1b2c3", "name": "Ananya Nair", "dept": "Engineering",
  "date": "2026-07-03", "checkIn": "09:14", "checkOut": null,
  "status": "present"        // present | late | absent | leave
}"""
)
h3("Roles")
p("HR Manager/Director: full read and override for anyone. Employee: check-in/out for self only.")
h3("Business logic to own - this is the module with the most client-side trust to remove")
bullets([
    "Late threshold: checkIn time after 09:30 marks status late, otherwise present - make this "
    "a configurable setting rather than hardcoded, and compute it server-side from server time.",
    "GPS geofencing: when settings.gpsCheckInEnabled is on, the frontend already computes a "
    "Haversine distance between the device's coordinates and settings.geofenceLat/Lng, and "
    "refuses check-in beyond geofenceRadius meters - but only in the browser. A modified client "
    "can currently submit a check-in with no coordinates at all. The server must re-run this "
    "same distance check and reject the request, never trust a client-supplied 'inside geofence' flag.",
    "QR check-in needs a real design, since today it auto-succeeds after a 3-second timer with no "
    "payload check: have the office screen call POST /attendance/qr-token to display a "
    "short-lived signed token (10-30 second expiry is plenty), have the employee's device read "
    "it, then send it back as { qrToken } on the check-in call - reject if the signature or "
    "expiry doesn't check out.",
    "Biometric device punches: keep a reconciliation endpoint, e.g. POST "
    "/attendance/punches/reconcile { empId, time, type }, for the staging queue UI in "
    "Integrations - but actually polling/ingesting from real ZKTeco/eSSL hardware is a separate, "
    "larger integration project (today it is 100% randomly generated) - see Section 8.",
])

# ---- 5.4 Payroll ----
module_header("5.4 Payroll")
endpoint_table([
    ("GET", "/payroll", "List payroll rows (optionally ?cycle=2026-07)"),
    ("PATCH", "/payroll/:id", "Mark a single row paid, or edit"),
    ("POST", "/payroll/:id/structure", "Save the earnings/deductions breakdown for one employee"),
    ("POST", "/payroll/process", "Bulk-process all ready rows for a given cycle"),
])
h3("Record shape")
code(
    """{
  "id": "pay_556677", "empId": "emp_a1b2c3", "name": "Ananya Nair", "dept": "Engineering",
  "gross": 236666, "deductions": 71000, "net": 165666,
  "status": "ready",          // ready | processing | paid
  "cycle": "2026-07",
  "lopDays": 0, "lopAmount": 0,
  "components": { "earnings": [], "deductions": [] }
}"""
)
h3("Roles")
p("Finance Lead, HR Director only. Employees see only their own rows (read-only), e.g. via "
  "GET /payroll?empId=me on the ESS dashboard.")
h3("Business logic to own")
bullets([
    "Structure endpoint computes: gross = sum(earnings), deductions = sum(deduction components), "
    "lopAmount = round(gross / 30 * lopDays), net = gross - deductions - lopAmount.",
    "POST /payroll/process should be scoped to a single { cycle } - today's frontend marks every "
    "ready row across every cycle as paid in one click, which is very likely not the intended "
    "real-world scope; confirm with the product owner and scope it correctly server-side regardless.",
    "Payslip 'download' today is really an HTML file renamed with a .html extension, not a real "
    "PDF. Decide whether the backend should generate genuine PDF payslips (recommended for a "
    "production system) or the frontend keeps doing print-to-PDF in the browser.",
    "The bank-advice CSV export is generated fully client-side from payroll + employee bank "
    "details already in memory - no new endpoint needed, it just needs to be fed real data.",
])

# ---- 5.5 Celebrations / Holidays / Jobs / Assets ----
module_header("5.5 Celebrations, Holidays, Jobs, Assets")
p("These four follow the generic collection pattern from Section 4.2 with a couple of small "
  "action endpoints layered on top - no dedicated Express example is included here since the "
  "generic CRUD router in Section 2.4 covers the bulk of it.")
three_col_table(
    [
        ["Celebrations", "id, type (birthday/anniv), name, detail, wished (bool)",
         "POST /celebrations/:id/wish sets wished true and increments a wish counter - no real "
         "notification is sent, this is a cosmetic 'send a wish' action today."],
        ["Holidays", "id, name, date, type (National/Regional/Optional)",
         "Plain CRUD, HR Manager/Director write access, everyone else read-only."],
        ["Jobs (postings)", "id, title, department, location, type, status (Open/Closed), description",
         "PATCH /jobs/:id toggles Open/Closed. HR Manager/Director write access."],
        ["Assets", "id, name, category, serialNumber, status (assigned/available), "
                    "assignedToEmpId, assignedToEmpName, assignedDate",
         "POST /assets/:id/assign { empId, date } and POST /assets/:id/return as small action "
         "endpoints on top of the generic pattern."],
    ],
    headers=["Module", "Fields", "Notes"],
    widths=[1.1 * inch, 2.2 * inch, PAGE_W - 2 * MARGIN - 3.3 * inch],
)

# ---- 5.6 Recruitment ----
module_header("5.6 Recruitment")
endpoint_table([
    ("GET", "/candidates", "List candidates across the pipeline"),
    ("POST", "/candidates", "Add a candidate to a stage"),
    ("PATCH", "/candidates/:id", "Move stage, edit fields"),
    ("DELETE", "/candidates/:id", "Remove a candidate"),
    ("POST", "/candidates/:id/onboarding/:itemId/toggle", "Check off an onboarding checklist item"),
])
h3("Record shape")
code(
    """{
  "id": "cand_331122", "title": "Senior Backend Engineer", "candidate": "Riya Mehta",
  "stage": "Applied",    // Applied | Screening | Interview | Offer | Hired
  "meta": "2d ago",
  "onboarding": [ { "id": "ob1", "label": "Verify documents", "done": false } ]
}"""
)
h3("Roles")
p("HR Manager, HR Director only.")
h3("Business logic to own")
bullets([
    "Moving a candidate to Hired auto-generates a fixed onboarding checklist (today: 6 items).",
    "Resume upload does not exist as a real feature today - candidates show identical hardcoded "
    "fake resume text regardless of who they are, and 'download resume' just shows a toast. "
    "Building this for real means adding an actual file input to the frontend plus the file "
    "upload endpoint in Section 6, not just a backend change.",
    "The exit-interview / offboarding modal currently piggybacks on the onboarding checklist and "
    "writes free text into the audit log. Recommend a proper exit_interviews sub-resource "
    "instead of overloading onboarding once this is built for real.",
])

# ---- 5.7 Performance Reviews ----
module_header("5.7 Performance Reviews")
endpoint_table([
    ("POST", "/review-cycles", "Body: cycleName. Bulk-creates one review row per employee"),
    ("GET", "/reviews", "List review rows, optionally by cycle or employee"),
    ("PATCH", "/reviews/:id/self", "Employee submits self rating/comments"),
    ("PATCH", "/reviews/:id/manager", "Manager submits rating/comments"),
    ("POST", "/reviews/:id/goals", "Add a goal"),
    ("PATCH", "/reviews/:id/goals/:goalId/toggle", "Toggle a goal done/not done"),
])
h3("Record shape")
code(
    """{
  "id": "rev_44a1", "cycleName": "H1 2026", "empId": "emp_a1b2c3", "name": "Ananya Nair",
  "dept": "Engineering", "status": "pending",   // pending | self-submitted | completed
  "selfRating": null, "selfComments": "",
  "managerRating": null, "managerComments": "",
  "goals": [ { "id": "g1", "text": "Ship v2 API", "done": false } ]
}"""
)
h3("Roles")
p("Self section: the employee themselves. Manager section, and starting a cycle: HR Manager, "
  "HR Director.")
h3("Business logic to own")
p("When a manager review is submitted, also update that employee's <font face='Courier'>rating</font> "
  "field on the Employees resource to the newly submitted managerRating - this is a real "
  "cross-resource side effect in the current frontend, not just a display value.")

# ---- 5.8 Expenses ----
module_header("5.8 Expenses")
endpoint_table([
    ("GET", "/expenses", "List expense claims"),
    ("POST", "/expenses", "File a new claim"),
    ("PATCH", "/expenses/:id", "Approve/decline with a reason, or edit"),
])
h3("Record shape")
code(
    """{
  "id": "exp_7788", "empId": "emp_v9w8", "name": "Vikram Menon", "category": "Travel & Lodging",
  "amount": 4500, "date": "2026-07-01", "description": "Client meeting travel reimbursement",
  "receiptUrl": "", "status": "pending", "reason": ""
}"""
)
h3("Roles")
p("Create: Employee (self). Approve/decline: Finance Lead, HR Director.")
h3("Business logic to own")
p("receiptUrl is currently a pasted text URL, not a real uploaded file (it defaults to a stock "
  "photo if left blank) - wiring in a genuine file upload uses the shared /files endpoint from "
  "Section 6 and needs a small frontend change to add a real file picker.")

# ---- 5.9 Settings ----
module_header("5.9 Settings")
endpoint_table([
    ("GET", "/settings", "Get the org-wide settings object"),
    ("PATCH", "/settings", "Update settings"),
])
p("Settings is a singleton, not a collection. Split it in the real backend: everything "
  "auth-sensitive (login accounts, passwords) moves out entirely into the real Users/Auth "
  "subsystem from Section 3 - it must never come back in a GET /settings response the way "
  "loginProfiles (including plaintext passwords) does in today's mock layer. Everything else - "
  "org name, work week, departments/designations, notification toggles, geofence configuration, "
  "notification templates, and gateway credential fields - can stay as one settings object.")
callout("Note", "settings.approvalWorkflows is read and written by the frontend's Workflows page, "
        "but is never actually enforced by the real Leave/Expense approval logic anywhere in the "
        "app today. Keep the field for UI compatibility, but do not build server-side enforcement "
        "for it unless the product owner confirms multi-step approval is a real, near-term "
        "requirement - see Section 8.", color="#8a6d00", bg="#fff8e1")

page_break()

# ─────────────────────────────────────────────────────────────
#  6. FILE UPLOAD & STORAGE
# ─────────────────────────────────────────────────────────────

h1("6. File Upload and Storage Design")

p("Three different 'file' touchpoints exist in the frontend today, at three different levels of "
  "reality. Documents.jsx does a genuine browser-side upload (FileReader to base64, capped at "
  "2MB, mime-checked), while Recruitment resumes and Expense receipts are not real uploads at "
  "all yet (hardcoded text, and a pasted URL field, respectively). Design one shared subsystem "
  "that can serve all three once the missing frontend pickers are added.")

h2("6.1 Endpoints")
endpoint_table([
    ("POST", "/files", "multipart/form-data: file, category. Returns id, url, mimeType, sizeBytes"),
    ("GET", "/files/:id", "Streams or redirects to the stored file, respecting visibility rules"),
    ("DELETE", "/files/:id", "Removes a stored file"),
])
p("Attach a <font face='Courier'>fileId</font> reference (not raw base64) to the owning record: "
  "<font face='Courier'>documents.fileId</font>, <font face='Courier'>expenses.receiptFileId</font>, "
  "<font face='Courier'>recruitment.resumeFileId</font>.")

h2("6.2 Storage")
p("Start with local disk storage under an app-data volume - simplest option for a first "
  "self-hosted deployment. Design the storage layer behind a small adapter interface so it can "
  "be swapped for S3-compatible object storage (AWS S3, MinIO, etc.) later without changing the "
  "endpoint contract above.")

h2("6.3 Size limits and allowed types")
three_col_table(
    [
        ["Documents (existing)", "2 MB", "PDF, DOC/DOCX, PNG/JPEG/WEBP, XLS/XLSX"],
        ["Resumes (new)", "Suggest 5 MB", "PDF, DOC/DOCX"],
        ["Receipts (new)", "Suggest 5 MB", "Image (PNG/JPEG) or PDF"],
    ],
    headers=["Category", "Max size", "Allowed types"],
)
p("Enforce these limits server-side - today they are only checked in the browser, so nothing "
  "stops a modified client from bypassing them.")

h2("6.4 Visibility")
p("Documents already carry an all / hr / finance visibility tag. Carry this onto the file record "
  "so GET /documents can filter by the caller's role on the server - today the entire document "
  "list including HR-only items is sent to the browser regardless of role, and only hidden by a "
  "client-side filter, which is trivially bypassable.")

h2("6.5 Express example")
code(
    """// routes/files.js
const multer = require('multer');
const upload = multer({ limits: { fileSize: 5 * 1024 * 1024 } });

router.post('/', requireAuth, upload.single('file'), async (req, res) => {
  const allowed = CATEGORY_MIME_MAP[req.body.category] || [];
  if (!allowed.includes(req.file.mimetype)) {
    return res.status(400).json({ error: { code: 'BAD_FILE_TYPE', message: 'File type not allowed' } });
  }
  const stored = await storage.save(req.file, req.body.category);
  res.status(201).json({ id: stored.id, url: stored.url, mimeType: req.file.mimetype, sizeBytes: req.file.size });
});"""
)

page_break()

# ─────────────────────────────────────────────────────────────
#  7. SIMULATED / MOCK FEATURES
# ─────────────────────────────────────────────────────────────

h1("7. Simulated Features That Need Real Implementation")
p("A single reference table so nothing gets missed - each of these looks finished in the UI "
  "today but has no real implementation behind it.")

three_col_table(
    [
        ["QR check-in", "Cosmetic SVG QR code; scan auto-succeeds after a 3-second timer",
         "Real signed, short-lived QR token - see Section 5.3"],
        ["Biometric device sync", "Device list and punches are randomly generated",
         "Real device protocol integration (ZKTeco/eSSL SDK or gateway) - separate project, see Section 8"],
        ["SMS / Email / WhatsApp sending", "Templates and Twilio/SMTP fields exist; nothing is sent; "
                                             "UI itself labels this 'interface only for now'",
         "Real provider integration (Twilio, SendGrid/SMTP) wired to the existing template fields"],
        ["OTP / 2FA delivery", "A fake code is shown to the user in an in-app toast",
         "Real SMS or email delivery of the one-time code"],
        ["GPS geofence check-in", "Distance check only runs in the browser",
         "Server must re-validate distance from submitted coordinates - never trust a client flag"],
        ["Resume storage", "Hardcoded identical fake text for every candidate; no file input exists",
         "Real file upload (frontend + Section 6 endpoint) and per-candidate storage"],
        ["Expense receipts", "A pasted text URL, defaults to a stock photo if left blank",
         "Real file upload via Section 6"],
        ["Face descriptor persistence", "Stored only in the browser's localStorage today",
         "Optional: persist per-user descriptor server-side if you want server-checked biometric login"],
    ],
    headers=["Feature", "What's fake today", "What's needed"],
    widths=[1.3 * inch, 2.6 * inch, PAGE_W - 2 * MARGIN - 3.9 * inch],
)

page_break()

# ─────────────────────────────────────────────────────────────
#  8. NON-BLOCKING / FUTURE ITEMS
# ─────────────────────────────────────────────────────────────

h1("8. Non-Blocking and Future Items")
p("These do not need to block a first backend release.")

bullets([
    "<b>Approval Workflows</b> - the Workflows page saves a multi-stage approval configuration "
    "to settings, but no approval logic anywhere in the app actually reads or enforces it "
    "today. Build server-side enforcement only if the product owner confirms this is a genuine, "
    "near-term requirement.",
    "<b>Tally accounting export</b> - generated entirely client-side from data already in "
    "memory; it just needs to be fed real data once the API is live, no new backend endpoint "
    "is required.",
    "<b>Biometric hardware protocol integration</b> - talking to real ZKTeco/eSSL devices is a "
    "meaningfully larger, separate integration effort; today's Integrations page is a complete "
    "mock with no real device I/O.",
    "<b>Server-side face-recognition validation</b> - optional; the current client-side-only "
    "approach is a reasonable place to stay unless there's a specific security requirement to "
    "verify biometric login server-side.",
])

page_break()

# ─────────────────────────────────────────────────────────────
#  APPENDIX - JSON FIELD REFERENCE
# ─────────────────────────────────────────────────────────────

h1("Appendix: Full JSON Field Reference")
p("Quick-lookup field lists for every entity, taken directly from the current frontend's seed "
  "data and data layer, without the surrounding prose above.")

h2("Employee")
code("""id, name, role, dept, loc, email, phone,
status (active | remote | on-leave),
joinDate, salary, rating, managerId, bankAccount, ifsc""")

h2("Leave")
code("""id, empId, name, dept,
type (sick | earned | casual),
start, end, status (pending | approved | declined), reason""")

h2("Attendance")
code("""id, empId, name, dept, date, checkIn, checkOut,
status (present | late | absent | leave)""")

h2("Payroll")
code("""id, empId, name, dept, gross, deductions, net,
status (ready | processing | paid), cycle,
lopDays, lopAmount, components: { earnings[], deductions[] }""")

h2("Celebration")
code("""id, type (birthday | anniv), name, detail, wished""")

h2("Holiday")
code("""id, name, date, type (National | Regional | Optional)""")

h2("Candidate (Recruitment)")
code("""id, title, candidate,
stage (Applied | Screening | Interview | Offer | Hired),
meta, onboarding: [ { id, label, done } ]""")

h2("Job Posting")
code("""id, title, department, location, type,
status (Open | Closed), description""")

h2("Performance Review")
code("""id, cycleName, empId, name, dept,
status (pending | self-submitted | completed),
selfRating, selfComments, managerRating, managerComments,
goals: [ { id, text, done } ]""")

h2("Expense")
code("""id, empId, name, category, amount, date, description,
receiptUrl, status (pending | approved | declined), reason""")

h2("Asset")
code("""id, name, category, serialNumber,
status (assigned | available),
assignedToEmpId, assignedToEmpName, assignedDate""")

h2("Settings (singleton, auth fields removed - see Section 3)")
code("""orgName, workWeek, notifyLeave, notifyPayroll, notifyBirthday,
totalLeaveDays, departments[], designations[],
gpsCheckInEnabled, geofenceLat, geofenceLng, geofenceRadius,
gatewayTwilioSid, gatewayTwilioToken, gatewayTwilioFrom,
gatewaySendgridKey, gatewaySmtpHost, gatewaySmtpUser, gatewaySmtpPass,
notificationTemplates: { email{}, sms{}, whatsapp{} },
approvalWorkflows: { leave[], expense[] }  // saved, currently unenforced""")


# ─────────────────────────────────────────────────────────────
#  BUILD
# ─────────────────────────────────────────────────────────────

class NumberedCanvas(pdfcanvas.Canvas):
    def __init__(self, *args, **kwargs):
        pdfcanvas.Canvas.__init__(self, *args, **kwargs)
        self._saved_page_states = []

    def showPage(self):
        self._saved_page_states.append(dict(self.__dict__))
        self._startPage()

    def save(self):
        num_pages = len(self._saved_page_states)
        for state in self._saved_page_states:
            self.__dict__.update(state)
            self._draw_footer(num_pages)
            pdfcanvas.Canvas.showPage(self)
        pdfcanvas.Canvas.save(self)

    def _draw_footer(self, page_count):
        self.setFont("Helvetica", 8)
        self.setFillColor(colors.grey)
        self.drawString(MARGIN, 0.5 * inch, FOOTER_TEXT)
        self.drawRightString(PAGE_W - MARGIN, 0.5 * inch,
                              "Page %d of %d" % (self._pageNumber, page_count))


class SpecDocTemplate(SimpleDocTemplate):
    def afterFlowable(self, flowable):
        if isinstance(flowable, Paragraph):
            style_name = flowable.style.name
            text = flowable.getPlainText()
            if style_name == "H1Style":
                level = 0
            elif style_name == "H2Style":
                level = 1
            else:
                return
            key = "toc-%s" % id(flowable)
            self.canv.bookmarkPage(key)
            self.canv.addOutlineEntry(text, key, level, 0)
            self.notify("TOCEntry", (level, text, self.page, key))


def build():
    doc = SpecDocTemplate(
        OUTPUT_PATH, pagesize=LETTER,
        leftMargin=MARGIN, rightMargin=MARGIN, topMargin=MARGIN, bottomMargin=MARGIN,
        title="Smaatech HRMS - Backend API Specification",
    )
    doc.multiBuild(story, canvasmaker=NumberedCanvas)
    print("Wrote %s" % OUTPUT_PATH)


if __name__ == "__main__":
    build()
