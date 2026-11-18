//! Per-job OS assertions. The loopback connection is the job's lifetime, not the agent's.
use serde_json::json;
use std::{
    any::Any,
    io::{self, Read, Write},
    net::TcpListener,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread::{self, JoinHandle},
    time::Duration,
};

trait KeepAwake {
    // Intentionally !Send: Windows must release on the acquiring thread.
    fn acquire(&self, pid: u32) -> io::Result<Box<dyn Any>>;
}

#[cfg(any(target_os = "macos", test))]
mod macos {
    use super::*;
    pub(super) struct Adapter<F>(pub F);
    impl<F, G: Any> KeepAwake for Adapter<F>
    where
        F: Fn(u32) -> io::Result<G>,
    {
        fn acquire(&self, pid: u32) -> io::Result<Box<dyn Any>> {
            (self.0)(pid).map(|g| Box::new(g) as _)
        }
    }
    #[cfg(target_os = "macos")]
    pub(super) fn native(pid: u32) -> io::Result<Assertion> {
        use std::process::{Command, Stdio};
        let mut assertion = Assertion(
            Command::new("/usr/bin/caffeinate")
                .args(["-i", "-w", &pid.to_string()])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()?,
        );
        thread::sleep(Duration::from_millis(20));
        if assertion.0.try_wait()?.is_some() {
            return Err(io::Error::other("caffeinate exited"));
        }
        Ok(assertion)
    }
    #[cfg(target_os = "macos")]
    pub(super) struct Assertion(std::process::Child);
    #[cfg(target_os = "macos")]
    impl Drop for Assertion {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
}

#[cfg(any(target_os = "windows", test))]
mod windows {
    use super::*;
    use std::{marker::PhantomData, rc::Rc};
    pub(super) const CONTINUOUS: u32 = 0x80000000;
    pub(super) const SYSTEM_REQUIRED: u32 = 1;
    pub(super) struct Adapter<F>(pub F);
    struct Assertion<F: Fn(u32) -> u32> {
        set: F,
        _owning_thread: PhantomData<Rc<()>>,
    }
    impl<F: Fn(u32) -> u32> Drop for Assertion<F> {
        fn drop(&mut self) {
            if (self.set)(CONTINUOUS) == 0 {
                log::warn!("could not clear keep awake execution state");
            }
        }
    }
    impl<F: Fn(u32) -> u32 + Clone + 'static> KeepAwake for Adapter<F> {
        fn acquire(&self, _: u32) -> io::Result<Box<dyn Any>> {
            if (self.0)(CONTINUOUS | SYSTEM_REQUIRED) == 0 {
                return Err(io::Error::other("execution state refused"));
            }
            Ok(Box::new(Assertion {
                set: self.0.clone(),
                _owning_thread: PhantomData,
            }))
        }
    }
    #[cfg(target_os = "windows")]
    pub(super) fn native(flags: u32) -> u32 {
        // SAFETY: flags are documented EXECUTION_STATE bits; the server owns this thread.
        unsafe { windows_sys::Win32::System::Power::SetThreadExecutionState(flags) }
    }
}

#[cfg(any(target_os = "linux", test))]
mod linux {
    use super::*;
    pub(super) struct Adapter<F>(pub F);
    impl<F, G: Any> KeepAwake for Adapter<F>
    where
        F: Fn(&str, &str, &str, &str) -> io::Result<G>,
    {
        fn acquire(&self, _: u32) -> io::Result<Box<dyn Any>> {
            (self.0)("sleep:idle", "Flipspin", "procesando", "block").map(|fd| Box::new(fd) as _)
        }
    }
    #[cfg(target_os = "linux")]
    pub(super) fn native(
        what: &str,
        who: &str,
        why: &str,
        mode: &str,
    ) -> io::Result<zbus::zvariant::OwnedFd> {
        let call = || -> zbus::Result<zbus::zvariant::OwnedFd> {
            let connection = zbus::blocking::Connection::system()?;
            let proxy = zbus::blocking::Proxy::new(
                &connection,
                "org.freedesktop.login1",
                "/org/freedesktop/login1",
                "org.freedesktop.login1.Manager",
            )?;
            proxy.call("Inhibit", &(what, who, why, mode))
        };
        call().map_err(io::Error::other)
    }
}

fn native() -> impl KeepAwake {
    #[cfg(target_os = "macos")]
    {
        macos::Adapter(macos::native)
    }
    #[cfg(target_os = "windows")]
    {
        windows::Adapter(windows::native)
    }
    #[cfg(target_os = "linux")]
    {
        linux::Adapter(linux::native)
    }
}

