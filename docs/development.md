# The development stack

`pnpm dev:stack` runs the front end and the API on your machine. You need Node 22 or later and pnpm 9.15.4 through Corepack, and that's it: no Docker, no database server. The API runs Postgres in-process with PGlite (Postgres compiled to WebAssembly), and so do the tests.

```sh
git clone https://github.com/vdrkit/vdrkit.git
cd vdrkit
corepack pnpm@9.15.4 install
corepack pnpm@9.15.4 dev:stack                                  # Next.js on 3100, the API on 3101
corepack pnpm@9.15.4 dev:stack -- --port 3200 --api-port 3201   # a second worktree beside the first
corepack pnpm@9.15.4 dev:stack -- --reset                       # reload the demo data
corepack pnpm@9.15.4 dev:stack -- --sign-in                     # real sign-in instead of the persona pill
corepack pnpm@9.15.4 dev:stack -- --sign-in --empty --reset     # an empty installation: first-run setup at /setup
corepack pnpm@9.15.4 dev:stack -- --no-real-mail                # never send real email, whatever .env says
corepack pnpm@9.15.4 dev:stack -- --no-converter                # no Gotenberg, whatever GOTENBERG_URL says
```

Open <http://127.0.0.1:3100/>. You'll land on the Project Heron dashboard as whoever is picked in the persona pill at the bottom right. Ctrl C stops both servers. With `--sign-in`, the emailed codes show up in the API's log.

Comments and tests refer to screens by short codes; [screens.md](screens.md) has the list. Running the tests is covered in [testing.md](testing.md).

## How it works

The API keeps its PGlite database in `apps/server/.dev-db`, which git ignores. `--reset` deletes it, and `VDRKIT_DEV_DIR` puts it somewhere else. On start it runs every migration and loads the demo data if it isn't there yet.

We've tried to keep the dev stack honest. Requests run as `vdrkit_app`, so row-level security applies just as in production, and files are stored encrypted under a master key created on first start. Uploads are processed in the same process straight away, and notifications go out every minute. Request limits are off, and it refuses to start with `NODE_ENV=production`.

Some demo documents have real pages: the contracts in 2.4 and the financials in 3.2.1 to 3.2.6 are generated PDFs that go through the real pipeline: about 200 pages, ready about 20 seconds after a fresh start. `VDRKIT_DEV_FULL_PAGES=1` makes them longer. 3.2.7 stays "processing" on purpose, so there's always one to look at.

In development, Next.js forwards `/v1/*` to the API. With the persona pill it adds dev headers for the chosen person; with `--sign-in` it passes the browser's cookies through, as Caddy does in production. The pill and the dev headers only exist under `next dev` with `VDRKIT_DEV_AUTH=1`, which `dev:stack` sets for you. A production build contains neither.

Every email is written to the API's log, and the last ten per address can be fetched from `GET /v1/dev/mailbox?to=`.

With `--empty` there's no data at all. The first-run setup code is printed, and you can also get it from `GET /v1/dev/setup-code`. Finishing setup closes it for good, so give an empty installation its own `VDRKIT_DEV_DIR` and use `--reset` when you want to go through it again.

`dev:sandbox` runs the public sandbox ([sandbox.md](sandbox.md)) on port 3141, with real sessions and no email. Run the front end beside it with `VDRKIT_SANDBOX=1` and open `/try`.

## The demo data

The demo is Project Heron, a sale run by Drosvelt Holdings with Anika Pillay of Quillmont Advisory as room admin, three bidders, and financiers backing Bidder C. The room holds over a thousand published documents and a few hundred drafts. Ids and generated names are fixed, so every load gives the same room and tests can refer to things by id. The seed writes through the same SQL as the API, so row-level security applies to it too.

To load it into your own Postgres:

```sh
corepack pnpm@9.15.4 --filter @vdrkit/core build
DATABASE_URL=postgres://... corepack pnpm@9.15.4 --filter @vdrkit/server seed:demo
```

It uses tenant `de300000-0000-4000-8000-000000000001` (override with `DEMO_TENANT_ID`) and does nothing if that tenant already has a room.

### Dates

The story is set around Thursday 12 November 2026. The room opened nine days earlier, Q&A round 1 closes eight days later at 17:00 SAST, non-binding offers are due a week after that, and binding offers on Friday 12 February 2027.

A data room whose deadlines all passed last year isn't much use for testing, so the seed moves every one of these dates forward by whole weeks, until the story's Thursday falls between one and seven days ago (Johannesburg time). Weekdays stay the same and Q&A round 1 is always still open. Load the demo on Monday 1 March 2027, for example, and the story's Thursday becomes 25 February, with Q&A round 1 closing on Friday 5 March. Dates printed inside the generated PDFs don't move.

`VDRKIT_DEMO_TODAY=YYYY-MM-DD` loads the room as if on another day. A loaded room keeps its dates, so if your dev database has been around for a while, run `dev:stack -- --reset`.

Playwright fixes `VDRKIT_DEMO_TODAY` once per run. In specs, work out the shifted dates with the helpers in `e2e/demo-dates.ts` instead of hard-coding them.

### Email addresses

Demo people have addresses on reserved domains that receive no mail: `seller.example.com`, `bidder-a.example.com`, `bidder-b.example.com` and `bidder-c.example.com`. If you want to test real email with domains you own, set `VDRKIT_DEMO_EMAIL_DOMAINS` in the environment or in `.env` in the repository root:

```sh
VDRKIT_DEMO_EMAIL_DOMAINS=mail.test                                     # every side on one domain
VDRKIT_DEMO_EMAIL_DOMAINS=seller=s.test,a=a.test,b=b.test,c=c.test      # one domain per side
```

It's only read when the demo data is created, so run `dev:stack -- --reset` after changing it.

## Real email

If a mail server is configured, `dev:stack` really sends the emails it triggers, and still keeps a copy in the dev mailbox.

Set `SMTP_HOST` (or `SMTP_URL`) and `MAIL_FROM`, plus `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER` and `SMTP_PASSWORD` if your server needs them, in the environment or in `.env` in the repository root. `dev:stack` reads only these from `.env`, passes them to the API and never prints them. Before you turn this on, point the demo addresses at your own domains, and don't add people on other domains while real email is on, unless you enjoy apologising to strangers.

The environment wins over `.env`: if any mail setting is present in the environment, even an empty one, `.env` is ignored for mail. That's why `SMTP_HOST= pnpm dev:stack` keeps everything local in Git Bash. It doesn't work in cmd or PowerShell, though, because they don't pass an empty variable on at all, so `.env` gets read after all. `dev:stack -- --no-real-mail` works everywhere and is what we'd use.

The API says on start-up which mode it's in. Tests never send real email: the test configs blank every mail setting, and a test fails if that changes.

## Office conversion

Without a converter, real Word, Excel and PowerPoint uploads "could not be prepared for viewing". Set `GOTENBERG_URL` and the API converts them through Gotenberg.

One Gotenberg is enough for all your worktrees. This one restarts with Docker and only listens on localhost:

```sh
docker run -d --name vdrkit-dev-gotenberg --restart unless-stopped -p 127.0.0.1:3130:3000 gotenberg/gotenberg:8.17.3
```

Then put `GOTENBERG_URL=http://127.0.0.1:3130` in `.env` in the repository root, or in the environment. `dev:stack -- --no-converter` runs without it.
