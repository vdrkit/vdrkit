# Screen codes

Code comments, tests and CSS class names refer to screens by a short code: a letter for the area and a number for the screen, so C2 is Documents. Users never see the codes. This page is the key, for when you meet `.d1-drop` in a stylesheet and wonder what it is.

## A: Signing in and your account

| Code | Screen | Where |
|---|---|---|
| A1 | Sign in | `/sign-in` |
| A2 | Accept invitation | `/invite/...` |
| A3 | NDA acceptance | `/rooms/<room>/nda` |
| A5 | Profile and notifications | `/rooms/<room>/profile` |

A1 is the whole sign-in, authenticator code included. A2 also takes care of two-factor set-up when the room requires it.

## B: Rooms

| Code | Screen | Where |
|---|---|---|
| B1 | My rooms | `/rooms` |
| B2 | Create a room | `/rooms/new` |

## C: Inside a room

| Code | Screen | Where |
|---|---|---|
| C1 | Room dashboard (bidder and admin) | `/rooms/<room>/dashboard` |
| C2 | Documents | `/rooms/<room>/documents` |
| C3 | Document viewer | `/rooms/<room>/view/...` |
| C4 | Search results | `/rooms/<room>/search` |
| C5 | Request to add a colleague | dialog in My team |
| C6 | My team (bidder leads) | `/rooms/<room>/team` |

## D: Documents, seller side

| Code | Screen | Where |
|---|---|---|
| D1 | Upload | in Documents |
| D2 | Document details | `/rooms/<room>/details/...` |
| D3 | Release review | `/rooms/<room>/release` |

## E: People and access

| Code | Screen | Where |
|---|---|---|
| E1 | People | `/rooms/<room>/people` |
| E2 | Invite people | in People |
| E3 | Permission matrix | `/rooms/<room>/permissions` |
| E4 | Access requests | in People |
| E5 | Group or person details | in People |

Revoking access, setting an end date and restoring access all happen in E5.

## F: Running the room

| Code | Screen | Where |
|---|---|---|
| F1 | Activity log | `/rooms/<room>/activity` |
| F2 | Timeline | `/rooms/<room>/timeline` |
| F3 | Room settings | `/rooms/<room>/settings` |

## G: The installation

| Code | Screen | Where |
|---|---|---|
| G1 | First-run setup | `/setup` |
| G2 | Site settings | `/site/settings` |

## H: Shared states and email

| Code | What | Where |
|---|---|---|
| H1 | Error pages ("This page is not available", "Signed out") | throughout |
| H2 | Empty states | throughout |
| H3 | Emails | `apps/server/src/mail` |

Some comments number the empty states too, as in "H2 state 5".

The gaps are deliberate. A4, A6, C7, C8, D4 to D8 and F4 to F6 are kept free for later features such as Q&A and redaction, so please don't reuse them.