/// Upload assertions have a dedicated owner so Windows acquires and releases on
/// the same thread, even when the async sender migrates between executor threads.
pub(crate) struct Activity {
    commands: std::sync::mpsc::Sender<(bool, std::sync::mpsc::SyncSender<bool>)>,
}
impl Activity {
    pub(crate) fn new() -> io::Result<Self> {
        Self::with_acquire(upload_assertion)
    }
    pub(crate) fn with_acquire(
        acquire: impl Fn() -> io::Result<Box<dyn Any>> + Send + 'static,
    ) -> io::Result<Self> {
        let (commands, receiver) =
            std::sync::mpsc::channel::<(bool, std::sync::mpsc::SyncSender<bool>)>();
        thread::Builder::new()
            .name("upload-keep-awake".into())
            .spawn(move || {
                let mut held = None;
                while let Ok((moving, reply)) = receiver.recv() {
                    if moving && held.is_none() {
                        held = acquire().ok();
                    } else if !moving {
                        held = None;
                    }
                    let _ = reply.send(held.is_some());
                }
            })?;
        Ok(Self { commands })
    }
    pub(crate) fn set(&self, moving: bool) -> bool {
        let (reply, result) = std::sync::mpsc::sync_channel(1);
        self.commands.send((moving, reply)).is_ok() && result.recv().unwrap_or(false)
    }
}
fn upload_assertion() -> io::Result<Box<dyn Any>> {
    #[cfg(target_os = "macos")]
    {
        use core_foundation::{
            base::TCFType,
            string::{CFString, CFStringRef},
        };
        #[link(name = "IOKit", kind = "framework")]
        unsafe extern "C" {
            fn IOPMAssertionCreateWithName(
                kind: CFStringRef,
                level: u32,
                name: CFStringRef,
                id: *mut u32,
            ) -> i32;
            fn IOPMAssertionRelease(id: u32) -> i32;
        }
        struct Assertion(u32);
        impl Drop for Assertion {
            fn drop(&mut self) {
                // SAFETY: this id belongs to this guard and is released exactly once.
                unsafe {
                    IOPMAssertionRelease(self.0);
                }
            }
        }
        let kind = CFString::new("PreventUserIdleSystemSleep");
        let name = CFString::new("Flipspin is uploading music");
        let mut id = 0;
        // SAFETY: live CFStrings and a writable assertion id for this call.
        let result = unsafe {
            IOPMAssertionCreateWithName(
                kind.as_concrete_TypeRef(),
                255,
                name.as_concrete_TypeRef(),
                &mut id,
            )
        };
        if result != 0 {
            return Err(io::Error::other("sleep assertion refused"));
        }
        Ok(Box::new(Assertion(id)))
    }
    #[cfg(target_os = "windows")]
    {
        native().acquire(std::process::id())
    }
    #[cfg(target_os = "linux")]
    {
        linux::native(
            "sleep:idle",
            "Flipspin",
            "Flipspin is uploading music",
            "block",
        )
        .map(|fd| Box::new(fd) as _)
    }
}

/// One owning thread acquires, holds and releases every OS assertion.
/// The worker side of the protocol is `helper/krobi_helper/agent.py`.
pub(crate) struct Server {
    address: String,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}
