# Account authentication

TECHNOVALENS opens on a centered Welcome Back card with username and password, a purple Login button and a Sign Up link. Signup uses the same centered card with username, password and confirmation. The split panel and all recovery UI have been removed. Email addresses and Google login are not collected. All `/api` document, dashboard, upload/progress, conversation, chat and report requests require an authenticated account, except the health endpoint and the explicit authentication endpoints below.

## Local setup

1. Install dependencies in `backend` and `frontend` using `npm install` (Node 22 or later; validated with Node 24).
2. Keep the existing private `backend/.env`. For a new checkout, copy `.env.example` only if `.env` does not already exist.
3. Run `npm run auth:configure` in `backend`. This appends a random signing secret if needed without printing it or overwriting other settings. Never commit `.env`.
4. Configure `MONGODB_URI` and start MongoDB, then start the backend and Vite as described in the root README. MongoDB is required for authentication even with `CONVERSATION_STORAGE=file`.
5. Use Sign Up to create an account and its private workspace. A username is 3–32 ASCII letters, numbers, dots, underscores or hyphens, beginning with a letter or number. Uniqueness is case insensitive and enforced by a MongoDB unique index, including concurrent signup attempts. Signup cannot supply roles, account IDs or document ownership.
6. Use Settings > Account Security to change credentials. Optional initial-admin provisioning remains available through `npm run admin:setup` in a private interactive terminal inside `backend`, after reviewing the intended database. It accepts a username (default `admin`) and strong password twice without echoing input or providing a default password. No setup against production was performed during local implementation.

Passwords require 15–128 characters, uppercase/lowercase letters and a number. Predictable passwords and passwords containing the username are rejected. Spaces and symbols are supported. Passwords use salted Argon2id (19 MiB, two iterations, parallelism one); neither plaintext passwords nor recovery codes are stored. This configuration follows the [OWASP password storage guidance](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html).

## Sessions and HTTPS configuration

`SESSION_SECRET` must contain at least 32 bytes of random secret material. Configure a different secret for each environment. Rotating it invalidates existing signed cookies. Sessions live in MongoDB, so accounts and sessions survive backend restarts. Session IDs are hashed in the session collection.

Local HTTP uses an HttpOnly, host-only cookie with `SameSite=Lax`. On deployed HTTPS set `NODE_ENV=production`: cookies are Secure, use the `__Host-` prefix, and default to `SameSite=None` for the existing cross-site frontend/API domains. Production rejects HTTP authentication requests. `AUTH_COOKIE_SAMESITE=lax` or `strict` is available for same-site hosting; `none` always requires Secure. Do not disable Secure in production.

