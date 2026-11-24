# The public sandbox

The sandbox at <https://demo.vdrkit.com> runs VDRkit with an invented sale, Project Heron, that anyone can try without signing in. Visitors pick one of the demo people on the Try VDRkit page and enter the data room as that person. Everything is wiped and reloaded every day at 03:00 UTC.

It's the normal VDRkit image with `VDRKIT_SANDBOX=1`. Never point it at a real installation's database or files: give it its own server, `.env`, database and volumes. It refuses to start against a real installation's database, but please don't make it prove that.

## What visitors can do

Anyone without a session lands on `/try`. That page says the data is invented and shared with everyone, asks people not to upload anything confidential or personal, and lists the demo people by role. There's no email sign-in.

Picking a person creates a real Better Auth session and opens the Project Heron dashboard. The demo rooms have two-factor sign-in turned off, so there's no code to enter. Switching person ends the previous session. A bar at the top of every page shows the reset time and links back to `/try`.

No email is ever sent. Invitations and notifications are recorded as not sent, and people can only be invited at example.com, example.net, example.org, or a domain ending in `.example`, `.test` or `.invalid`.

Uploads are scanned as usual and limited to 20 MB a file, 25 files per IP address per day, and 300 for all visitors between resets. The limits are constants in `apps/server/src/sandbox/config.ts` if you want different ones.

Most things work normally, and whatever one visitor changes, the next one sees until the reset. The exceptions are the things that would spoil the sandbox for everyone after them. The API refuses site settings, disabling or enabling accounts, changing email addresses, resetting two-factor sign-in, "Sign out everywhere" and moving the authenticator app to a new phone. In a room, it refuses changes to the sign-in settings, the room's state and its logo, and any revoking, ending or demoting of a demo person's access or that of a group they're in. It also refuses to create rooms: a new room requires two-factor sign-in, and since the strictest room wins, that would lock the demo person out for every later visitor. All of these come back as a 403 with reason `sandbox_refused`.

## Project Heron

The sandbox loads a smaller Project Heron than the development stack does: the same story and people, but 305 published documents instead of 1,248, and every one of them opens. Counting drafts there are 334, across eleven folders from 1 Corporate to 11 Data protection. Bidder A sees all of them; B and C miss a few (Insurance, for one), and Bidder C's financiers see only 3 Finance. The full plan, folder by folder, is in `apps/server/src/sandbox/room/catalogue.ts`.

Access follows the demo: 2.4 Material contracts and 3.2 Audited financials have their own grants, Bidder A has the print level and Bidders B and C can view. Until printing arrives in release 2, Bidder A's print level works as view. Three documents have a version 2 waiting in Release review and three more have one already released.

The documents are generated from templates that suit their folder and name, plus the demo's own contracts and financial statements. Most are PDFs; the rest are Word, Excel and PowerPoint files that go through Office conversion like any upload. All names are invented, and the only email addresses in the text end in `.example`. Generation is seeded, so every reset produces the same bytes.

Search covers every page. Try `"consents tracker for the sale"`, which finds the facility agreements in 3.5 Treasury.

The other rooms match the demo. Osprey, Falcon and Weaver have documents that open; the rest are empty.

## Running it

```sh
docker compose -f docker-compose.yml -f docker-compose.sandbox.yml up -d
```

Set up `.env` as for any installation ([install.md](install.md)), with a few differences. Leave out the mail settings (`SMTP_*` and `MAIL_FROM`) or leave them empty, keep `STORAGE_DRIVER` at `local`, leave `VDRKIT_DEMO_EMAIL_DOMAINS` empty, and set `COMPOSE_PROFILES=postgres,clamav`. The override sets `VDRKIT_SANDBOX=1` on api, worker and web for you. `SANDBOX_CACHE_DIR` is optional and defaults to `.sandbox-cache` in the files volume.

The start is strict about this. Any mail setting stops it, and so does any value of `VDRKIT_SANDBOX` other than `1`, `0` or empty. S3 isn't supported, because the reset empties the files volume but never a bucket.

The override adds two services. `sandbox-init` runs once after `migrate`, once Gotenberg is up, and the API and worker wait for it. On an empty database it loads the room and writes the sandbox marker; on a current sandbox it does nothing.

`sandbox-scheduler` runs the reset at 03:00 UTC. A failed reset is tried again after 15 minutes, up to three more times, unless it failed because it refused the database or the folder. It also refuses to run if the owner's and the application's database URLs reach different databases. It needs the database owner's password, which a normal installation only gives to `migrate`. If you'd rather not hand that out, start without it (`docker compose ... up -d --scale sandbox-scheduler=0`) and use the host's cron:

```cron
0 3 * * *  cd /srv/vdrkit && docker compose -f docker-compose.yml -f docker-compose.sandbox.yml run --rm sandbox-init sandbox-reset
```

To reset by hand:

```sh
docker compose -f docker-compose.yml -f docker-compose.sandbox.yml run --rm sandbox-init sandbox-reset
```

