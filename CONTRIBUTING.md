# Contributing to VDRkit

Security problems go through [SECURITY.md](SECURITY.md), never a public issue or pull request.

Thanks for wanting to help. If you're planning anything bigger than a small fix, please open an issue first so we can agree on the approach before you write code. Nobody enjoys having a weekend's work turned down over a design question. You'll also need to sign the [Contributor Licence Agreement](CLA.md) once, on your first pull request.

Keep discussion civil and on topic. Maintainers may close or remove issues, comments and pull requests, and block anyone who disrupts the project.

## Setting up

You need Node 22 or later (CI runs 22), Git, and pnpm 9.15.4, which is pinned in `package.json`. We recommend getting pnpm through Corepack: run `corepack enable` once, or put `corepack pnpm@9.15.4` in front of each command if you'd rather leave your global setup alone. Line endings are LF everywhere, Windows included; `.gitattributes` takes care of that.

You don't need a database server or Docker for everyday work. The tests and the development stack run Postgres in-process with PGlite.

```sh
git clone https://github.com/vdrkit/vdrkit.git
cd vdrkit
pnpm install
pnpm --filter @vdrkit/core build
```

### The development stack

```sh
pnpm dev:stack                                  # Next.js on 3100, the API on 3101, with the Project Heron demo
pnpm dev:stack -- --reset                       # reload the demo data
pnpm dev:stack -- --sign-in                     # real sign-in instead of the persona pill
pnpm dev:stack -- --sign-in --empty --reset     # an empty installation, with first-run setup at /setup
pnpm dev:stack -- --no-real-mail                # never send real email, whatever .env says
pnpm dev:stack -- --port 3200 --api-port 3201   # a second copy beside the first
```

Then open <http://127.0.0.1:3100/>. The "Prototype" pill in the bottom right corner switches between demo users, and Ctrl C stops both servers. There's more in [docs/development.md](docs/development.md).

With no mail settings, emails end up in the log and a dev mailbox. Be careful if your `.env` points at a real mail server: the stack will then send real email unless you pass `--no-real-mail`.

Don't commit `.env` or anything else containing passwords, keys or tokens. `.env.example` lists the settings without values.

## Running the tests

CI (`.github/workflows/ci.yml`) runs these from the repository root:

```sh
pnpm turbo run typecheck                                          # every package
pnpm turbo run lint                                               # ESLint, every package
node --test docker/throwaway.test.mjs                             # the smoke test's and drills' guards, no Docker
pnpm --filter @vdrkit/core exec vitest run --maxWorkers=4         # core: permission engine, migrations, events
pnpm --filter @vdrkit/server exec vitest run --maxWorkers=4       # the API and the worker
```

vitest 4 dropped `--minWorkers` and `poolOptions`; limit workers with `--maxWorkers` only. To run a single file, use something like `pnpm --filter @vdrkit/server exec vitest run test/viewer.test.ts`.

The suites are heavy, and running them flat out will make most laptops unusable for a while. We keep vitest at `--maxWorkers=4` and Playwright at `--workers=2`, and run one full suite at a time.

### Against a real Postgres

PGlite runs everything as one superuser, and a superuser skips row-level security entirely, so a policy mistake can pass every PGlite test. If you change SQL, migrations or permissions, please run both suites against a throwaway Postgres 17 as well:

```sh
docker run -d --name vdrkit-pg17-test -e POSTGRES_PASSWORD=<password> -p 127.0.0.1:55432:5432 postgres:17
TEST_DATABASE_URL=postgres://postgres:<password>@127.0.0.1:55432/postgres pnpm --filter @vdrkit/core test:pg --maxWorkers=4
TEST_DATABASE_URL=postgres://postgres:<password>@127.0.0.1:55432/postgres pnpm --filter @vdrkit/server test:pg --maxWorkers=4
```

Each test file creates and drops its own database. Never point them at a Postgres with real data in it.

### End-to-end tests (Playwright)

```sh
pnpm --filter @vdrkit/dataroom exec playwright install chromium   # once
pnpm --filter @vdrkit/dataroom exec playwright test --workers=2   # Chromium, starts the API and next dev itself
pnpm --filter @vdrkit/dataroom build
E2E_PROD=1 pnpm --filter @vdrkit/dataroom exec playwright test --workers=2   # against next start, after a build
```

A full run starts from a fresh database. While you're working on one spec, `E2E_KEEP_DB=1` reuses it and saves a lot of waiting.

For other browsers, run one of these from `apps/dataroom` after `npx playwright install firefox webkit`:

```sh
pnpm test:e2e:firefox
pnpm test:e2e:webkit      # desktop Safari's engine
pnpm test:e2e:edge        # uses the Edge installed on the machine
pnpm test:e2e:browsers    # Firefox, WebKit, then Edge
```

Anything after `--` goes to `playwright test`, for example `pnpm test:e2e:webkit -- e2e/bulk-import.spec.ts --workers=2`.

