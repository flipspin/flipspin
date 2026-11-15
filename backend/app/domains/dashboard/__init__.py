"""Cache dashboard chart and editorial rows to limit shared provider quota use.

Serve stale rows after provider failure so one unavailable source cannot blank
the page."""
