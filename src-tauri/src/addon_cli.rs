//! Terminal waiter and replies for commands delivered by the single-instance plugin.
//! Only the app executes add-on operations; the waiter never owns an engine.
use crate::{
    error::{ShellError, ShellResult},
    lyrics::{AddonEvent, Feedback, LyricsState},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    io::{self, BufRead, BufReader, Write},
    net::{Ipv4Addr, SocketAddrV4, TcpListener, TcpStream},
    process::{Command as ProcessCommand, Stdio},
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};

const REPLY_FLAG: &str = "--addon-reply";
const STARTUP_TIMEOUT: Duration = Duration::from_secs(60);
const REPLY_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const RETRY_DELAY: Duration = Duration::from_millis(25);

#[derive(Clone, Debug, PartialEq, Eq)]
enum Command {
    Status,
    Install(String),
    Remove(String),
}

impl Command {
    fn addon(&self) -> Option<&str> {
        match self {
            Self::Status => None,
            Self::Install(name) | Self::Remove(name) => Some(name),
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
struct Request {
    command: Command,
    reply: Option<(u16, String)>,
}

/// `None` preserves ordinary app launches (including OS-supplied arguments).
fn parse(args: &[String]) -> Result<Option<Request>, &'static str> {
    let args = args.get(1..).unwrap_or_default();
    if !args.iter().any(|arg| arg == "--addon" || arg == REPLY_FLAG) {
        return Ok(None);
    }
    let (verb, rest) = match args {
        [flag, verb, rest @ ..] if flag == "--addon" => (verb.as_str(), rest),
        _ => {
            return Err(
                "usage: --addon install|remove <engine|lyrics|stems|analysis> | --addon status",
            )
        }
    };
    let (command, rest) = match (verb, rest) {
        ("status", rest) => (Command::Status, rest),
        ("install" | "remove", [name, rest @ ..])
            if ["engine", "lyrics", "stems", "analysis"].contains(&name.as_str()) =>
        {
            let command = if verb == "install" {
                Command::Install(name.clone())
            } else {
                Command::Remove(name.clone())
            };
            (command, rest)
        }
        _ => return Err("invalid-addon-command"),
    };
    let reply = match rest {
        [] => None,
        [flag, port, token]
            if flag == REPLY_FLAG
                && token.len() == 32
                && token.bytes().all(|b| b.is_ascii_hexdigit()) =>
        {
            let port = port
                .parse::<u16>()
                .ok()
                .filter(|port| *port != 0)
                .ok_or("invalid-addon-reply")?;
            Some((port, token.clone()))
        }
        _ => return Err("invalid-addon-arguments"),
    };
    Ok(Some(Request { command, reply }))
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum Reply {
    Progress { payload: Value },
    Done { payload: Value, ok: bool },
}

fn failure(command: Option<&Command>, state: Value, error: impl ToString) -> Value {
    json!({"ok": false, "addon": command.and_then(Command::addon), "state": state, "error": error.to_string()})
}

/// Runs before constructing Tauri. A dispatcher child enters the normal app
/// lifecycle; its parent survives the plugin's immediate secondary-process exit.
pub(crate) fn launch() -> Option<i32> {
    let args: Vec<_> = std::env::args().collect();
    let request = match parse(&args) {
        Ok(None) => return None,
        Ok(Some(request)) if request.reply.is_some() => return None,
        Ok(Some(request)) => request,
        Err(error) => {
            println!("{}", failure(None, Value::Null, error));
            return Some(1);
        }
    };
    Some(match wait_for_app(&args) {
        Ok(code) => code,
        Err(error) => {
            println!("{}", failure(Some(&request.command), Value::Null, error));
            1
        }
    })
}

fn wait_for_app(args: &[String]) -> io::Result<i32> {
    let deadline = Instant::now() + REPLY_TIMEOUT;
    let listener = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0))?;
    listener.set_nonblocking(true)?;
    let token = format!("{:032x}", rand::random::<u128>());
    let mut command = ProcessCommand::new(std::env::current_exe()?);
    command
        .args(&args[1..])
        .arg(REPLY_FLAG)
        .arg(listener.local_addr()?.port().to_string())
        .arg(&token)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // The user's app survives a terminal interrupt or terminal closure.
        command.process_group(0);
    }
    let mut child = command.spawn()?;
    loop {
        check_deadline(deadline)?;
        match listener.accept() {
            Ok((stream, _)) => {
                // Accepted sockets can inherit nonblocking mode on macOS.
                stream.set_nonblocking(false)?;
                // Wake periodically to enforce the overall operation deadline.
                stream.set_read_timeout(Some(Duration::from_millis(250)))?;
                let mut reader = BufReader::new(stream);
                let mut handshake = Vec::new();
                // Bound unauthenticated input before accepting the response stream.
                let valid = read_reply_line(
                    &mut std::io::Read::take(&mut reader, 128),
                    &mut handshake,
                    deadline.min(Instant::now() + Duration::from_secs(5)),
                )
                .is_ok()
                    && std::str::from_utf8(&handshake).is_ok_and(|line| line.trim_end() == token);
                if valid {
                    return print_replies(reader, &mut io::stdout().lock(), deadline);
                }
            }
            Err(error) if retryable(&error) => {}
            Err(error) => return Err(error),
        }
        if child.try_wait()?.is_some_and(|status| !status.success()) {
            return Err(io::Error::other("app-launch-failed"));
        }
        thread::sleep(RETRY_DELAY);
    }
}

