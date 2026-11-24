# Architecture notes

This page is for people who want to know how VDRkit fits together before they change it, audit it or run it at scale. For running it, read [install.md](install.md); for the security summary, [SECURITY.md](../SECURITY.md).

```
packages/core     the domain: SQL migrations, the permission function, the event log, notification rules
apps/server       the API (Fastify, OpenAPI at /v1/openapi.json for site admins) and the background worker (pg-boss)
apps/dataroom     the web front end (Next.js, React, plain CSS)
docker/           the image's entry point, Postgres roles, backup and restore, drills, the smoke test
scripts/          the development stack, load tests, S3 bucket set-up, the licence-header check
```

There is one image, built from one commit, and it runs as `web`, `api`, `worker` or `migrate`. We chose that deliberately: the screens, the API and the job payloads can never come from different versions. Caddy terminates HTTPS in front of them.

The most important design decision is that access control lives in Postgres, not in the API. There is a single permission function, `effective_level()`, and the API, the worker, search and notifications all go through it. Row-level security is forced on every table that holds tenant data. The only tables without it are Better Auth's logins and the rate-limit counters, which hold none.

Files are stored on local disk or in S3 (AWS, Cloudflare R2 or Garage), encrypted with a per-room data key that is itself wrapped by the master key. Files are encrypted in 64 KB chunks with AES-256-GCM. Each file's key is derived from the room key, a random salt kept in the file's header and the location the file is stored at, so no two files share a key and a file moved to another file's location will not decrypt. The worker hashes each file, scans it with ClamAV, converts it with Gotenberg and renders the page images.

Migrations only run forward, each in its own transaction, under an advisory lock. The API and the worker refuse to start against a database that is missing a migration they ship.

VDRkit needs Postgres 16 or later. The Docker Compose set-up bundles Postgres 17.


## Database roles

| Role | Used by | Rights |
| --- | --- | --- |
| `vdrkit_owner` | migrations (`MIGRATION_DATABASE_URL`) | owns the database, tables and security-definer functions |
| `vdrkit_app` | API and worker (`DATABASE_URL`) | what the migrations grant |
| `vdrkit_queue` | pg-boss (`QUEUE_DATABASE_URL`) | `CREATE` on the database, for its schema `pgboss` |

None of the three is a superuser, and none has `BYPASSRLS`. `vdrkit_app` never holds `CREATE` on the database or on any schema.

The owner matters more than it looks. Row-level security is forced on every tenant table, which means it binds the owner as well, and the security-definer functions (the event append, the folder-history trigger, the lookup of due notifications) run as the owner and stay inside the current tenant. A superuser ignores row-level security altogether, so if the owner were a superuser those functions could read and write across tenants.

Create the roles once, as a superuser:

```sql
create role vdrkit_owner login nosuperuser nobypassrls password '...';
create role vdrkit_app   login nosuperuser nobypassrls password '...';
create role vdrkit_queue login nosuperuser nobypassrls password '...';
create database vdrkit owner vdrkit_owner;
grant create on database vdrkit to vdrkit_queue;
```

The first migration creates `vdrkit_app` without a login if it does not exist yet, so create it yourself beforehand if you want to give it a password. `ltree` is a trusted extension, and the owner can create it without superuser rights. On Neon, use `docker/neon/roles.sql` rather than the console, and check the result with `docker/neon/neon-check.mjs`.

At start-up the API, the worker and `migrate` each check their own role and refuse to run as a superuser or as a role with `BYPASSRLS` (`checkRole()` in `packages/core/src/role-safety.ts`). Such a role would skip every policy without a word and see every tenant's data. The API and the worker also refuse a `DATABASE_URL` whose role owns the tables or is a member of the owner role. The revokes that keep `event` append-only do not apply to an owner, and an owner can switch row-level security off. The only role with `BYPASSRLS` is the backup role, `vdrkit_backup`, and it can only read.

