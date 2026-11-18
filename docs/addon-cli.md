# Managing this computer's add-ons from an agent

Set `KROBI_BIN` to the desktop app's executable, then run it directly:

```sh
"$KROBI_BIN" --addon install engine
"$KROBI_BIN" --addon install lyrics
"$KROBI_BIN" --addon install stems
"$KROBI_BIN" --addon install analysis
"$KROBI_BIN" --addon status
"$KROBI_BIN" --addon remove analysis
```

Names are exactly `engine`, `lyrics`, `stems`, and `analysis`. Install the engine
before lyrics or stems. Analysis can be installed on its own. Remove all add-ons
before removing the engine. An operation already in progress returns an error;
wait for it to finish before retrying.

The running desktop app executes the same operations as Settings → Features → Engines,
using its environment, shared virtualenv, extras union, model prefetch and
`addons.json`. Its progress events update an open Engines page. Successful
changes restart the helper when enabled and applicable, so its advertised jobs
reflect the installed add-ons. Worker connectivity failures remain visible in
status (`workerError` and `agentRunning`). No terminal token is needed: the app
owns the worker credentials.

If model prefetch fails, install returns `ok: false` with the prefetch error,
even if the packages were installed. If a later prefetch makes an add-on ready,
`--addon status` or the engine status poll restarts the running, enabled helper
once to advertise the newly ready kind. Readiness probes are cached for up to
30 seconds.

Each progress event is printed as one JSON line containing the unchanged
`lyrics:engine-progress` payload. Install and remove end with one line:

```json
{"ok":true,"addon":"analysis","state":{"addons":{"analysis":{"installed":true}},"agentRunning":true}}
```

`state` is the full `lyrics:engine-status` response (the example is abbreviated).
Failures have `ok: false` and an `error` string. Exit status is 0 for success and
1 for failure. `--addon status` prints just the full bridge status JSON, including
`addons` and `agentRunning`, without a result wrapper or progress lines.

If the app is closed, the command starts it, performs the operation, and returns
while the app keeps running. If it is open, the single-instance mechanism forwards
the request to that instance. Keep the app open until the command finishes.
Closing the terminal does not cancel an operation already accepted by the app.
The app has 60 seconds to initialize after accepting a request. The terminal
waits up to 30 minutes overall, including model downloads. Transient reply socket
errors are retried. A deadline failure prints a final line with `ok: false` and
`error: "timeout"` and exits 1; an app-owned operation can continue afterwards.
