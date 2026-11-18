//! Opt-in login registration. Every reply is freshly read from the OS.
use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct State {
    pub supported: bool,
    pub enabled: bool,
    pub status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<&'static str>,
}
impl State {
    fn status(status: &'static str) -> Self {
        Self {
            supported: status != "unsupported",
            enabled: status == "enabled",
            status,
            error: None,
        }
    }
    fn failed(error: &'static str) -> Self {
        Self {
            error: Some(error),
            ..Self::status("unknown")
        }
    }
}

pub(crate) fn get() -> State {
    platform::get()
}
pub(crate) fn set(enabled: bool) -> State {
    update(enabled, platform::set, get)
}
fn update(
    enabled: bool,
    write: impl FnOnce(bool) -> Result<(), &'static str>,
    read: impl FnOnce() -> State,
) -> State {
    let error = write(enabled).err();
    let mut state = read();
    state.error = error.or(state.error);
    state
}

#[cfg(target_os = "macos")]
mod platform {
    use super::*;
    use objc2::{
        msg_send,
        rc::Retained,
        runtime::{AnyClass, AnyObject, Bool},
    };
    // Link the framework so the class is loaded; no LaunchAgent/AppleScript fallback.
    #[link(name = "ServiceManagement", kind = "framework")]
    extern "C" {}
    fn service() -> Option<Retained<AnyObject>> {
        // Absent before macOS 13.
        let class = AnyClass::get(c"SMAppService")?;
        // SAFETY: SMAppService's +mainAppService returns an autoreleased object.
        unsafe { msg_send![class, mainAppService] }
    }
    pub(super) fn get() -> State {
        let Some(service) = service() else {
            return State::status("unsupported");
        };
        // SAFETY: status is SMAppServiceStatus (NSInteger) and takes no arguments.
        let status: isize = unsafe { msg_send![&*service, status] };
        State::status(match status {
            0 => "disabled",
            1 => "enabled",
            2 => "requires-approval",
            3 => "not-found",
            _ => return State::failed("read-failed"),
        })
    }
    pub(super) fn set(enabled: bool) -> Result<(), &'static str> {
        let Some(service) = service() else {
            return Err("unsupported-platform");
        };
        let current = get();
        if current.enabled == enabled && matches!(current.status, "enabled" | "disabled") {
            return Ok(());
        }
        let mut error: *mut AnyObject = std::ptr::null_mut();
        // SAFETY: these methods accept NSError** and return ObjC BOOL. The object
        // remains retained for the call; the autoreleased error is never dereferenced.
        let ok: Bool = unsafe {
            if enabled {
                msg_send![&*service, registerAndReturnError: &mut error]
            } else {
                msg_send![&*service, unregisterAndReturnError: &mut error]
            }
        };
        if ok.as_bool() {
            Ok(())
        } else {
            Err("registration-failed")
        }
    }
}

