# Installing and running VDRkit

VDRkit runs under Docker Compose as a handful of containers: the screens (`web`), the API (`api`), the background worker (`worker`), a one-shot `migrate` step, Gotenberg to convert Office files, Caddy for HTTPS, and Postgres 17. ClamAV virus scanning and a daily backup are optional extras that we recommend turning on.

Everything below assumes the bundled Postgres, and that is what we recommend. A managed Postgres 16 or later should work too; there are notes on [Neon](#neon) near the end, but nobody has run VDRkit on Neon in production yet.

## What you need

A Linux server (x86-64) with at least 2 CPU cores and 4 GB of memory. A virtual machine is fine. If you want ClamAV, and you probably do, make that 8 GB: ClamAV sits at about 1 GB at rest and can reach 3 GB while it loads signatures or scans a large file.

For disk, start from 20 GB and add three to four times the size of the documents you expect. ClamAV also wants 1 GB free for the largest file it scans, and if your backups live on the same disk for a while, leave room for those as well.

You'll also need:

- Docker Engine 24 or later with the Compose plugin 2.20 or later (`docker compose version` tells you)
- a name you control, such as `dataroom.example.com`
- ports 80 and 443 (TCP) open to the internet, plus 443 (UDP) if you like; Caddy needs port 80 to get its certificate
- an SMTP server or provider that may send mail for your domain
- `openssl` on whichever machine you use to fill in `.env`

## DNS

Point the name at the server:

| Type | Name | Value |
| --- | --- | --- |
| `A` | `dataroom.example.com` | the server's IPv4 address |
| `AAAA` | `dataroom.example.com` | the server's IPv6 address, if it has one |
| `CAA` (optional) | `example.com` | `0 issue "letsencrypt.org"` |

Once the name resolves and the ports are open, Caddy gets the certificate and renews it on its own.

## Email

VDRkit sends sign-in codes, invitations and notifications by email, so it matters that they arrive. In our experience they only land in inboxes reliably when they come from an address on your own domain, such as `dataroom@example.com`, sent through your own mail server or a provider that has verified the domain. The domain needs these records:

| Record | Name | Value |
| --- | --- | --- |
| SPF (`TXT`) | `example.com` | `v=spf1 include:<your provider's SPF domain> ~all` |
| DKIM (`TXT` or `CNAME`) | `<selector>._domainkey.example.com` | from your provider, e.g. `v=DKIM1; k=rsa; p=<public key>` |
| DMARC (`TXT`) | `_dmarc.example.com` | `v=DMARC1; p=none; rua=mailto:dmarc-reports@example.com; adkim=r; aspf=r` |
| Reverse DNS (`PTR`) | the server's IP address | `mail.example.com` |

A domain can have only one SPF record, so if you already have one, add the `include:` to it rather than creating a second. The `PTR` row only matters if you run your own mail server. In that case use `v=spf1 mx ~all` or `v=spf1 ip4:<server address> ~all` for SPF, and set the reverse DNS record at your hosting provider.

We suggest starting DMARC at `p=none` and reading the reports for a week or two. When only your own servers show up in them, move to `p=quarantine`, and later to `p=reject`.

You enter the mail server itself during first-run setup. It can be changed later in Site settings, which also checks the three DNS records for you. `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD` and `MAIL_FROM` in `.env` only prefill that form.

## Files to download

Put these in one folder on the server, keeping the folder structure. We use `/opt/vdrkit`, but put them wherever makes sense to you.

```
docker-compose.yml
Caddyfile
.env.example
docker/postgres-init/01-roles.sh
docker/postgres-init/02-backup-role.sh
docker/backup/backup.sh
docker/backup/restore-db.sh
```

## Settings (`.env`)

Copy `.env.example` to `.env` and fill it in. This file holds every secret the installation has, so make it readable by root only with `chmod 600 .env`.

| Setting | Value |
| --- | --- |
| `VDRKIT_TAG` | the version to run, e.g. `1.0.0` (not `latest`) |
| `SITE_ADDRESS` | your address, without `https://` |
| `COMPOSE_PROFILES` | `postgres,clamav,backup` |
| `POSTGRES_PASSWORD`, `VDRKIT_OWNER_PASSWORD`, `VDRKIT_APP_PASSWORD`, `VDRKIT_QUEUE_PASSWORD`, `VDRKIT_BACKUP_PASSWORD` | `openssl rand -hex 24`, a different value for each |
| `VDRKIT_MASTER_KEY` | `openssl rand -base64 32` |
| `BETTER_AUTH_SECRET` | `openssl rand -base64 32` |
| `STORAGE_DRIVER` | `local` (default) or `s3` |
| `BACKUP_DIR`, `BACKUP_AT`, `BACKUP_KEEP_DAYS` | where daily backups go, when (UTC), how many days to keep |
| `SMTP_*`, `MAIL_FROM` | optional |

Leave `CSP_CONNECT_SRC`, `CLAMAV_MAX_BYTES`, `CLAMAV_MEMORY_LIMIT` and `VDRKIT_SOURCE_URL` out unless one of the cases below applies to you.

Pin `VDRKIT_TAG` to a real version so that you decide when to upgrade, not whoever pushes the next image. Leave `postgres` out of `COMPOSE_PROFILES` only if you use a managed Postgres, and `clamav` only if memory is tight. If you leave out `clamav`, add an empty `CLAMAV_HOST=` to `.env` as well, or VDRkit will keep looking for the scanner and every upload will fail. The database passwords are hex because they end up inside connection strings, where other characters cause trouble.

Two of these settings deserve more care than the rest. `VDRKIT_MASTER_KEY` unwraps every room's encryption key; without it, the documents can't be read. There's no key rotation, so you can't change it later; a new value leaves every room unreadable. `BETTER_AUTH_SECRET` signs sessions and encrypts the authenticator secrets, and if you lose it everyone has to set up two-factor sign-in again. Neither is in any backup, and no backup can be restored without them. Keep a copy of `.env` in a password manager or a safe, somewhere other than the server.

With `STORAGE_DRIVER=local`, files are kept encrypted in a Docker volume. With `s3` they go to a bucket on AWS S3, Cloudflare R2 or a store you run yourself (see [Garage](#self-hosted-s3-with-garage) below), set up through the `S3_*` settings. Browsers then upload straight to the bucket, and the Content-Security-Policy already allows its address. You'd only need `CSP_CONNECT_SRC` if browsers reach the store at some other origin, a CDN for example; separate several origins with spaces.

"About and source code" in the account menu links to https://github.com/vdrkit/vdrkit. If you run a modified copy, the AGPL-3.0 requires you to offer your source code to its users, so set `VDRKIT_SOURCE_URL` to wherever you publish it.

Now start it:

```
docker compose up -d
docker compose ps
```

The first start takes about a minute. `docker compose logs migrate` prints a line per migration and ends with "Database is up to date".

### Virus scanning

With the `clamav` profile on, every uploaded file up to 1 GB (1073741824 bytes) is scanned before anything else happens to it. An infected file is locked, and nobody can open or download it. Larger files go through unscanned, and their details page says "Not scanned: larger than 1 GB."

ClamAV gets 3 GB of memory, and its own limits (`StreamMaxLength`, `MaxFileSize`, `MaxScanSize`, `MaxScanTime`) are set to match in `docker-compose.yml`. If you want to scan bigger files, raise `CLAMAV_MAX_BYTES` and those limits together, bearing in mind that ClamAV won't go past 2 GB.

### Bigger servers

One API process and one worker are plenty for a 4-core server running one deal. How many bidders that serves at once depends on the cores: about 15 to 20 reading at people's pace on a 4-core ARM cloud server, and about 50 on a fast desktop with the API held to 4 cores. For larger deals, or many bidders all reading at the same moment, we recommend 8 cores and 16 GB with two of each:

1. Finish first-run setup with a single API process. The setup code lives in the memory of the process that printed it, and a second process won't know it.
2. Add to `.env`:

   ```
   API_REPLICAS=2
   WORKER_REPLICAS=2
   ```

3. Run `docker compose up -d`. `docker compose ps` should now list two `api` and two `worker` containers.

Caddy spreads requests across the API containers, and rate limits are kept in the database, so they hold across both. On 4 cores a second API process doesn't buy you anything.

Each API process is capped at 1.5 GB of memory (`API_MEMORY_LIMIT`) and each worker at 3 GB (`WORKER_MEMORY_LIMIT`). The image preloads the jemalloc allocator through `LD_PRELOAD` to keep the API's memory in check; please don't unset it in an override. Images from before 21 November 2026 don't include jemalloc. On those, set `MALLOC_ARENA_MAX: "2"` for `api` and `worker` in `docker-compose.override.yml`, which holds the API to about 1 GB but costs some throughput. Two API processes and a worker use about 40 of Postgres's 100 connections. If you want the numbers behind all this, `docs/performance.md` has the load tests.

## First-run setup

Open `https://dataroom.example.com`. A fresh installation shows first-run setup and nothing else.

1. Unlock it with the setup code from the API's log: `docker compose logs api | grep "Setup code"`. The code works once and expires after 24 hours. A restart makes a new one.
2. The checks page tests the database, file storage, document conversion, the virus scanner and the certificate. If you left ClamAV out and set `CLAMAV_HOST=` empty, you'll get a warning. A failed virus scanner check means either ClamAV is still loading its signatures, which takes a few minutes, or `CLAMAV_HOST` isn't empty.
3. Create the first site admin with your name, company and work email. There's no password: you sign in with an emailed link or code, then an authenticator app.
4. Enter the organisation's name, and a light and a dark logo if you have them.
5. Check the outgoing email settings, which are prefilled from `.env`. "Finish setup" stays disabled until the mail server has accepted a test email to you.

Then sign in and set up two-factor sign-in. We'd add a second site admin in Site settings fairly early on, so you're not the only one who can get in.

## Backups

The `backup` service runs every day at `BACKUP_AT` (UTC, default 02:30) and keeps backups for `BACKUP_KEEP_DAYS` (default 14). VDRkit stays up while it runs.

A backup holds a `pg_dump` of the whole database, audit log included, taken as the read-only role `vdrkit_backup`. With `STORAGE_DRIVER=local` it also holds a `tar` of the files volume. Uploads that were still in progress aren't included and have to be uploaded again after a restore.

That means `BACKUP_DIR` holds the whole database unencrypted, including names, email addresses and the audit log. The backup service makes everything it writes there readable by root only. Keep the folder that way: `chmod 700` it, give no other account on the server access, and run your copy job (below) as root.

If a backup fails it's retried three times, 15 minutes apart (`BACKUP_RETRIES`, `BACKUP_RETRY_MINUTES`), and older backups are never removed to make room for it. A backup only gets its final name, `vdrkit-YYYYMMDDTHHMMSSZ`, once its checksums and manifest are written and the dump has been read back, so anything with that name is complete.

```
docker compose run --rm backup now              # a backup at once
docker compose run --rm backup list             # the backups and their sizes
docker compose run --rm backup verify vdrkit-20261116T023000Z
docker compose ps backup                        # "healthy": the last backup succeeded less than 26 hours ago
```

A backup on the same disk as the server won't help you much when the server dies. Copy `BACKUP_DIR` somewhere else every day, for example with `rclone` or `restic` to another provider's object storage. The documents are encrypted but the database dump isn't, so encrypt the copy: `restic` does by default, and with `rclone` you'd use a `crypt` remote. Keep your copy of `.env` somewhere else again.

With `STORAGE_DRIVER=s3` the backup holds only the database, and the files need a copy of their own: replicate the bucket to another region or provider. On AWS, replication needs versioning, and versioning needs one more lifecycle rule. Uploads in progress sit unencrypted under `quarantine/`, and on a versioned bucket a delete only hides them. Without the rule, the unencrypted original of every upload would stay in the bucket for good and be replicated with everything else. Run `scripts/s3-bucket-setup.sh` again after you turn versioning on; it adds a rule that removes old versions under `quarantine/` after a day. Run it against the replica as well, because S3 doesn't replicate lifecycle rules or the removals they make.

Garage, Cloudflare R2 and some other S3 stores have no versioning, or don't take the rule for old versions. Leave versioning off there and copy the bucket elsewhere with `rclone sync`; the plain expiry rule the script sets is then enough.

If your installation is older than the backup service, add `VDRKIT_BACKUP_PASSWORD` to `.env`, download the current `docker-compose.yml` and the three backup files from [Files to download](#files-to-download), which are `docker/postgres-init/02-backup-role.sh`, `docker/backup/backup.sh` and `docker/backup/restore-db.sh`. Then create the role once:

```
docker compose up -d postgres
docker compose exec postgres sh /docker-entrypoint-initdb.d/02-backup-role.sh
```

Then add `backup` to `COMPOSE_PROFILES`.

## Restore

Always restore into a fresh installation; the restore script refuses a database that already has tables. The same steps move VDRkit to a new server.

1. On the new server, put the downloaded files in place with your saved `.env` beside them. The database passwords can be new, but `VDRKIT_MASTER_KEY` and `BETTER_AUTH_SECRET` must be the ones the backup was made with.
2. Copy the backup folder into `BACKUP_DIR`. By default that's `./backups/vdrkit-YYYYMMDDTHHMMSSZ`.
3. Start the database on its own, restore it, then restore the files:

   ```
   docker compose up -d --wait postgres
   docker compose exec postgres sh /vdrkit-backup/restore-db.sh vdrkit-20261116T023000Z
   docker compose run --rm --no-deps backup restore-files vdrkit-20261116T023000Z
   ```

   `restore-db.sh` verifies the checksums and restores everything in a single transaction as the container's superuser. If anything goes wrong the database is left empty, and you can try again. `restore-files` unpacks into the empty files volume. With `STORAGE_DRIVER=s3` there are no files in the backup. Skip `restore-files` and point the new installation's `S3_*` settings at the bucket, or at the replica you're restoring it from.
4. Run `docker compose up -d`. `migrate` reports "none pending", or applies newer migrations if the image is newer than the backup. First-run setup stays closed, and people sign in as before with the same authenticator app.

A backup you've never restored is a hope rather than a backup. There's a restore drill you can run on one machine from a checkout with Node 22. After `pnpm install`, `pnpm --filter @vdrkit/dataroom exec playwright install chromium` (the drill signs in with a browser) and `docker build -t vdrkit:smoke .`, run `node docker/drill/restore-drill.mjs`. It sets up a throwaway installation of that image with invented data, backs it up, destroys it, restores it and compares the tables, audit chains, files and documents. That tests backup and restore in the version you built. It says nothing about your own backups; for those, restore a recent one into a fresh installation every so often and sign in. We'd run the drill after upgrading VDRkit or Docker, and at least once a quarter regardless.

## Upgrades

Migrations run by themselves when a new version starts, before the API and the worker, and they only go forward. Your way back is the backup you take first.

1. Take a backup with `docker compose run --rm backup now` and copy it off the server.
2. Read the release notes for every version between yours and the new one. Occasionally one needs a manual step, such as a new `.env` setting.
3. Set `VDRKIT_TAG` in `.env` to the new version, then:

   ```
   docker compose pull
   docker compose up -d
   docker compose logs migrate
   ```

   Each new migration runs in its own transaction, and the log ends with "Database is up to date". Only then do the API and the worker start.
4. Check that `docker compose ps` shows every service healthy, then sign in and open a document.

If a migration fails, it's rolled back and `migrate` exits with an error naming the file. The new version doesn't start, though any migrations before the failed one stay applied. The API and the worker won't start on a database that lacks one of their own migrations, so you never end up running half an upgrade.

To go back, whether after a failed migration or because the new version misbehaves, set `VDRKIT_TAG` to the old version and run `docker compose up -d`. That works as long as the new migrations only added things; the old API logs "The database has N migrations this version does not know" as a warning and carries on. If it won't start, or you're not sure, restore the backup into a fresh installation with the old `VDRKIT_TAG`. You'll lose anything done since the upgrade.

To rehearse your own upgrade, restore your latest backup into a fresh installation on another machine with your current `VDRKIT_TAG`, then upgrade that copy as above.

VDRkit can tell you when a new version is out. Set `VDRKIT_UPDATE_URL` in `.env`, for example to `https://api.github.com/repos/vdrkit/vdrkit/releases/latest`, and the Version line on the Health tab in Site settings checks that address every 6 hours and says when there's something newer. The address has to answer with JSON that gives the version in `version` or `tag_name`, as GitHub's does. Leave the setting out and there's no check at all: VDRkit doesn't ask anyone about versions. GitHub's latest-release address never names a pre-release, and a version with a suffix, such as `1.1.0-rc.1`, counts as older than `1.1.0`.

## Neon

We haven't run VDRkit on Neon in production and still recommend the bundled Postgres. If you'd like to try it anyway, or another managed Postgres 16 or later, here's what you need.

Create a Neon project on Postgres 16 or 17 in the region nearest the server. Choose the region carefully, because Neon can't move a project later. The default branch becomes your production database. From "Connect" in the Neon console you need the owner role (usually `neondb_owner`) and its **direct** connection string, which is the host without `-pooler`. You only use that once, to run `roles.sql`; it doesn't go in `.env`. You'll also use the pooled host of the same branch, which is the same name with `-pooler` added.

It's worth reading [Backups on Neon](#backups-on-neon) before you start, since it may affect whether Neon suits you.

### Roles

VDRkit uses three roles. The two that touch room data must not be superusers or have `BYPASSRLS`, because either would quietly skip the row-level security that keeps rooms and tenants apart. The API, the worker and `migrate` refuse to start with such a role, and the API and the worker also refuse the owner role in `DATABASE_URL`. Rather than clicking roles together in the Neon console, create them and the database with `docker/neon/roles.sql`, on the direct connection, as the owner role:

```
owner_pw=$(openssl rand -hex 24); app_pw=$(openssl rand -hex 24); queue_pw=$(openssl rand -hex 24)
printf 'vdrkit_owner %s\nvdrkit_app %s\nvdrkit_queue %s\n' "$owner_pw" "$app_pw" "$queue_pw"
psql "postgresql://neondb_owner:<password>@ep-xxxx.<region>.aws.neon.tech/neondb?sslmode=require" \
  -v owner_pw="$owner_pw" -v app_pw="$app_pw" -v queue_pw="$queue_pw" -f docker/neon/roles.sql
```

The second line prints the three passwords, and that's the only place you'll see them. Put them in your password manager before you run `psql`.

### Connections

Every Neon branch has a direct host, `ep-xxxx.<region>.aws.neon.tech`, and a pooled one, `ep-xxxx-pooler.<region>.aws.neon.tech`, which is PgBouncer in transaction mode. The API, the worker and the job queue are happy behind the pooler. Migrations need the direct host: the lock that stops two `migrate` runs at once belongs to the session, and a transaction-mode pooler doesn't keep sessions.

| `.env` setting | Role | Host |
| --- | --- | --- |
| `MIGRATION_DATABASE_URL` | `vdrkit_owner` | direct |
| `DATABASE_URL` | `vdrkit_app` | pooled |
| `QUEUE_DATABASE_URL` | `vdrkit_queue` | pooled |

Each ends in `/vdrkit?sslmode=require`. Remove `postgres` from `COMPOSE_PROFILES`.

### Check before you start

We have a script that checks a Neon set-up end to end. From a checkout of the repository, run `pnpm install` and `pnpm --filter @vdrkit/core build`, then:

```
NEON_MIGRATION_URL="<MIGRATION_DATABASE_URL>" NEON_DATABASE_URL="<DATABASE_URL>" NEON_QUEUE_URL="<QUEUE_DATABASE_URL>" \
  node docker/neon/neon-check.mjs
```

It checks the connections and roles, applies the migrations, and tests row-level security over the pooler and the job queue. If it passes, run `docker compose up -d`.

### Backups on Neon

On Neon, point-in-time restore and branches are your main safety net. We'd still want a daily `pg_dump` outside Neon. That needs a `BACKUP_DATABASE_URL` whose role can read every row, which means `BYPASSRLS`:

```
create role vdrkit_backup login bypassrls;
grant pg_read_all_data to vdrkit_backup;
```

Whether the owner role may create that depends on Neon's rules at the time, and restoring a dump into Neon needs the same right. Check before you rely on it.

## Self-hosted S3 with Garage

Local disk is the default, and most installations never need anything else. S3 storage starts to make sense when losing the server mustn't mean losing the files, or when you'd like to be able to replace the app server with nothing more than `.env` and the database. If you want that on your own hardware, we recommend Garage.

[Garage](https://garagehq.deuxfleurs.fr) is a small open-source S3 store built for a handful of machines in different places. We test VDRkit against Garage 2.5.0. It isn't part of VDRkit's `docker-compose.yml`: run it on its own machines, or on the VDRkit server as a single node to start with. Files reach Garage already encrypted with each room's key, with one exception. Uploads in progress sit unencrypted under `quarantine/` until they finish, and browsers send them to Garage directly, so put HTTPS in front of it.

### Three nodes

You need three machines, ideally in different places, each with Docker and a disk for the files. An SSD for Garage's metadata helps. The example uses `10.0.0.11`, `10.0.0.12` and `10.0.0.13` on a private network and `s3.example.com` as the public address.

1. Make a shared secret with `openssl rand -hex 32`. All three nodes use the same one.
2. On each node, write `/etc/garage.toml` with that node's own address in `rpc_public_addr`:

   ```
   metadata_dir = "/var/lib/garage/meta"
   data_dir = "/var/lib/garage/data"
   db_engine = "lmdb"
   replication_factor = 3
   rpc_bind_addr = "[::]:3901"
   rpc_public_addr = "10.0.0.11:3901"
   rpc_secret = "<the shared secret>"

   [s3_api]
   s3_region = "garage"
   api_bind_addr = "[::]:3900"
   root_domain = ".s3.example.com"
   ```

3. Start Garage on each node with this `docker-compose.yml` in a folder of its own, then `docker compose up -d`:

   ```
   services:
     garage:
       image: dxflrs/garage:v2.5.0
       restart: unless-stopped
       network_mode: host
       volumes:
         - /etc/garage.toml:/etc/garage.toml:ro
         - /var/lib/garage/meta:/var/lib/garage/meta
         - /var/lib/garage/data:/var/lib/garage/data
   ```

   3900 is the S3 port. Port 3901 carries traffic between the nodes and shouldn't be reachable from anywhere else.
4. On nodes 2 and 3, `docker compose exec garage /garage node id` prints the node's identity, something like `631f50206bdfbfd2...@10.0.0.12:3901`. Connect them from node 1:

   ```
   docker compose exec garage /garage node connect <node 2 identity>
   docker compose exec garage /garage node connect <node 3 identity>
   docker compose exec garage /garage status
   ```

   `status` should list three healthy nodes, each "NO ROLE ASSIGNED".
5. Give each node a zone and the space Garage may use there. With three zones, Garage keeps one copy of every file in each. The first 16 characters of an identity will do as the id.

   ```
   docker compose exec garage /garage layout assign -z site-a -c 500G <node 1 id>
   docker compose exec garage /garage layout assign -z site-b -c 500G <node 2 id>
   docker compose exec garage /garage layout assign -z site-c -c 500G <node 3 id>
   docker compose exec garage /garage layout show
   docker compose exec garage /garage layout apply --version 1
   ```

6. Create the key and the bucket:

   ```
   docker compose exec garage /garage key create vdrkit
   docker compose exec garage /garage bucket create vdrkit-files
   docker compose exec garage /garage bucket allow --read --write --owner vdrkit-files --key vdrkit
   ```

   `key create` shows the key ID (`GK...`) and the secret key only once. Put both in your password manager.
7. Put Caddy on node 1 in front of port 3900 and point `s3.example.com` at that machine:

   ```
   s3.example.com {
       reverse_proxy 10.0.0.11:3900 10.0.0.12:3900 10.0.0.13:3900
   }
   ```

### One node

Follow the same steps on one machine with `replication_factor = 1`, skip step 4, and run a single `layout assign`. If that machine dies, the files go with it, so copy the bucket somewhere else every night with `rclone sync`. You can connect more nodes later and assign them in a new layout version, but raising `replication_factor` means editing every node's `garage.toml` and restarting Garage.

### The VDRkit settings

In VDRkit's `.env`:

```
STORAGE_DRIVER=s3
S3_ENDPOINT=https://s3.example.com
S3_REGION=garage
S3_BUCKET=vdrkit-files
S3_ACCESS_KEY_ID=GK...
S3_SECRET_ACCESS_KEY=<the secret key>
S3_FORCE_PATH_STYLE=true
```

`S3_REGION` has to match `s3_region` in `garage.toml`. If it doesn't, Garage rejects every request with "Authorization header malformed, unexpected scope", which is not the most helpful way of saying so. `S3_FORCE_PATH_STYLE=true` puts the bucket in the path (`https://s3.example.com/vdrkit-files/...`) and saves you a wildcard DNS record.

Prepare the bucket once, from a checkout of the repository or with just the script:

```
S3_ENDPOINT=https://s3.example.com S3_REGION=garage S3_BUCKET=vdrkit-files PUBLIC_URL=https://dataroom.example.com \
S3_ACCESS_KEY_ID=GK... S3_SECRET_ACCESS_KEY=... sh scripts/s3-bucket-setup.sh
```

The script limits uploads to the VDRkit site and adds two lifecycle rules: leftovers under `quarantine/` are deleted after a day, and so are unfinished uploads. Garage applies them once a day at midnight UTC.

Restart VDRkit with `docker compose up -d` and check that "File storage" shows as working on the Health tab in Site settings.

### Running it

`docker compose exec garage /garage status` shows each node and its free space, and lists failed nodes separately.

If a node stops, the other two keep going. Garage can take up to a minute to notice, and uploads may hang until it does (bulk import retries those by itself). When the node comes back it resyncs on its own, and you can watch the queue shrink in `status`.

Keep in mind that three copies don't protect you from a mistake made through VDRkit itself. For that you still want a nightly `rclone sync` to a fourth place.

## Day to day

`docker compose ps` should show every service running and healthy, and `migrate` as "exited (0)". Compose restarts everything after a reboot (`restart: unless-stopped`).

`https://dataroom.example.com/health` answers `ok` when every check passes, and we recommend pointing an outside uptime monitor at it. The Health tab in Site settings has the details, and emails site admins when a check stays failed past its delay.

For logs, `docker compose logs --since 1h api worker` is a good start. They rotate at 10 MB, five files per service.