The user flow specs are `e2e/flow-*`, and [docs/testing.md](docs/testing.md) walks through them. The accessibility specs are `e2e/a11y-*` ([docs/accessibility.md](docs/accessibility.md#running-the-checks) says how to run them). The load tests live in `scripts/load`, with [docs/performance.md](docs/performance.md) alongside.

### When you change an API route

Regenerate the front end's API types and commit them with the change:

```sh
pnpm --filter @vdrkit/dataroom api:types
```

## What we look for in a change

A fix should come with a test that fails without it. Put feature tests at the level where the feature lives, whether that's core, server or end to end.

We're strict about permissions. All permission checks go through `effective_level()` and the functions built on it, and we won't merge a second path, however convenient it looks. A refused item has to look exactly like one that doesn't exist. Actions and their audit entries are written in the same transaction. If you touch grants, row-level security, the audit log or who can see what, say so in the pull request so the reviewers know where to look.

Screens have to meet WCAG 2.2 AA; run the `a11y-*` specs for anything you change. Layout changes are worth talking through before you build them: open an issue with before and after screenshots.

Text on screen and in email is British English. Keep sentences short and make buttons say what they do. The product name is written VDRkit; file, package and domain names use lower case `vdrkit`.

Pin dependencies to exact versions, and run `pnpm audit` before you add a new one. We'd generally rather have fewer.

### Licence headers

CI checks that every source file and script starts with an SPDX comment:

- `// SPDX-License-Identifier: AGPL-3.0-only` in TypeScript and JavaScript
- `-- SPDX-License-Identifier: AGPL-3.0-only` in SQL
- `# SPDX-License-Identifier: AGPL-3.0-only` in shell scripts, after the `#!` line

It goes above `'use client'` or `'use server'` if the file has one. Run `node scripts/check-spdx.mjs` to check, or `node scripts/check-spdx.mjs --fix` to add what's missing. Generated files such as `apps/dataroom/src/api/schema.d.ts` are skipped.

## Commits

`git log` is the best guide. Subjects are plain English, say what changed for the user, and usually start with the area: `Viewer: a failed open no longer leaves the viewer opening for ever`. We don't use `feat:` or `fix:` prefixes. Dependency bumps give the versions and the reason, like `fastify 5.2.1 -> 5.12.5: auth bypass via malformed URLs`.

The body explains why, and mentions the tests you added or changed. Wrap it at about 100 characters. Keep one topic per commit, and please don't mix refactoring with behaviour changes; it makes review much harder than it needs to be. Add `Co-Authored-By:` lines for co-authors.

## Pull requests

Fork the repository, branch from `main`, and open your pull request against `main` with the template checklist filled in. Run the typecheck and whichever suites your change touches before you do.

The CLA bot will ask you to sign if you haven't yet, and we can't merge until every author on the pull request has. After that a maintainer reviews it. Anything touching permissions, sign-in, the audit log or encryption is reviewed by two maintainers.

## The CLA

VDRkit is licensed under the [AGPL-3.0](LICENSE), and contributors also sign [CLA.md](CLA.md). You keep the copyright in your work and give the project a permanent, irrevocable licence to use it as part of VDRkit, including under other licences. That lets Shibula (Pty) Ltd offer VDRkit under other terms as well, while your contribution stays available under the AGPL-3.0. If you're contributing as part of your job, check with your employer first.

The CLA Assistant bot comments on your first pull request with a link to the agreement. To sign, reply on the pull request with exactly:

```text
I have read the CLA Document and I hereby sign the CLA
```

That covers all your future pull requests too. Comment `recheck` if the check needs rerunning.

### Setting up the CLA check (maintainers)

The workflow is `.github/workflows/cla.yml`. A repository admin has to create two things for it.

First, a private repository, `vdrkit/cla-signatures`, with `main` as its default branch. The bot writes `signatures/version1/cla.json` there on its first run. It never pushes to this repository.

Second, a repository secret named `CLA_SIGNATURES_TOKEN`. Use a fine-grained personal access token or a GitHub App token with "Contents: read and write" on `vdrkit/cla-signatures` and no other permissions, and add it under Settings, Secrets and variables, Actions.

Then make the "Contributor licence agreement" check required on `main`. If CLA.md changes in substance, set `path-to-signatures` to `signatures/version2/cla.json` and everyone will be asked to sign again.

## Releasing (maintainers)

A release is a tag. Set the same version in `apps/server/package.json`, `apps/dataroom/package.json`, `packages/core/package.json` and `VDRKIT_TAG` in `.env.example`, add its entry to `CHANGELOG.md`, merge, then tag that commit `v<version>` and push the tag.

`.github/workflows/release.yml` does the rest in two jobs. The first can only read the repository. It refuses a tag whose commit isn't on `main`, checks that the tag matches the version in the code, builds the image and runs the Compose smoke test on it. The second checks out nothing and installs nothing. It loads the image the first job tested, makes sure it's the same image, and only then pushes it to `ghcr.io/<owner>/vdrkit:<version>` and opens the GitHub release. The token that can write packages and releases lives in that second job alone, where no dependency's install script ever runs.

We don't publish a `latest` tag; an installation names the version it runs. A version with a suffix, such as `1.1.0-rc.1`, becomes a pre-release on GitHub. The update check in Site settings only looks at the address in `VDRKIT_UPDATE_URL`, and GitHub's latest-release address never names a pre-release, so installations using it won't hear about release candidates. The check counts `1.1.0-rc.1` as older than `1.1.0`, which means an installation running a release candidate is told when the release is out.

## Licence

By contributing you agree that your contribution is licensed under the AGPL-3.0, and under the terms of the CLA once you have signed it.