With the bundled Postgres, `docker/postgres-init/01-roles.sh` creates the three roles the first time it starts on an empty volume, taking their passwords from `VDRKIT_OWNER_PASSWORD`, `VDRKIT_APP_PASSWORD` and `VDRKIT_QUEUE_PASSWORD` in `.env`.


## One "not available" answer

Someone guessing links should learn nothing about which rooms or documents exist. Every `/v1/workspaces/{ws}/...` request therefore starts with a single query on the caller's memberships. A room that does not exist, a deleted room and a room the caller is not in all get the same `404` after the same amount of work, and documents and folders are not looked up at all. Inside a room, a missing id, an id from another room and an item the caller may not see get the same status and the same bytes from every document and folder route. Upload plans that target a folder in another room get the same `404`.

We have a test that compares these answers byte for byte across the document and folder routes, and counts the queries in both room cases.


## Sign-in and request limits

Sign-in uses Better Auth, mounted under `/v1/auth/*`, and there are no passwords. A person signs in with an emailed magic link (`POST /v1/auth/sign-in/magic-link`, then the emailed `GET /v1/auth/magic-link/verify?token=`) or a six-digit email code (`POST /v1/auth/email-otp/send-verification-otp` with `type: "sign-in"`, then `POST /v1/auth/sign-in/email-otp`). The second factor is TOTP: `POST /v1/auth/two-factor/enable`, confirmed with `POST /v1/auth/two-factor/verify-totp`. Passing `trustDevice: true` with the TOTP check trusts the browser.

The front end only calls the magic-link route. That email carries a code as well, in the subject line. Link and code each work once, for 15 minutes, and the email does not name a room. Requesting a new email invalidates the previous link and code.

A login can only act as a person it is linked to. Accepting an invitation creates the link, and the first sign-in with a proved email address binds it. An unknown address gets no email but sees the same answer as a known one, so the form does not reveal who has an account.

Once TOTP is set up, a magic link or email code alone gives no session; the answer is `twoFactorRedirect: true` until the authenticator code is right. Out of the box Better Auth only does this for password sign-in, and we apply it to both email methods.

A login linked in more than one tenant sends `X-VDRkit-Tenant` to choose. Erased people get no caller, whatever their session says.

Better Auth's own tables have no row-level security, because a login is global and is looked up before any tenant is known. They hold no tenant data. The table that links logins to people can be read across tenants but written only by its own tenant.

A request whose path changes when it is parsed as a URL (dot segments, `%2e%2e`) is refused with 400 before any rate limit or route applies. Better Auth would happily resolve such a path, and it could otherwise slip past the sign-in limit.

Failed sign-ins are kept for 30 days and listed on the Accounts tab of site settings. After that the worker deletes the email address, IP address and browser recorded with them.

Sign-in emails are logged in one tenant only: the one named in `X-VDRkit-Tenant`, or the only tenant the address belongs to. For an address in several tenants with no header, nothing is logged. One organisation should not be able to see when its member signed in to another.

The mail server being down is the awkward case. The form then says "We could not send the email right now. Try again in a few minutes.", and that message must not depend on whether the address has an account. The API therefore checks the mail channel separately from any address. The first sign-in request after a minute without a check starts a background connect-and-login that sends nothing. While the last check is failing, every sign-in request gets 503 with code `EMAIL_NOT_SENT` before the address is looked at, and known and unknown addresses get the same answer in the same time. If the channel is healthy but a send to a known address fails, the user still sees "Check your email" and the event is logged as not sent.

Set `BETTER_AUTH_SECRET` (at least 32 random characters) in `.env`. `PUBLIC_URL` defaults to `https://SITE_ADDRESS`; set it as well if people reach VDRkit at another address. Outside `NODE_ENV=test` or `development` the API will not start without the secret, or with neither address. In development the header authenticator takes over only when `VDRKIT_DEV_AUTH=1` is set and `BETTER_AUTH_SECRET` is not.

### Request limits

