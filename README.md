# Golden Pay backend

Five Bun services share one PostgreSQL database and one login system. Clients only
ever call the Identity API on port 4001, which forwards the routes below, so the app
and dashboard keep a single base URL. `./start-golden-pay.sh` starts everything.

| Service | Port | Routes | Owns |
| --- | --- | --- | --- |
| `IdentityAcess_Services` | 4001 | `/auth`, `/users`, `/admin` | Accounts, sessions, permissions |
| `DynamicForms_Services` | 4002 | `/forms` | Clients, client report templates and their versions |
| `Investigators_Services` | 4003 | `/investigators`, `/locations` | Work areas, Egypt location tree, area matching |
| `Investigations_Services` | 4004 | `/investigations` | Cases, answers, photos, PDF reports, review |

`Shared/service.ts` runs a domain service with the Identity service's authentication,
error format and logging. Each service applies its own idempotent `schema.sql` on start.
Set `DB_POOL_MAX` to change the database pool (default 5; domain services use 3).

## Forms

`DynamicForms_Services/Seeds/forms.json` holds the first conversion of the 51 forms in
`Investigation Forms/` (`Seeds/convert_forms.py`). They became version 1 of each template.
Forms now change only through versions that Head Office reviews and approves (see
«Client report templates» below). A case stores the exact version it was sent with, so
later versions never change a running case.

A field's `prefill` starts it from data the administrator entered (`subject_name`,
`address`, `phone`, `landmark`, `governorate`, `district`, `national_id`,
`client_reference`); the investigator confirms or corrects it.

## Locations

`Investigators_Services/Seeds/egypt.json` seeds 27 governorates and 396 districts. No
reliable public list exists for the lower three levels, so they start empty: names that
investigators type join the shared list for the next person. Spelling variants such as
الدقي and الدقى match.

## Case lifecycle and dispatch

`open` (offered, waiting for acceptance) → `assigned` → `in_progress` → `submitted` →
`approved`, or `returned` for correction. `unassigned` means nobody accepted; the admin
can re-send it. Administrators can cancel before submission.

A case is offered to one investigator at a time (`dispatch.ts`). Each offer lasts the
type's `accept_minutes`. Refusing, or letting the window pass, moves the case to the
next candidate. Candidates are ranked by how closely their work area matches the case
address — sub village, then main village, local unit, district, governorate — and by
GPS distance within a level. A case sent to a person is offered to them first and
then falls back the same way; a case sent to an area never leaves that area. A timer
in the Investigations service checks every 15 seconds, so escalation needs no client.

### Spreading the work

An investigator works on one case at a time. While they have a case in progress, or
are holding another offer, area cases skip them and go to the nearest free
investigator; if everyone suitable is busy the case waits (a `waiting` event) and is
offered the moment someone finishes. Within about a kilometre, whoever has done the
fewest cases today goes first. The exception is a case sent to a chosen person
("مستعلم محدد"): it is offered to them even when busy and they may accept it on top of
current work. Accepting an area case while busy returns `409 INVESTIGATOR_BUSY`, and
accepting one cancels the investigator's other pending area offers so they move on.

### Negative reports and location trail

When the person cannot be found the investigator submits a negative report
("استعلام سلبي", `outcome: "negative"`): at least one reason from the fixed list in
`outcome.ts` plus an explanation of at least 10 characters; the form itself is then
optional. Every submission needs a GPS fix (`400 LOCATION_REQUIRED` otherwise). The app
also records positions on accepting, opening the form and taking photos
(`POST /investigations/:id/location`), stored in `investigation_locations`. Managers see
this trail in the case drawer and in the PDF; negative reports carry their reasons too.

`investigation_offers` records each offer's offered, seen, answered and expiry times;
`investigation_events` is the full case log shown in the dashboard. The app reports
"seen" when an investigator opens an offer.

## Investigation types, prices and earnings

Every case has one of five types (`normal`, `urgent`, `express`, `same_day`,
`scheduled`). Each type has a delivery time, a deadline in hours, the price the bank
or company pays, and the investigator's pay. They start at zero and are set on the
dashboard's Pricing page. Scheduled cases take an appointment instead of a deadline.
The administrator can override both prices for a single case.

Prices are copied onto the case when it is sent, so changing a price never alters
past earnings. Money counts when a report is approved, in the Cairo calendar month
of approval: company revenue is the client price, payouts are the investigator pay,
and profit is the difference. Investigators see only their own pay, never the client
price. `return_count` records how often a report was sent back for changes.

