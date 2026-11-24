<!-- Fixing an undisclosed security problem? Don't open a public pull request; see SECURITY.md. -->

## What this changes

<!-- What changes for users, and why. Link the issue, e.g. "Closes #123". -->

## How it was tested

<!-- Tests added or changed, and which suites you ran. -->

## Checklist

- [ ] Tests cover the change. For a fix, there's a test that fails without it.
- [ ] `pnpm turbo run typecheck`, `pnpm turbo run lint` and the vitest suites I touched pass (`--maxWorkers=4`).
- [ ] SQL, migrations or permissions changed: the suites also pass on Postgres 17 (`test:pg`).
- [ ] Screens changed: Playwright passes, including the `a11y-*` specs, and keyboard use, focus, labels and colours meet WCAG 2.2 AA.
- [ ] Permission rules, row-level security and the audit log are untouched, or the change is explained below.
- [ ] No secrets, `.env` files, real documents or personal data are included.
- [ ] API route changed: types regenerated (`pnpm --filter @vdrkit/dataroom api:types`).
- [ ] British English on screen and in email, and the product is written "VDRkit".
- [ ] I have signed the [CLA](https://github.com/vdrkit/vdrkit/blob/main/CLA.md), or will when the bot asks.

## Permission or audit changes

<!-- Only if this touches who may see or do what, row-level security, or what is logged. Otherwise delete this section. -->
