//! Managed interpreter setup and package upgrades that preserve extras and models.

use super::*;

// ----------------------------------------------------------------- install

pub(super) fn set_install(
    app: &AppHandle,
    state: &LyricsState,
    feedback: &Feedback,
    f: impl FnOnce(&mut InstallState),
) {
    if let Ok(mut install) = state.install.lock() {
        f(&mut install);
        feedback.progress(app, json!(*install));
    }
}

pub(super) fn run(command: &mut Command, what: &str) -> ShellResult<()> {
    let output = command
        .output()
        .map_err(|e| ShellError::io_context(what, e))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    log_install_error(&stderr);
    Err(ShellError::Message(format!("{what}: {}", stderr.trim())))
}

pub fn install_target(app: AppHandle, target: &str) -> ShellResult<Value> {
    install_target_observed(app, target, Feedback::default())
}

pub(crate) fn install_target_observed(
    app: AppHandle,
    target: &str,
    feedback: Feedback,
) -> ShellResult<Value> {
    if target == "engine" {
        install_runtime_target(app, "engine", feedback)
    } else if ["analysis", "gpu"].contains(&target) {
        install_runtime_target(app, target, feedback)
    } else if ["lyrics", "stems"].contains(&target) {
        repair_target(app, target, feedback)
    } else {
        Err(ShellError::Guard("invalid-request"))
    }
}

pub fn install(app: AppHandle) -> ShellResult<Value> {
    install_target(app, "engine")
}

pub(super) fn install_runtime_target(
    app: AppHandle,
    target: &str,
    feedback: Feedback,
) -> ShellResult<Value> {
    if !supported() {
        return Ok(json!({"started": false, "reason": "unsupported-platform"}));
    }
    if ["gpu", "gpu-remove"].contains(&target) {
        let state = app.state::<LyricsState>();
        let check = helper_check(&state);
        if !installed() || (target == "gpu" && check["engineReady"] != true) {
            return Ok(json!({"started": false, "reason": "not-installed"}));
        }
        if target == "gpu" && check["addons"]["gpu"]["available"] != true {
            return Ok(json!({"started": false, "reason": "gpu-unavailable"}));
        }
    }
    let sources = worker_sources(&app);
    if sources.is_empty() {
        return Ok(json!({"started": false, "reason": "no-worker-source"}));
    };
    let Some(uv) = find_uv(&app) else {
        return Ok(json!({"started": false, "reason": "no-uv"}));
    };
    {
        let state = app.state::<LyricsState>();
        let mut install = lock(&state.install, "lyrics")?;
        if install.running {
            if install.target.as_deref() != Some(target) {
                return Err(ShellError::Guard("installing"));
            }
            return Ok(json!({"started": true, "already": true}));
        }
        *install = InstallState {
            running: true,
            repairing: false,
            target: Some(target.into()),
            phase: Some("entorno".into()),
            percent: None,
            error: None,
        };
        feedback.progress(&app, json!(*install));
    }
    let target = target.to_string();
    thread::spawn(move || {
        let state = app.state::<LyricsState>();
        let result =
            install_steps(&app, &state, &uv, &sources, &target, &feedback).and_then(|()| {
                if target == "analysis" {
                    prefetch_models(&binary(), &target, |percent| {
                        set_install(&app, &state, &feedback, |s| {
                            s.phase = Some("modelos".into());
                            s.percent = percent;
                        })
                    })?;
                }
                Ok(())
            });
        if let Ok(mut hint) = state.check_hint.lock() {
            *hint = None;
        }
        if let Ok(mut cache) = state.check_snapshot.lock() {
            *cache = None;
        }
        set_install(&app, &state, &feedback, |s| {
            s.running = false;
            s.repairing = false;
            s.phase = None;
            s.percent = None;
            s.error = result.as_ref().err().map(ToString::to_string);
            if let Some(error) = &s.error {
                log_install_error(error);
            }
        });
        if result.is_ok() {
            agent_stop(&state);
            let resumed = if target == "analysis" {
                crate::desktop::mac_worker::change(&app, Some(true))
            } else {
                crate::desktop::mac_worker::resume(&app)
            };
            if let Err(error) = resumed {
                crate::desktop::mac_worker::set_error(&app, Some(error.to_string()));
            }
        }
        feedback.finish(result);
    });
    Ok(json!({"started": true}))
}

fn install_steps(
    app: &AppHandle,
    state: &LyricsState,
    uv: &PathBuf,
    sources: &[PathBuf],
    target: &str,
    feedback: &Feedback,
) -> ShellResult<()> {
    if ["gpu", "gpu-remove"].contains(&target) {
        agent_stop(state);
        let mut command = Command::new(binary());
        command.arg("gpu").arg("--uv").arg(uv);
        if target == "gpu-remove" {
            command.arg("--remove");
        }
        engine_env(&mut command);
        return run(&mut command, "change GPU acceleration");
    }
    fs::create_dir_all(tools_dir())?;
    fs::create_dir_all(krobi_home().join("models"))?;

    let mut venv = Command::new(uv);
    // Managed CPython avoids an app-bundled interpreter's separate macOS LAN
    // permission identity, which can refuse helper claims despite shell access.
    venv.args([
        "venv",
        "--python",
        ENGINE_PYTHON,
        "--python-preference",
        "only-managed",
        "--allow-existing",
    ])
    .arg(venv_dir());
    engine_env(&mut venv);
    run(&mut venv, "uv venv")?;

    set_install(app, state, feedback, |s| s.phase = Some("paquetes".into()));
    let check = helper_check(state);
    let (engine, analysis) = selected_extras(&check, Some(target));
    let mut pip = Command::new(uv);
    pip.args(["pip", "install", "--python"])
        .arg(venv_executable("python"))
        .args(["--torch-backend", torch_backend(&check)])
        .args(package_requirements(sources, engine, analysis));
    engine_env(&mut pip);
    run(&mut pip, "uv pip install")?;

    Ok(())
}

