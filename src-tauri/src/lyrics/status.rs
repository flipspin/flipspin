//! Cached helper checks and renderer-facing installation and agent status.

use super::*;

// ------------------------------------------------------------------ status

pub fn status(app: &AppHandle, state: &LyricsState) -> Value {
    let install = state.install.lock().map(|s| s.clone()).unwrap_or_default();
    let settings = crate::desktop::mac_worker::settings(app);
    let check = helper_check(state);
    let refresh = !install.running
        && settings["enabled"] == true
        && settings["eligible"] == true
        && state.agent.lock().ok().is_some_and(|mut slot| {
            slot.as_mut()
                .is_some_and(|agent| agent.running() && agent.newly_ready(&check))
        });
    if refresh {
        // The worker operation lock serializes concurrent status polls. Start
        // rechecks readiness under that lock, so only one poll restarts it.
        if let Err(error) = crate::desktop::mac_worker::resume(app) {
            crate::desktop::mac_worker::set_error(app, Some(error.to_string()));
        }
    }
    let agent_running = state
        .agent
        .lock()
        .ok()
        .map(|mut child| match child.as_mut() {
            Some(agent) => agent.running(),
            None => false,
        })
        .unwrap_or(false);
    let local: Value = if settings["enabled"] == true {
        fs::read(status_path())
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or(Value::Null)
    } else {
        Value::Null
    };
    let mut addons = check["addons"].clone();
    for name in ["lyrics", "stems", "analysis", "gpu"] {
        if !addons[name].is_object() {
            addons[name] = json!({"installed": false, "ready": false, "sizeBytes": null});
        }
        addons[name]["installing"] = json!(
            install.running
                && (install.target.as_deref() == Some(name)
                    || (name == "gpu" && install.target.as_deref() == Some("gpu-remove")))
        );
        let recorded = state
            .addon_errors
            .lock()
            .ok()
            .and_then(|errors| errors.get(name).cloned());
        addons[name]["error"] = json!(addon_error(name, recorded, &install));
    }
    let mut facts = hardware();
    facts["accel"] = if check["accel"].is_string() {
        check["accel"].clone()
    } else {
        json!(if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
            "mlx"
        } else {
            "cpu"
        })
    };
    json!({
        "engineReady": check["engineReady"],
        "addons": addons,
        "enabled": settings["enabled"],
        "eligible": settings["eligible"],
        "tray": settings["tray"],
        "workerId": settings["workerId"],
        "hardware": facts,
        "version": installed_version(),
        "sizeBytes": engine_size().map(|bytes| bytes.saturating_sub(
            check["addons"]["analysis"]["runtimeBytes"].as_u64().unwrap_or(0)
                + check["addons"]["gpu"]["runtimeBytes"].as_u64().unwrap_or(0)
        )),
        "local": local,
        "worker": state.nest_worker.lock().map(|v| v.clone()).unwrap_or_default(),
        "workerError": state.worker_error.lock().ok().and_then(|v| v.clone()),
        "supported": supported(),
        "installed": installed(),
        "hint": if install.repairing && install.running { "models-missing".into() } else { engine_hint(state, install.running) },
        "agentRunning": agent_running,
        "installing": if install.running { json!({"phase": install.phase, "percent": install.percent, "repairing": install.repairing, "target": install.target}) } else { Value::Null },
        "installError": if matches!(install.target.as_deref(), Some("gpu" | "gpu-remove")) { None } else { install.error },
        "uv": find_uv(app).is_some(),
        "workerSource": worker_sources(app).first().map(|p| p.display().to_string()),
        "toolsDir": tools_dir().display().to_string(),
        "modelsDir": krobi_home().join("models").display().to_string(),
    })
}

/// An add-on's own failure: a model repair records it per add-on, and a runtime
/// install (Analysis without the engine, the GPU pack) leaves it on the install
/// it ran, which must reach that add-on's card rather than only the engine's.
fn addon_error(name: &str, recorded: Option<String>, install: &InstallState) -> Option<String> {
    let ran = match install.target.as_deref() {
        Some("gpu-remove") => "gpu",
        other => other.unwrap_or_default(),
    };
    recorded.or_else(|| (ran == name).then(|| install.error.clone()).flatten())
}