fn retryable(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted | io::ErrorKind::TimedOut
    )
}

fn check_deadline(deadline: Instant) -> io::Result<()> {
    if Instant::now() >= deadline {
        Err(io::Error::new(io::ErrorKind::TimedOut, "timeout"))
    } else {
        Ok(())
    }
}

fn read_reply_line(
    reader: &mut impl BufRead,
    line: &mut Vec<u8>,
    deadline: Instant,
) -> io::Result<()> {
    loop {
        check_deadline(deadline)?;
        // Keep partial bytes across transient errors, including split UTF-8.
        match reader.fill_buf() {
            Ok([]) if line.is_empty() => {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "app-disconnected",
                ));
            }
            Ok([]) => return Ok(()),
            Ok(buffer) => {
                let newline = buffer.iter().position(|byte| *byte == b'\n');
                let amount = newline.map_or(buffer.len(), |index| index + 1);
                line.extend_from_slice(&buffer[..amount]);
                reader.consume(amount);
                if newline.is_some() {
                    return Ok(());
                }
            }
            Err(error) if retryable(&error) => thread::sleep(RETRY_DELAY),
            Err(error) => return Err(error),
        }
    }
}

fn print_replies(
    mut reader: impl BufRead,
    output: &mut impl Write,
    deadline: Instant,
) -> io::Result<i32> {
    let mut line = Vec::new();
    loop {
        read_reply_line(&mut reader, &mut line, deadline)?;
        match serde_json::from_slice::<Reply>(&line)? {
            Reply::Progress { payload } => writeln!(output, "{payload}")?,
            Reply::Done { payload, ok } => {
                writeln!(output, "{payload}")?;
                output.flush()?;
                return Ok(i32::from(!ok));
            }
        }
        output.flush()?;
        line.clear();
    }
}

/// Both initial setup and the plugin callback pass their argv through here.
/// Startup forwarding can arrive before managed state exists, so wait off the
/// event thread. A CLI launch never needs to focus the app's window.
pub(crate) fn forward(app: &AppHandle, args: &[String]) -> bool {
    route(args, |request| {
        let app = app.clone();
        thread::spawn(move || {
            let deadline = Instant::now() + STARTUP_TIMEOUT;
            serve(request, |command, emit| {
                while app.try_state::<LyricsState>().is_none()
                    || app.try_state::<crate::DesktopState>().is_none()
                {
                    if Instant::now() >= deadline {
                        emit(Reply::Done {
                            payload: failure(Some(command), Value::Null, "app-not-ready"),
                            ok: false,
                        });
                        return;
                    }
                    thread::sleep(Duration::from_millis(25));
                }
                execute(command, &AppService(&app), emit);
            });
        });
    })
}

fn route(args: &[String], dispatch: impl FnOnce(Request)) -> bool {
    match parse(args) {
        Ok(Some(request)) => {
            if request.reply.is_some() {
                dispatch(request);
            }
            true
        }
        Err(_) => true,
        Ok(None) => false,
    }
}

