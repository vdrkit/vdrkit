# Accessibility

VDRkit release 1 aims to meet WCAG 2.2 at level AA. Every release 1 screen passes axe with zero violations, and so do the checks we could script beyond what axe looks at. One part doesn't conform, and it's a big one: the viewer shows document content as watermarked page images, which a screen reader can't read. Nobody has tested with a screen reader yet either.

We'll publish a formal VPAT after the pilot. Until then, this page is our accessibility statement.

## Conformance

We test against WCAG 2.2 levels A and AA, on every screen in release 1, for every role, in light and dark mode. Emails, downloaded PDF files and Q&A (which isn't in release 1) are out of scope. On every screen and state we tested, VDRkit conforms, apart from the limitations further down.

The tests run in Playwright's Chromium with axe-core 4.10, through `@axe-core/playwright`. We haven't yet tested with screen readers (NVDA, JAWS, VoiceOver or TalkBack), in Firefox or Safari, in Windows High Contrast, or with speech input.

## How it was tested

### axe

`apps/dataroom/e2e/a11y-axe.spec.ts` runs axe with the tags `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa` and `wcag22aa` on every screen, in light and dark mode, signed in as each role. It also opens the menus, dialogs, drawers and panels, and checks the empty states of a new room. `a11y-signin.spec.ts` does the same for signing in, against the real server, and `first-run-setup.spec.ts` covers first-run setup.

The bar is zero violations, and we'd like to keep it there. `ALLOWED` in `apps/dataroom/e2e/a11y-helpers.ts` is empty. `EXCLUDED` holds a single element, the watermark preview described under [Exception](#exception).

### Scripted checks axe cannot make

Some criteria need someone pressing keys or resizing the window, so `apps/dataroom/e2e/a11y-keyboard.spec.ts` does that itself.

It tabs through the main screens and the outside pages until focus comes back round, and fails if focus gets stuck (2.1.1, 2.1.2). In a room, the first Tab has to reach "Skip to the page" (2.4.1). Every Tab stop must have a visible outline or ring, be on screen (2.4.3, 2.4.7) and not be hidden under a sticky bar, list or panel (2.4.11). In each dialog, focus moves in, a long run of Tab and Shift Tab presses stays inside, and Escape closes it and puts focus back where it was. Menus move with the arrow keys and close the same way. Quick search is a combobox using `aria-activedescendant`, and tab strips move with arrow keys and name their panel. At 390 px wide the closed room menu is out of the tab order, and when it's open, Tab stays inside it.

The layout checks are mostly about zoom and spacing. On the screens it covers, every control is at least 24 by 24 px or has 24 px of clear space around it (2.5.8). At 320 by 640 CSS px nothing scrolls sideways except tables, the permission matrix and the document pages, each in its own box (1.4.10), and the same holds at 640 px wide, which is 200% of 1280 (1.4.4). With the WCAG text-spacing overrides applied, no text is cut off (1.4.12). Field borders, the focus ring and the top-bar icons reach 3:1 in both modes (1.4.11). With reduced motion set, transitions and animations stop (2.3.3).

The rest checks structure: `lang="en-GB"`, a title naming the screen, one `main`, navigation, one `h1` and no skipped heading levels (1.3.1, 2.4.2, 2.4.6, 3.1.1). Leaving the name out when creating a room sets `aria-invalid` and `aria-describedby` (3.3.1, 3.3.3). Upload progress and toasts go into live regions that exist before the message arrives (4.1.3).

Every drag action has another way to do it (2.5.7): Choose files and Choose a folder for uploads, the document menu for a new version, and number boxes or a "Change the number" button for ordering.

The sign-in spec also checks the six code boxes. A pasted code fills all of them from any box, and a browser that autofills the whole code into one box has it spread over all six (3.3.8). The invited address is shown rather than asked for again (3.3.7), and the email and name fields carry `autocomplete` (1.3.5).

`a11y-retry.spec.ts` covers uploads that retry after a connection problem. The per-second countdown is hidden from screen readers, which hear one polite announcement instead. "Try again" keeps focus in the dialog even after the button disappears; busy buttons use `aria-disabled` rather than `disabled` so they hold on to focus. Storage is stubbed, so the test adds nothing to the room.

### Running the checks

The specs run in the `chromium` project along with the rest of the end-to-end tests:

```sh
cd apps/dataroom
corepack pnpm@9.15.4 exec playwright test e2e/a11y- --project=chromium --workers=2
corepack pnpm@9.15.4 exec playwright test e2e/first-run-setup.spec.ts --project=setup
```

## The document viewer

The viewer's controls work with a keyboard and a screen reader. The document name is the `h1`, and the page area is a `main` region named "<document>, pages". Each page is a region named "Page 3 of 12", the same text as its image's `alt`. The pages take focus when a document opens and scroll with the arrow keys, Page Up, Page Down, Home and End. Zoom in and Zoom out announce the new level. The room menu and, below 900 px, the details panel are modal dialogs.

J and K move to the next and previous document, but only while focus is on the pages, the page strip or the details panel. That way a speech user talking to the toolbar won't change document by accident (2.1.4). The buttons declare the keys with `aria-keyshortcuts`.

The content itself doesn't conform. Each page is an image rendered on the server with the reader's watermark, and a screen reader hears "Page 3 of 12" and nothing more. That fails 1.1.1 and 1.4.5 for document content. You could argue the 1.4.5 exception for essential images of text covers the watermark, but it doesn't cover what's underneath. Page images keep their shape and scroll sideways at high zoom, which 1.4.10 allows for two-dimensional content. Colours inside a page come from the uploaded file.

What a reader can do instead depends on their access. A group with Original access can download the file and read it in their own reader. Groups with PDF download get the watermarked PDF; whether that keeps a text layer depends on the source file, and we haven't tested it. A group with View only access has no accessible way to read the content at all. A screen-reader text version isn't planned for release 1.

## Changes made to pass

### Colours

Four design tokens failed contrast, and each moved to the nearest passing shade of the same hue:

| Token | Mode | Value | Contrast now |
| --- | --- | --- | --- |
| `--muted` | light | `#626E7B` | 4.51:1 or more on every surface (1.4.3) |
| `--muted` | dark | `#909EAC` | 4.53:1 on a selected row |
| `--subtle` | light | `#7D8B9B` | 3:1 or more (1.4.11) |
| `--subtle` | dark | `#6E7F94` | 3.03:1 on a selected row |
| `--field-line` | light | `#7D8B9B` | 3.48:1 (1.4.11) |
| `--field-line` | dark | `#6E7F94` | 3.66:1 |

`--muted` is for secondary text such as captions, hints, table headers and dates. `--subtle` is for chevrons, grips and rules; text that used it now uses `--muted`. `--field-line` is new and draws the borders of text boxes, selects, radios and switch tracks, which previously used `--line-strong` at 1.44:1. The logo previews had hard-coded copies of these colours, which we updated, and the links under those previews keep their tile's colour (`#0F5568` on white, `#7CCBE2` on dark). Past rooms in My rooms, and folders a contributor can't add to, are now drawn at full opacity instead of faded.

### Structure, keyboard and forms

Most of the remaining fixes were about structure. Table rows in Documents, Activity and People now have real cells and column headers, and release-review rows, which sat outside any table, are list items (1.3.1, 4.1.2). Activity rows used `aria-pressed`; the name in each row is now a toggle button. The People group header and the upload drop zone had nested controls, so the chevron is now the toggle and the drop zone is no longer a button. Quick search had `aria-expanded` on a plain search box and became a proper combobox. The tab strips in People and Permissions held a link and had no panels; they now have a separate tab list, named panels and arrow keys. The organisation mark had `aria-label` on a `span` and is now an image with that name. People and the in-room "Page not available" page gained titles (2.4.2). On a phone, the dashboard's bidder table scrolled sideways without being able to take focus, and screen-reader-only text in a scrolling table widened the page; both are fixed.

Keyboard and focus took the most work. Tab escaped most dialogs, so every dialog, drawer and panel now uses the shared `useModal` in `src/lib/a11y.ts` (2.4.3, 2.1.2). There was no way past the room menu until we added "Skip to the page" (2.4.1). Menu focus was shown as a background at 1.04:1, which you could barely see; it's now a 2 px accent ring, and some fields and the viewer's page area got rings they didn't have (2.4.7). The closed phone menu stays out of the tab order until it's opened. The time zone list and the viewer's details panel used to cover the focused element, and sticky bars could cover a field scrolled into view by Tab; the list now closes at once, the panel takes focus, and scroll padding handles the bars (2.4.11). Menus now answer arrow keys, Home and End, and the see-as menu holds focus while it loads. The viewer's pages can take focus so they scroll by keyboard, and J and K now work only from the pages, the page strip and the details panel, not wherever focus is (2.1.4).

On forms, autofill used to put a single digit into the code boxes; now several digits at once fill from that box, and a paste fills all six (3.3.8). Errors in sign-in, setup, room settings, site settings and several dialogs are linked to their fields with `aria-invalid` and `aria-describedby` (3.3.1, 1.3.1), and site-settings hints moved out of the label to become the field's description. Upload progress used to live only on a disabled button and some toasts arrived together with their live region; there's now a live region for progress, and toasts go into a status region that's already there (4.1.3). Transitions switch off under `prefers-reduced-motion` (2.3.3).

### Exception

The Watermark tab in room settings shows a sample page with the watermark at 30% strength, as faint as on real pages. 1.4.3 exempts text that is part of a picture. The sample is a single image named with the watermark text, and the same words label the check boxes beside it at full contrast. axe excludes `.f3 .wm`.

## Known limitations

The biggest one is the viewer, which shows document content as images; we've accepted that for release 1. We also haven't used a screen reader yet, so what we've checked is the structure, not what it's like to use. Testing so far has been in Chromium only, and Firefox and Safari draw focus rings, date fields and code boxes differently.

A few smaller gaps. Errors about several fields at once, such as "Fill in all four fields" in setup, are announced but not linked to a field, and in a few less common dialogs in People, Timeline and My team, field errors still sit inside the label and are read as part of the name. The idle sign-out dialog keeps focus and allows at least two minutes (2.2.1) but hasn't been through axe, and neither has the authenticator-code step for returning users on its own. We don't check what people upload or type, so a low-contrast logo stays low-contrast. Windows High Contrast is untested: focus rings use `outline`, which survives forced colours, but the tinted level labels and switches may not.

## Screen reader checklist

This is the test we most need someone to run. Use the seeded Project Heron room, once with NVDA and Firefox on Windows and once with VoiceOver and Safari on macOS, then repeat sign-in and the dashboard on an iPhone. Budget about half a day per pairing. Write down what was announced, and anything missing, wrong or said twice.

The scripted tests already cover focus order, dialogs trapping focus and the tab strips, so this list is about what is actually spoken.

Sign in:

- [ ] Title and `h1` announced on arrival.
- [ ] The email field reads as "Work email, edit text". A bad address produces an error that is read out at once and again when the field gets focus.
- [ ] The code boxes read "Code from the email, digit 1 of 6" and so on.
- [ ] Accept invitation says which step you are on, and the email is read-only.
- [ ] The QR code in two-factor set-up isn't read as gibberish, and the manual key comes out in groups.
- [ ] The NDA can be read line by line.

In a room:

- [ ] Landmarks list shows banner, navigation and main.
- [ ] Each folder in the index reads its number, name and document count, and says expanded when open.
- [ ] Typing in quick search announces the number of matches.
- [ ] The account and see-as menus announce how many items they have.
- [ ] On the iPhone, swiping stays inside the open room menu.
- [ ] The document table reads number, name, status, pages and date for each row, under its column headers.
- [ ] The document menu names the document it belongs to.
- [ ] Upload progress ("Adding 3 of 10 files") is spoken without moving focus. So are toasts such as "1 change saved".
- [ ] In Edit index, each number box says which document it is for.
- [ ] Viewer: name, pages region and "Page 1 of 12" are announced, and Zoom in reads the new level. The page content itself will not be read.

Admin screens:

- [ ] People: the chevron says "Show the people in …".
- [ ] Permissions: a matrix cell reads group, folder and level; the cell panel is a radio group.
- [ ] Settings: an unsaved change is announced on its tab.
- [ ] Activity: the group name toggle says pressed, and the log reads one entry per row with its day.
- [ ] Release review: selecting drafts announces the count, and the Publish dialog says what will happen.
- [ ] Every form field across People, Settings, Timeline, Profile, My team, Site settings and Create a room has a name, and its error is read both when it appears and on return to the field.

Timing and system settings:

- [ ] "Are you still there?" takes focus and reads its countdown once.
- [ ] At 200% and 400% browser zoom nothing is cut off.
- [ ] In Windows High Contrast, focus rings, switches, check boxes and level labels are still visible.
- [ ] With reduce motion on, the menu drawer and panels appear without sliding.