pub(super) fn install_log() -> ShellResult<PathBuf> {
    let logs = krobi_home().join("logs");
    fs::create_dir_all(&logs)?;
    Ok(logs.join("helper-install.log"))
}

pub(super) fn log_install_error(detail: &str) {
    use std::io::Write;
    log::warn!("helper install failed: {detail}");
    if let Ok(path) = install_log() {
        if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(path) {
            let _ = writeln!(file, "{detail}");
        }
    }
}

pub(super) fn installed_version() -> Option<String> {
    #[cfg(target_os = "windows")]
    let packages = vec![venv_dir().join("Lib/site-packages")];
    #[cfg(not(target_os = "windows"))]
    let packages = fs::read_dir(venv_dir().join("lib"))
        .ok()?
        .flatten()
        .map(|python| python.path().join("site-packages"))
        .collect::<Vec<_>>();
    for packages in packages {
        let Ok(entries) = fs::read_dir(packages) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if let Some(version) = name
                .strip_prefix("krobi_helper-")
                .and_then(|s| s.strip_suffix(".dist-info"))
            {
                return Some(version.to_string());
            }
        }
    }
    None
}

fn wheel_version(path: &std::path::Path) -> Option<&str> {
    path.file_name()?
        .to_str()?
        .strip_prefix("krobi_helper-")?
        .split('-')
        .next()
}

fn newer(bundled: &str, installed: &str) -> bool {
    let parse = |s: &str| -> Option<Vec<u64>> {
        s.split('.').map(str::parse).collect::<Result<_, _>>().ok()
    };
    match (parse(bundled), parse(installed)) {
        (Some(a), Some(b)) => a > b,
        // A prerelease wheel is older; unknown versions need repair.
        _ => bundled != installed,
    }
}

/// Only replace the package: model caches and the managed interpreter survive.
pub(super) fn update(app: &AppHandle, state: &LyricsState) -> ShellResult<()> {
    let sources = worker_sources(app);
    let Some(wheel) = sources.first() else {
        return Err(ShellError::Guard("no-worker-source"));
    };
    let Some(version) = wheel_version(wheel) else {
        return Ok(());
    };
    if installed_version().is_some_and(|old| !newer(version, &old)) {
        return Ok(());
    }
    let uv = find_uv(app).ok_or(ShellError::Guard("no-uv"))?;
    set_install(app, state, &Feedback::default(), |s| {
        s.running = true;
        s.phase = Some("updating".into());
        s.error = None;
    });
    let mut pip = Command::new(uv);
    pip.args([
        "pip",
        "install",
        "--reinstall-package",
        "krobi-helper",
        "--python",
    ])
    .arg(venv_executable("python"))
    .args(["--torch-backend", torch_backend(&helper_check(state))])
    .args({
        let (engine, analysis) = selected_extras(&helper_check(state), None);
        package_requirements(&sources, engine, analysis)
    });
    engine_env(&mut pip);
    let result = run(&mut pip, "uv pip install");
    set_install(app, state, &Feedback::default(), |s| {
        s.running = false;
        s.phase = None;
        s.error = result.as_ref().err().map(ToString::to_string);
    });
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_errors_keep_context_and_full_stderr_for_diagnostics() {
        let mut missing = Command::new("/nonexistent/krobi-shell-error-test");
        let expected = format!("uv venv: {}", missing.output().unwrap_err());
        let error = run(&mut missing, "uv venv").unwrap_err();
        assert!(matches!(error, ShellError::IoContext { .. }));
        assert_eq!(tauri::ipc::InvokeError::from(error).0, expected);

        #[cfg(unix)]
        {
            let error = run(
                Command::new("sh").args([
                    "-c",
                    "printf 'old\\none\\ntwo\\nthree\\nfour\\n' >&2; exit 1",
                ]),
                "uv pip install",
            )
            .unwrap_err();
            assert_eq!(
                tauri::ipc::InvokeError::from(error).0,
                "uv pip install: old\none\ntwo\nthree\nfour"
            );
        }
    }

    #[test]
    fn package_update_only_when_bundled_is_newer() {
        assert!(newer("0.7.1", "0.6.0"));
        assert!(newer("0.10.0", "0.9.0"));
        assert!(!newer("0.7.1", "0.7.1"));
        assert!(!newer("0.7.1", "0.8.0"));
        assert_eq!(
            wheel_version(std::path::Path::new("krobi_helper-0.7.1-py3-none-any.whl")),
            Some("0.7.1")
        );
    }
}
