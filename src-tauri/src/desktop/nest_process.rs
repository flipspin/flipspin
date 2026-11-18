//! Own the entire PyInstaller tree, not just its onefile launcher PID.

use std::{
    io,
    path::{Path, PathBuf},
    process::{Child, Command, ExitStatus, Stdio},
    thread,
    time::{Duration, Instant},
};

pub(super) fn source_runtime(command: &mut Command, app: &tauri::AppHandle) {
    if let Some(uv) = crate::lyrics::find_uv(app) {
        command.env("KROBI_UV", uv);
    }
}

const GRACE: Duration = Duration::from_secs(3);

pub(super) struct ChildTree {
    child: Child,
    stopped: bool,
    #[cfg(windows)]
    job: std::os::windows::io::OwnedHandle,
}

impl ChildTree {
    pub(super) fn spawn(command: &mut Command) -> io::Result<Self> {
        // EOF is the portable graceful-stop and parent-death signal. Keep the
        // writer in Child until shutdown; PyInstaller's Python process reads it.
        command.stdin(Stdio::piped());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
            Ok(Self {
                child: command.spawn()?,
                stopped: false,
            })
        }
        #[cfg(windows)]
        windows::spawn(command)
    }

    pub(super) fn id(&self) -> u32 {
        self.child.id()
    }

    pub(super) fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        self.child.try_wait()
    }

    pub(super) fn stop(&mut self) -> io::Result<()> {
        self.stop_with_grace(GRACE)
    }

    fn stop_with_grace(&mut self, grace: Duration) -> io::Result<()> {
        if self.stopped {
            return Ok(());
        }
        self.child.stdin.take();
        #[cfg(unix)]
        signal(-(self.id() as i32), libc::SIGTERM)?;
        let deadline = Instant::now() + grace;
        loop {
            let exited = self.child.try_wait()?.is_some();
            #[cfg(unix)]
            let tree_exited = !group_exists(self.id());
            #[cfg(windows)]
            let tree_exited = windows::job_empty(&self.job)?;
            if exited && tree_exited {
                self.stopped = true;
                return Ok(());
            }
            if Instant::now() >= deadline {
                break;
            }
            thread::sleep(Duration::from_millis(25));
        }
        #[cfg(unix)]
        signal(-(self.id() as i32), libc::SIGKILL)?;
        #[cfg(windows)]
        windows::kill_job(&self.job)?;
        self.child.wait()?;
        self.stopped = true;
        Ok(())
    }
}

impl Drop for ChildTree {
    fn drop(&mut self) {
        if let Err(error) = self.stop() {
            log::warn!("Could not stop the local nest: {error}");
        }
    }
}

#[cfg(unix)]
fn signal(target: i32, signal: i32) -> io::Result<()> {
    // SAFETY: kill accepts a PID or a negative process group, without pointers.
    if unsafe { libc::kill(target, signal) } == 0 {
        return Ok(());
    }
    let error = io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        Ok(())
    } else {
        Err(error)
    }
}

#[cfg(unix)]
fn group_exists(pid: u32) -> bool {
    // SAFETY: signal zero only tests for existence.
    unsafe { libc::kill(-(pid as i32), 0) == 0 }
}

/// No path or PID supplied by an HTTP response is authority to kill a process.
/// Confirm both the listening socket and the executable with the OS.
#[derive(Debug)]
pub(super) struct BundleProcess {
    pid: u32,
    executable: PathBuf,
    generation: u128,
}

impl BundleProcess {
    pub(super) fn listening(pid: u32, port: u16, bundled: &Path) -> Option<Self> {
        if pid == 0 || pid == std::process::id() || !listens_on(pid, port) {
            return None;
        }
        let executable = process_executable(pid)?;
        let generation = process_generation(pid)?;
        is_bundle_executable(&executable, bundled).then_some(Self {
            pid,
            executable,
            generation,
        })
    }

    pub(super) fn stop(&self) -> io::Result<()> {
        // Recheck immediately before signalling: a process may have exited
        // between the probe and this call. Fail closed if its PID was reused.
        if !self.is_same_process() {
            return Err(io::Error::other("local nest process changed"));
        }
        #[cfg(unix)]
        {
            // A new shell gives the launcher its own group. Legacy orphans
            // inherit a shell's group, which must NEVER be signalled wholesale.
            // SAFETY: getpgid accepts a PID, without pointers.
            let group = unsafe { libc::getpgid(self.pid as i32) };
            let target = if group > 0
                && process_executable(group as u32).as_ref() == Some(&self.executable)
            {
                -group
            } else {
                self.pid as i32
            };
            signal(target, libc::SIGTERM)?;
            let deadline = Instant::now() + GRACE;
            while self.is_same_process() || (target < 0 && group_exists((-target) as u32)) {
                if Instant::now() >= deadline {
                    signal(target, libc::SIGKILL)?;
                    let killed = Instant::now() + Duration::from_secs(1);
                    while self.is_same_process() && Instant::now() < killed {
                        thread::sleep(Duration::from_millis(25));
                    }
                    if self.is_same_process() {
                        return Err(io::Error::other("old local nest did not stop"));
                    }
                    break;
                }
                thread::sleep(Duration::from_millis(25));
            }
            Ok(())
        }
        #[cfg(windows)]
        windows::stop_existing(self.pid, &self.executable)
    }

    fn is_same_process(&self) -> bool {
        process_generation(self.pid) == Some(self.generation)
            && process_executable(self.pid).as_ref() == Some(&self.executable)
    }
}

