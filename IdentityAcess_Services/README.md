# Golden Pay — Identity & Access Service

Authentication and account-management backend for Golden Pay employees and field
investigators. Built with **Bun + TypeScript + PostgreSQL** (the pure-JS `postgres`
driver), with no web framework or validation library — HTTP routing, JWT signing,
Argon2id hashing, RBAC and request validation are implemented directly on Bun and
Node primitives.

The schema lives in [`Config/schema.sql`](./Config/schema.sql) and is applied
idempotently on every startup. Uploaded national-ID images are written under the
repository `Storage/` tree, outside the service folder.

---

## Table of contents

- [What it does](#what-it-does)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Bootstrapping existing employees](#bootstrapping-existing-employees)
- [Creating the first administrator](#creating-the-first-administrator)
- [Account lifecycle](#account-lifecycle)
- [API reference](#api-reference)
  - [Conventions](#conventions)
  - [Authentication](#authentication)
  - [Existing-employee signup](#existing-employee-signup)
  - [New-investigator signup](#new-investigator-signup)
  - [Sessions and profile](#sessions-and-profile)
  - [Biometric sign-in](#biometric-sign-in)
  - [Administration](#administration)
- [Biometric protocol](#biometric-protocol)
- [Project layout](#project-layout)
- [Data storage](#data-storage)
- [Web dashboard](#web-dashboard)
- [Security notes](#security-notes)
- [Troubleshooting](#troubleshooting)

---

## What it does

- **Employee ID + password** login
- **Employee number + password** login
- **Email + password** login — after the password step the account completes its
  MFA step: a 6-digit email OTP (sent with 5-minute expiry, resend after 60s) or
  an authenticator-app (TOTP) / recovery code, verified via `/auth/mfa/verify`
  before tokens are issued
- **Biometric login** (fingerprint / Face ID) using device-held key pairs, available
  only after the account is active
- **Existing-employee signup**: enter the employee number → the system matches it
  against the HR registry → complete the profile and upload national ID images
- **New-investigator signup**: complete the profile → the system generates an
  employee number (`GP-000001`, ...) that the applicant must save
- Admin/HR review: approve, reject, suspend, reactivate, assign roles, inspect
  national-ID images and audit logs
- Session management with rotating refresh tokens, reuse detection and revocation
- Argon2id password hashing, encrypted national IDs, brute-force lockout, per-IP and
  per-account rate limits, UUID request IDs and audit logging

---

## Quick start

Requirements:

- [Bun](https://bun.sh) 1.3+
- PostgreSQL 16+ (17 or 18 recommended), reachable over TCP

```bash
bun install
cp .env.example .env          # then set DATABASE_URL and the secrets
bun run db:init               # create tables, seed RBAC, ensure the upload folder
bun run create-admin          # create the first administrator (prints credentials)
bun run dev                   # watch mode, http://localhost:4001
```

`bun run db:init` is safe to re-run: every statement in `Config/schema.sql` is
idempotent and the RBAC seed upserts.

`bun run create-admin` accepts flags (all optional — anything omitted is generated
or prompted for):

```bash
bun run create-admin --employee-number GP-000001 --full-name "أحمد محمود" \
  --phone 01012345678 --national-id 29901011234567 --password "Str0ngPass!"
```

It creates both the account and its HR registry row, activates the account and
grants the `admin` role, then prints the employee number, user ID, generated
password (when not supplied) and permissions.

Production:

```bash
NODE_ENV=production bun run start
```

Useful commands:

| Command | Purpose |
| --- | --- |
| `bun run dev` | Start with file watching |
| `bun run start` | Start once (production) |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run db:init` | Apply `Config/schema.sql`, seed RBAC, create the upload folder |
| `bun run create-admin` | Create/activate an administrator with an HR record |
| `bun run import-employees <file>` | Load the HR registry |
| `bun run promote-admin <selector>` | Grant/remove a role on an existing account |
| `bun scripts/test-admin-selfservice.ts` | Verify TOTP enrollment, recovery codes, name change and disable |
| `bun scripts/verify-http-selfservice.ts` | Same self-service flow over HTTP against a running API |

Health check: `GET /api/v1/health` → `200` when PostgreSQL answers, `503` otherwise.
The service also applies the schema at startup, so a fresh database only needs to
exist and be reachable.

---

## Configuration

### Dashboard administrator security

New dashboard invitations submit only `email` to
`POST /admin/administrators/invitations`. Omitted `full_name` is blank and omitted
`mfa_required` defaults to false. Existing clients can still supply those fields.
The recipient sets their own name/password and chooses protection in onboarding.
Invitation acceptance is transactional and locks the invitation, preventing
concurrent reuse. The dashboard signs in with the newly created credentials and
continues to verified email/authenticator setup when selected. Existing mandatory
MFA invitations still require their original verification policy.

Run `bun scripts/test-invite-onboarding.ts` to verify recipient-owned profile
setup and concurrent single-use acceptance with a temporary invitation.

The primary account is `goldenpayservices@gmail.com`; its password is stored as
Argon2id. `admin_security.mfa_method` selects `email`, `totp` (authenticator only)
or `both` (emailed code followed by the authenticator code). Email challenges
reuse `/auth/mfa/verify` and return `method: "email"` with a masked recipient after
successful delivery. OTPs are cryptographically random, HMAC-hashed, expire after
five minutes, permit five attempts, and cannot be replayed. The cooldown between
sends is one minute. Password changes invalidate outstanding email challenges. Mail
errors return `503 OTP_DELIVERY_FAILED` and never issue a session or return the OTP
to the browser.

Administrators can switch sign-in method from the dashboard's **إدارة حسابي** page:

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/auth/mfa/totp/setup` | Issue a pending secret, `otpauth://` URI and QR PNG data URL |
| `POST` | `/auth/mfa/totp/activate` | Verify a 6-digit code, enable TOTP and return eight recovery codes; `mode` may be `totp` or `both` |
| `POST` | `/auth/mfa/totp/mode` | Switch an enrolled account between `totp` and `both` after confirming the password |
| `POST` | `/auth/mfa/totp/disable` | Remove TOTP after confirming the account password |
| `POST` | `/auth/mfa/email/start` | Send a verification code to switch to email OTP |
| `POST` | `/auth/mfa/email/confirm` | Prove the emailed code and activate email OTP |

The secret stays *pending* until a valid code is supplied, so a mis-scanned QR never
locks the account. Recovery codes are stored only as SHA-256 hashes and are shown
once. Each code works once. `GET /admin/security` reports `mfa_method`, `enrolled`,
`pending_enrollment` and `recovery_codes_remaining`. Email OTP remains active until
the authenticator is actually activated.

Gmail SMTP requires a Google **App Password** in `SMTP_PASS` (configured locally;
never commit or print it). Dashboard passwords are not Gmail SMTP passwords. The
mail transport uses TLS with Nodemailer and does not log OTP bodies. Run
`bun scripts/test-email-otp.ts` for isolated tests using an injected delivery
transport and a temporary user.

To explicitly update owner credentials and switch their policy, supply `email`,
`password`, and `mfa_method` on stdin to `scripts/configure-owner.ts`. This revokes
old sessions, clears lockouts and outstanding challenges, and retains the owner
identity and employee record.

`POST /api/v1/auth/login` also accepts `{ "email": "name@example.com", "password": "..." }`,
which is the fourth login option (email + password → OTP → MFA). Password-only
sign-in never returns tokens for an MFA-required account: it receives
`403 MFA_REQUIRED` with a five-minute challenge in `error.details` instead.
When the account's method is `email`, the challenge carries the 6-digit OTP
details (`challenge_token`, `method: "email"`, a masked `email_hint`, a 300s
`expires_in` and a 60s `resend_after`); when the method is TOTP, first-time
enrollment details contain a setup key and a locally generated QR image.
`POST /api/v1/auth/mfa/verify` accepts `challenge_token` and `code` and issues
tokens only after the OTP/TOTP/recovery verification passes. Initial enrollment
also returns eight one-time recovery codes.

Owner-only endpoints: `GET/POST /admin/administrators` and
`POST /admin/administrators/:id/policy` (`mfa_required` boolean, owner `password`).
Policy changes revoke sessions and reset enrollment. Employee-number and email
password logins also enforce MFA, and biometric login is denied for MFA-required
accounts.
Administrators may change their own display name with `PATCH /users/me`; employee
names remain immutable. Run `bun scripts/test-admin-selfservice.ts` for isolated
checks of enrollment, activation, recovery codes, name changes and disabling MFA.

`scripts/configure-owner.ts` configures an existing primary administrator from JSON
on stdin (`employee_number`, `email`, `password`). It is an explicit bootstrap operation,
not a startup password reset. `scripts/test-admin-security.ts` runs integration checks
with owner credentials on stdin and `TEST_API_URL` pointing to the local API; its
temporary admin accounts are deleted afterward.

All settings are read by `Config/env.ts` from the environment or `.env`
(Bun loads it automatically). See [`.env.example`](./.env.example) for the full list.

| Variable | Default | Notes |
| --- | --- | --- |
| `NODE_ENV` | `development` | Production enables strict secret checks |
| `PORT` | `4001` | HTTP port |
| `DATABASE_URL` | `postgresql://postgres:postgres@127.0.0.1:5432/golden_pay_identity` | PostgreSQL connection, e.g. `postgresql://user:pass@host:5432/golden_pay_identity` |
| `JWT_SECRET` | dev fallback | HS256 signing key, **required in production** |
| `JWT_ISSUER` / `JWT_AUDIENCE` | `golden-pay-identity` / `golden-pay-clients` | Validated on every token |
| `NATIONAL_ID_ENCRYPTION_KEY` | dev fallback | Exactly 32 bytes, base64 or 64-char hex |
| `NATIONAL_ID_HMAC_SECRET` | dev fallback | Duplicate detection / HR matching |
| `REFRESH_TOKEN_PEPPER` | dev fallback | Refresh-token and biometric-nonce hashing |
| `ACCESS_TOKEN_TTL_SECONDS` | `900` | Access-token lifetime |
| `REFRESH_TOKEN_TTL_SECONDS` | `2592000` | Refresh-token lifetime (30 days) |
| `SIGNUP_TOKEN_TTL_SECONDS` | `1200` | Existing-employee signup window |
| `BIOMETRIC_CHALLENGE_TTL_SECONDS` | `90` | Challenge lifetime |
| `EMPLOYEE_NUMBER_PREFIX` | `GP` | Generated numbers look like `GP-000001` |
| `EMPLOYEE_NUMBER_PAD` | `6` | Zero-padding width |
| `UPLOAD_DIR` | `../../Storage/identity-access` | National ID image root (created by `db:init`) |
| `MAX_UPLOAD_BYTES` | `8388608` | Per image |
| `MAX_JSON_BYTES` | `1048576` | Per JSON body |
| `LOGIN_MAX_ATTEMPTS` | `5` | Failed attempts before lockout |
| `LOGIN_LOCK_MINUTES` | `15` | Lockout duration |
| `STRICT_EMPLOYEE_VERIFICATION` | `true` | Also match full name and phone to the HR record |
| `CORS_ORIGINS` | `*` | Comma-separated allowed origins |
| `LOG_LEVEL` | `debug` | `debug` / `info` / `warn` / `error` |

In production the service refuses to start if any required secret is missing or too
short. Generate secrets with `openssl rand -base64 32`.

---

## Bootstrapping existing employees

An "existing employee" can only start signup if their employee number exists in the
**HR registry** (`EmployeeRecord`). The registry stores a national-ID fingerprint and
last four digits — never the full number.

### Via script (recommended for bulk data)

```bash
bun run import-employees ./data/employees.json
bun run import-employees ./data/employees.csv
```

JSON may be an array or `{ "employees": [...] }`:

```json
[
  {
    "employee_id": "EMP-001",
    "employee_number": "GP-000001",
    "full_name": "Amina Yusuf",
    "phone": "01012345678",
    "email": "amina@example.com",
    "national_id_number": "12345678901234",
    "department": "Investigation",
    "position": "Field Investigator"
  }
]
```

CSV uses the same field names in the header row. Re-running is safe: records that are
still `available` are updated, registered records are skipped, and rows that fail
validation are reported individually.

### Via API

`POST /api/v1/admin/employees/import` with `{ "employees": [ ... ] }` and an admin
token holding `employees:import`.

---

## Creating the first administrator

There is intentionally no public endpoint that can create an administrator. Use the
bootstrap script after the person has signed up and been approved (or let the script
activate them):

```bash
bun run promote-admin --employee-number GP-000001
bun run promote-admin --employee-id EMP-001 --role hr
bun run promote-admin --phone 01012345678 --remove
```

The script seeds RBAC, activates the account if necessary, grants the role
(`admin`, `hr` or `employee`) and prints the resulting roles and permissions.

Seeded roles:

| Role | Permissions |
| --- | --- |
| `admin` | everything below |
| `hr` | `users:read`, `users:approve`, `employees:import`, `audit:read` |
| `employee` | none (standard access) |

Permissions: `users:read`, `users:approve`, `users:manage`, `employees:import`,
`roles:manage`, `audit:read`.

---

## Account lifecycle

```
Existing employee                                             New investigator
─────────────────                                             ────────────────
HR registry record (available)
        │                                                             │
        │ POST /auth/signup/existing/start                            │
        │ (employee number recognised, signup JWT issued)              │
        │                                                             │
        ▼                                                             ▼
POST /auth/signup/existing/complete                           POST /auth/signup/new
────────────────────────────────────                          ────────────────────
multipart profile + ID images                                 multipart profile + ID images
status: pending_verification                                  employee number generated
                                                              status: pending_approval
        │                                                             │
        └────────────────────────► admin review ◄─────────────────────┘
                                     │
                     approve ────────┼──────── reject
                        ▼           │            ▼
                      active        │        rejected
                                    │
                                 suspend ──► suspended ──► reactivate ──► active
```

Only `active` accounts can sign in. Pending, rejected and suspended accounts receive
`403 ACCOUNT_NOT_ACTIVE` (or the specific status code) when attempting login.

| Status | Meaning |
| --- | --- |
| `pending_verification` | Existing employee submitted, awaiting HR/admin verification |
| `pending_approval` | New investigator submitted, awaiting approval |
| `active` | Can sign in and use biometrics |
| `rejected` | Application declined |
| `suspended` | Temporarily disabled by an administrator |

| Account type | Signup route |
| --- | --- |
| `existing_employee` | `/auth/signup/existing/start` → `/auth/signup/existing/complete` |
| `new_investigator` | `/auth/signup/new` |

---

## API reference

### Conventions

- Base path: **`/api/v1`**. Root aliases (`/auth/login`, `/users/me`, ...) also work.
- JSON in, JSON out (except signup, which is `multipart/form-data`).
- Phone numbers accept Egyptian local format (`01XXXXXXXXX`) or E.164; they are stored
  normalised to `+20…`. National IDs are exactly 14 digits (Egyptian NIN).
- Success: `{ "success": true, "data": { ... } }`
- Error:
  ```json
  {
    "success": false,
    "error": {
      "code": "VALIDATION_ERROR",
      "message": "phone is required",
      "details": { "field": "phone", "message": "phone is required" }
    },
    "request_id": "..."
  }
  ```
- Authentication: `Authorization: Bearer <access_token>`
- Every response includes `X-Request-Id`; send your own via `X-Request-Id` for tracing.

Common status codes: `400` validation, `401` unauthenticated/invalid credentials,
`403` not active or missing permission, `404` not found, `409` conflict,
`413` payload too large, `429` rate limited or locked out, `500` unexpected.

---

### Authentication

#### `POST /auth/login`

Sign in with an employee ID, an employee number, or an email address — never more
than one.

```json
{
  "employee_number": "GP-000001",
  "password": "correct horse battery staple",
  "device_id": "iphone-15-pro",
  "device_name": "Amina's iPhone",
  "platform": "ios"
}
```

Alternatives for the identifier:

```json
{ "employee_id": "EMP-001", "password": "..." }
{ "email": "amina@example.com", "password": "..." }
{ "identifier": "GP-000001", "identifier_type": "employee_number", "password": "..." }
{ "identifier": "amina@example.com", "identifier_type": "email", "password": "..." }
```

Response `200`:

```json
{
  "success": true,
  "data": {
    "access_token": "<jwt>",
    "refresh_token": "<opaque token>",
    "token_type": "Bearer",
    "expires_in": 900,
    "refresh_expires_in": 2592000,
    "auth_method": "password",
    "session": {
      "session_id": "…",
      "created_at": "2026-01-01T10:00:00.000Z",
      "expires_at": "2026-01-31T10:00:00.000Z"
    },
    "user": {
      "user_id": "…",
      "employee_id": "EMP-001",
      "employee_number": "GP-000001",
      "full_name": "Amina Yusuf",
      "phone": "01012345678",
      "email": "amina@example.com",
      "national_id_last4": "8901",
      "account_type": "existing_employee",
      "status": "active",
      "biometric_enabled": false,
      "roles": ["employee"]
    }
  }
}
```

Notes:

- Five failed attempts lock the account for 15 minutes (`429` with `Retry-After`).
- Successful login resets the counter and records `last_login_at`.
- Credentials for unknown accounts are verified against a dummy hash to reduce timing
  differences.

#### `POST /auth/refresh`

```json
{ "refresh_token": "<opaque token>" }
```

Refresh tokens are single-use and rotate on every call. Reusing an already-rotated
token revokes **all** sessions for that user and returns `401`.

#### `POST /auth/logout`

Requires a bearer token. Optional body: `{ "refresh_token": "..." }`. Revokes the
current session (or the supplied refresh token).

#### `POST /auth/logout-all`

Requires a bearer token. Revokes every session for the user.

#### `POST /auth/password/change`

Requires a bearer token.

```json
{
  "current_password": "...",
  "new_password": "...",
  "confirm_password": "..."
}
```

Changing the password revokes all other sessions and **all biometric credentials**.
The new password must not contain the employee number, phone or national ID, and must
not be a common password.

---

### Existing-employee signup

#### Step 1 — `POST /auth/signup/existing/start`

```json
{ "employee_number": "GP-000001" }
```

Response `200`:

```json
{
  "success": true,
  "data": {
    "signup_token": "<jwt, valid 20 minutes>",
    "expires_in": 1200,
    "employee": {
      "employee_number": "GP-000001",
      "employee_id": "EMP-001",
      "full_name": "Amina Yusuf",
      "phone_hint": "+201******678",
      "department": "Investigation",
      "position": "Field Investigator"
    },
    "next_step": "complete_profile"
  }
}
```

Unknown numbers return `404`. Already-registered numbers return
`409 EMPLOYEE_ALREADY_REGISTERED`.

A rejected employee can repeat these steps with the same employee number. Their
existing account is reopened as `pending_verification`: the new details and images
replace the old ones, and the rejection reason is cleared. Rejected new
investigators are not covered and still see `ACCOUNT_ALREADY_EXISTS`.

#### Step 2 — `POST /auth/signup/existing/complete`

`Authorization: Bearer <signup_token>` (the token from step 1 — not an access token)
and `Content-Type: multipart/form-data`.

| Field | Required | Notes |
| --- | --- | --- |
| `full_name` | yes | Must match the HR record when strict verification is on |
| `phone` | yes | Normalised; must match the HR record when strict verification is on |
| `email` | no | |
| `password` | yes | Min 8 characters |
| `confirm_password` | yes | Must match |
| `national_id_number` | yes | Exactly 14 digits; must match the HR record |
| `national_id_front` | yes | JPEG/PNG/WebP image |
| `national_id_back` | yes | JPEG/PNG/WebP image |
| `profile_image` | yes | JPEG/PNG/WebP personal photo |

Image field aliases: `front_id_image`, `FrontID_image` and `back_id_image`,
`BackID_image`.

Response `201`:

```json
{
  "success": true,
  "data": {
    "user_id": "…",
    "employee_number": "GP-000001",
    "employee_id": "EMP-001",
    "account_type": "existing_employee",
    "status": "pending_verification",
    "next_step": "await_admin_verification",
    "message": "Your profile was submitted successfully. An administrator will verify your account before you can sign in."
  }
}
```

Mismatched identity details return `400 IDENTITY_VERIFICATION_FAILED` with a list of
fields. An account cannot sign in until an administrator approves it.

---

### New-investigator signup

#### `POST /auth/signup/new`

`Content-Type: multipart/form-data` — same fields as step 2 above, no signup token.

Response `201`:

```json
{
  "success": true,
  "data": {
    "user_id": "…",
    "employee_number": "GP-000123",
    "employee_id": null,
    "account_type": "new_investigator",
    "status": "pending_approval",
    "next_step": "await_admin_approval",
    "message": "Your profile was submitted successfully. Save your employee number: it is required to sign in. An administrator will review your application."
  }
}
```

The generated employee number is shown **once** in this response. Applicants must
save it — it is the identifier they use to sign in. If a national ID matches the HR
registry, the request is rejected with `409 EXISTING_EMPLOYEE_DETECTED` and the
applicant is directed to the existing-employee flow.

---

### Sessions and profile

All routes require a bearer access token.

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/users/me` | Current profile and roles |
| `PATCH` | `/users/me` | Update `phone` / `email` (administrators may also change `full_name`) |
| `GET` | `/users/me/sessions` | Active sessions for this user |
| `DELETE` | `/users/me/sessions/:session_id` | Revoke one session |

`PATCH /users/me` body (all optional):

```json
{ "phone": "01012345678", "email": "new@example.com" }
```

Send `"email": null` or `""` to clear the email. Changing the phone resets
`phone_verified_at` and rejects duplicates with `409`. Accounts with a row in
`admin_security` may also send `full_name` (3–120 characters); the new name is
audited and reflected everywhere the profile appears. Employee names remain
immutable.

---

### Biometric sign-in

Biometric login is **opt-in after activation**. The device generates a key pair in
the secure enclave (Secure Enclave / Android Keystore / WebCrypto) and registers the
**public** key. The private key never leaves the device.

#### 1. Register a device — `POST /auth/biometric/register`

Requires a bearer access token.

```json
{
  "device_id": "iphone-15-pro-abc123",
  "device_name": "Amina's iPhone",
  "platform": "ios",
  "algorithm": "ed25519",
  "public_key": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----"
}
```

Supported algorithms: `ed25519`, `es256` (P-256), `rs256` (RSA ≥ 2048 bits).
`public_key` must be PEM. The key type must match `algorithm`.

Response `201`:

```json
{
  "success": true,
  "data": {
    "credential_id": "…",
    "device_id": "iphone-15-pro-abc123",
    "device_name": "Amina's iPhone",
    "platform": "ios",
    "algorithm": "ed25519",
    "created_at": "2026-01-01T10:00:00.000Z"
  }
}
```

#### 2. Request a challenge — `POST /auth/biometric/challenge`

Public endpoint (rate limited).

```json
{
  "device_id": "iphone-15-pro-abc123",
  "employee_number": "GP-000001"
}
```

`employee_number` / `employee_id` / `identifier` is optional when the device is
already bound to exactly one account.

Response `200`:

```json
{
  "success": true,
  "data": {
    "challenge_id": "…",
    "nonce": "<random>",
    "algorithm": "ed25519",
    "signing_payload": "golden-pay-biometric:<challenge_id>:<nonce>",
    "expires_at": "2026-01-01T10:01:30.000Z",
    "message": "Sign signing_payload with the private key protected by Face ID / fingerprint, then POST challenge_id and signature to /auth/biometric/login"
  }
}
```

Challenges are single-use and expire after 90 seconds.

#### 3. Sign and log in — `POST /auth/biometric/login`

Sign the **exact UTF-8 bytes** of `signing_payload` with the device private key, then:

```json
{
  "challenge_id": "…",
  "nonce": "<the nonce from the challenge>",
  "signature": "<base64url signature>"
}
```

Signature encodings: Ed25519 and RSA (PKCS#1 v1.5) use their standard raw
signatures. ES256 accepts either a DER-encoded ECDSA signature or the raw 64-byte
`r||s` form (converted to DER server-side).

Response `200` has the same shape as password login (`auth_method: "biometric"`).

#### 4. List / revoke devices

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/auth/biometric/devices` | List registered credentials (no public keys) |
| `DELETE` | `/auth/biometric/devices/:credential_id` | Revoke one credential |

---

### Administration

Require a bearer token with the listed permission. Users are addressed by
`user_id`.

| Method | Path | Permission | Description |
| --- | --- | --- | --- |
| `GET` | `/admin/users` | `users:read` | List users |
| `GET` | `/admin/stats` | `users:read` | Dashboard counters (users by status, employees, recent activity) |
| `POST` | `/admin/investigators` | `users:manage` | Create an investigator + HR record, returns a temporary password |
| `GET` | `/admin/users/:user_id` | `users:read` | User detail |
| `GET` | `/admin/users/:user_id/national-id/:side` | `users:read` | Stream ID image (`front`/`back`) |
| `GET` | `/admin/users/:user_id/photo` | `users:read` | Stream the personal photo |
| `POST` | `/admin/users/:user_id/approve` | `users:approve` | Activate a pending account |
| `POST` | `/admin/users/:user_id/reject` | `users:approve` | Reject (`{"reason": "..."}` optional) |
| `POST` | `/admin/users/:user_id/suspend` | `users:manage` | Suspend an active account |
| `POST` | `/admin/users/:user_id/reactivate` | `users:manage` | Reactivate a suspended account |
| `POST` | `/admin/users/:user_id/roles` | `roles:manage` | Assign role (`{"role": "hr"}`) |
| `DELETE` | `/admin/users/:user_id/roles` | `roles:manage` | Remove role (`{"role": "hr"}`) |
| `GET` | `/admin/roles` | `users:read` | List roles |
| `GET` | `/admin/employees` | `employees:import` | List HR registry records |
| `POST` | `/admin/employees/import` | `employees:import` | Import/update HR records |
| `GET` | `/admin/audit-logs` | `audit:read` | Query audit events |

`GET /admin/users` query parameters: `status`, `account_type`, `search`, `page`,
`limit`. `GET /admin/employees`: `status`, `search`, `page`, `limit`.

`GET /admin/stats` returns totals for investigators (active, pending approval, pending
verification, suspended, rejected), HR registry records (available/registered) and the
latest audit events used by the dashboard overview.

`POST /admin/investigators` body: `full_name`, `phone`, `national_id_number`, optional
`employee_id`, `employee_number`, `email`, `department`, `position`, `password`. When
`password` is omitted a strong temporary one is generated. It creates the account in
`active` state, creates the HR registry row, grants the `employee` role and returns
`{ user, temporary_password }` that must be handed over securely. The action is
audited as `user.created_by_admin`.

`GET /admin/audit-logs` query parameters: `event`, `user_id`, `success`
(`true`/`false`), `from`, `to` (ISO dates), `page`, `limit`.

Approving an existing employee also marks their HR registry record as `registered`.
Suspending or rejecting a user revokes all their sessions.

---

## Biometric protocol

```
Device                                   Server
  │  generate key pair in secure enclave   │
  │  POST /auth/biometric/register ───────►│  store public key + algorithm
  │                                        │
  │  POST /auth/biometric/challenge ──────►│  create single-use challenge (90 s)
  │◄──────── challenge_id, nonce, payload ─│
  │                                        │
  │  sign "golden-pay-biometric:<id>:<nonce>"
  │  with Face ID / fingerprint            │
  │                                        │
  │  POST /auth/biometric/login ──────────►│  verify signature, burn challenge,
  │◄────────────── access + refresh ───────│  create session
```

Properties:

- Private keys are never transmitted or stored server-side.
- Each challenge is single-use and bound to a device credential; nonce is stored only
  as an HMAC.
- A wrong signature burns the challenge — request a new one.
- Disabled, suspended or deleted accounts are rejected before signature verification.
- Deleting a credential revokes only that device; changing the password revokes all.

---

## Project layout

```
IdentityAcess_Services/
├── app.ts                      Bun.serve bootstrap, CORS, headers, logging
├── Config/
│   ├── env.ts                  Typed environment configuration
│   ├── db.ts                   postgres connection, transactions, schema apply
│   └── schema.sql              Idempotent DDL for all 11 tables + indexes
├── Models/
│   ├── SqlModel.ts             Shared typed query builder / persistence helper
│   ├── UserSchema.ts           Accounts (statuses, account types)
│   ├── EmployeeRecordSchema.ts HR registry for existing employees
│   ├── RefreshSessionSchema.ts Hashed refresh tokens / sessions
│   ├── BiometricCredentialSchema.ts
│   ├── LoginChallengeSchema.ts
│   ├── AuditLogSchema.ts
│   ├── RoleSchema.ts / PermissionSchema.ts / RolePermissionSchema.ts / UserRolesSchema.ts
│   └── CounterSchema.ts        Atomic employee-number sequence
├── Services/
│   ├── auth.service.ts         Login, signup, refresh, password
│   ├── session.service.ts      Token issue/rotation/revocation
│   ├── biometric.service.ts    Registration, challenge, verification
│   ├── admin.service.ts        Review, stats, investigator creation, HR import, audit
│   ├── admin-security.service.ts Invitations, owner policy, TOTP enrollment
│   ├── email-otp.service.ts    Hashed, expiring email challenges
│   ├── mail.service.ts         SMTP delivery and invitation mail
│   ├── user.service.ts         Profile and sessions
│   ├── rbac.service.ts         Roles/permissions seeding and checks
│   ├── audit.service.ts        Structured audit events
│   └── employeeNumber.service.ts
├── Controllers/                HTTP request/response mapping
├── Routes/                     Route table + middleware wiring
├── MIddlewares/                Auth, error, rate limiting
├── Utils/                      http, crypto, jwt, validation, files, logger, router
└── scripts/
    ├── init-db.ts              Apply schema, seed RBAC, create upload dir
    ├── create-admin.ts         Create an active administrator + HR record
    ├── configure-owner.ts      Set the primary administrator's credentials/policy
    ├── test-admin-selfservice.ts  TOTP/name-change integration checks
    ├── test-admin-security.ts  Owner authorization and policy checks
    ├── test-email-otp.ts       Email challenge checks with injected delivery
    ├── verify-http-selfservice.ts HTTP self-service check (API must be running)
    ├── import-employees.ts
    └── promote-admin.ts```

> `MIddlewares` keeps its existing (intentional) casing so all imports stay stable.

### Data handling

- PostgreSQL stores every entity in its own table. Each row has a generated text
  `_id` primary key plus separate UNIQUE business keys, so the JSON contract is
  unchanged from the previous document store.
- National IDs are stored as AES-256-GCM ciphertext plus a keyed HMAC and last four
  digits. Full numbers are never returned by the API.
- Passwords use Argon2id (`Bun.password`).
- Refresh tokens are random 48-byte values stored only as HMAC hashes.
- ID images live under the repository `Storage/identity-access/national-ids/<user_id>/`
  tree (`UPLOAD_DIR`) and are served exclusively through the permission-checked admin
  endpoint.
- Sensitive columns (`password_hash`, `national_id_*`, image paths, lockout counters)
  are stripped before serialisation.

---

## Data storage

```
Storage/
├── README.md
└── identity-access/
    ├── national-ids/<user_id>/front-*.png   Uploaded ID images
    ├── exports/                             Generated reports (reserved)
    └── backups/                             Database dumps (reserved)
```

- `UPLOAD_DIR` is resolved relative to the service directory; the default
  `../../Storage/identity-access` lands on `<repo>/Storage/identity-access`.
- Back up PostgreSQL **and** the `Storage/identity-access` folder together — images are
  on disk, not in the database.
- The folder is created automatically by `bun run db:init` and at startup.

---

## Web dashboard

`Dashboard/` is a dependency-free Bun static server + API proxy for HR/admin staff.
It talks to this service through `IDENTITY_API_URL` (default `http://127.0.0.1:4001`)
so the browser never needs CORS access to the API.

```bash
cd ../Dashboard
bun install       # no runtime deps; type-only
bun app.ts        # http://127.0.0.1:4100
```

Sign in with an employee number + password (an `admin` or `hr` account). Features:
overview counters, quick employee-number lookup, registration requests with national-ID
image review, approve/reject, investigator directory (suspend/reactivate/roles), adding
investigators with generated credentials, employee directory and the audit log. See
[`Dashboard/README.md`](../../Dashboard/README.md).

---

## Security notes

- Run behind TLS. HSTS, `nosniff`, `DENY` framing and a restrictive permissions
  policy are set on every response.
- Set `CORS_ORIGINS` to explicit origins in production (never `*` when using
  credentialed requests).
- Rotate `JWT_SECRET`, `NATIONAL_ID_*` and `REFRESH_TOKEN_PEPPER` using a secrets
  manager; changing the pepper invalidates all refresh tokens.
- Rate limits are in-memory and per instance. For multi-instance deployments put a
  shared limiter (or API gateway) in front of the service.
- Audit logs record login attempts, signup events, approvals, role changes and
  profile updates; they intentionally contain no secrets.
- Back up the PostgreSQL database and `UPLOAD_DIR` together — ID images are stored on
  disk, not in PostgreSQL. `pg_dump` into `Storage/identity-access/backups/` and keep
  the image tree in the same backup set.

---

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| Startup exits with "… is required in production" | Missing/short secret in `.env`; run `openssl rand -base64 32` |
| `503` on `/api/v1/health` | PostgreSQL unreachable; check `DATABASE_URL`, the server port and pg_hba auth |
| `ECONNREFUSED` / `password authentication failed` at startup | Database not running or bad credentials; start PostgreSQL and re-check `DATABASE_URL` |
| `relation "users" does not exist` | Schema not applied; run `bun run db:init` |
| `409` on `/admin/investigators` | Phone or national ID already belongs to an account |
| `404` on existing-employee start | Employee number not in the HR registry — import it first |
| `409 EMPLOYEE_ALREADY_REGISTERED` | A user or claimed registry record already exists |
| `400 IDENTITY_VERIFICATION_FAILED` | Name/phone/national ID differ from HR data; set `STRICT_EMPLOYEE_VERIFICATION=false` only if intended |
| `401` after refresh | Token was already rotated (reuse detection) — sign in again |
| `403 ACCOUNT_NOT_ACTIVE` | Account is pending, rejected or suspended — needs admin action |
| `429` on login | Per-IP limit or account lockout; wait for `Retry-After` |
| `413` on signup | ID images exceed `MAX_UPLOAD_BYTES` |

---

## License

Proprietary — Golden Pay. All rights reserved.