Limits are counted per signed-in person, or per IP address for anonymous calls. Going over returns `429` as a problem document (`https://vdrkit.com/problems/rate-limited`) with `Retry-After`.

| Limit | Applies to | Default |
| --- | --- | --- |
| General | every signed-in call, per person | 600 a minute |
| Heavy | listing, page images, coverage, search, activity log and export, release preview, per person | 120 a minute |
| Upload | upload sessions (start, bytes, status, cancel, complete), per person | 3,000 a minute |
| Sign-in | `/v1/auth` sign-in paths and `/v1/public/*`, per IP address | 100 per 15 minutes |
| Sign-in email | requests for a sign-in link or code, per email address, known or not | 10 per 15 minutes |
| Setup code | `/v1/setup/unlock`, per IP address | 10 per 15 minutes |
| Anonymous | other calls without a valid caller, per IP address | 300 a minute |

The sign-in limit is set for an office: about 25 people can sign in from one IP address within 15 minutes. What stops someone requesting code after code for one account is the per-email limit. Better Auth's own per-path limits are raised to the same 100 per 15 minutes, so that they do not trip before ours. Uploads have their own limit because a bulk import makes three calls per file; the upload plan itself stays under General. `AppOptions.rateLimit` changes the limits and the route lists, and `rateLimit: false` turns them off in tests.

The counters live in Postgres, which is what makes the limits hold across every API instance on the same database. Better Auth's per-path limits share the table. The app role cannot touch the table directly and goes through a security-definer function. The table stores only a SHA-256 of each key (IP address or person) and times from the database clock. Each API instance clears expired windows at most every five minutes. `RATE_LIMIT_STORE=memory` keeps the counters in the process instead, which is only correct with a single instance.

`TRUST_PROXY` lists the proxies allowed to set `X-Forwarded-For`. The default trusts private networks only, which suits the bundled Caddy. The client address that results is what the audit trail records for every sign-in and failed attempt, and what the sign-in email shows. The API hands it to Better Auth in a header it sets itself (`x-vdrkit-client-ip`, stripped from incoming requests), never as `X-Forwarded-For` arrived. If you run behind a proxy on a public address, such as a cloud load balancer, add it to `TRUST_PROXY`, or every sign-in will show the proxy's address.


## Sign-in policy and sessions

Four room settings control sign-in. They are on the Sign-in tab of room settings, and each change is logged with the values before and after.

| Setting | Default | Allowed |
| --- | --- | --- |
| `requireTwoFactor` | `true` | |
| `allowTrustedBrowser` | `true` | |
| `trustedBrowserDays` | 30 | 1 to 90 |
| `idleSignOutMinutes` | 240 | 30, 60, 120, 240, 480 or 1440 |

A session belongs to a login, and a login may act as people in several tenants, so the API applies the strictest policy across every room the login's people belong to (active, current memberships in rooms that are not deleted). Two-factor is required if any room requires it, and the shortest idle time wins. The trusted-browser rule comes only from the rooms that require two-factor: a browser may be trusted only if all of them allow it, and for the fewest days any of them allows. If no room requires two-factor, all rooms count. Someone in no room gets the defaults. `GET /v1/me/sign-in-policy` returns the combined policy.

The policy is applied on every request with a session. While it requires two-factor, a login without an authenticator app gets `403` `two-factor-setup-required`; it can still read its policy and reach Better Auth's set-up routes, which the invitation screen needs, and turning the setting on takes effect on the next request. A session idle for longer than the policy allows is deleted and answered with `401` `signed-out-inactive`, and the sign-out is logged in the same transaction. Every authenticated request resets the idle clock, but no session lasts longer than 30 days from sign-in, however active it is. At that point it is deleted, the sign-out is logged as `auth.signed_out_expired`, and the request is answered with `401` `session-expired`.

Session tokens older than 15 minutes are replaced on the next request with a new cookie. The old token keeps working for 60 seconds, so requests already in flight do not fail.

