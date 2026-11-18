# <feature> — one line on what it lets someone do

<!-- Written by /port before any code. The three apps build from this page; a
     rule they must all apply the same way goes in contracts/<feature>.json as
     cases, and this page links to it. UI copy uses English source keys; add the
     English and Spanish catalog lines by hand. -->

## What it does

Two or three sentences, from the user's side of the screen.

## Server

Routes added or changed (method, path, body, answer, error codes and what each
means). Additive only — see API_COMPATIBILITY.md. "none" if the server is
untouched.

## States and controls

| when | the row/screen shows | tapping it does |
|---|---|---|
| … | … | … |

## Copy (exact strings)

| where | text |
|---|---|
| button | "…" |
| confirm title / detail | "…" / "…" |
| success / failure | "…" / the server's sentence |

## Decided per app on purpose

What may differ by platform (icon vs text, sheet vs dialog) and why. Anything
not listed here must match across the three apps.

## Pinned by

`contracts/<feature>.json` — the cases (input → answer) every suite runs.
`contracts/wire/<route>.json` — recorded bodies for new routes.

## Not in scope

…