pub(super) fn helper_check(state: &LyricsState) -> Value {
    let Ok(mut cache) = state.check_snapshot.lock() else {
        return Value::Null;
    };
    if let Some((at, check)) = cache.as_ref() {
        if at.elapsed() < Duration::from_secs(30) {
            return check.clone();
        }
    }
    if !installed() {
        return Value::Null;
    }
    let mut command = Command::new(binary());
    command.args(["check", "--json"]);
    engine_env(&mut command);
    let check = probe_output(&mut command, Duration::from_secs(3))
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .unwrap_or(Value::Null);
    *cache = Some((Instant::now(), check.clone()));
    check
}

/// Probe this helper, not the remote nest's engine. Never import ML libraries.
fn engine_hint(state: &LyricsState, running: bool) -> String {
    if running {
        return "installing".into();
    }
    if !installed() {
        return "not-installed".into();
    }
    let Ok(mut cache) = state.check_hint.lock() else {
        return "broken".into();
    };
    if let Some((at, hint)) = cache.as_ref() {
        if at.elapsed() < Duration::from_secs(30) {
            return hint.clone();
        }
    }
    let mut check = Command::new(binary());
    check.args(["check", "--json"]);
    engine_env(&mut check);
    let hint = probe_output(&mut check, Duration::from_secs(3))
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .map(|check| {
            if check["engineReady"] == true {
                "ready"
            } else if check["models"]
                .as_object()
                .is_some_and(|models| models.values().any(|v| v == false))
            {
                "models-missing"
            } else {
                "broken"
            }
        })
        .unwrap_or("broken")
        .to_string();
    *cache = Some((Instant::now(), hint.clone()));
    hint
}

pub(crate) fn installing(state: &LyricsState) -> bool {
    state.install.lock().map(|s| s.running).unwrap_or(false)
}

pub(crate) fn installed() -> bool {
    supported() && binary().is_file()
}

fn engine_size() -> Option<u64> {
    if !installed() {
        return None;
    }
    // du does not follow the model cache's symlinks or double-count snapshots.
    // Cache this expensive measurement for one minute.
    static SIZE: Mutex<Option<(Instant, u64)>> = Mutex::new(None);
    let mut cache = SIZE.lock().ok()?;
    if let Some((at, size)) = *cache {
        if at.elapsed() < Duration::from_secs(60) {
            return Some(size);
        }
    }
    // Resolve only the tools directory alias; keep internal model links opaque.
    let tools = tools_dir();
    let tools = tools.canonicalize().unwrap_or(tools);
    let output = Command::new("du")
        .arg("-sk")
        .arg(tools.join("venv"))
        .output()
        .ok()?;
    let size = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|l| l.split_whitespace().next()?.parse::<u64>().ok())
        .sum::<u64>()
        * 1024;
    *cache = Some((Instant::now(), size));
    Some(size)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn failed(target: &str) -> InstallState {
        InstallState {
            target: Some(target.into()),
            error: Some("tempocnn: HTTP 404".into()),
            ..InstallState::default()
        }
    }

    #[test]
    fn a_runtime_install_failure_reaches_its_own_card() {
        let install = failed("analysis");
        assert_eq!(
            addon_error("analysis", None, &install).as_deref(),
            Some("tempocnn: HTTP 404")
        );
        for other in ["lyrics", "stems", "gpu"] {
            assert_eq!(addon_error(other, None, &install), None);
        }
        assert_eq!(
            addon_error("gpu", None, &failed("gpu-remove")).as_deref(),
            Some("tempocnn: HTTP 404")
        );
        assert_eq!(addon_error("analysis", None, &failed("engine")), None);
    }

    #[test]
    fn a_recorded_repair_failure_wins() {
        let recorded = Some("aligner: disk full".to_string());
        assert_eq!(
            addon_error("lyrics", recorded, &InstallState::default()).as_deref(),
            Some("aligner: disk full")
        );
    }
}