We disable the Better Auth routes for turning two-factor off, reading the secret back, recovery codes, and codes by email or text message. The secret is shown once, in the set-up answer, and there are no recovery codes. Someone who loses their phone asks the room admin.

Trusted browsers use Better Auth's trust-device cookie. Better Auth renews the trust record on every use, which we do not want, so VDRkit keeps the end date fixed from when the browser was first trusted. At sign-in, a browser past the current policy's period, or one the policy no longer allows, is asked for the authenticator code again.

| Route | Answer | Event |
| --- | --- | --- |
| `GET /v1/me/sign-in-policy` | the policy, `rooms`, `twoFactorEnabled`, `twoFactorSetupRequired` | |
| `GET /v1/me/trusted-browsers` | `{ items: [{ id, browser, trustedAt, trustedUntil, lastUsedAt, thisBrowser }] }` | |
| `DELETE /v1/me/trusted-browsers/{id}` | 204 | `auth.trusted_browser_removed` |
| `POST /v1/me/sign-out-everywhere` | `{ sessionsEnded }` | `auth.signed_out_everywhere` |
| `POST /v1/me/two-factor/new-phone` | `{ totpURI, expiresAt }` | |
| `POST /v1/me/two-factor/new-phone/confirm` | `{ movedAt }` | `auth.two_factor_moved` |
| `POST /v1/workspaces/{ws}/people/{personId}/reset-two-factor` | `{ personId, hadTwoFactor, sessionsEnded, trustedBrowsersRemoved }` | `auth.two_factor_reset` |

Signing out everywhere keeps the current session. The new-phone URI is valid for 10 minutes. Confirming takes `{ oldCode, newCode }`, and five wrong codes, including wrong codes from the old phone, end the attempt.

Only room admins can reset someone's two-factor, and only for people with an active, current membership of that room; anyone else gets `404`. If the same login also opens another organisation's rooms, the reset answers `409` `two-factor-reset-elsewhere` and changes nothing. A reset is logged once for each room of the tenant the person is in.

All of this needs Better Auth. Register `sessionRoutes(auth)` next to `betterAuthRoutes`, as `main.ts` does. The development header authenticator enforces none of it.


## Record time from the database clock

In a data room, who knew what and when can end up in front of a lawyer, so record time is set by the database and never by the API. A server with a wrong clock, or a bug, cannot backdate anything.

Triggers set `recorded_at` on grants and memberships and `created_at` on document versions, whatever the app sends, and closing a row (`superseded_at`) uses database time as well. Neither column can be changed afterwards, by the app or by the owner. NDA publication and acceptance, and releasing and withdrawing versions, work the same way.

State tables use the transaction timestamp. An "as known at" query therefore sees a whole transaction or none of it, and a superseded row ends exactly when its replacement starts.

Events go through `append_event()`, a security-definer function and the only way to write to the event table. It locks the head of the chain, takes the time itself (never earlier than the previous link) and computes the hash inside the database, so time order and chain order always agree. It refuses a workspace from another tenant and reads only the current tenant's chain. The app role can read the chain heads and the sequence counter but not change them.

What the chain catches is an entry edited or removed without the hashes after it being recomputed. It does not protect against someone with owner access to the database, who can rewrite events and recompute every hash.

Valid time (`valid_from`, `valid_to`) is the exception and comes from the app, because admins may set those dates.

Present-time queries compare record times with the database clock rather than the API's, so a change made a moment ago is never hidden because the API's clock is behind. A query with an explicit `at`, like `GET .../grants?at=`, uses that moment instead. The clock functions and triggers pin their search path and call each other by schema, so nothing in another schema can shadow them.

Tests pin the clock by replacing `db_clock_pin()` as the owner or a superuser. The app role cannot replace it.

## The folder tree keeps its history

Moves, renames, renumbering, state changes and deletes are all kept, so "the room as it stood on date X" shows the tree as it was on that date. A trigger on `node` writes the history, which means no code path can skip it. The app role can only read the history, and the owner can only close a row once.

