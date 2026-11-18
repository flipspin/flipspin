//! Add-on selection, model prefetch, repair and removal.

use super::*;

/// Existing engines retain their extra on upgrade; analysis-only stays light.
pub(super) fn torch_backend(check: &Value) -> &'static str {
    if check["addons"]["gpu"]["installed"] == true && !cfg!(target_os = "macos") {
        "cu130"
    } else {
        "cpu"
    }
}

pub(super) fn selected_extras(check: &Value, target: Option<&str>) -> (bool, bool) {
    let engine = target == Some("engine")
        || check["engineReady"] == true
        || (check["engineReady"].is_null() && check["ready"] == true)
        || check["packages"]["torch"] == true
        || ["lyrics", "stems"]
            .iter()
            .any(|name| check["addons"][name]["installed"] == true);
    let analysis = target == Some("analysis") || check["addons"]["analysis"]["installed"] == true;
    (engine, analysis)
}

pub(super) fn package_requirements(
    sources: &[PathBuf],
    engine: bool,
    analysis: bool,
) -> Vec<String> {
    let Some(base) = sources.first() else {
        return vec![];
    };
    let mut extras = Vec::new();
    if engine {
        extras.push("engine");
    }
    if analysis {
        extras.push("analysis");
    }
    let suffix = if extras.is_empty() {
        String::new()
    } else {
        format!("[{}]", extras.join(","))
    };
    let mut args = vec![format!("{}{suffix}", base.display())];
    if base.is_file() {
        if let Some(directory) = base.parent() {
            args.extend([
                "--find-links".into(),
                directory.to_string_lossy().into_owned(),
            ]);
        }
    } else if analysis && base.join("keyfinder/pyproject.toml").is_file() {
        args.push(base.join("keyfinder").to_string_lossy().into_owned());
    }
    if engine {
        args.extend(
            sources
                .iter()
                .skip(1)
                .filter(|source| {
                    !source
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .starts_with("krobi_keyfinder-")
                })
                .map(|p| p.to_string_lossy().into_owned()),
        );
    }
    args
}

/// Shared with repair: cached models are reused by the helper.
pub(super) fn prefetch_models(
    helper: &std::path::Path,
    target: &str,
    progress: impl FnMut(Option<u8>),
) -> ShellResult<()> {
    prefetch_models_with_log(helper, target, install_log()?, progress)
}

fn prefetch_models_with_log(
    helper: &std::path::Path,
    target: &str,
    log: PathBuf,
    mut progress: impl FnMut(Option<u8>),
) -> ShellResult<()> {
    let mut prefetch = Command::new(helper);
    prefetch
        .args(["prefetch", "--addon", target, "--json"])
        .stdout(Stdio::piped())
        .stderr(
            fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(log)
                .map(Stdio::from)?,
        );
    engine_env(&mut prefetch);
    let child = prefetch
        .spawn()
        .map_err(|e| ShellError::io_context("prefetch", e))?;
    wait_for_prefetch(child, &mut progress)
}

fn wait_for_prefetch(mut child: Child, mut progress: impl FnMut(Option<u8>)) -> ShellResult<()> {
    let stdout = child.stdout.take().ok_or("prefetch: no stdout")?;
    let result = prefetch_output(BufReader::new(stdout), &mut progress);
    let status = child
        .wait()
        .map_err(|e| ShellError::io_context("prefetch", e))?;
    result?;
    if !status.success() {
        return Err("La descarga de modelos falló.".into());
    }
    Ok(())
}