fn serve(request: Request, execute: impl FnOnce(&Command, &mut dyn FnMut(Reply))) {
    let Some((port, token)) = request.reply else {
        return;
    };
    let Ok(mut stream) = TcpStream::connect_timeout(
        &SocketAddrV4::new(Ipv4Addr::LOCALHOST, port).into(),
        Duration::from_secs(5),
    ) else {
        return;
    };
    let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
    if writeln!(stream, "{token}").is_err() {
        return;
    }
    execute(&request.command, &mut |reply| {
        // A vanished terminal does not cancel an app-owned install.
        if let Ok(line) = serde_json::to_string(&reply) {
            let _ = writeln!(stream, "{line}");
        }
    });
}

trait Service {
    fn status(&self) -> Value;
    fn install(&self, target: &str, feedback: Feedback) -> ShellResult<Value>;
    fn remove(&self, target: &str, feedback: &Feedback) -> ShellResult<Value>;
}

struct AppService<'a>(&'a AppHandle);
impl Service for AppService<'_> {
    fn status(&self) -> Value {
        crate::lyrics::status(self.0, &self.0.state::<LyricsState>())
    }
    fn install(&self, target: &str, feedback: Feedback) -> ShellResult<Value> {
        crate::lyrics::install_target_observed(self.0.clone(), target, feedback)
    }
    fn remove(&self, target: &str, feedback: &Feedback) -> ShellResult<Value> {
        crate::lyrics::remove_observed(self.0, target, feedback)
    }
}

