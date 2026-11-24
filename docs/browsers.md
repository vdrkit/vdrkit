# Browsers

We support the current and previous major versions of Chrome, Edge and Firefox, the current Firefox ESR, and Safari 17 and later on macOS. There are no plug-ins and no browser-specific code paths. The build itself targets the Next.js default browser list (Chrome and Edge 111, Firefox 111, Safari 16.4 and later), but the versions above are the ones we test.

The iPad isn't supported yet. We go through it by hand before each release, but we're not ready to promise it.

Day to day we test on Windows: Chrome as Playwright's Chromium, Firefox as Playwright's Firefox, Safari as Playwright's WebKit, and Edge as the copy installed on the machine. The whole suite passed in Chromium, WebKit and Edge. In Firefox one test failed: two tests clashed by importing into the same folder at once, which is not a browser fault. That test has since been fixed but not yet re-run in Firefox.

## Running the tests in other browsers

The Playwright suite runs in Chromium by default, as CI does. To try another browser, run one of these from `apps/dataroom`:

```sh
pnpm test                  # Chromium
pnpm test:e2e:firefox      # Firefox
pnpm test:e2e:webkit       # WebKit, desktop Safari's engine
pnpm test:e2e:edge         # the installed Microsoft Edge
pnpm test:e2e:browsers     # Firefox, WebKit and Edge, one after another
```

Anything after `--` goes to `playwright test`, for example `pnpm test:e2e:webkit -- e2e/bulk-import.spec.ts --workers=2`. Each browser gets the same three projects as Chromium: `<browser>`, `<browser>-signin` and `<browser>-setup`. Against a production build (`E2E_PROD=1`) only `<browser>` runs.

You'll need the browsers once: `npx playwright install firefox webkit`. Playwright doesn't install Edge; the tests use the one already on the machine (channel `msedge`). Production-build checks are skipped unless you set `E2E_PROD=1`.

One WebKit quirk you may trip over: the keyboard test focuses "Skip to the page" directly instead of reaching it with the first Tab. Safari leaves links out of the Tab order by default, and Playwright's WebKit on Windows has no Option+Tab to bring them back.

### Waiting for hydration

If you write new tests, use `page.goto` and `page.reload` from `e2e/fixtures.ts`. They wait until React has hydrated the page (the app sets `data-hydrated` on `<html>`); without that, WebKit would lose text typed into the slow development bundles. A page you make with `browser.newContext()` doesn't get this for free, so call `pageHydrated(page)` after its `goto`, and again after any full page load the app starts itself with `window.location.assign`.

For saves, use `clickAndRefresh`. It clicks Save and waits for the `router.refresh()` that follows, because Firefox aborts a `goto` or `reload` that starts while that refresh is still running.

## Checking by hand

Playwright's WebKit on Windows has Safari's engine but not the rest of Safari: its networking, cookie policy, file dialogs, Finder drag and drop, PDF handling and memory limits are all missing. So before a release, someone sits down at a Mac with the current Safari and goes through this:

1. Sign in with the email link and with the code, and set up two-factor sign-in. Quit Safari and come back; the session and "trust this browser" should still hold.
2. Drag a folder with subfolders from Finder onto Documents and onto Bulk import; the subfolders should keep their names and order. Then drag a folder and a loose file together.
3. Pick a folder with the folder picker in Bulk import.
4. Upload a file of about 4 GB with Activity Monitor open and keep an eye on memory. Close the tab partway through, then resume the bulk import.
5. Open a long PDF on a Retina screen. Zoom with the buttons and by pinching the trackpad, page with the arrow keys, and check the watermark.
6. Download an original and a PDF and look at the file names: they should be right, not saved as `.html` or without an extension.
7. Copy a fingerprint and paste it somewhere.
8. Dark mode, dialog backgrounds, sticky headers in a long folder.

On an iPad, sign in from an email link opened in Mail, read a few documents in both orientations with pinch and swipe, open a dialog with the on-screen keyboard up, and download something into Files.

Once per release, also try Firefox ESR on a machine set to a different time zone from the room.