`GET .../grants?at=` returns the tree as it was alongside the grants, and the activity export names each document as it was called at the time of the event. Permission checks only look at the history when the tree has changed since the moment in question.

## Renumbering keeps old numbers working

When a published item gets a new index number, the old number keeps working. `GET .../numbers/{number}` returns the item that has that number now, or else the item that last had it, and search shows "was 2.4.7". Drafts are not tracked, since nobody outside the seller side has seen their numbers. A number that belonged to a removed draft is never reused.

Renumbered items carry a tag for three days after each person's first visit following the change. To change it for one room, as the database owner: `update workspace set renumbered_tag_days = 5 where id = '...'` (0 to 365).


## Large files, storage and processing

Files can be up to 5 GB, and an installation cannot change that. The front end checks the same limit in `apps/dataroom/src/components/documents/limits.ts` before an upload starts. The API reads `UPLOAD_MAX_BYTES` only so that tests can lower it, and `docker-compose.yml` does not pass it. No step holds a whole file in memory.

### Upload

On S3 the browser sends 8 MiB parts (larger for files over 78 GiB) straight to presigned URLs, with each part's length included in the signature. On the local driver it PUTs the file to `.../upload-sessions/{id}/content`, which streams it to quarantine and refuses more or fewer bytes than were declared. The upload route accepts only `application/octet-stream` and rejects anything else before reading the body, so no other body parser gets the chance to buffer gigabytes.

On completion the quarantine copy is streamed through SHA-256 and the room key's encryption into storage, outside any transaction, and a second, short transaction places the draft. Retrying a completion after the parts were joined is safe.

`GET .../upload-sessions/{id}` reports the state. For an open S3 upload it lists the parts the store already holds and signs fresh URLs for the rest; bulk import uses this to resend only what is missing. `DELETE` aborts the upload.

Every hour the worker sweeps for uploads more than an hour past their expiry (24 hours after they started), whatever the driver. It deletes the unencrypted quarantine copy, aborts any unfinished multipart upload and marks the session expired in the audit trail. On S3 the bucket lifecycle also aborts multipart uploads left for more than a day.

### Download

Originals (level 60) stream, decrypting only the chunks needed, and support `Range` and `If-Range`, so downloads can resume. Every request is logged, ranges included with their byte range. The stamped PDF (level 50) and page images are built in memory from the preview, which large files do not have.

### Processing

Files over 512 MiB get no preview, no pages and no search text, because conversion and rendering need the whole file in memory. They download as they are, like archives. The 512 MiB limit is sized to the worker's 3 GB memory ceiling and is fixed in an installation: the worker reads `PREVIEW_MAX_BYTES` only in tests, and `docker-compose.yml` does not pass it. Images (JPEG, PNG, GIF, TIFF, BMP) become a one-page PDF without going through LibreOffice and are viewed as a watermarked page. Types with no converter, a ZIP or a 3D model for example, are published with "No preview", and only people allowed to download originals (level 60) can get them.

A worker processing a version checks in every 30 seconds. If it goes quiet for five minutes, the worker is presumed gone and the version is started again, at most twice. A version gets up to two hours in all before it is marked failed with a plain reason. If the converter or the virus scanner cannot be reached, the version waits and is retried every two minutes for an hour before that counts as a failure. A room admin, or anyone who may add files or publish where the document is, can process a failed version again from its details page without a new upload.

### Virus scan

With `CLAMAV_HOST` (and `CLAMAV_PORT`, default 3310) set, the worker streams each original to clamd before conversion. A file with a virus fails, showing the signature name, and stays locked: open and download answer 409 `virus_found`, for room admins as well. Until the scan has run, downloading the original answers 409 `virus_check_pending`, or 409 `virus_check_missing` if the worker gave up because the scanner was down through every retry. Page images and the watermarked PDF are only produced after the scan.