fn execute(command: &Command, service: &impl Service, emit: &mut dyn FnMut(Reply)) {
    if command == &Command::Status {
        emit(Reply::Done {
            payload: service.status(),
            ok: true,
        });
        return;
    }
    let (sender, receiver) = mpsc::channel();
    let feedback = Feedback(Some(sender));
    let result = match command {
        Command::Install(target) => service.install(target, feedback.clone()).and_then(|reply| {
            if reply["already"] == true {
                return Err(ShellError::Guard("installing"));
            }
            if reply["started"] != true {
                return Err(reply["reason"].as_str().unwrap_or("install-failed").into());
            }
            Ok(())
        }),
        Command::Remove(target) => service.remove(target, &feedback).map(|_| ()),
        Command::Status => unreachable!(),
    };
    // Drop the caller's sender so a lost worker is an error rather than a hang.
    drop(feedback);
    let result = if result.is_ok() && matches!(command, Command::Install(_)) {
        loop {
            match receiver.recv() {
                Ok(AddonEvent::Progress(payload)) => emit(Reply::Progress { payload }),
                Ok(AddonEvent::Finished(result)) => break result,
                Err(_) => break Err(ShellError::Guard("install-worker-disconnected")),
            }
        }
    } else {
        for event in receiver.try_iter() {
            if let AddonEvent::Progress(payload) = event {
                emit(Reply::Progress { payload });
            }
        }
        result
    };
    let state = service.status();
    let ok = result.is_ok();
    let payload = match result {
        Ok(()) => json!({"ok": true, "addon": command.addon(), "state": state}),
        Err(error) => failure(Some(command), state, error),
    };
    emit(Reply::Done { payload, ok });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    fn argv(args: &[&str]) -> Vec<String> {
        std::iter::once("krobi")
            .chain(args.iter().copied())
            .map(String::from)
            .collect()
    }

    #[test]
    fn parses_all_public_verbs_and_targets() {
        for name in ["engine", "lyrics", "stems", "analysis"] {
            for verb in ["install", "remove"] {
                let request = parse(&argv(&["--addon", verb, name])).unwrap().unwrap();
                assert_eq!(request.command.addon(), Some(name));
                assert_eq!(
                    matches!(request.command, Command::Install(_)),
                    verb == "install"
                );
                assert_eq!(request.reply, None);
            }
        }
        assert_eq!(
            parse(&argv(&["--addon", "status"]))
                .unwrap()
                .unwrap()
                .command,
            Command::Status
        );
        assert_eq!(parse(&argv(&[])).unwrap(), None);
        assert_eq!(parse(&argv(&["--unrelated"])).unwrap(), None);
    }

    #[test]
    fn rejects_missing_unknown_and_extra_arguments() {
        for args in [
            vec!["--addon"],
            vec!["--addon", "install"],
            vec!["--addon", "remove"],
            vec!["--addon", "update", "lyrics"],
            vec!["--addon", "install", "unknown"],
            vec!["--addon", "install", "Lyrics"],
            vec!["--addon", "status", "lyrics"],
            vec!["--addon", "install", "engine", "extra"],
            vec!["extra", "--addon", "status"],
            vec![REPLY_FLAG, "12", "token"],
            vec![
                "--addon",
                "status",
                REPLY_FLAG,
                "0",
                "00000000000000000000000000000000",
            ],
            vec![
                "--addon",
                "status",
                REPLY_FLAG,
                "65536",
                "00000000000000000000000000000000",
            ],
            vec!["--addon", "status", REPLY_FLAG, "12", "short"],
        ] {
            assert!(parse(&argv(&args)).is_err(), "{args:?}");
        }
    }

    struct Fixture {
        state: Arc<Mutex<Value>>,
        reject: Option<&'static str>,
        fail: bool,
        calls: Mutex<Vec<String>>,
    }

    impl Fixture {
        fn new() -> Self {
            Self {
                state: Arc::new(Mutex::new(json!({"addons": {}, "agentRunning": false}))),
                reject: None,
                fail: false,
                calls: Mutex::new(Vec::new()),
            }
        }
    }

    impl Service for Fixture {
        fn status(&self) -> Value {
            self.state.lock().unwrap().clone()
        }
        fn install(&self, target: &str, feedback: Feedback) -> ShellResult<Value> {
            self.calls.lock().unwrap().push(format!("install:{target}"));
            if let Some(reason) = self.reject {
                return Ok(if reason == "installing" {
                    json!({"started": true, "already": true})
                } else {
                    json!({"started": false, "reason": reason})
                });
            }
            let state = self.state.clone();
            let target = target.to_owned();
            let fail = self.fail;
            thread::spawn(move || {
                let sender = feedback.0.unwrap();
                sender.send(AddonEvent::Progress(json!({"running": true, "target": target, "phase": "modelos", "percent": 25}))).unwrap();
                sender
                    .send(AddonEvent::Progress(
                        json!({"running": false, "target": target}),
                    ))
                    .unwrap();
                // Completion follows the restart, even though the last UI event
                // has already announced that the installation itself finished.
                state.lock().unwrap()["agentRunning"] = json!(!fail);
                state.lock().unwrap()["addons"][&target] = json!({"installed": !fail});
                sender
                    .send(AddonEvent::Finished(if fail {
                        Err("prefetch failed\nwith details".into())
                    } else {
                        Ok(())
                    }))
                    .unwrap();
            });
            Ok(json!({"started": true}))
        }
        fn remove(&self, target: &str, feedback: &Feedback) -> ShellResult<Value> {
            self.calls.lock().unwrap().push(format!("remove:{target}"));
            if let Some(reason) = self.reject {
                return Err(reason.into());
            }
            self.state.lock().unwrap()["addons"][target] = json!({"installed": false});
            feedback
                .0
                .as_ref()
                .unwrap()
                .send(AddonEvent::Progress(json!({"running": false})))
                .unwrap();
            Ok(json!({"ok": true}))
        }
    }

    /// Uses the production argv router, reply socket, executor and stdout reader.
    /// Only the engine boundary is substituted; it never touches a live helper.
    fn forwarded(args: &[&str], service: &impl Service) -> (i32, Vec<Value>) {
        let listener = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0)).unwrap();
        let token = "0123456789abcdef0123456789abcdef"; // gitleaks:allow (test fixture)
        let mut args = argv(args);
        args.extend([
            REPLY_FLAG.into(),
            listener.local_addr().unwrap().port().to_string(),
            token.into(),
        ]);
        thread::scope(|scope| {
            let client = scope.spawn(|| {
                let (stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut reader = BufReader::new(stream);
                let mut handshake = String::new();
                reader.read_line(&mut handshake).unwrap();
                assert_eq!(handshake.trim_end(), token);
                let mut output = Vec::new();
                let code =
                    print_replies(reader, &mut output, Instant::now() + Duration::from_secs(5))
                        .unwrap();
                let lines = String::from_utf8(output)
                    .unwrap()
                    .lines()
                    .map(|line| serde_json::from_str(line).unwrap())
                    .collect();
                (code, lines)
            });
            assert!(route(&args, |request| serve(request, |command, emit| {
                execute(command, service, emit)
            })));
            client.join().unwrap()
        })
    }

    #[test]
    fn forwarded_install_waits_for_completion_and_preserves_each_progress_event() {
        for target in ["engine", "lyrics", "stems", "analysis"] {
            let service = Fixture::new();
            let (code, lines) = forwarded(&["--addon", "install", target], &service);
            assert_eq!(code, 0);
            assert_eq!(lines.len(), 3);
            assert_eq!(
                lines[0],
                json!({"running": true, "target": target, "phase": "modelos", "percent": 25})
            );
            assert_eq!(lines[1], json!({"running": false, "target": target}));
            assert_eq!(
                lines[2],
                json!({"ok": true, "addon": target, "state": service.status()})
            );
            assert_eq!(lines[2]["state"]["agentRunning"], true);
            assert_eq!(
                *service.calls.lock().unwrap(),
                [format!("install:{target}")]
            );
        }
    }

    #[test]
    fn forwarded_remove_and_status_use_the_service_without_wrapping_status() {
        let service = Fixture::new();
        for target in ["engine", "lyrics", "stems", "analysis"] {
            let (code, lines) = forwarded(&["--addon", "remove", target], &service);
            assert_eq!(code, 0);
            assert_eq!(lines[0], json!({"running": false}));
            assert_eq!(
                lines[1],
                json!({"ok": true, "addon": target, "state": service.status()})
            );
        }
        let (code, lines) = forwarded(&["--addon", "status"], &service);
        assert_eq!(code, 0);
        assert_eq!(lines, [service.status()]);
        assert_eq!(service.calls.lock().unwrap().len(), 4);
    }

    #[test]
    fn forwarded_failures_are_json_and_exit_one_including_busy_and_worker_errors() {
        for reason in [
            "engine-first",
            "no-uv",
            "unsupported-platform",
            "installing",
        ] {
            let mut service = Fixture::new();
            service.reject = Some(reason);
            let (code, lines) = forwarded(&["--addon", "install", "lyrics"], &service);
            assert_eq!(code, 1);
            assert_eq!(lines.len(), 1);
            assert_eq!(lines[0]["error"], reason);
            assert_eq!(lines[0]["ok"], false);
        }
        let mut service = Fixture::new();
        service.fail = true;
        let (code, lines) = forwarded(&["--addon", "install", "analysis"], &service);
        assert_eq!(code, 1);
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[2]["error"], "prefetch failed\nwith details");
        service.reject = Some("remove-addons-first");
        let (code, lines) = forwarded(&["--addon", "remove", "engine"], &service);
        assert_eq!(code, 1);
        assert_eq!(lines[0]["error"], "remove-addons-first");
    }

    #[test]
    fn ordinary_launches_focus_and_only_reply_requests_dispatch() {
        assert!(!route(&argv(&[]), |_| panic!("ordinary launch dispatched")));
        assert!(route(&argv(&["--addon", "status"]), |_| panic!(
            "missing reply dispatched"
        )));
        assert!(route(&argv(&["--addon", "invalid"]), |_| panic!(
            "invalid request dispatched"
        )));
    }

    #[test]
    fn nonblocking_reply_transport_waits_and_preserves_partial_lines() {
        // Model an accepted socket inheriting nonblocking mode on macOS.
        // Release the rest of the final reply only after a real WouldBlock.
        struct ObservedReader {
            inner: BufReader<TcpStream>,
            blocked: mpsc::Sender<()>,
        }
        impl io::Read for ObservedReader {
            fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
                io::Read::read(&mut self.inner, buffer)
            }
        }
        impl BufRead for ObservedReader {
            fn fill_buf(&mut self) -> io::Result<&[u8]> {
                let result = self.inner.fill_buf();
                if matches!(&result, Err(error) if error.kind() == io::ErrorKind::WouldBlock) {
                    let _ = self.blocked.send(());
                }
                result
            }
            fn consume(&mut self, amount: usize) {
                self.inner.consume(amount);
            }
        }
        let listener = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0)).unwrap();
        let mut sender = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let progress = json!({"phase": "entorno", "running": true, "target": "analysis"});
        let done = json!({"ok": true, "addon": "analysis", "state": {"agentRunning": true}});
        let first = serde_json::to_string(&Reply::Progress {
            payload: progress.clone(),
        })
        .unwrap();
        let last = serde_json::to_string(&Reply::Done {
            payload: done.clone(),
            ok: true,
        })
        .unwrap();
        let split = last.len() / 2;
        write!(sender, "{first}\n{}", &last[..split]).unwrap();
        let mut reader = BufReader::new(stream);
        assert!(!reader.fill_buf().unwrap().is_empty());
        reader.get_ref().set_nonblocking(true).unwrap();
        let (blocked, observed) = mpsc::channel();
        let mut output = Vec::new();
        let result = thread::scope(|scope| {
            scope.spawn(move || {
                observed.recv_timeout(Duration::from_secs(5)).unwrap();
                writeln!(sender, "{}", &last[split..]).unwrap();
            });
            print_replies(
                ObservedReader {
                    inner: reader,
                    blocked,
                },
                &mut output,
                Instant::now() + Duration::from_secs(5),
            )
        });
        assert_eq!(result.unwrap(), 0);
        assert_eq!(
            String::from_utf8(output).unwrap(),
            format!("{progress}\n{done}\n")
        );
    }

    #[test]
    fn reply_deadline_returns_clear_timeout_even_after_progress() {
        let listener = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0)).unwrap();
        let mut sender = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let progress = json!({"percent": 25});
        writeln!(
            sender,
            "{}",
            serde_json::to_string(&Reply::Progress {
                payload: progress.clone()
            })
            .unwrap()
        )
        .unwrap();
        let mut reader = BufReader::new(stream);
        assert!(!reader.fill_buf().unwrap().is_empty());
        reader.get_ref().set_nonblocking(true).unwrap();
        let mut output = Vec::new();
        let error = print_replies(
            reader,
            &mut output,
            Instant::now() + Duration::from_millis(100),
        )
        .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        let payload = failure(
            Some(&Command::Install("analysis".into())),
            Value::Null,
            error,
        );
        assert_eq!(payload["ok"], false);
        assert_eq!(payload["error"], "timeout");
        assert_eq!(String::from_utf8(output).unwrap(), format!("{progress}\n"));
    }

    #[test]
    fn reply_retries_interrupted_and_timed_out_reads_without_losing_utf8() {
        struct Chunks(std::collections::VecDeque<io::Result<Vec<u8>>>);
        impl io::Read for Chunks {
            fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
                unreachable!("buffered reader only");
            }
        }
        impl BufRead for Chunks {
            fn fill_buf(&mut self) -> io::Result<&[u8]> {
                if self.0.front().is_some_and(Result::is_err) {
                    return Err(self.0.pop_front().unwrap().unwrap_err());
                }
                Ok(self
                    .0
                    .front()
                    .map(|chunk| chunk.as_ref().unwrap().as_slice())
                    .unwrap_or_default())
            }
            fn consume(&mut self, amount: usize) {
                let chunk = self.0.front_mut().unwrap().as_mut().unwrap();
                chunk.drain(..amount);
                if chunk.is_empty() {
                    self.0.pop_front();
                }
            }
        }
        let payload = json!({"ok": false, "error": "descarga falló"});
        let reply = serde_json::to_vec(&Reply::Done {
            payload: payload.clone(),
            ok: false,
        })
        .unwrap();
        let split = reply.iter().position(|byte| *byte == 0xc3).unwrap() + 1;
        let chunks = Chunks(std::collections::VecDeque::from([
            Ok(reply[..split].to_vec()),
            Err(io::ErrorKind::Interrupted.into()),
            Err(io::ErrorKind::TimedOut.into()),
            Ok(reply[split..].to_vec()),
            Ok(vec![b'\n']),
        ]));
        let mut output = Vec::new();
        assert_eq!(
            print_replies(chunks, &mut output, Instant::now() + Duration::from_secs(5)).unwrap(),
            1
        );
        assert_eq!(String::from_utf8(output).unwrap(), format!("{payload}\n"));
    }

    #[test]
    fn disconnected_app_is_an_error_instead_of_success() {
        let mut output = Vec::new();
        let line = serde_json::to_string(&Reply::Progress {
            payload: json!({"percent": 10}),
        })
        .unwrap();
        let error = print_replies(
            io::Cursor::new(format!("{line}\n")),
            &mut output,
            Instant::now() + Duration::from_secs(5),
        )
        .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::UnexpectedEof);
        assert_eq!(String::from_utf8(output).unwrap(), "{\"percent\":10}\n");
    }

    #[test]
    #[ignore = "manual forwarded-handler harness; uses no live app, helper, models or server"]
    fn forwarded_handler_harness() {
        let service = Fixture::new();
        for args in [
            vec!["--addon", "install", "analysis"],
            vec!["--addon", "status"],
            vec!["--addon", "remove", "analysis"],
        ] {
            let (code, lines) = forwarded(&args, &service);
            for line in lines {
                println!("{line}");
            }
            println!("exit={code}");
            assert_eq!(code, 0);
        }
    }
}
