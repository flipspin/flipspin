# Per-job keep awake

The shell starts an idle loopback TCP server for each agent launch and exports
`KROBI_KEEP_AWAKE_ADDR=127.0.0.1:<ephemeral port>`. An empty value means the shell
could not start it. No account credential is sent over this connection.

**Worker integration required** (worker/ is owned separately):

1. For each job (lyrics, stems, batch), connect to that address. Set a bounded
   socket timeout (for example 5 seconds). Send one UTF-8 JSON line:
   `{"pid": <job subprocess pid>}\n` (positive u32).
2. Read one JSON line: `{"keepAwake":"held"}` or `{"keepAwake":"failed"}`.
   Retain the socket for this job. Never acquire for the idle agent's lifetime.
3. Put that exact `keepAwake` value in every lyrics/stems heartbeat and helper
   identity while the job runs. Missing/empty address, connect/read failure,
   invalid reply or lost connection means **failed**, never held. Use `none`
   while idle. A failed assertion must not stop processing.
4. Close the socket in the job's `finally` block on success, failure, cancellation
   and shutdown. The shell drops the assertion on EOF or app shutdown. Do not
   inherit the socket into subprocesses. A later job opens a fresh connection.
5. When this hand-off is configured, replace the worker's `_caffeinate` call
   with this protocol, including `_run_batch_process`; do not acquire twice.
   The legacy caffeinate path can remain for older shells without the variable.

The shell serializes jobs on one owning thread (the worker already processes one
job at a time). macOS uses `/usr/bin/caffeinate -i -w <pid>`; Windows checks
`SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)` and clears it with
`ES_CONTINUOUS` on that same thread; Linux holds the fd returned by logind's
`Inhibit("sleep:idle", "Krobi", "procesando", "block")`.

The Rust tests exercise each adapter with fake OS calls, including refusal,
resource release and Windows thread ownership. The fake-transport protocol test verifies the
exact success/failure reply and release on disconnect. **Actual heartbeat
propagation is pending**; this shell does not modify heartbeat payloads.
No assertion promises to prevent lid close or explicit sleep.

# Login-item bridge

`system:login-item-get` takes no request. `system:login-item-set` takes
`{enabled: boolean}`. Both return fresh OS state:

```
{ supported, enabled, status, error? }
```

`status`: `enabled | disabled | requires-approval | not-found | unknown |
unsupported`. `error`: `unsupported-platform | registration-failed | read-failed |
invalid-executable`. Set rereads the OS even when registration fails. There is no
stored preference or automatic registration: opening at login is off by default.

macOS 13+ uses SMAppService.mainAppService directly via objc2. It requires a
properly signed app bundle; an unbundled debug executable may report `not-found`
or fail registration. Older macOS reports unsupported. Windows writes only its
HKCU Run value and preserves StartupApproved; a Task Manager denial returns
`requires-approval`, never an optimistic enabled state. Linux reads the current
XDG autostart file and honors Hidden and X-GNOME-Autostart-enabled. AppImage
registration uses APPIMAGE rather than its temporary mount's executable.