Every file up to 1 GB is scanned, whatever its type; `CLAMAV_MAX_BYTES` defaults to 1 GiB. The `clamav` service in `docker-compose.yml` sets `StreamMaxLength` and `MaxFileSize` to 1024M, `MaxScanSize` to 2048M, `PCREMaxFileSize` to 1024M and `MaxScanTime` to 10 minutes, with a 3g memory ceiling (`CLAMAV_MEMORY_LIMIT`). clamd peaks at a little over 2 GiB on a file near the limit. Larger files are not sent and are recorded as too large to scan. The worker waits up to 10 minutes for a verdict, because clamd says nothing between the last byte and its answer.

Without a scanner, or for a file over the limit, a file counts as scanned and the Health tab shows a warning.

A scanner or converter that does not answer is treated as a service problem: the job fails and pg-boss retries it. The file is only marked failed after the last retry.

### File types

Gotenberg will cheerfully turn random bytes named .xlsx into pages of garbage text, so we check the content against the extension before conversion:

| Type | Accepted content |
| --- | --- |
| Office Open XML | a ZIP whose `[Content_Types].xml` names the right Word, Excel or PowerPoint part, or an OLE file with `EncryptedPackage` |
| .doc, .xls, .ppt | an OLE file with the program's own stream, or HTML, XML, RTF or the newer format |
| OpenDocument | the right mimetype |
| text | no NUL byte |
| PDF | starts with `%PDF-` |

A mismatch fails at the convert step and asks the uploader to save the file again. A truncated ZIP still goes to the converter, which reports it as damaged. Gotenberg's message for a damaged file mentions passwords, which confuses people, so VDRkit just reports it as damaged. If Gotenberg is down, the job is retried.

### S3 bucket setup

`scripts/s3-bucket-setup.sh` sets the bucket's CORS and lifecycle rules. CORS allows PUT from `PUBLIC_URL` only and exposes `ETag`, which the browser needs to finish an upload. Downloads go through the API, so there is no GET rule. The lifecycle deletes objects under `quarantine/` after `QUARANTINE_DAYS` (default 1) and their old versions after a day, aborts multipart uploads after a day, and leaves `ws/...`, the encrypted room files, alone. The old-versions rule matters on a versioned bucket, where a delete only hides the unencrypted upload. If the store refuses that rule, or accepts it but does not keep it, the script carries on when the bucket is not versioned and stops when it is. The script uses `aws` if you have it and the `amazon/aws-cli` Docker image if not. `CREATE_BUCKET=1` creates the bucket. Running it again replaces both settings.

```
S3_BUCKET=vdrkit PUBLIC_URL=https://dataroom.example.com S3_ACCESS_KEY_ID=... S3_SECRET_ACCESS_KEY=... sh scripts/s3-bucket-setup.sh
# Cloudflare R2: add S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com S3_REGION=auto
# Garage: add S3_ENDPOINT=https://s3.example.com S3_REGION=garage (the s3_region in garage.toml)
```

Garage has no versioning and drops the old-versions rule without an error. It applies lifecycle rules once a day, at midnight UTC.

MinIO is more particular. It accepts neither bucket CORS nor the abort rule, and the script then sets only the quarantine rule. On MinIO, set `MINIO_API_CORS_ALLOW_ORIGIN` to `PUBLIC_URL` on the server; MinIO removes stale multipart uploads itself after `MINIO_API_STALE_UPLOADS_EXPIRY` (24 hours). To add the quarantine rule with `mc`: `mc ilm rule add --prefix quarantine/ --expire-days 1 --noncurrent-expire-days 1 <alias>/<bucket>`.

### Testing against real services

The real-services test runs the pipeline against a real Gotenberg and ClamAV, and the S3 driver against a real store. It is skipped unless you point it at them:

```
GOTENBERG_URL=http://127.0.0.1:4104 CLAMAV_HOST=127.0.0.1 CLAMAV_PORT=4105 \
S3_TEST_ENDPOINT=http://127.0.0.1:4103 S3_TEST_REGION=garage S3_TEST_BUCKET=vdrkit-test S3_TEST_ACCESS_KEY_ID=... S3_TEST_SECRET_ACCESS_KEY=... \
S3_TEST_CORS_ORIGIN=http://127.0.0.1:4100 npx vitest run test/real-services.test.ts
```