fn prefetch_output(reader: impl BufRead, mut progress: impl FnMut(Option<u8>)) -> ShellResult<()> {
    let mut last_error: Option<String> = None;
    for line in reader.lines() {
        let line = line.map_err(|error| ShellError::io_context("prefetch output", error))?;
        let Ok(event) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        match event.get("event").and_then(Value::as_str) {
            Some("prefetch") => {
                let percent = event
                    .get("percent")
                    .and_then(Value::as_u64)
                    .map(|p| p.min(100) as u8);
                progress(percent);
            }
            Some("failed") => {
                last_error = Some(
                    event
                        .get("error")
                        .and_then(Value::as_str)
                        .filter(|error| !error.is_empty())
                        .unwrap_or("La descarga de modelos falló.")
                        .to_string(),
                );
            }
            _ => {}
        }
    }
    if let Some(error) = last_error {
        return Err(error.into());
    }
    Ok(())
}

/// Claim before spawning so two bridge calls cannot launch two downloads.
fn begin_repair(
    state: &LyricsState,
    helper: &std::path::Path,
    target: &str,
    launch: impl FnOnce(),
    progress: impl FnOnce(&InstallState),
) -> ShellResult<Value> {
    {
        let mut install = lock(&state.install, "lyrics")?;
        if install.running {
            return Ok(json!({"started": true, "already": true, "running": &*install}));
        }
        if !helper.is_file() {
            return Ok(json!({"started": false, "reason": "not-installed"}));
        }
        *install = InstallState {
            running: true,
            repairing: true,
            target: Some(target.into()),
            phase: Some("modelos".into()),
            percent: Some(0),
            error: None,
        };
        progress(&install);
    }
    launch();
    Ok(json!({"started": true}))
}

/// Repair never creates a venv, installs packages or changes worker preferences.
pub fn repair(app: AppHandle) -> ShellResult<Value> {
    repair_target(app, "lyrics", Feedback::default())
}

pub(super) fn repair_target(
    app: AppHandle,
    target: &str,
    feedback: Feedback,
) -> ShellResult<Value> {
    if !supported() {
        return Ok(json!({"started": false, "reason": "unsupported-platform"}));
    }
    let state = app.state::<LyricsState>();
    if installing(&state) {
        return Ok(json!({"started": false, "reason": "installing"}));
    }
    if helper_check(&state)["engineReady"] != true {
        return Ok(json!({"started": false, "reason": "engine-first"}));
    }
    let target = target.to_string();
    if let Ok(mut errors) = state.addon_errors.lock() {
        errors.remove(&target);
    }
    let background_target = target.clone();
    let helper = binary();
    let background = app.clone();
    let prefetch_helper = helper.clone();
    let background_feedback = feedback.clone();
    begin_repair(
        &state,
        &helper,
        &target,
        move || {
            thread::spawn(move || {
                let state = background.state::<LyricsState>();
                let result = prefetch_models(&prefetch_helper, &background_target, |percent| {
                    set_install(&background, &state, &background_feedback, |s| {
                        s.percent = percent
                    });
                });
                // Invalidate before the completion event triggers a fresh status probe.
                if let Ok(mut hint) = state.check_hint.lock() {
                    *hint = None;
                }
                if let Ok(mut cache) = state.check_snapshot.lock() {
                    *cache = None;
                }
                if let Err(error) = &result {
                    log_install_error(&error.to_string());
                    if let Ok(mut errors) = state.addon_errors.lock() {
                        errors.insert(background_target, error.to_string());
                    }
                }
                set_install(&background, &state, &background_feedback, |s| {
                    s.running = false;
                    s.repairing = false;
                    s.phase = None;
                    s.percent = None;
                    s.error = None;
                });
                if result.is_ok() {
                    // Restart to advertise only the installed add-ons to the nest.
                    let resumed = crate::desktop::mac_worker::stop(&background)
                        .and_then(|_| crate::desktop::mac_worker::change(&background, Some(true)));
                    if let Err(error) = resumed {
                        crate::desktop::mac_worker::set_error(&background, Some(error.to_string()));
                    }
                }
                background_feedback.finish(result);
            });
        },
        |install| {
            feedback.progress(&app, json!(install));
        },
    )
}