pub(super) fn is_bundle_executable(executable: &Path, bundled: &Path) -> bool {
    if executable.file_name() != bundled.file_name() {
        return false;
    }
    if executable == bundled {
        return true;
    }
    // Match path components, never a substring such as "not-Krobi.app" or a
    // Python executable in a dev checkout. Other installations may be renamed
    // only in case (the product's bundle is normally Flipspin.app).
    executable.ancestors().any(|bundle| {
        bundle.file_name().is_some_and(|name| {
            name.eq_ignore_ascii_case("krobi.app") || name.eq_ignore_ascii_case("flipspin.app")
        }) && executable
            == bundle
                .join("Contents/Resources/backend")
                .join(bundled.file_name().unwrap())
    })
}

#[cfg(target_os = "macos")]
fn process_generation(pid: u32) -> Option<u128> {
    // SAFETY: zero is valid for the integer fields of proc_bsdinfo.
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of_val(&info) as i32;
    // SAFETY: correctly sized writable proc_bsdinfo; the OS fills the record.
    if unsafe {
        libc::proc_pidinfo(
            pid as i32,
            libc::PROC_PIDTBSDINFO,
            0,
            (&mut info as *mut libc::proc_bsdinfo).cast(),
            size,
        )
    } != size
    {
        return None;
    }
    Some((u128::from(info.pbi_start_tvsec) << 64) | u128::from(info.pbi_start_tvusec))
}

#[cfg(target_os = "macos")]
fn process_executable(pid: u32) -> Option<PathBuf> {
    use std::os::unix::ffi::OsStrExt;
    #[link(name = "proc")]
    extern "C" {
        fn proc_pidpath(pid: i32, buffer: *mut libc::c_void, size: u32) -> i32;
    }
    let mut buffer = [0u8; 4096];
    // SAFETY: writable buffer of the supplied size; proc_pidpath NUL-terminates.
    let length =
        unsafe { proc_pidpath(pid as i32, buffer.as_mut_ptr().cast(), buffer.len() as u32) };
    if length <= 0 {
        return None;
    }
    let end = buffer.iter().position(|byte| *byte == 0)?;
    Some(PathBuf::from(std::ffi::OsStr::from_bytes(&buffer[..end])))
}

#[cfg(target_os = "macos")]
fn listens_on(pid: u32, port: u16) -> bool {
    Command::new("/usr/sbin/lsof")
        .args([
            "-nP",
            "-a",
            "-p",
            &pid.to_string(),
            &format!("-iTCP:{port}"),
            "-sTCP:LISTEN",
            "-Fp",
        ])
        .output()
        .is_ok_and(|output| {
            output.status.success()
                && String::from_utf8_lossy(&output.stdout)
                    .lines()
                    .any(|line| line == format!("p{pid}"))
        })
}

#[cfg(target_os = "linux")]
fn process_generation(pid: u32) -> Option<u128> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    // The command in parentheses may itself contain spaces or parentheses.
    stat.rsplit_once(')')?
        .1
        .split_whitespace()
        .nth(19)?
        .parse()
        .ok()
}

#[cfg(target_os = "linux")]
fn process_executable(pid: u32) -> Option<PathBuf> {
    std::fs::read_link(format!("/proc/{pid}/exe")).ok()
}

#[cfg(target_os = "linux")]
fn listens_on(pid: u32, port: u16) -> bool {
    let sockets: Vec<String> = ["/proc/net/tcp", "/proc/net/tcp6"]
        .into_iter()
        .filter_map(|path| std::fs::read_to_string(path).ok())
        .flat_map(|table| {
            table
                .lines()
                .skip(1)
                .filter_map(|line| {
                    let fields: Vec<_> = line.split_whitespace().collect();
                    (fields.len() > 9
                        && fields[3] == "0A"
                        && fields[1].ends_with(&format!(":{port:04X}")))
                    .then(|| format!("socket:[{}]", fields[9]))
                })
                .collect::<Vec<_>>()
        })
        .collect();
    std::fs::read_dir(format!("/proc/{pid}/fd")).is_ok_and(|entries| {
        entries
            .flatten()
            .filter_map(|entry| std::fs::read_link(entry.path()).ok())
            .any(|link| sockets.iter().any(|socket| link == Path::new(socket)))
    })
}

#[cfg(windows)]
use windows::{listens_on, process_executable, process_generation};

#[cfg(windows)]
mod windows;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn listener_and_executable_are_confirmed_by_the_os() {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let pid = std::process::id();
        assert!(listens_on(pid, port));
        assert!(process_generation(pid).is_some());
        assert_eq!(process_executable(pid), std::env::current_exe().ok());
        drop(listener);
        assert!(!listens_on(pid, port));
    }

    #[cfg(unix)]
    #[test]
    fn shutdown_stops_launcher_and_stubborn_python_grandchild() {
        // The launcher exits on TERM, while its child ignores it: the exact
        // onefile ownership boundary, including escalation after launcher exit.
        let path = std::env::temp_dir().join(format!("krobi-child-{}", rand::random::<u64>()));
        let mut command = Command::new("sh");
        command.args(["-c", "trap 'exit 0' TERM; sh -c 'trap \"\" TERM; echo ready > \"$1\"; while :; do sleep 1; done' sh \"$1\" & wait", "sh"])
            .arg(&path).stdout(Stdio::null()).stderr(Stdio::null());
        let mut tree = ChildTree::spawn(&mut command).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while !path.exists() {
            assert!(Instant::now() < deadline, "grandchild did not start");
            thread::sleep(Duration::from_millis(10));
        }
        tree.stop_with_grace(Duration::from_millis(100)).unwrap();
        assert!(tree.try_wait().unwrap().is_some());
        let deadline = Instant::now() + Duration::from_secs(5);
        while group_exists(tree.id()) && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(25));
        }
        assert!(!group_exists(tree.id()), "orphan survived shutdown");
        std::fs::remove_file(path).unwrap();
    }
}