The reset empties every table except the migration ledger, and the files volume except the cache. It then loads the rooms, copies the processed files in from the cache and adds a week of bidder reading so the dashboard and Activity have something to show. Visitors are signed out. Room data keys survive the reset, and an API or worker that still holds one keeps working.

Dates move with the reset day, in whole weeks, keeping the day one to seven days after the story's Thursday ([development.md](development.md#the-demo-data)). Q&A round 1 is always still ahead and a Friday deadline stays on a Friday. Dates inside the documents don't move.

### The cache

Rendering every page takes minutes of CPU, so the reset keeps the processed files in a cache of about 60 MB, in `.sandbox-cache` in the files volume or in `SANDBOX_CACHE_DIR`. The files are encrypted with each room's data key, and a manifest records what the worker would have written to the database. The reset won't use a non-empty folder that lacks a `.vdrkit-sandbox-cache` file.

Building the cache runs the worker's own steps, ClamAV and Gotenberg included. If Gotenberg doesn't answer, a generated PDF stands in for each Office file and the log says so. Visitors keep the old room while it builds.

It's rebuilt when the room plan changes, when a room's data key changes, when a file is missing, or when `CONTENT_VERSION` in `apps/server/src/sandbox/room/cache.ts` goes up. If you change a generator, raise that number. To force a rebuild, delete the folder.

If the database is lost but `VDRKIT_MASTER_KEY` still opens the cached keys, the rooms take those keys back and the cache is reused.

A cold start takes about a minute on a development PC and probably 7 to 10 minutes on a 4-core ARM server. A reset with the cache takes a few seconds.

### Without Docker

```sh
corepack pnpm@9.15.4 --filter @vdrkit/server dev:sandbox -- --reset
```

That runs the API on PGlite on port 3141, keeping its cache and master key in `apps/server/.dev-db-sandbox-cache` (`--reset` leaves them alone). Then, in `apps/dataroom`, run `VDRKIT_SANDBOX=1 API_PORT=3141 PORT=3140 NEXT_DIST_DIR=.next-sandbox node scripts/next.mjs dev` and open <http://127.0.0.1:3140/try>.

## How it stays out of real installations

The sandbox code ships in every copy of VDRkit, which is why we've been careful about how it gets switched on. It takes two things: `VDRKIT_SANDBOX=1`, and a row in the `sandbox_instance` table. Only the sandbox reset writes that row, connected as the database owner. The `vdrkit_app` role used by the API and worker can read it but not write it.

With the flag set, the API and worker check the database before they start. There must be no mail settings, the demo domains must be unchanged and storage must be local. The marker has to exist for the demo tenant, the site has to belong to that tenant, and there can't be any other tenant. Every person and login must have an invented address. If any of that fails they stop and say why, for example *"VDRKIT_SANDBOX=1, but this database is not a sandbox: it carries no sandbox marker"*. A real installation always fails: it has no marker, its site was set up for a real organisation, and its people have real addresses. While the marker exists, a database trigger also rejects any person or login with a real address (SQLSTATE `VS001`).

The marker without the flag gives a normal installation and a warning in the log.

`sandbox-init` and `sandbox-reset` need the flag too. They only touch an empty database (no tenant, login or site) or one that passes the start check, and a files folder that's empty or carries the reset's own `.vdrkit-sandbox` file. They won't use the root of a file system.

Without sandbox mode the sandbox plugin isn't loaded at all: `GET /v1/sandbox` and `POST /v1/sandbox/sign-in` return 404, and nothing is refused. The web app shows `/try` and the bar only when it has `VDRKIT_SANDBOX=1` and the API answers `GET /v1/sandbox`. One image serves both cases.

### Sign-in

`POST /v1/sandbox/sign-in {"person": "jan"}` takes only the keys of the demo people: `anika`, `johan`, `maria`, `liesl`, `jan`, `pieter`, `mei`, `sipho` and `lars`. Anything else, a person id included, gets a 400. The request passes the usual Origin check and returns a normal Better Auth session cookie, HttpOnly and signed with `BETTER_AUTH_SECRET`. The session row stores no IP address or browser, and sandbox sign-ins don't go into the audit trail.

The other Better Auth routes are cut down to reading the session and signing out. Email sign-in and two-factor set-up return 404. The development persona pill stays out of production builds, and the security headers are the same as in any installation.

## Living with a public demo

A sandbox anyone can use is messy by design. Visitors see each other's uploads and edits until the reset, and there's no way to check what someone has uploaded. Someone will rename documents, remove grants or withdraw things; if it bothers you, sign in as the room admin and put most of it right, or wait for 03:00.

The per-visitor upload count is kept per IP address in the API's memory, so it starts again when the API restarts and visitors behind one address share it. The overall count is in the database.

The API's request log holds IP addresses, as in any installation. Keep its retention short, and keep the reset daily.

## Tests

`apps/server/test/sandbox.test.ts` and `apps/server/test/sandbox-room.test.ts` run with the server tests. The browser tests start their own servers:

```sh
corepack pnpm@9.15.4 --filter @vdrkit/dataroom exec playwright test -c playwright.sandbox.config.ts
```