#[cfg(any(target_os = "linux", test))]
mod linux {
    use super::*;
    use std::{fs, io, path::Path};
    // Desktop Entry Exec quoting, then string-value escaping. % is a field code.
    fn exec(executable: &Path) -> Result<String, &'static str> {
        let path = executable.to_str().ok_or("invalid-executable")?;
        let quoted = path
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('`', "\\`")
            .replace('$', "\\$")
            .replace('%', "%%");
        Ok(format!("\"{quoted}\"")
            .replace('\\', "\\\\")
            .replace('\n', "\\n")
            .replace('\r', "\\r"))
    }
    pub(super) fn get(path: &Path, executable: &Path) -> State {
        let content = match fs::read_to_string(path) {
            Ok(content) => content,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return State::status("disabled"),
            Err(_) => return State::failed("read-failed"),
        };
        let Ok(expected) = exec(executable) else {
            return State::failed("invalid-executable");
        };
        let mut section = false;
        let mut hidden = false;
        let mut desktop = false;
        let mut matches = false;
        for line in content.lines().map(str::trim) {
            if line.starts_with('[') {
                section = line == "[Desktop Entry]";
                continue;
            }
            if !section || line.starts_with('#') {
                continue;
            }
            if let Some((key, value)) = line.split_once('=') {
                match key.trim() {
                    "Hidden" if value.trim() == "true" => hidden = true,
                    "X-GNOME-Autostart-enabled" if value.trim() == "false" => hidden = true,
                    "Type" => desktop = value.trim() == "Application",
                    "Exec" => matches = value.trim() == expected,
                    _ => {}
                }
            }
        }
        State::status(if desktop && matches && !hidden {
            "enabled"
        } else {
            "disabled"
        })
    }
    pub(super) fn set(path: &Path, executable: &Path, enabled: bool) -> Result<(), &'static str> {
        if !enabled {
            return match fs::remove_file(path) {
                Ok(()) => Ok(()),
                Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
                Err(_) => Err("registration-failed"),
            };
        }
        let parent = path.parent().ok_or("registration-failed")?;
        fs::create_dir_all(parent).map_err(|_| "registration-failed")?;
        let content = format!(
            "[Desktop Entry]\nType=Application\nName=Flipspin\nExec={}\nTerminal=false\n",
            exec(executable)?
        );
        let temporary = path.with_extension(format!("desktop.{}.tmp", std::process::id()));
        fs::write(&temporary, content)
            .and_then(|()| fs::rename(&temporary, path))
            .map_err(|_| "registration-failed")
    }
}
#[cfg(target_os = "linux")]
mod platform {
    use super::*;
    use std::path::PathBuf;
    fn paths() -> Option<(PathBuf, PathBuf)> {
        // AppImage's current_exe points inside a transient mount. Register the image.
        let executable = std::env::var_os("APPIMAGE")
            .map(PathBuf::from)
            .or_else(|| std::env::current_exe().ok())?;
        Some((
            dirs::config_dir()?.join("autostart/krobi.desktop"),
            executable,
        ))
    }
    pub(super) fn get() -> State {
        match paths() {
            Some((path, exe)) => linux::get(&path, &exe),
            None => State::failed("read-failed"),
        }
    }
    pub(super) fn set(enabled: bool) -> Result<(), &'static str> {
        let (path, exe) = paths().ok_or("registration-failed")?;
        linux::set(&path, &exe, enabled)
    }
}

