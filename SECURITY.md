# Security policy

VDRkit holds confidential deal documents, and we want to hear about any security problem you find in it.

## Supported versions

| Version | Supported |
| --- | --- |
| The latest release | Yes |
| Any earlier release | No, upgrade to the latest release |

Security fixes ship in a new release only. Earlier releases do not get them, so upgrade when a new version comes out.

## Reporting a vulnerability

Do not open a public issue, discussion or pull request for a security problem. Report it privately instead, either through GitHub's private vulnerability reporting (preferred: open the [Security tab](https://github.com/vdrkit/vdrkit/security/advisories/new) and choose "Report a vulnerability", which only the maintainers can see) or by email to `security@vdrkit.com`.

Please write in English. If you are not sure whether something is a security problem, report it privately anyway; we would much rather read a report that turns out to be harmless than miss one that is not.

A useful report tells us the VDRkit version (shown in Site settings, and set as `VDRKIT_TAG` in `.env`) and how it is installed. Describe what an attacker can do and what access they need, and give steps to reproduce. If you can, reproduce it against the demo data from `dev:stack`, which [CONTRIBUTING.md](CONTRIBUTING.md) explains how to run. A proof of concept helps. Let us know if you have told anyone else or plan to publish on a particular date.

Do not send real deal documents, real personal data or working credentials. If the report needs a file, make a harmless one.

## What happens next

We reply within 7 days and give our assessment, with severity and a plan, within 21 days. Within 90 days of the report, unless we agree otherwise with you, we release a fix and publish an advisory, or disclose the problem. If it is being exploited in the wild we may publish sooner.

We will keep you informed while we work on the fix. When it ships, we publish a GitHub security advisory that credits you, unless you would prefer not to be named. We do not pay bug bounties at present.

## Scope

This policy covers the code in this repository, the production image built from the `Dockerfile`, and `docker-compose.yml`, `Caddyfile` and `.env.example` as shipped, together with the instructions in [docs/install.md](docs/install.md).

It does not cover third-party software and services that VDRkit uses, such as Neon, S3 providers, Garage, Gotenberg, ClamAV, Caddy, Postgres or a mail provider. Report those to their own projects, and tell us as well if VDRkit uses them unsafely.

Also out of scope:

- Weaknesses in how a particular server was set up, for example leaked secrets, a database role with `BYPASSRLS`, disabled TLS, open ports or settings that depart from the install guide.
- Screenshots or photos of documents a person is allowed to view.
- Scanner output and missing best-practice headers with no demonstrated attack.
- Denial of service by traffic volume, social engineering and physical attacks.

## Safe harbour

We will not take legal action against you, or ask anyone else to, for security research that follows this policy. That means you:

- test only against your own installation, or one whose owner has given you permission;
- avoid harm: do not access other people's data beyond what is needed to show the problem, do not change or delete data, and do not degrade the service for others;
- stop and report as soon as you have shown the problem, and delete any data you obtained;
- keep the problem confidential until we have released a fix or the disclosure period has ended.

If you are unsure whether something is allowed, ask us first through one of the private channels above. This promise covers only the VDRkit project. It cannot bind other owners of VDRkit installations or third-party services.

## Security design