## Worker and job queue

The worker processes uploads and sends due notifications, using pg-boss. Start it with `node dist/main.js worker`, which first applies pending migrations when `MIGRATION_DATABASE_URL` is set. `node dist/worker-main.js` and `corepack pnpm@9.15.4 --filter @vdrkit/server worker` work as well. Both make the same start-up checks of the database role and the migrations, but neither applies migrations.

| Queue | Job | Schedule and retries |
| --- | --- | --- |
| `process-version` | process one uploaded version | one job per version at a time; 4 retries, backoff from 30 s |
| `process-version-dead` | mark a version failed after its last retry | |
| `send-due-notifications` | send what is due for one tenant | every minute (`NOTIFY_CRON`), one job per tenant |
| `purge-failed-sign-ins` | remove personal data from failed sign-ins older than 30 days | daily at 03:17 UTC (`PURGE_CRON`), 3 retries |

Problems with the file itself, such as password protection or a wrong hash, are final and are not retried. A version that fails every retry is marked failed with a plain reason, which the uploader sees, the admin dashboard shows and the audit trail records. If it reached `ready` in the meantime, it is left alone.

The purge job runs a security-definer function that works across tenants but only deletes the address, IP address and browser stored with failed sign-in events. The events themselves stay, with the reason and method, and the hash chain still verifies.

### Tenant context inside jobs

The worker connects as `vdrkit_app`, so row-level security hides every row until a tenant is set. Every job payload carries `tenantId`, the queue refuses jobs without one, and each handler runs inside `withTenant(db, tenantId, ...)`, one transaction per unit of work. The only cross-tenant read is the list of tenants with notifications due. It comes from a security-definer function with a pinned search path that only `vdrkit_app` may call, and it returns tenant ids and nothing else. `WORKER_TENANT_IDS` overrides it.

pg-boss keeps its schema `pgboss` on `QUEUE_DATABASE_URL` under its own role, which needs `CREATE` on the database the first time, and it owns the schema it creates. It must never run as `vdrkit_app`. The reason is that `vdrkit_app` must never hold `CREATE` anywhere: a schema it owned could hold a function that shadows one VDRkit calls. Outside development the server warns when `QUEUE_DATABASE_URL` is missing or equals `DATABASE_URL`.

`GOTENBERG_URL` points the worker at Gotenberg. Compose sets it to `http://gotenberg:3000` and puts the worker on Gotenberg's internal network.


## Outgoing email

Invitations, sign-in emails and notifications all leave through one SMTP channel, built on nodemailer and shared by the API and the worker. Without the settings below nothing is sent, and each email is recorded in the audit trail as not sent.

| Setting | Meaning |
| --- | --- |
| `SMTP_HOST` | the mail server |
| `SMTP_PORT` | default 587 |
| `SMTP_SECURE` | `starttls` (default) or `tls` |
| `SMTP_USER`, `SMTP_PASSWORD` | login, if the server asks for one |
| `MAIL_FROM` | the sender, e.g. `"Project data room <dataroom@example.com>"`; required once a server is set |
| `SMTP_URL` | instead of the five server settings: `smtp://user:password@host:587`, or `smtps://` for port 465 |

With `starttls` the connection must upgrade to TLS or nothing is sent. `tls` means TLS from the first byte, usually on port 465. Either way, TLS 1.2 or later is required. nodemailer is not allowed to read files or fetch URLs.

Sign-in codes travel in the subject line, so we keep nodemailer's protocol log off and never log subjects or bodies. A failed send is logged with the person id and the reason, with the password and message text removed. Notifications are not retried. The start-up log names the server, port and TLS mode, but not the login.

For a manual test, put the settings in `.env` in the repository root, which git ignores. Please never put a real password in `.env.example`.