| Route | Access | Returns |
| --- | --- | --- |
| `GET /investigations/service-levels` | `investigations:manage` | Types and prices |
| `PATCH /investigations/service-levels/:code` | `finance:manage` | Updated type |
| `GET /investigations/finance?month=YYYY-MM` | `finance:manage` | Revenue, payouts, profit, pipeline, by client and type, six-month trend |
| `GET /investigations/performance?month=` | `investigations:manage` | Per-investigator counts and earnings |
| `GET /investigations/performance/:user_id?month=` | `investigations:manage` | One investigator's stats, trend, breakdowns and recent cases |
| `GET /investigations/mine/earnings?month=` | Investigator | Own monthly earnings and trend |
| `GET /investigations/leaderboard?month=` | `investigations:manage` | Activity score, growth, acceptance, reply time, seen-to-finish time |
| `POST /investigations/:id/seen` · `/claim` · `/decline` | Offered investigator | Record a view, accept, refuse |
| `POST /investigations/:id/location` | Assigned investigator | Add a GPS point (`started`, `draft`, `photo`) to the trail |
| `POST /investigations/:id/redispatch` | `investigations:manage` | Offer an open or unassigned case again |

Investigators sign in with their employee number or their phone number.

## PDF reports

Submitting a case builds a PDF in the background with headless Chrome, which handles
Arabic shaping and right-to-left layout correctly. The machine therefore needs Chrome,
Chromium or Edge. Common install paths are detected; otherwise set `CHROME_PATH`. Failed
reports can be retried from the case drawer. Reports use one branded layout for every
client rather than reproducing each original Word page.

## Permissions

`investigations:manage` (admin, HR) sends and reviews cases. `forms:manage` (admin) edits
forms. `finance:manage` (admin) sets prices and sees company earnings. Investigators reach only cases offered or assigned to them.

## End-to-end check

From `Investigations_Services/`, with the stack running:

```sh
bun --env-file=../IdentityAcess_Services/.env scripts/test-flow.ts
```

## Head office (`HeadOffice_Services`, port 4005)

A separate layer above administrators: attendance, points, salaries, expenses,
monthly profit and complaints. The Identity API forwards `/headoffice`, `/attendance`,
`/points` and `/complaints` to it.

- **Access.** Role `head_office` with permission `headoffice:manage`. Admins do not hold
  it and cannot grant it through the API; create a head office account with
  `bun run scripts/promote-admin.ts --email owner@company.com --role head_office`.
  Head office itself is not tracked for attendance.
- **Attendance.** The app and both dashboards call `POST /attendance/ping` on open and
  every 5 minutes. The first ping of a Cairo day is arrival, the last is leaving.
  Admins and investigators have separate work hours, grace minutes and days off
  (`/headoffice/settings`).
- **Points.** Green: arrived within the grace time and still active at the end time.
  Black: late (with minutes), absent on a working day (swept every 30 minutes for the
  last 14 days, counted only from the day the system started), or a violation added
  by head office. Blue: past the end time by the overtime minutes, active on a day off,
  or recognition added by head office. Each `blue_per_black` blue points in a month
  wipe out one black point; leftover blue earns `blue_bonus`, leftover black costs
  `black_deduction`. Head office can remove any point with a reason.
- **Pay.** Base salary + approved case pay + bonus − deduction + adjustments. A month
  marked paid is locked and keeps what was paid. Salaries count from the system's start
  month and the person's join month.
- **Profit.** Revenue (approved cases) − all pay − expenses (one-time, or monthly until
  stopped).
- **Complaints and messages.** Investigators send complaints from the app (`POST /complaints`,
  `CMP-` numbers); administrators send messages from the dashboard (`kind: "message"`,
  `MSG-` numbers, investigators cannot). Only head office and the sender can read a thread;
  `GET /complaints/mine?kind=message` lists an admin's threads with unread replies.

`bun ../HeadOffice_Services/scripts/test-headoffice.ts` (run from
`IdentityAcess_Services`) checks all of this end to end and restores what it changes.

## Client report templates (Head Office)

Every bank and company keeps its own approved Word layout. Head Office uploads it,
checks what the system proposes, maps any remaining places, and approves a version.
Cases created afterwards are filled into that exact layout. The engine lives in
`Shared/templates/` and is used by the forms and investigations services.

### What a template version holds

| Part | What it is |
| --- | --- |
| Original file | Stored once by SHA-256 in `templates/files/`, never changed (`template_files`). `.doc` and `.pdf` are converted to `.docx` for scanning; the original is kept. |
| Prepared layout | A copy of the client's `.docx` with invisible bookmarks (`gp_001`…) at every place a value can go. Nothing in the layout moves. |
| Definition | Sections and fields: types (`text`, `textarea`, `number`, `date`, `time`, `phone`, `national_id`, `choice`, `multichoice`, `yesno`, `photos`, `signature`, `table`, `attestation`), `required` and `required_if`, `visible_if` conditions, options, validation, `prefill` from case data, photo limits, table columns and row limits. |
| Bindings | What each bookmark prints: an answer, a case value (`case.subject_name`, `case.report_date`, `case.investigator_name`…), the Golden Pay stamp after approval, or `clear` to remove old content. |

