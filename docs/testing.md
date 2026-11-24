# Testing

Before you open a pull request, run these:

```sh
corepack pnpm@9.15.4 typecheck
corepack pnpm@9.15.4 lint
corepack pnpm@9.15.4 --filter @vdrkit/core exec vitest run --maxWorkers=4
corepack pnpm@9.15.4 --filter @vdrkit/server exec vitest run --maxWorkers=4
corepack pnpm@9.15.4 --filter @vdrkit/dataroom exec playwright test --workers=2
node scripts/check-spdx.mjs
```

The core and server suites run on PGlite, which is quick and needs nothing installed. PGlite is close to Postgres but not identical, so if you change SQL, migrations or permissions, also run them against a throwaway Postgres 17 with `TEST_DATABASE_URL` and `test:pg`.

Playwright starts its own API and front end. Besides the screen specs it runs the user flows below and the accessibility checks ([accessibility.md](accessibility.md)). The screen specs share one seeded room, Project Heron, and run in parallel against it. CI runs everything in Chromium against the development servers, then runs the screen specs a second time against a production build. [CONTRIBUTING.md](../CONTRIBUTING.md) covers other browsers and testing a production build, and [development.md](development.md) the development stack.

## User flows end to end

Each of the seven core flows has a spec in `apps/dataroom/e2e` that walks through it on screen, with every person in their own browser and signed in for real. Each spec sets up its own room through the API beforehand, so the flows leave Project Heron alone.

- `flow-1-first-visit.spec.ts` follows an invitation through two-factor set-up and the NDA, then a second room's NDA.
- `flow-2-room-setup.spec.ts` creates a room, imports a tree, sets per-folder rights and publishes to bidders.
- `flow-3-bidder-onboarding.spec.ts`: a bidder group with an end date, a subgroup, a phase and a private presentation.
- `flow-4-colleague-request.spec.ts` has a lead ask for two colleagues. One is declined, one approved.
- `flow-5-document-lifecycle.spec.ts` covers drafts, release, new versions, withdrawal and a file that fails to process.
- `flow-6-document-view.spec.ts` checks watermarks on pages and downloads, and view-only access.
- `flow-7-revoke-and-close.spec.ts` revokes a bidder, then freezes and closes the room.

They run in the `signin` project. CI runs them only in Chromium; for other browsers, run `test:e2e:<browser>` yourself. Shared helpers are in `e2e/flow-helpers.ts`.

Some of what these specs check looks like a bug the first time you see it, and isn't. A contributor with View only doesn't see other contributors' drafts. A publisher can still withdraw a document in a frozen room. The download dialog always says the PDF carries name, group and date, although the file itself follows the room's watermark settings. And if a new NDA version is published while someone is already in the room, they're only sent to it on a full page load; until then the API shows them no documents.

## The public sandbox

The sandbox spec isn't part of CI. You run it on its own, against a sandbox API on port 3141 and `next dev` with `VDRKIT_SANDBOX=1` on port 3140. [sandbox.md](sandbox.md) has the details.

```sh
corepack pnpm@9.15.4 --filter @vdrkit/dataroom exec playwright test -c playwright.sandbox.config.ts
```