#[cfg(any(target_os = "windows", test))]
fn windows_status(registered: bool, approval: Option<&[u8]>) -> &'static str {
    if !registered {
        return "disabled";
    }
    match approval {
        None => "enabled",
        // Windows uses DWORD 2 (enabled), 3 (disabled), and 6/7 for policy variants.
        Some(bytes)
            if bytes.len() >= 12
                && matches!(u32::from_le_bytes(bytes[..4].try_into().unwrap()), 2 | 6) =>
        {
            "enabled"
        }
        Some(_) => "requires-approval",
    }
}
#[cfg(target_os = "windows")]
mod platform {
    use super::*;
    use std::{io, ptr};
    use windows_sys::Win32::{
        Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS},
        System::Registry::*,
    };
    const RUN: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
    const APPROVED: &str =
        r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";
    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(Some(0)).collect()
    }
    fn command() -> io::Result<Vec<u16>> {
        use std::os::windows::ffi::OsStrExt;
        let mut value = vec![b'"' as u16];
        value.extend(std::env::current_exe()?.as_os_str().encode_wide());
        value.extend([b'"' as u16, 0]);
        Ok(value)
    }
    fn read(path: &str, kind: u32) -> io::Result<Option<Vec<u8>>> {
        let path = wide(path);
        let name = wide("Krobi");
        let mut size = 0;
        // SAFETY: UTF-16 strings are NUL-terminated; first call queries byte length.
        let result = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                path.as_ptr(),
                name.as_ptr(),
                kind,
                ptr::null_mut(),
                ptr::null_mut(),
                &mut size,
            )
        };
        if result == ERROR_FILE_NOT_FOUND {
            return Ok(None);
        }
        if result != ERROR_SUCCESS {
            return Err(io::Error::from_raw_os_error(result as i32));
        }
        let mut bytes = vec![0u8; size as usize];
        // SAFETY: buffer has the size requested by the registry.
        let result = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                path.as_ptr(),
                name.as_ptr(),
                kind,
                ptr::null_mut(),
                bytes.as_mut_ptr().cast(),
                &mut size,
            )
        };
        if result != ERROR_SUCCESS {
            return Err(io::Error::from_raw_os_error(result as i32));
        }
        bytes.truncate(size as usize);
        Ok(Some(bytes))
    }
    pub(super) fn get() -> State {
        let result = || -> io::Result<State> {
            let expected: Vec<u8> = command()?.into_iter().flat_map(u16::to_le_bytes).collect();
            let registered = read(RUN, RRF_RT_REG_SZ)?.is_some_and(|value| value == expected);
            let approval = read(APPROVED, RRF_RT_REG_BINARY)?;
            Ok(State::status(windows_status(
                registered,
                approval.as_deref(),
            )))
        };
        result().unwrap_or_else(|_| State::failed("read-failed"))
    }
    pub(super) fn set(enabled: bool) -> Result<(), &'static str> {
        let path = wide(RUN);
        let name = wide("Krobi");
        if !enabled {
            // SAFETY: delete only the named HKCU Run value, preserving StartupApproved.
            let result =
                unsafe { RegDeleteKeyValueW(HKEY_CURRENT_USER, path.as_ptr(), name.as_ptr()) };
            return if matches!(result, ERROR_SUCCESS | ERROR_FILE_NOT_FOUND) {
                Ok(())
            } else {
                Err("registration-failed")
            };
        }
        let command = command().map_err(|_| "invalid-executable")?;
        let mut key: HKEY = ptr::null_mut();
        // SAFETY: all arguments live across the synchronous call. RegCreateKeyW
        // opens/creates only this user's Run key. Every successful open is closed.
        let result = unsafe { RegCreateKeyW(HKEY_CURRENT_USER, path.as_ptr(), &mut key) };
        if result != ERROR_SUCCESS {
            return Err("registration-failed");
        }
        let result = unsafe {
            RegSetValueExW(
                key,
                name.as_ptr(),
                0,
                REG_SZ,
                command.as_ptr().cast(),
                (command.len() * 2) as u32,
            )
        };
        unsafe {
            RegCloseKey(key);
        }
        // StartupApproved is deliberately preserved: a Task Manager denial wins.
        if result == ERROR_SUCCESS {
            Ok(())
        } else {
            Err("registration-failed")
        }
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
mod platform {
    use super::*;
    pub(super) fn get() -> State {
        State::status("unsupported")
    }
    pub(super) fn set(_: bool) -> Result<(), &'static str> {
        Err("unsupported-platform")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn set_reports_os_denial_and_rereads_even_after_write_failure() {
        let denied = update(true, |_| Ok(()), || State::status("requires-approval"));
        assert!(!denied.enabled);
        assert_eq!(denied.status, "requires-approval");
        let failed = update(
            false,
            |_| Err("registration-failed"),
            || State::status("enabled"),
        );
        assert!(failed.enabled);
        assert_eq!(failed.error, Some("registration-failed"));
    }
    #[test]
    fn windows_honours_os_denial_and_missing_registration() {
        for state in [2u32, 6] {
            let mut bytes = vec![0; 12];
            bytes[..4].copy_from_slice(&state.to_le_bytes());
            assert_eq!(windows_status(true, Some(&bytes)), "enabled");
        }
        for bytes in [vec![3; 12], vec![7; 12], vec![], vec![2]] {
            assert_eq!(windows_status(true, Some(&bytes)), "requires-approval");
            assert_eq!(windows_status(false, Some(&bytes)), "disabled");
        }
        assert_eq!(windows_status(true, None), "enabled");
        assert_eq!(windows_status(false, None), "disabled");
    }
    #[test]
    fn linux_reads_back_external_edits_and_removal() {
        let dir = std::env::temp_dir().join(format!("krobi-login-test-{}", std::process::id()));
        let path = dir.join("autostart/krobi.desktop");
        let exe = std::path::Path::new("/opt/Krobi music/$a`b\\c\"100%.AppImage");
        assert!(!linux::get(&path, exe).enabled);
        linux::set(&path, exe, true).unwrap();
        assert!(linux::get(&path, exe).enabled);
        let entry = std::fs::read_to_string(&path).unwrap();
        assert!(entry.contains("100%%.AppImage"));
        assert!(entry.contains("\\\\$"));
        std::fs::write(&path, format!("{entry}Hidden=true\n")).unwrap();
        assert!(!linux::get(&path, exe).enabled);
        std::fs::write(&path, format!("{entry}X-GNOME-Autostart-enabled=false\n")).unwrap();
        assert!(!linux::get(&path, exe).enabled);
        linux::set(&path, exe, false).unwrap();
        assert!(!linux::get(&path, exe).enabled);
        linux::set(&path, exe, false).unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }
}