Ready-made tables (`BLOCKS` in `definition.ts`): partners, board members, branches,
sales outlets, warehouses, verification sources and references.

### Classification (`inventory.ts`)

Each upload is classified from its content, never from the file name alone: client logos
(by image fingerprint), then the client's name in the title, header, footer or body. The
folder and file name are weak hints only. A file without its client's name or logo inside
(Bedayty, Global, One Finance, Rizk Allah, CIB suppliers) gets a suggestion, plus a
blocking warning until Head Office confirms the client. The investigation type comes from
the page header and title, with client names removed first; a title that disagrees with
its folder is flagged. Revisions come from the document properties.

Leftovers from real reports are flagged: site photos, staff signatures, QR codes, other
companies' stamps, filled dates and phrases such as «لم نوافي» or «لم تتم الافادة».
Near-identical layouts shared by different clients (Bedayty, Global and MIDBANK) are noted.

### Never claiming what did not happen

- Sentences in a client form that claim something happened («تم مقابلة…», «تم الاطلاع
  على…», «بالوصول…», «بسؤال…») become `attestation` fields. One prints only if the
  investigator confirmed it and the recorded evidence supports it: a GPS fix on site
  (optionally within a distance of the case address), a number of photos, or other
  answers. Otherwise it is removed from the report and listed for the reviewer.
- A field's default text may not claim a visit or a check; such definitions are refused.
  Old forms that pre-filled «تمت زيارة…» lose that default when migrated.
