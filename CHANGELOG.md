# Changelog

Notable changes to VDRkit. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-11-24

The first release of VDRkit: a self-hosted virtual data room for M&A and other corporate transactions, for one organisation per installation.

### Rooms and documents

- My rooms lists every room a person belongs to. If they only have one, they go straight into it.
- Rooms can be created from scratch or from a template, and move through five states: being prepared, open, frozen, closed and archived. Only room admins can enter a closed or archived room. An archived room is read-only for everyone, room admins included; the one change left is deleting it.
- A numbered folder index. You can type over the numbers; renumbering asks first before it changes published numbers, and old numbers keep pointing to the right document.
- Bulk import of a whole folder tree previews the numbers and skips duplicates. Dropping files on a folder adds them, and dropping one on a document uploads a new version.
- Resumable uploads of files up to 5 GB. Gotenberg converts Office files to PDF.
- Uploads arrive as drafts. Release review publishes drafts and new versions and shows which groups will see them. You can also release a single draft from its menu, or withdraw a published document.
- Document details: processing steps, versions, and who opened it.
- Search with text snippets, across the documents a person may see.

### Permissions

- An access ladder per folder or document: no access (where even the name is hidden), view online with a watermark, download as PDF, and download the original.
- Adding files and publishing are separate switches per folder. A room can require four eyes, so that nobody publishes their own upload.
- Groups belong either to the seller side or to a bidder. There is one level of subgroups, always capped at the parent's rights.
- Explicit deny for a named person, and grants with start and end dates.
- A permission matrix for the whole room. Changes are saved together after a review in plain language, and the matrix can show the room as it stood on any past date.
- "See as" shows a room admin the room exactly as any team sees it.
- Neither the permission history nor the folder tree's history is ever overwritten.

### People

- Groups, leads and members, and invitations with a standard message.
- Bidder leads can ask to add or remove colleagues; a room admin approves or declines.
- An NDA that has to be accepted before the room opens, with new versions and a correction mode.
- Revoking a group or a person takes effect immediately.

### Viewer and audit

- The document viewer renders every page on the server with the reader's personal watermark. Room admins choose the watermark fields, and the download choice names exactly what each page will carry.
- Page images are stored as WebP, in about a sixth of the space PNG took.
- Page coverage per reader. Viewing sessions end 8 hours after the document was opened.
- Downloads follow the access ladder and are logged.
- An activity log of views, downloads, uploads, releases and access changes. Room admins get a summary per bidder and a CSV export. The log is hash-chained and shows whether the chain is intact.

### Timeline and notifications

- A process timeline with phases, deadlines and per-group visibility, plus a countdown on the dashboard.
- On the dashboard, each folder lists its first 5 new documents with the count and a link to the rest.
- Email notifications can be immediate, bundled, daily in each person's time zone, or off, and room admins can make some kinds mandatory. Access is checked again as each email is sent.
- Email templates for invitations, sign-in, new documents, reminders, requests and site alerts.

### Sign-in and security

- No passwords: people sign in with an emailed link or code plus an authenticator app (two-factor sign-in, required by default). Trusted browsers and sign-out after inactivity are set per room, and a person in several rooms gets the strictest setting.
- Every sign-in and failed attempt is logged with IP address and browser. Failed attempts are deleted after 30 days.
- Row-level security on every table. The API, the worker and migrations refuse a database role that bypasses it.
- A refused item answers exactly like a missing one.
- Every stored file is encrypted with its room's key.
- ClamAV scans every file up to 1 GB for viruses. Before conversion, file contents are checked against their type, and uploaded SVG logos are turned into PNG.
- Rate limits per person and per IP address, shared across API instances.
- Every page gets a strict Content-Security-Policy with a fresh nonce, and the API's answers carry `default-src 'none'`. The API also refuses writes coming from another site (the Origin check).

### Site administration

- First-run setup with a one-time setup code, which also checks email, conversion and storage.
- Site settings cover branding, outgoing email, who may create rooms, accounts and a privacy notice link, plus health checks that email the site admins when something fails.

### Installation and operations

- One production image for the screens, API, worker and migrations, run with Docker Compose, with Caddy for HTTPS ([docs/install.md](docs/install.md)).
- By default, one API process and one worker; on servers with 8 cores we recommend setting two of each.
- "About and source code" in the account menu shows the version and links to the source code, as the AGPL requires. A site running a changed copy points it at its own source with `VDRKIT_SOURCE_URL`.
- Postgres 17, either bundled or your own. Neon worked in our tests; support for it in production is on the roadmap.
- Files go on the server's own disk by default, or in S3-compatible storage (AWS, Cloudflare R2 or Garage).
- Migrations run on start, under a lock. There's a daily backup service, plus procedures for restore and upgrade, and a drill for the restore.

### Quality

- WCAG 2.2 AA on every screen, with one documented exception ([docs/accessibility.md](docs/accessibility.md)).
- Current and previous Chrome, Edge and Firefox, Firefox ESR, and Safari 17 or later ([docs/browsers.md](docs/browsers.md)).
- Load-tested with rooms of about 1,250 and 10,000 documents ([docs/performance.md](docs/performance.md)).
- End-to-end tests for the seven user flows ([docs/testing.md](docs/testing.md)).

### Known limitations

- Screen readers can't read document text in the viewer, because every page is a watermarked image.
- Safari on iPad is not promised in this release.
- Screenshots cannot be prevented in a browser; the watermark makes a leak traceable.
- Planned for release 2: Q&A, passkeys, encrypted PDF downloads, printing, staged releases, reports, archive export, redaction and screenshot deterrence.

[Unreleased]: https://github.com/vdrkit/vdrkit/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/vdrkit/vdrkit/releases/tag/v1.0.0
