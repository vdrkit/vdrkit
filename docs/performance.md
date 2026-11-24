# Performance and load

Before release 1 we load-tested VDRkit against the roadmap targets: a room of about 1,250 documents, a bulk import of 400 files, a single 1 GiB file, and 50 bidders reading while 5 sellers upload. We also built a room of 10,000 documents to find out where things start to hurt. The scripts, and a README on running them yourself, are in `scripts/load/`.

If you only want to know what server to buy, skip to [Recommended server size](#recommended-server-size).

## What we measured

We ran everything twice: on a fast 16-core desktop, and on a 4-core ARM cloud server (Oracle Ampere A1) of the kind a small firm might rent. Both used the production build, Postgres 17 with default settings and a 2 GB memory limit, Gotenberg and ClamAV in their own containers, and real Better Auth sessions. The test room is Project Heron, the demo deal, with three bidder groups and a subgroup of financiers.

On the desktop, the screens people use most (the folder list, search and the permissions screen) answer well inside the 300 ms target, and the folder list and permissions screen stay that fast at 10,000 documents. Fifty bidders reading at a normal pace got every answer within about two thirds of a second, with no errors.

The ARM server runs out of CPU much sooner. A single screen is still quick, but an ARM core does well under half the work of a desktop core, and watermarking page images is CPU work. It served about 10 bidders clicking through quickly, or 15 to 20 reading at a normal pace, before pages took more than a second or two. Fifty still worked without errors, just slowly: pages took ten seconds or more. Since then we've roughly halved the CPU cost of a watermarked page, which should let that server take 1.5 to 2 times as many readers, but we haven't repeated the test there.

The tests turned up a handful of real bottlenecks, all fixed: folder lists that worked out permissions for the whole room, an activity log that joined every entry before sorting, a missing index on the room, and a rate limit that a normal bulk import ran straight into. We found most of the slow queries by turning on `auto_explain` in the test database and reading the plans of anything over 15 ms. We'd recommend the same if you're chasing a slow screen.

## Bulk import and the worker

Uploads are fast and cheap on memory. They stream through hashing and encryption to disk, so the API stayed under 300 MB even for the 1 GiB file. The 400 files (2.56 GiB) went up in about half a minute on the desktop.

Making them viewable is the slow part. The worker converts, scans and renders one file at a time, and a 400-file import took about half an hour to become viewable on the desktop and would take about 1.5 hours on the ARM server. If imports of that size are routine for you, set `WORKER_REPLICAS=2`, which halves the wait. Each worker stayed under 1 GB in these tests, but converting a file close to the 512 MB limit can take more, and the worker's ceiling, `WORKER_MEMORY_LIMIT`, is 3 GB. Plan memory for that. Files over 512 MB are download-only and get no viewer pages. We haven't tested uploads over 1 GiB.

The worker stores page images and thumbnails as WebP: text and drawings losslessly, scans and photos lossy. That takes about a sixth of the space PNG did. Pages stored as PNG by earlier versions still open. If a room turns every watermark field off, pages go out as stored without any encoding.

On disk, plan for about 4 times the size of the originals for scanned documents and 2 times for text. That covers the original, the download PDF and the page images.

## Reading under load

Every page the viewer shows is watermarked for the person and the minute, and encoded on each request. That's what limits a small server. Two changes made it cheaper: the watermark is only drawn where it actually lands on the page, and a person's overlay is cached for the minute (at most 48 MB in total, keyed by the exact text, so one person's overlay is never served to someone else). Opening a document with its first few pages and thumbnails now costs about half the CPU it did.

On a fast machine with plenty of cores, one API process tops out on its own main thread, and a second process (`API_REPLICAS=2`) nearly doubles throughput. On a 4-core server the cores are the limit, and a second process just shares them. Add API processes when you have cores to spare, not before.

The default database pool of 10 connections (`DB_POOL_SIZE`) was enough in every test. Two API processes and a worker need about 40 of Postgres's default 100 connections. The API also sizes Node's thread pool to the machine (`UV_THREADPOOL_SIZE`, the number of CPUs, between 4 and 32); you shouldn't need to touch it.

## Memory

The production image runs Node with jemalloc (`LD_PRELOAD=/usr/local/lib/libjemalloc.so.2`, set for every role). With glibc's own allocator, libvips' freed memory stayed in per-thread arenas and the API grew past its 1.5 GB limit within a couple of minutes of heavy viewing; with jemalloc it stays under 1 GB and gives memory back afterwards. Nothing needs to change in `.env` or Compose.

If you're stuck on an older image, you can cap the growth by giving `api` and `worker` `MALLOC_ARENA_MAX: "2"` in a `docker-compose.override.yml`. It costs about a sixth of the throughput.

## Rate limits

The limits held up as intended. A bidder flooding the folder list was refused with 429 while another bidder reading at the same time got every answer, and the same went for someone guessing email codes and for calls without a session. Fifty bidders reading quickly for three minutes never hit a limit; a fast reader uses about a third of the allowance of 120 heavy requests a minute.

Bulk import makes three calls per file, and the general limit of 600 calls a minute per person stopped our first 400-file import halfway. Upload calls now have their own limit of 3,000 a minute per person.

An emailed code allows three attempts, after which you ask for a new one. Each email address can request a link or code 10 times in 15 minutes, and each IP address gets 100 sign-in calls in 15 minutes, which is enough for about 25 people in one office.

## Large rooms

A room of 10,000 documents works. The folder list, the permissions screen and a page of the activity log stay under 150 ms. Search, the bidder dashboard, the room shell and the activity summary slow down as the room grows, to the better part of a second on the desktop and over a second on the ARM server, because each of them works out the reader's access to every document in the room first. Checking access only for search hits, and keeping counts per folder, would fix it; we haven't done that yet.

Two smaller things show up at that size. On a first visit the bidder dashboard downloads the list of every new document, close to 1 MB for 10,000 documents, of which the screen shows a few. And with a quarter of a million log entries, filtering the activity log by group takes about a second.

## Recommended server size

For one deal like Project Heron, with up to 2,000 documents and bulk imports of a few hundred files:

| Part | Size |
| --- | --- |
| CPU | 4 cores (one API process, one worker, Postgres) |
| Memory | 8 GB |
| Disk | SSD, about 4 times the document size for scans, 2 times for text, plus 1 GB free |
| Database | well under 1 GB for this room |

The 8 GB is the API and the worker at up to 1 GB each as measured here, ClamAV 3 GB, Gotenberg 1 GB and Postgres 1 to 2 GB. The worker can go up to its 3 GB ceiling on the largest files. ClamAV is optional, and leaving it out saves 3 GB; if you do, set `CLAMAV_HOST=` empty as well, as [install.md](install.md#settings-env) explains. ClamAV needs the spare 1 GB of disk to scan a 1 GB file.

How many bidders that serves at once depends on the speed of the cores more than their number. Cloud cores are often much slower than a desktop's, so plan with the ARM figures above, not the desktop ones: on a 4-core cloud server, count on 15 to 20 bidders reading at once and expect somewhat more.

For larger deals, several deals at once, rooms of 10,000 documents, or more bidders than that reading at the same time, we'd go to 8 cores and 16 GB with two API processes and two workers. Compose starts one of each by default. On an 8-core server, set these in `.env` and run `docker compose up -d` again:

```
API_REPLICAS=2
WORKER_REPLICAS=2
```

Caddy finds the API containers by name and sends each request to the one with the fewest open requests. Raise `API_REPLICAS` only after first-run setup is finished, because the setup code lives in the memory of the API process that printed it. "Bigger servers" in `docs/install.md` has the rest.

`API_MEMORY_LIMIT` defaults to 1.5 GB (`1536m`), which is plenty with jemalloc.