- Unanswered blanks stay blank (the client's dots stay). Old sample text and pictures are
  removed, or must be bound to a question before a version can be reviewed.
- The Golden Pay stamp and the reviewer's name are added only after approval.
- Answers to hidden fields and unknown keys are dropped before saving or printing.
- Answers without a place in the client's layout print on a «ملحق التقرير» page; nothing
  is dropped silently.

### Review, approval and immutability

`draft → in_review → approved → active → retired`; a reviewer may return a version to
draft with a note. Submitting needs every blocking warning resolved. Any Head Office member
with `templates:approve` can approve, including the one who prepared the version (set
`TEMPLATE_REQUIRE_SECOND_APPROVER=true` to require a different member). Approval checks
that the content hash is the one that was reviewed. A database trigger
(`gp_template_version_guard`) refuses any change or deletion of a version that left
draft. Each case stores `template_version_id`, `template_version_no` and
`template_hash`, so it always reports with the version it was sent with. Every step is in
`template_events` and in the general audit log.

Permissions: `templates:manage` (upload, map, submit) and `templates:approve` (approve,
return, activate) belong to the `head_office` role; administrators do not hold them.

### Report rendering

`render.ts` fills the prepared layout: text into cells, text boxes and dotted blanks;
ticks in checkbox controls, typed boxes, drawn squares and picture boxes; the chosen
option in written option lists; photos and signatures sized to their cell; repeating rows
(extra rows are cloned). Arabic runs are right-to-left; numbers, dates and phone numbers
stay left-to-right. Headers, footers, section and page breaks are untouched.

The filled `.docx` becomes a PDF through a real Word engine (`convert.ts`):

- **Production (Linux):** install LibreOffice and the fonts the templates use (Arial,
  Calibri, Times New Roman, Simplified Arabic, Traditional Arabic, Segoe UI Symbol, or
  metric-compatible replacements). Set `SOFFICE_PATH` if it is not in a standard place.
- **Windows with Microsoft Word:** used automatically, one Word process per file with a
  timeout (`word-convert.ps1`).
- `REPORT_CONVERTER=libreoffice|word|auto`, `REPORT_CONVERT_TIMEOUT_MS` (default 120000).

Without an engine, reports fall back to the standard Golden Pay layout (Chrome) and say
so in `report_error`. Negative reports always use the standard layout.

### Routes (all under `/forms`, through the Identity API)

| Route | Access | Purpose |
| --- | --- | --- |
| `GET /forms/templates?client=&type=`, `GET /forms/templates/:id`, `GET /forms/resolve?client=&type=`, `GET /forms/types` | Signed in | The active versions new cases use |
| `GET /forms/admin/library`, `GET /forms/admin/files`, `GET` and `PATCH /forms/admin/templates/:id` | `templates:manage` | Library, archive with classification, versions; switch a template on or off |
| `POST /forms/admin/files` (multipart `file`) | `templates:manage` | Upload and classify |
| `POST /forms/admin/versions` | `templates:manage` | Draft from a file, for an existing template or a new one |
| `GET`, `PATCH`, `DELETE /forms/admin/versions/:id`, `/clone`, `/submit`, `/withdraw` | `templates:manage` | Edit drafts, send for review |
| `/approve` (`{ activate }`), `/return` (`{ note }`), `/activate` | `templates:approve` | Decide |
| `/layout`, `/layout.docx`, `/preview?mode=labels\|sample\|blank`, `/diff` | `templates:manage` | Mapper page, PDF previews, changes |
| `GET /forms/admin/events?template_id=` | `templates:manage` | Audit trail |
| `GET /investigations/:id/check`, `GET /investigations/:id/report.docx` | `investigations:manage` | Pre-approval check, Word report |

`PATCH /forms/templates/:id` (the old direct editor) now answers `409 TEMPLATE_VERSIONING`.

### Import of the original archive

On start, the forms service turns every form already in use into an active version
(standard layout, so running cases and the app are unchanged) and imports every file in
`Investigation Forms/` (`TEMPLATE_ARCHIVE_DIR`) as a draft in the client's own layout,
waiting for Head Office review. Files already stored are skipped. After the scanner
improves, `bun run rescan-drafts` (in `DynamicForms_Services`) re-scans the drafts that
nobody has edited.

### Tests

From `Shared/` (run `bun install` there first):

```sh
bun run test               # definitions, conditions, evidence, data mapping on real templates, classification
bun run test:visual        # layout regression with the Word engine on representative templates
bun run test:visual:all    # all 51 originals
bun run baselines:update   # accept the current rendering after reviewing it
```

Baselines are stored per engine in `templates/tests/visual/baselines/<engine>/`; a failure
writes the actual page and a diff image to `templates/tests/visual/output/`.

With the stack running, from `DynamicForms_Services/`: `bun run test:templates` checks the
whole lifecycle end to end (upload, classification, validation, four-eyes approval,
immutability, version pinning, evidence rules, client-layout report, stamp, audit trail).
`scripts/ui-test-account.ts create|remove` makes a temporary Head Office account for trying
the screens; its sign-in details go to `scripts/.ui-test-account.local`.

## Database and file storage

All services read `IdentityAcess_Services/.env` (never commit it).

- `DATABASE_URL` — the PostgreSQL the whole stack uses. When it points at a remote host,
  `start-golden-pay.sh` does not start the local PostgreSQL.
- `STORAGE_BUCKET`, `STORAGE_REGION`, `STORAGE_ENDPOINT`, `STORAGE_FOLDER`,
  `STORAGE_ACCESS_KEY_ID`, `STORAGE_SECRET_ACCESS_KEY` — S3-compatible bucket for every
  uploaded or generated file (ID images, profile photos, case photos, reports, template
  files, layouts, previews). Leave `STORAGE_BUCKET` empty to keep files under `UPLOAD_DIR`.
  The database stores the same relative paths either way (`Utils/files.ts`).
- `bun --env-file=.env scripts/upload-storage.ts` (in `IdentityAcess_Services`) copies the
  local `UPLOAD_DIR` into the bucket and checks every file the database references.

## Deploying (Thalmet Cloud or any container host)

The whole backend runs as **one service**: `bun start.ts` starts the Identity API on
`$PORT` (default 4001), the only public entry, which applies the schema once PostgreSQL
answers; the domain services then start on internal ports 4002–4005. It proxies `/api/v1/forms`, `/investigators`,
`/investigations` and `/headoffice` to the others.

- Build: the `Dockerfile` (Bun 1.3.14, LibreOffice and Chromium for PDF reports, Arabic fonts).
- Port: `4001` (or whatever `PORT` the platform sets), on `0.0.0.0`. The internal
  services listen on `127.0.0.1` only.
- Health check: `GET /health` answers 200 as soon as the server listens and reports the
  database state without querying it. `GET /api/v1/health` is the readiness check: 503
  until PostgreSQL is connected.
- Startup: missing required settings stop the launcher with a list of their names. An
  unreachable database does not stop it: the API retries in the background, logging
  `postgresql.unreachable` with the host, and requests that need data get a 503
  `DATABASE_UNAVAILABLE` until it connects.
- Environment variables: everything in `IdentityAcess_Services/.env.example`, with
  `NODE_ENV=production`. Use the **same** `NATIONAL_ID_ENCRYPTION_KEY`,
  `NATIONAL_ID_HMAC_SECRET`, `JWT_SECRET` and `REFRESH_TOKEN_PEPPER` as the existing
  installation, or stored national IDs can no longer be read and every user is signed out.
  Set `STORAGE_*` (or the same names with `S3_`) so files go to the bucket, and
  `CORS_ORIGINS` to the dashboards' addresses.
- Never commit `.env`; the platform's environment settings hold the secrets.
