//! Runtime connection and account authority for offline work.

use super::*;

/// Read the connection owner's verdict; only Unreachable enables offline mode.
pub(in crate::desktop) fn connection_state(status: &ServerStatus) -> &'static str {
    match status.connection.state {
        ConnectionState::Connecting => "connecting",
        ConnectionState::Connected => "connected",
        ConnectionState::Unreachable => "unreachable",
        ConnectionState::NeedsAuth => "needs-auth",
        ConnectionState::WrongNest => "wrong-nest",
        ConnectionState::Unchosen => "unchosen",
    }
}

pub(in crate::desktop) fn offline_now(runtime: &Runtime) -> bool {
    runtime.preferences.offline_mode || is_offline(connection_state(&runtime.server))
}

pub(in crate::desktop) fn scope(runtime: &Runtime) -> ShellResult<Scope> {
    if connection_state(&runtime.server) == "wrong-nest" {
        return Err(ShellError::Guard("wrong-nest"));
    }
    let account = runtime
        .credentials
        .get(&runtime.credential_key())
        .and_then(|c| c.user_id.as_deref())
        .filter(|s| !s.is_empty())
        .ok_or(ShellError::Guard("account-required"))?;
    let instance = runtime
        .server
        .instance_id
        .as_deref()
        .or_else(|| {
            runtime
                .preferences
                .nest_addresses
                .get(&runtime.configured_origin)
                .and_then(|n| n.instance_id.as_deref())
        })
        .ok_or(ShellError::Guard("nest-identity-required"))?;
    Scope::new(instance, account).map_err(storage_error)
}

/// Only the reachability owner can authorize requests. Capture credentials once;
/// every commit is fenced against account/nest switches (including WrongNest).
pub(super) fn connected_scope(
    state: &DesktopState,
    expected: &Scope,
) -> ShellResult<(String, String)> {
    let r = state.runtime()?;
    if connection_state(&r.server) != "connected" || offline_now(&r) || scope(&r)? != *expected {
        return Err(ShellError::Guard("offline"));
    }
    Ok((r.backend_origin.clone(), r.token.clone()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn offline_mode_reads_only_the_connection_owners_state() {
        let mut runtime = crate::desktop::tests::remote_runtime("http://nest", "http://nest");
        for state in [
            ConnectionState::Connecting,
            ConnectionState::Connected,
            ConnectionState::Unreachable,
            ConnectionState::NeedsAuth,
            ConnectionState::WrongNest,
            ConnectionState::Unchosen,
        ] {
            runtime.server.connection.state = state;
            // Deliberately contradict the legacy fields: none is authoritative.
            runtime.server.reachable = state == ConnectionState::Unreachable;
            runtime.server.starting = state == ConnectionState::Unreachable;
            runtime.server.problem = Some("needs-auth".into());
            assert_eq!(offline_now(&runtime), state == ConnectionState::Unreachable);
        }
    }
}
