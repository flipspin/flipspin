//! Process-owned App Nap assertions. The owner thread retains every native token
//! until its renderer reason is released or the shell accepts quit.
use std::{collections::HashMap, io, sync::mpsc, thread};

type Reply = mpsc::SyncSender<()>;
enum Command {
    Set(String, String, bool, Reply),
    Stop(Reply),
}

pub(crate) struct Activity {
    commands: mpsc::Sender<Command>,
}
impl Activity {
    pub(crate) fn new() -> io::Result<Self> {
        Self::with_begin(native::begin)
    }
    fn with_begin<G: 'static>(begin: impl Fn(&str) -> G + Send + 'static) -> io::Result<Self> {
        let (commands, receiver) = mpsc::channel();
        thread::Builder::new()
            .name("playback-activity".into())
            .spawn(move || {
                let mut held = HashMap::new();
                while let Ok(command) = receiver.recv() {
                    match command {
                        Command::Set(owner, reason, active, reply) => {
                            let key = (owner, reason);
                            if active {
                                held.entry(key.clone()).or_insert_with(|| begin(&key.1));
                            } else {
                                held.remove(&key);
                            }
                            let _ = reply.send(());
                        }
                        Command::Stop(reply) => {
                            held.clear();
                            let _ = reply.send(());
                            break;
                        }
                    }
                }
                // Sender disconnect (including shell teardown) also drops tokens.
            })?;
        Ok(Self { commands })
    }
    pub(crate) fn set(&self, owner: &str, reason: &str, active: bool) -> bool {
        let (reply, result) = mpsc::sync_channel(1);
        self.commands
            .send(Command::Set(owner.into(), reason.into(), active, reply))
            .is_ok()
            && result.recv().is_ok()
    }
    pub(crate) fn shutdown(&self) {
        let (reply, result) = mpsc::sync_channel(1);
        if self.commands.send(Command::Stop(reply)).is_ok() {
            let _ = result.recv();
        }
    }
}

#[cfg(target_os = "macos")]
mod native {
    use objc2::{rc::Retained, runtime::ProtocolObject};
    use objc2_foundation::{NSActivityOptions, NSObjectProtocol, NSProcessInfo, NSString};

    const OPTIONS: NSActivityOptions =
        NSActivityOptions::UserInitiated.union(NSActivityOptions::LatencyCritical);

    pub(super) struct Token(Retained<ProtocolObject<dyn NSObjectProtocol>>);
    pub(super) fn begin(reason: &str) -> Token {
        Token(
            NSProcessInfo::processInfo()
                .beginActivityWithOptions_reason(OPTIONS, &NSString::from_str(reason)),
        )
    }
    impl Drop for Token {
        fn drop(&mut self) {
            // SAFETY: this is the live token returned by beginActivity, retained
            // on its owning thread, and this guard ends it exactly once.
            unsafe { NSProcessInfo::processInfo().endActivity(&self.0) }
        }
    }
    #[cfg(test)]
    #[test]
    fn native_call_wrapper_begins_and_ends() {
        assert_eq!(OPTIONS.bits(), 0xFF00FFFFFF);
        drop(begin("Playback activity test"));
    }
}
#[cfg(not(target_os = "macos"))]
mod native {
    pub(super) fn begin(_: &str) {}
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    struct Token(Arc<Mutex<Vec<String>>>, String);
    impl Drop for Token {
        fn drop(&mut self) {
            self.0.lock().unwrap().push(format!("end:{}", self.1));
        }
    }
    #[test]
    fn idempotent_and_independent_reasons_end_on_quit() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let observed = calls.clone();
        let activity = Activity::with_begin(move |reason| {
            observed.lock().unwrap().push(format!("begin:{reason}"));
            Token(observed.clone(), reason.into())
        })
        .unwrap();
        assert!(activity.set("main", "Playing music", true));
        assert!(activity.set("main", "Playing music", true));
        assert!(activity.set("main", "Uploading music", true));
        assert!(activity.set("main", "Playing music", false));
        assert!(activity.set("main", "Playing music", false));
        assert_eq!(
            *calls.lock().unwrap(),
            [
                "begin:Playing music",
                "begin:Uploading music",
                "end:Playing music"
            ]
        );
        activity.shutdown();
        activity.shutdown();
        assert_eq!(calls.lock().unwrap().last().unwrap(), "end:Uploading music");
        assert!(!activity.set("main", "Playing music", true));
    }
}