impl Server {
    pub(crate) fn start() -> io::Result<Self> {
        Self::with_adapter(native)
    }
    fn with_adapter<A: KeepAwake + 'static>(
        adapter: impl FnOnce() -> A + Send + 'static,
    ) -> io::Result<Self> {
        let listener = TcpListener::bind("127.0.0.1:0")?;
        listener.set_nonblocking(true)?;
        let address = listener.local_addr()?.to_string();
        let stop = Arc::new(AtomicBool::new(false));
        let stopped = stop.clone();
        let thread = thread::Builder::new()
            .name("helper-keep-awake".into())
            .spawn(move || {
                let adapter = adapter();
                while !stopped.load(Ordering::Relaxed) {
                    match listener.accept() {
                        Ok((stream, _)) => {
                            let _ = serve(stream, &adapter, &stopped);
                        }
                        Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(25))
                        }
                        Err(_) => break,
                    }
                }
            })?;
        Ok(Self {
            address,
            stop,
            thread: Some(thread),
        })
    }
    pub(crate) fn address(&self) -> &str {
        &self.address
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}
fn serve(
    mut stream: impl Read + Write,
    adapter: &impl KeepAwake,
    stop: &AtomicBool,
) -> io::Result<()> {
    let mut request = Vec::new();
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    let mut byte = [0];
    loop {
        if stop.load(Ordering::Relaxed) || std::time::Instant::now() > deadline {
            return Ok(());
        }
        match stream.read(&mut byte) {
            Ok(0) => return Ok(()),
            Ok(_) if byte[0] == b'\n' => break,
            Ok(_) if request.len() < 128 => request.push(byte[0]),
            Ok(_) => return Ok(()),
            Err(e)
                if matches!(
                    e.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                ) =>
            {
                continue
            }
            Err(e) => return Err(e),
        }
    }
    let pid = serde_json::from_slice::<serde_json::Value>(&request)
        .ok()
        .and_then(|v| v["pid"].as_u64())
        .and_then(|pid| u32::try_from(pid).ok())
        .filter(|pid| *pid > 0);
    let assertion = pid.and_then(|pid| {
        adapter
            .acquire(pid)
            .map_err(|e| log::warn!("keep awake failed: {e}"))
            .ok()
    });
    let status = if assertion.is_some() {
        "held"
    } else {
        "failed"
    };
    writeln!(stream, "{}", json!({"keepAwake": status}))?;
    // EOF releases the guard, including when the worker crashes. No assertion while idle.
    while !stop.load(Ordering::Relaxed) {
        match stream.read(&mut byte) {
            Ok(0) => break,
            Ok(_) => continue,
            Err(e)
                if matches!(
                    e.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                ) =>
            {
                continue
            }
            Err(_) => break,
        }
    }
    drop(assertion);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{cell::RefCell, rc::Rc, sync::atomic::AtomicUsize};
    struct Held(Arc<AtomicUsize>);
    impl Drop for Held {
        fn drop(&mut self) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }
    #[test]
    fn macos_checks_acquisition_and_releases_at_job_end() {
        let drops = Arc::new(AtomicUsize::new(0));
        let a = macos::Adapter(|pid| {
            assert_eq!(pid, 42);
            Ok(Held(drops.clone()))
        });
        let held = a.acquire(42).unwrap();
        assert_eq!(drops.load(Ordering::SeqCst), 0);
        drop(held);
        assert_eq!(drops.load(Ordering::SeqCst), 1);
        assert!(macos::Adapter(|_| Err::<(), _>(io::Error::other("denied")))
            .acquire(42)
            .is_err());
    }
    #[test]
    fn windows_sets_and_clears_on_the_same_thread_and_checks_zero() {
        let calls = Rc::new(RefCell::new(Vec::new()));
        let observed = calls.clone();
        let a = windows::Adapter(move |flags| {
            observed.borrow_mut().push((thread::current().id(), flags));
            1
        });
        let held = a.acquire(42).unwrap();
        assert_eq!(calls.borrow().len(), 1);
        drop(held);
        assert_eq!(
            *calls.borrow(),
            vec![
                (thread::current().id(), 0x80000001),
                (thread::current().id(), 0x80000000)
            ]
        );
        assert!(windows::Adapter(|_| 0).acquire(42).is_err());
    }
    #[test]
    fn linux_holds_inhibitor_fd_until_job_end_and_checks_errors() {
        let drops = Arc::new(AtomicUsize::new(0));
        let a = linux::Adapter(|what: &str, who: &str, why: &str, mode: &str| {
            assert_eq!(
                (what, who, why, mode),
                ("sleep:idle", "Flipspin", "procesando", "block")
            );
            Ok(Held(drops.clone()))
        });
        let held = a.acquire(42).unwrap();
        assert_eq!(drops.load(Ordering::SeqCst), 0);
        drop(held);
        assert_eq!(drops.load(Ordering::SeqCst), 1);
        let failed = linux::Adapter(|_: &str, _: &str, _: &str, _: &str| {
            Err::<(), _>(io::Error::other("denied"))
        });
        assert!(failed.acquire(42).is_err());
    }
    #[test]
    fn wire_reports_held_and_failed_and_disconnect_releases() {
        // Fake duplex stream: no network permissions or real sleep assertion.
        struct Stream {
            input: io::Cursor<Vec<u8>>,
            output: Rc<RefCell<Vec<u8>>>,
            drops: Arc<AtomicUsize>,
        }
        impl Read for Stream {
            fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
                assert_eq!(self.drops.load(Ordering::SeqCst), 0, "released before EOF");
                self.input.read(buffer)
            }
        }
        impl Write for Stream {
            fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
                self.output.borrow_mut().extend_from_slice(bytes);
                Ok(bytes.len())
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }
        for success in [true, false] {
            let drops = Arc::new(AtomicUsize::new(0));
            let observed = drops.clone();
            let adapter = macos::Adapter(move |_| {
                if success {
                    Ok(Held(observed.clone()))
                } else {
                    Err(io::Error::other("denied"))
                }
            });
            let output = Rc::new(RefCell::new(Vec::new()));
            let stream = Stream {
                input: io::Cursor::new(b"{\"pid\":42}\n".to_vec()),
                output: output.clone(),
                drops: drops.clone(),
            };
            serve(stream, &adapter, &AtomicBool::new(false)).unwrap();
            let reply: serde_json::Value = serde_json::from_slice(&output.borrow()).unwrap();
            assert_eq!(reply["keepAwake"], if success { "held" } else { "failed" });
            assert_eq!(drops.load(Ordering::SeqCst), usize::from(success));
        }
    }
}