Proxy trust defaults to one hop when `RENDER=true` and zero elsewhere. Render documents that [RENDER is set automatically](https://render.com/docs/environment-variables#render). `AUTH_TRUST_PROXY_HOPS` is an explicit override: if currently set to zero on Render, remove it or set it to one for the standard platform proxy. Never use unrestricted `trust proxy=true` or trust forwarded headers on a directly exposed origin port. Other proxy topologies need their exact trusted hop count.

The reported HTTPS error is consistent with the previous default of zero: TLS terminates upstream, Express sees an HTTP socket, ignores `X-Forwarded-Proto`, and rejects authentication. The server now configures proxy trust before sessions/routes. It still checks `req.secure`; Express derives this from the HTTPS socket or the trusted proxy's `X-Forwarded-Proto=https`. A spoofed header with trust disabled still fails, as do missing/HTTP protocol headers in production. See [Express proxy guidance](https://expressjs.com/en/guide/behind-proxies/). No live Render requests or environment changes were used for verification.

Production CORS permits exact `https://technovahub.in` and `https://www.technovahub.in` origins, credentials and `X-CSRF-Token`. The website's `/technovalens` path is not part of its origin. Localhost and the old Vercel development origin are not allowed by default in production. Add extra trusted frontend origins as exact HTTP(S) origins in `AUTH_ALLOWED_ORIGINS`, comma separated. Wildcards and paths are rejected. Untrusted origins cannot make credentialed mutations.

The intended Render configuration is `NODE_ENV=production`, `AUTH_TRUST_PROXY_HOPS=1` (or leave unset for Render detection), `AUTH_COOKIE_SECURE=true`, and `AUTH_COOKIE_SAMESITE=none`, with a private random `SESSION_SECRET`. The frontend build still uses `VITE_API_URL=https://technovalens.onrender.com`. These are setup instructions; no deployment or production configuration was changed.

Cross-site hosting requires browsers to permit the API session cookie. Browsers blocking third-party cookies may require deploying the frontend and API on the same site or behind a same-site reverse proxy. Keep CSRF protection enabled.

Sessions expire after 30 minutes of inactivity and at most eight hours after authentication. Successful login and recovery-code regeneration rotate the session ID and CSRF token. Logout revokes the current session, including protection against a concurrent stale request saving the old session again. Password recovery or a username/password change invalidates all existing account sessions. Disabled accounts are checked on every protected request. Client requests send credentials and hold the CSRF token in memory; they do not store passwords or session tokens in localStorage.

## First administrator setup and Account Security

Public signup creates ordinary accounts and cannot grant administrator metadata. There is no HTTP bootstrap endpoint. Only the explicit terminal command calls first-admin provisioning. A singleton `auth_bootstrap` record is claimed atomically before insertion of the initial admin. Concurrent invocations cannot create multiple initial admins. Its permanent lock remains after username/password changes, account deletion or an interrupted setup. Interrupted setup fails closed and needs operator inspection; the application provides no automatic unlock command. The command never replaces an existing username/account. An initial administrator stores an Argon2id hash and has `role: admin` and `initialAdmin: true` metadata.

Existing accounts retain their credentials, immutable IDs and original data access through Login. They are not silently promoted, reassigned or merged with new accounts. Login does not grant cross-account access. To retain documents owned by an existing account, log in with that account instead of creating another account to claim its files.

Settings > Account Security supports a new username, current password, optional new password and confirmation. The browser shows password requirement feedback; the server always enforces the policy and username uniqueness. Every credential update verifies the current password, uses optimistic session-version checks, revokes all sessions and requires a new login. The immutable user ID and ownership hash stay unchanged, preserving documents and conversations. Existing recovery codes remain valid; replace them separately if needed. New recovery codes require current-password verification and can be issued without changing credentials.

## Authentication API

All responses are private and non-cacheable. Obtain the session cookie and CSRF token from `GET /api/auth/session` before sending mutations; include `X-CSRF-Token` and the cookie on each mutation. Cross-origin browser requests also need `credentials: include`. Do not put tokens in URLs.

| Route | Body / result |
| --- | --- |
| `GET /api/auth/session` | Returns `{user: {id, username} \| null, csrfToken}`. |
| `POST /api/auth/signup` | `{username, password, confirmPassword}`; validates credentials, creates an ordinary account and returns HTTP 201 with `{user, csrfToken}` after rotating the session. No password hash or recovery secrets are returned. |
| `POST /api/auth/login` | `{username, password}`; returns user and rotated CSRF token. Invalid credentials have one generic response. |
| `POST /api/auth/logout` | Revokes the current session and clears its cookie. |
| `POST /api/auth/account` | Requires login and `{currentPassword, username?, newPassword?, confirmPassword?}`; validates changes, revokes every session and returns `{updated: true, signInRequired: true}`. |
| `POST /api/auth/recover` | `{username, recoveryCode, password, confirmPassword}`; atomically consumes the code, replaces the password and revokes all sessions. Sign in again afterward. |
| `POST /api/auth/recovery-codes` | Internal API, with no UI link. Requires login plus `{password}`; replaces all recovery codes and returns the new codes and rotated CSRF token. |

The server applies MongoDB-backed 15-minute attempt buckets: signup has 20 attempts per IP, and login/recovery/account security have 60 per IP and ten per normalized username per action. Session bootstrap and recovery-code issuance are also limited. Responses include HTTP 429 and `Retry-After` when the limit is exceeded. Password hashing concurrency, including signup, is bounded to limit memory/CPU exhaustion. Rate-limit keys use keyed hashes rather than raw IPs/usernames. Authentication store failures deny access rather than bypassing checks.

## Recovery and ownership

The recovery UI is removed, but the recovery/issuance APIs and their security checks remain unchanged. Existing saved recovery codes continue to work through the internal API. Each code contains 128 bits of random material and is stored only as a user-bound hash. Codes are single use and consumed atomically. Issuance returns codes only once and requires an authenticated session, CSRF token and current password. Signup does not display or return recovery codes; a user who needs codes can obtain them only through that reauthenticated internal API and must save them privately. There is no username-only password reset. Without a password or saved code, there is no automatic recovery path; a separately verified administrator process would be needed. Removing links does not remove or bypass these requirements.

An authenticated account ID determines ownership, using a server-derived hash. Client workspace headers are ignored as credentials. MongoDB conversations, GridFS documents and local document metadata retain ownership checks; report generation and streaming endpoints use the same checks. Another account's object IDs return 404. Session cookies are required for downloads as well as JSON requests. Account changes unmount the old frontend workspace and account-specific preferences use separate keys.

Existing anonymous documents and conversations keep their original owner and remain inaccessible to new accounts. Initial setup creates only its new administrator account and bootstrap record; it never migrates, adopts or changes existing data. Local implementation tests use isolated databases only. Back up existing storage before considering any separately reviewed historical migration. Old workspace-assignment tools must not be used to grant account access.

## Verification

Run `npm test` in `backend` for the complete suite or `node tests/run-tests.js --auth-only` for auth tests. The runner creates a disposable loopback MongoDB instance and random signing secret; it never uses the configured application database. Its first run downloads a pinned MongoDB 8.0.18 binary to the ignored `.data/test-mongodb-binaries` cache. Legacy test clients seed isolated accounts and log in normally; signup and isolation tests use the public signup endpoint. Coverage includes signup confirmation/strength, concurrent uniqueness, ignored privilege/ownership injection, CSRF/origin rejection and signup rate limits, plus first-admin locks, existing-user preservation, proxy spoof rejection, credential changes/session revocation, password storage, session rotation/replay/expiry/restart, internal recovery replay/concurrency, cookie flags, fail-closed storage and cross-account local/Mongo/GridFS/history/report access.

`node tests/run-tests.js --auth-ui` runs the isolated Edge browser smoke test (override `AUTH_TEST_BROWSER` for an installed Chromium browser). It checks centered desktop/mobile Login and Sign Up, signup confirmation/uniqueness, incorrect passwords, session persistence across refresh, Account Security, credential changes, upload, logout, protected dashboard access and restored data. It also checks the absence of recovery UI. Screenshots are written to ignored `.data/auth-validation` without passwords. Run `npm run build` in `frontend` for production compilation. The older optional `tests/browser-smoke.mjs` predates account authentication; use the auth UI runner for authenticated browser validation.

HTTP workbook diagnostic scripts require an existing dedicated account supplied through private terminal variables `TECHNOVALENS_DIAGNOSTIC_USERNAME` and `TECHNOVALENS_DIAGNOSTIC_PASSWORD`. They use normal login/CSRF sessions, never print credentials, and delete only files created by the diagnostic invocation. Never point a local test at production resources.
