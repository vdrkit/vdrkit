# Load and volume tests

Scripts behind `docs/performance.md`. They run against a throwaway Postgres 17, the production build of the API and
the worker (`apps/server/dist`), and, for the bulk import, your own Gotenberg and ClamAV containers. Nothing here
touches a real installation, and no email is sent: the API and the worker get no mail settings.

Everything generated (the database's session cookies, the 2.6 GiB of test files, logs, results) goes to
`scripts/load/.work/`, which git ignores.

## 1. Containers and build

Ports: the API on 4601, Postgres on 4620, Gotenberg on 4621, ClamAV on 4622. The passwords are throwaway test values,
also in `config.mjs`.

```sh
docker run -d --name load-pg -p 127.0.0.1:4620:5432 --memory 2g --shm-size 256m \
  -e POSTGRES_PASSWORD=load_pg -e POSTGRES_DB=vdrkit \
  -e VDRKIT_OWNER_PASSWORD=load_owner -e VDRKIT_APP_PASSWORD=load_app -e VDRKIT_QUEUE_PASSWORD=load_queue \
  -v "$PWD/docker/postgres-init/01-roles.sh:/docker-entrypoint-initdb.d/01-roles.sh:ro" \
  -v load-pg-data:/var/lib/postgresql/data postgres:17
docker run -d --name load-gotenberg -p 127.0.0.1:4621:3000 --memory 2g gotenberg/gotenberg:8.17.3 gotenberg --api-timeout=120s
docker run -d --name load-clamav -p 127.0.0.1:4622:3310 --memory 3g \
  -e CLAMD_CONF_StreamMaxLength=1024M -e CLAMD_CONF_MaxFileSize=1024M -e CLAMD_CONF_MaxScanSize=2048M \
  -e CLAMD_CONF_PCREMaxFileSize=1024M -e CLAMD_CONF_MaxScanTime=600000 -v load-clamav-db:/var/lib/clamav clamav/clamav:1.4

corepack pnpm@9.15.4 install --frozen-lockfile
corepack pnpm@9.15.4 --filter @vdrkit/core build && corepack pnpm@9.15.4 --filter @vdrkit/server build
MIGRATION_DATABASE_URL=postgres://vdrkit_owner:load_owner@127.0.0.1:4620/vdrkit node apps/server/dist/main.js migrate
```

ClamAV needs a few minutes to load its signatures (`docker logs load-clamav` says "clamd started").

## 2. Volume

```sh
node scripts/load/seed.mjs            # Project Heron: 1,248 published documents, 55 load people, 60,000 log entries
node scripts/load/seed.mjs --kite     # also Project Kite: 10,000 published documents, 250,000 log entries (about 70 s)
node scripts/load/start.mjs api       # the API, NODE_ENV=production, Better Auth, rate limits in Postgres
node scripts/load/measure.mjs                     # response times in Heron
node scripts/load/measure.mjs --room kite         # and in Kite
```

`seed.mjs` writes one signed-in session per load person to `.work/sessions.json`, as an email-code sign-in would
leave it. The scripts keep that file up to date when the API rotates a session (every 15 minutes in use). Run
`seed.mjs` again for fresh sessions; it skips what is already there.

## 3. Bulk import

```sh
node scripts/load/gen-files.mjs --big   # 400 files, 2.56 GiB, in ten folders, and one PDF of exactly 1 GiB
GOTENBERG_URL=http://127.0.0.1:4621 CLAMAV_HOST=127.0.0.1 CLAMAV_PORT=4622 node scripts/load/start.mjs worker
node scripts/load/bulk.mjs              # the 400 files, then waits until the worker has processed them all
node scripts/load/bulk.mjs --big        # the 1 GiB file
```

`bulk.mjs` uploads as the browser's bulk import does: three files ahead, completions in order. It prints the upload
time, the API's peak memory (sampled by `memwatch.mjs`, which `start.mjs` preloads) and the worker's drain time.

## 4. Concurrency

```sh
node scripts/load/conc.mjs --prepare               # grants the bidder groups the import folder and publishes it
node scripts/load/conc.mjs --minutes 3 --think 5000 --label human     # people reading
node scripts/load/conc.mjs --minutes 3 --think 1000 --label realistic # busy
node scripts/load/conc.mjs --minutes 2 --think 0 --label stress       # no pauses
node scripts/load/abuse.mjs                        # rate limits: abuse is stopped, others are not
```

`--bidders 20 --sellers 0` uses fewer of the seeded people: that many bidders, spread over the groups, and no sellers.

**Against the production image.** Memory behaviour depends on the allocator, so measure it on Linux, not natively on
Windows: build the image (`docker build -t perf-vdrkit .`), run it as `api` on a Docker network with the load
database, `-p 127.0.0.1:4701:3001`, `--cpuset-cpus 0-3` for a 4-core server, the settings `start.mjs` passes (with
`PUBLIC_URL=http://127.0.0.1:4701`, `STORAGE_DRIVER=local` on a volume, no mail settings), and point the scripts at it
with `LOAD_API_PORT=4701`. Its memory is `VmRSS` in `docker exec <container> grep VmRSS /proc/1/status`; `memwatch.mjs`
does not run there. From Git Bash on Windows set `MSYS_NO_PATHCONV=1`, or paths such as `/data/storage` are rewritten.

More API processes on the same database: `node scripts/load/start.mjs api --port 4602`, then
`conc.mjs --apis 4601,4602`. `--no-images` leaves out page images, to see the cost of the rest.

To see where the API's main thread spends its time, start it with
`LOAD_NODE_OPTIONS=--inspect=127.0.0.1:4609 node scripts/load/start.mjs api`, put load on it, and run
`node scripts/load/profile.mjs 20`. `memwatch.mjs` also records how busy the main thread was (`eventLoopBusy` in
`.work/api-mem.json`).

`conc.mjs` is a small Node load generator rather than k6 or autocannon: every bidder keeps its own session cookie,
which the API replaces while in use, and follows a reading path whose later requests depend on earlier answers (the
viewing session id). `abuse.mjs` uses autocannon for raw request floods; it installs it into
`scripts/load/.work/tools` on first use.

## 5. Clean up

```sh
node scripts/load/start.mjs stop
node scripts/load/gen-files.mjs --clean
docker rm -f load-pg load-gotenberg load-clamav
docker volume rm load-pg-data load-clamav-db
```

Then delete `scripts/load/.work` (the uploaded copies of the files sit in `.work/storage`).