Postgres row-level security is forced on every tenant table, and the API, the worker and the migrations refuse to start under a superuser or a role with `BYPASSRLS`. [docs/architecture.md](docs/architecture.md#database-roles) explains the database roles. Every permission decision goes through one central function. A document a person may not see answers exactly as if it did not exist.

Each action is written in the same transaction as its audit entry. The audit log is append-only and hash-chained, with times taken from the database clock.

There are no passwords. People sign in with an emailed link or code, and an authenticator app is required by default. One sign-in serves all of a person's rooms, so a room admin can change someone's sign-in email or reset their two-factor sign-in only if that person is in no room the admin does not run. For anyone else, it takes a site admin. A new sign-in email takes effect only once the code sent to it is entered, and when a room admin asks for someone who has signed in before, that person must first agree from their current address. Sign-in is limited to 100 requests per 15 minutes per IP address, enough for about 25 people in one office, and to 10 requests for a link or code per 15 minutes per email address, whether or not the address has an account. Other requests are rate-limited per person and per IP address across all API instances.

Stored files are encrypted with a key per room. Room keys are wrapped by a master key that is kept out of the backups. When ClamAV is configured, files up to 1 GB are scanned before they are converted or shown, and an infected file is locked for everyone. Office files and PDFs are checked against their actual content, and uploaded SVG logos are converted to PNG.

Document pages are rendered on the server with the reader's watermark, and every view and download is logged. The hash chain records each page a person sees, once per viewing session, and a SHA-256 digest of the watermark stamped on each page and PDF. The readable watermark text stays outside the chain so that it can be erased with the person's other personal data.

The code has been through several internal security reviews, and every finding has a regression test. We have not yet had an external penetration test, and we would welcome one. If you would like to test VDRkit, write to `security@vdrkit.com` and we will give you accounts on a test server set up for this.

### Security headers

The screens (Next.js) and the API set their own headers rather than relying on the reverse proxy. Caddy adds `Strict-Transport-Security: max-age=31536000; includeSubDomains` and otherwise only fills in headers that an answer lacks. The header code is in `apps/dataroom/src/lib/security-headers.ts`, `apps/dataroom/src/proxy.ts` and `apps/server/src/app.ts`. The tests are `apps/server/test/security-headers.test.ts`, `apps/server/test/origin-check.test.ts` and `apps/dataroom/e2e/production-build.spec.ts`, and every other end-to-end test fails on any CSP violation in its pages.

Every page in production carries this Content-Security-Policy, where `N` is a new random nonce for each answer:

```
default-src 'self'; script-src 'self' 'nonce-N' 'sha256-<theme script>'; style-src 'self' 'nonce-N';
style-src-attr 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' [S3 store];
media-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; manifest-src 'self'; base-uri 'self';
form-action 'self'; frame-ancestors 'none'
```

Scripts are never allowed `'unsafe-inline'` or `'unsafe-eval'`. Next.js puts the nonce on its own inline scripts. VDRkit adds one inline script of its own, to apply the stored theme before the first paint, and it is allowed by its hash. Inline `style` attributes are allowed because React writes them; they cannot run script or load anything. The two-factor QR code is a `data:` image, and page images and logo previews use `blob:`.

With `STORAGE_DRIVER=s3` the browser uploads directly to the S3 store, and `connect-src` includes it. The web container derives that address from `S3_ENDPOINT`, `S3_BUCKET`, `S3_REGION` and `S3_FORCE_PATH_STYLE`. `CSP_CONNECT_SRC` adds further origins.

Every page is rendered per request, since a page prerendered at build time could not carry the nonce. In development, `next dev` also allows `'unsafe-eval'` and inline styles for its own tooling; production builds do not.

The screens also send `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-origin`, `X-Frame-Options: DENY` and a `Permissions-Policy` that turns off camera, microphone, location, payment, USB, serial, HID, Bluetooth, MIDI, motion sensors, screen capture and Topics.

The API sends `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'` (logos keep their own sandboxing policy), `nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY` and `Cross-Origin-Resource-Policy: same-origin`.

### The Origin check

`apps/server/src/origin-check.ts` checks every POST, PUT, PATCH and DELETE under `/v1`:

1. An `Origin` header must match the origin of `PUBLIC_URL`. Anything else, `null` included, gets 403 `application/problem+json` with the reason `cross_site_request`.
2. Without `Origin`, the `Referer` header's origin must match `PUBLIC_URL`.
3. Without either header, the request is accepted only if it carries no VDRkit cookie.

Browsers always send `Origin` on these methods. The one caller that sends cookies without either header is the screens' own server rendering. It marks its requests with `x-vdrkit-render: server`, a header a browser cannot add to a cross-site request without a CORS preflight, and the API never grants one. The same header stops the session cookie being renewed during a render. The screens reach the API on the internal network, and Caddy removes the header from every request it passes to the API, so a client cannot send it to keep its session token from rotating.

GET and HEAD are not checked. There are no exemptions and no webhooks. Better Auth runs its own origin check on `/v1/auth` as well. In development, `dev:pglite` also trusts the origins in `VDRKIT_DEV_ORIGINS`.

### What the design does not cover

No browser can stop someone taking a screenshot or a photo of the screen. What the watermark does is make a leaked page traceable to the person who viewed it.

A room admin can use "See the room as" to check what a team sees. Documents read that way leave no record per document: the room's activity gets one `room.seen_as` entry per team, at most once every 30 minutes. We accept this because see-as is open only to room admins, who can read everything in the room anyway, and it is read-only: it cannot download, export or change anything.

A site admin can point the outgoing mail settings, and the test email, at any host and port, internal addresses included, so the test email can tell a site admin whether a port is open on the server's own network. Site admins already control the installation's configuration, so we accept this. Keep site-admin accounts few, and protected by two-factor sign-in.

Office and HTML files are converted to PDF by LibreOffice, inside Gotenberg, and a document can ask for remote resources while it is converted. `docker-compose.yml` puts Gotenberg on a Docker network marked `internal: true`, with no route out to the internet or to a cloud metadata address. That network setting is a security control: if you move Gotenberg onto a network with outside access, an uploaded document can make your server fetch internal or external addresses.

Site admins run the installation but see no room content. A site admin can join a room as room admin only by giving a reason, which is logged in the room's activity and emailed to the room's other admins. The application cannot change or delete audit entries, but the database owner could rewrite the audit chain, hashes included, and the check would still pass. More generally, the application cannot protect against the operator of the server. Anyone with root access, or with database-owner access and the master key, can read everything, so choose who runs your server with that in mind.
