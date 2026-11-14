# Account authentication

TECHNOVALENS uses username/password accounts. Email addresses and Google login are not collected. All `/api` document, dashboard, upload/progress, conversation, chat and report requests require an authenticated account, except the health endpoint and the explicit authentication endpoints below.

## Local setup

1. Install dependencies in `backend` and `frontend` using `npm install` (Node 22 or later; validated with Node 24).
2. Keep the existing private `backend/.env`. For a new checkout, copy `.env.example` only if `.env` does not already exist.
3. Run `npm run auth:configure` in `backend`. This appends a random signing secret if needed without printing it or overwriting other settings. Never commit `.env`.
4. Configure `MONGODB_URI` and start MongoDB, then start the backend and Vite as described in the root README. MongoDB is required for authentication even with `CONVERSATION_STORAGE=file`.
5. Sign up in the browser and save the ten recovery codes displayed once. A username is 3–32 ASCII letters, numbers, dots, underscores or hyphens, beginning with a letter or number. Uniqueness is case insensitive.

Passwords require 15–128 characters, uppercase/lowercase letters and a number. Predictable passwords and passwords containing the username are rejected. Spaces and symbols are supported. Passwords use salted Argon2id (19 MiB, two iterations, parallelism one); neither plaintext passwords nor recovery codes are stored. This configuration follows the [OWASP password storage guidance](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html).

## Sessions and HTTPS configuration

`SESSION_SECRET` must contain at least 32 bytes of random secret material. Configure a different secret for each environment. Rotating it invalidates existing signed cookies. Sessions live in MongoDB, so accounts and sessions survive backend restarts. Session IDs are hashed in the session collection.

Local HTTP uses an HttpOnly, host-only cookie with `SameSite=Lax`. On deployed HTTPS set `NODE_ENV=production`: cookies are Secure, use the `__Host-` prefix, and default to `SameSite=None` for the existing cross-site frontend/API domains. Production rejects HTTP authentication requests. `AUTH_COOKIE_SAMESITE=lax` or `strict` is available for same-site hosting; `none` always requires Secure. Do not disable Secure in production.

Set `AUTH_TRUST_PROXY_HOPS` to the exact trusted reverse-proxy hop count (default zero). Only use one when there is exactly one trusted HTTPS proxy and clients cannot reach the backend directly. Add any extra trusted frontend origins as exact HTTP(S) origins in `AUTH_ALLOWED_ORIGINS`, comma separated. Wildcards and paths are rejected. Untrusted origins cannot make credentialed mutations.

Cross-site hosting requires browsers to permit the API session cookie. Browsers blocking third-party cookies may require deploying the frontend and API on the same site or behind a same-site reverse proxy. Keep CSRF protection enabled.

Sessions expire after 30 minutes of inactivity and at most eight hours after authentication. Successful login and recovery-code regeneration rotate the session ID and CSRF token. Logout revokes the current session, including protection against a concurrent stale request saving the old session again. A password recovery invalidates all existing account sessions. Disabled accounts are checked on every protected request. Client requests send credentials and hold the CSRF token in memory; they do not store passwords or session tokens in localStorage.

## Authentication API

All responses are private and non-cacheable. Obtain the session cookie and CSRF token from `GET /api/auth/session` before sending mutations; include `X-CSRF-Token` and the cookie on each mutation. Cross-origin browser requests also need `credentials: include`. Do not put tokens in URLs.

| Route | Body / result |
| --- | --- |
| `GET /api/auth/session` | Returns `{user: {id, username} \| null, csrfToken}`. |
| `POST /api/auth/signup` | `{username, password, confirmPassword}`; creates an account and returns the authenticated user, rotated CSRF token and ten recovery codes. |
| `POST /api/auth/login` | `{username, password}`; returns user and rotated CSRF token. Invalid credentials have one generic response. |
| `POST /api/auth/logout` | Revokes the current session and clears its cookie. |
| `POST /api/auth/recover` | `{username, recoveryCode, password, confirmPassword}`; atomically consumes the code, replaces the password and revokes all sessions. Sign in again afterward. |
| `POST /api/auth/recovery-codes` | Requires login plus `{password}`; replaces all recovery codes and returns the new codes and rotated CSRF token. Available through Settings. |

The server applies MongoDB-backed 15-minute attempt buckets: login/recovery have 60 attempts per IP and ten per normalized username per action; signup has 20 per IP. Session bootstrap and recovery-code issuance are also limited. Responses include HTTP 429 and `Retry-After` when the limit is exceeded. Password hashing concurrency is bounded to limit memory/CPU exhaustion. Rate-limit keys use keyed hashes rather than raw IPs/usernames. Authentication store failures deny access rather than bypassing checks.

## Recovery and ownership

Each recovery code contains 128 bits of random material and is stored only as a user-bound hash. Codes are single use, consumed atomically, and are shown/downloaded only when initially issued. Save them somewhere private outside the application. Regenerating them requires the current password. There is no username-only password reset. If both the password and all codes are lost, there is no automatic recovery path; a separately verified administrator process would be needed. Do not treat knowledge of a username as proof of ownership.

An authenticated account ID determines ownership, using a server-derived hash. Client workspace headers are ignored as credentials. MongoDB conversations, GridFS documents and local document metadata retain ownership checks; report generation and streaming endpoints use the same checks. Another account's object IDs return 404. Session cookies are required for downloads as well as JSON requests. Account changes unmount the old frontend workspace and account-specific preferences use separate keys.

Existing anonymous documents and conversations keep their original owner and remain inaccessible to new accounts. No migration, adoption, production-data update or administrator recovery action is performed during setup. Back up existing storage before considering any separately reviewed historical migration. Old workspace-assignment tools must not be used to grant account access.

## Verification

Run `npm test` in `backend` for the complete suite or `node tests/run-tests.js --auth-only` for auth tests. The runner creates a disposable loopback MongoDB instance and random signing secret; it never uses the configured application database. Its first run downloads a pinned MongoDB 8.0.18 binary to the ignored `.data/test-mongodb-binaries` cache. Tests cover password storage, uniqueness, CSRF/origin rejection, session rotation/replay/expiry/restart, recovery replay/concurrency, rate limits, cookie flags, fail-closed storage and cross-account local/Mongo/GridFS/history/report access.

`node tests/run-tests.js --auth-ui` runs the isolated Edge browser smoke test (override `AUTH_TEST_BROWSER` for an installed Chromium browser). It checks desktop login, mobile signup, code acknowledgement, upload, logout, login persistence and password recovery. Screenshots are written to ignored `.data/auth-validation`; recovery codes are not included. Run `npm run build` in `frontend` for production compilation. The older optional `tests/browser-smoke.mjs` predates account authentication; use the auth UI runner for authenticated browser validation.

HTTP workbook diagnostic scripts require an existing dedicated account supplied through private terminal variables `TECHNOVALENS_DIAGNOSTIC_USERNAME` and `TECHNOVALENS_DIAGNOSTIC_PASSWORD`. They use normal login/CSRF sessions, never print credentials, and delete only files created by the diagnostic invocation. Never point a local test at production resources.