pub fn remove(app: &AppHandle, target: &str) -> ShellResult<Value> {
    remove_observed(app, target, &Feedback::default())
}

pub(crate) fn remove_observed(
    app: &AppHandle,
    target: &str,
    feedback: &Feedback,
) -> ShellResult<Value> {
    if target == "gpu" {
        // CUDA wheel replacement is a download; use the ordinary background lane.
        let result = install_runtime_target(app.clone(), "gpu-remove", feedback.clone())?;
        if result["started"] != true {
            return Err(ShellError::Guard("gpu-removal-unavailable"));
        }
        return Ok(json!({"ok": true}));
    }
    let state = app.state::<LyricsState>();
    let operation = lock(&state.operation, "lyrics")?;
    if installing(&state) {
        return Err(ShellError::Guard("installing"));
    }
    let check = helper_check(&state);
    if check.is_null() {
        return Err(ShellError::Guard("engine-check-failed"));
    }
    if target == "engine"
        && ["lyrics", "stems", "analysis"]
            .iter()
            .any(|name| check["addons"][name]["installed"] == true)
    {
        return Err(ShellError::Guard("remove-addons-first"));
    }
    if target != "engine" && !["lyrics", "stems", "analysis"].contains(&target) {
        return Err(ShellError::Guard("invalid-request"));
    }
    agent_stop(&state);
    if target == "engine" {
        fs::remove_dir_all(venv_dir())?;
    } else {
        let mut command = Command::new(binary());
        command.args(["remove", "--addon", target]);
        engine_env(&mut command);
        run(&mut command, "remove add-on")?;
    }
    if let Ok(mut errors) = state.addon_errors.lock() {
        errors.remove(target);
    }
    if let Ok(mut cache) = state.check_snapshot.lock() {
        *cache = None;
    }
    if let Ok(mut cache) = state.check_hint.lock() {
        *cache = None;
    }
    drop(operation);
    if target == "engine" {
        let _ = crate::desktop::mac_worker::change(app, Some(false));
    } else if ["lyrics", "stems", "analysis"]
        .iter()
        .any(|name| helper_check(&state)["addons"][name]["ready"] == true)
    {
        if let Err(error) = crate::desktop::mac_worker::resume(app) {
            crate::desktop::mac_worker::set_error(app, Some(error.to_string()));
        }
    }
    feedback.progress(app, json!({"running": false}));
    Ok(json!({"ok": true}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn prefetch_subprocess_failures_preserve_errors_even_with_exit_zero() {
        for (event, exit, expected) in [
            (
                json!({"event": "failed", "error": "tempocnn: HTTP 404"}),
                "1",
                "tempocnn: HTTP 404",
            ),
            (
                json!({"event": "failed", "error": "tempocnn: HTTP 404"}),
                "0",
                "tempocnn: HTTP 404",
            ),
            (
                json!({"event": "failed"}),
                "0",
                "La descarga de modelos falló.",
            ),
            (
                json!({"event": "done"}),
                "1",
                "La descarga de modelos falló.",
            ),
        ] {
            let child = Command::new("sh")
                .args([
                    "-c",
                    "printf '%s\\n' \"$1\"; exit \"$2\"",
                    "prefetch-fixture",
                    &event.to_string(),
                    exit,
                ])
                .stdout(Stdio::piped())
                .spawn()
                .unwrap();
            let error = wait_for_prefetch(child, |_| {}).unwrap_err();
            assert_eq!(error.to_string(), expected);
        }
        let mut progress = Vec::new();
        let child = Command::new("sh")
            .args([
                "-c",
                r#"printf '%s\n' '{"event":"prefetch","percent":50}' '{"event":"done"}'"#,
            ])
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        wait_for_prefetch(child, |percent| progress.push(percent)).unwrap();
        assert_eq!(progress, [Some(50)]);
    }

    #[cfg(unix)]
    #[test]
    fn repair_runs_only_prefetch_and_duplicate_returns_running_state() {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!("krobi-repair-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let helper = root.join("helper");
        let calls = root.join("calls");
        let cached = root.join("cached-model");
        fs::write(&cached, "keep this model").unwrap();
        // A real subprocess boundary: any verb other than prefetch fails.
        fs::write(&helper, format!(r#"#!/bin/sh
[ "$*" = "prefetch --addon lyrics --json" ] || exit 42
printf '%s\n' "$*" >> '{}'
printf '%s\n' 'not json' '{{"event":"prefetch","model":"aligner","percent":67}}' '{{"event":"prefetch","model":"demucs","percent":100}}'
"#, calls.display())).unwrap();
        fs::set_permissions(&helper, fs::Permissions::from_mode(0o755)).unwrap();
        let state = LyricsState::default();
        let mut percentages = Vec::new();
        let result = begin_repair(
            &state,
            &helper,
            "lyrics",
            || {
                prefetch_models_with_log(&helper, "lyrics", root.join("install.log"), |percent| {
                    percentages.push(percent);
                    // Call again while consuming the running helper's JSON lines.
                    let duplicate = begin_repair(
                        &state,
                        &helper,
                        "lyrics",
                        || panic!("second repair launched"),
                        |_| panic!("duplicate progress"),
                    )
                    .unwrap();
                    assert_eq!(duplicate["already"], true);
                    assert_eq!(duplicate["running"]["running"], true);
                    assert_eq!(duplicate["running"]["phase"], "modelos");
                })
                .unwrap();
            },
            |progress| {
                assert!(progress.running);
                assert!(progress.repairing);
                assert_eq!(progress.percent, Some(0));
            },
        )
        .unwrap();
        assert_eq!(result["started"], true);
        assert_eq!(
            fs::read_to_string(&calls).unwrap(),
            "prefetch --addon lyrics --json\n"
        );
        assert_eq!(percentages, vec![Some(67), Some(100)]);
        assert_eq!(fs::read_to_string(&cached).unwrap(), "keep this model");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn fresh_base_uses_cpu_and_only_selected_pack_keeps_cuda() {
        assert_eq!(torch_backend(&json!({})), "cpu");
        assert_eq!(
            torch_backend(&json!({"hardware": {"accel": "cuda"}})),
            "cpu"
        );
        assert_eq!(
            torch_backend(&json!({"addons": {"gpu": {"installed": false}}})),
            "cpu"
        );
        assert_eq!(
            torch_backend(&json!({"addons": {"gpu": {"installed": true}}})),
            if cfg!(target_os = "macos") {
                "cpu"
            } else {
                "cu130"
            }
        );
    }

    #[test]
    fn extras_follow_selection_and_preserve_old_engines() {
        assert_eq!(selected_extras(&json!({}), Some("analysis")), (false, true));
        assert_eq!(
            selected_extras(&json!({"packages": {"torch": true}}), None),
            (true, false)
        );
        let installed = json!({"engineReady": true, "addons": {"analysis": {"installed": true}}});
        assert_eq!(selected_extras(&installed, None), (true, true));
        let sources = vec![
            PathBuf::from("/packages/helper"),
            PathBuf::from("/packages/plugin.whl"),
        ];
        assert_eq!(
            package_requirements(&sources, false, true),
            vec!["/packages/helper[analysis]"]
        );
        assert_eq!(
            package_requirements(&sources, true, true),
            vec!["/packages/helper[engine,analysis]", "/packages/plugin.whl"]
        );
    }

    #[test]
    fn repair_without_helper_never_launches_installation() {
        let state = LyricsState::default();
        let result = begin_repair(
            &state,
            std::path::Path::new("/nonexistent/krobi-helper"),
            "lyrics",
            || panic!("repair launched"),
            |_| panic!("progress emitted"),
        )
        .unwrap();
        assert_eq!(result["reason"], "not-installed");
        assert!(!installing(&state));
    }
}
