//! Bounded platform hardware probes and capability predictions.

use super::*;

pub(super) fn hardware() -> Value {
    static FACTS: OnceLock<Value> = OnceLock::new();
    FACTS
        .get_or_init(|| {
            let (chip, memory, gpu) = probe_hardware();
            let (accel, jobs) = predict_capabilities(
                memory,
                gpu.is_some(),
                cfg!(all(target_os = "macos", target_arch = "aarch64")),
            );
            json!({"name": crate::desktop::discovery::device_name(), "chip": chip,
                "memoryBytes": memory, "gpu": gpu, "accel": accel, "jobs": jobs})
        })
        .clone()
}

fn predict_capabilities(
    memory: Option<u64>,
    nvidia: bool,
    apple_silicon: bool,
) -> (&'static str, Vec<&'static str>) {
    let accel = if apple_silicon {
        "mlx"
    } else if nvidia {
        "cuda"
    } else {
        "cpu"
    };
    let capable = memory.map_or(apple_silicon, |bytes| bytes >= 8 * 2_u64.pow(30));
    (
        accel,
        if capable {
            vec!["align", "transcribe", "stems", "analysis"]
        } else {
            vec!["analysis"]
        },
    )
}

fn nonempty(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_string())
}

#[cfg(any(target_os = "linux", test))]
fn parse_cpuinfo(text: &str) -> Option<String> {
    text.lines().find_map(|line| {
        let (key, value) = line.split_once(':')?;
        (key.trim() == "model name")
            .then(|| nonempty(value))
            .flatten()
    })
}

#[cfg(any(target_os = "linux", test))]
fn parse_meminfo(text: &str) -> Option<u64> {
    let value = text
        .lines()
        .find_map(|line| line.strip_prefix("MemTotal:"))?;
    let mut fields = value.split_whitespace();
    let kib = fields.next()?.parse::<u64>().ok()?;
    if fields.next()? != "kB" || fields.next().is_some() || kib == 0 {
        return None;
    }
    kib.checked_mul(1024)
}

#[cfg(any(target_os = "linux", target_os = "windows", test))]
fn parse_nvidia_smi(text: &str) -> Option<String> {
    nonempty(text.lines().next()?)
}

#[cfg(any(target_os = "linux", test))]
fn parse_nvidia_information(text: &str) -> Option<String> {
    text.lines().find_map(|line| {
        let (key, value) = line.split_once(':')?;
        (key.trim() == "Model").then(|| nonempty(value)).flatten()
    })
}

#[cfg(target_os = "macos")]
fn probe_hardware() -> (Option<String>, Option<u64>, Option<String>) {
    let probe = |key: &str| {
        let output = Command::new("sysctl").args(["-n", key]).output().ok()?;
        output
            .status
            .success()
            .then(|| nonempty(&String::from_utf8_lossy(&output.stdout)))
            .flatten()
    };
    (
        probe("machdep.cpu.brand_string").and_then(|s| nonempty(s.trim_start_matches("Apple "))),
        probe("hw.memsize").and_then(|s| s.parse::<u64>().ok()),
        None,
    )
}

// Poll only this small, optional probe; a broken driver must not hold up status.
pub(super) fn probe_output(command: &mut Command, timeout: Duration) -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    return None;
                }
                let output = child.wait_with_output().ok()?;
                return String::from_utf8(output.stdout).ok();
            }
            Ok(None) if start.elapsed() < timeout => thread::sleep(Duration::from_millis(10)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}

#[cfg(any(target_os = "linux", target_os = "windows"))]
fn nvidia_smi(path: impl AsRef<std::ffi::OsStr>) -> Option<String> {
    let output = probe_output(
        Command::new(path).args(["--query-gpu=name", "--format=csv,noheader"]),
        Duration::from_millis(750),
    )?;
    parse_nvidia_smi(&output)
}

#[cfg(target_os = "linux")]
fn probe_hardware() -> (Option<String>, Option<u64>, Option<String>) {
    let chip = fs::read_to_string("/proc/cpuinfo")
        .ok()
        .and_then(|s| parse_cpuinfo(&s));
    let memory = fs::read_to_string("/proc/meminfo")
        .ok()
        .and_then(|s| parse_meminfo(&s));
    let gpu = nvidia_smi("nvidia-smi").or_else(|| {
        fs::read_dir("/proc/driver/nvidia/gpus")
            .ok()?
            .filter_map(Result::ok)
            .find_map(|entry| {
                let text = fs::read_to_string(entry.path().join("information")).ok()?;
                parse_nvidia_information(&text)
            })
    });
    (chip, memory, gpu)
}

#[cfg(target_os = "windows")]
fn windows_chip() -> Option<String> {
    use windows_sys::Win32::{
        Foundation::ERROR_SUCCESS,
        System::Registry::{RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ},
    };
    let wide = |s: &str| s.encode_utf16().chain(Some(0)).collect::<Vec<u16>>();
    let key = wide(r"HARDWARE\DESCRIPTION\System\CentralProcessor\0");
    let name = wide("ProcessorNameString");
    let mut buffer = [0_u16; 512];
    let mut size = std::mem::size_of_val(&buffer) as u32;
    // SAFETY: terminated UTF-16 inputs; writable buffer is `size` bytes long.
    let result = unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            key.as_ptr(),
            name.as_ptr(),
            RRF_RT_REG_SZ,
            std::ptr::null_mut(),
            buffer.as_mut_ptr().cast(),
            &mut size,
        )
    };
    if result != ERROR_SUCCESS {
        return None;
    }
    let end = buffer.iter().position(|c| *c == 0)?;
    nonempty(&String::from_utf16(&buffer[..end]).ok()?)
}

#[cfg(target_os = "windows")]
fn windows_memory() -> Option<u64> {
    use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    let mut memory = MEMORYSTATUSEX {
        dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32,
        ..Default::default()
    };
    // SAFETY: initialized structure has the required size and a valid writable pointer.
    (unsafe { GlobalMemoryStatusEx(&mut memory) } != 0).then_some(memory.ullTotalPhys)
}

#[cfg(target_os = "windows")]
fn probe_hardware() -> (Option<String>, Option<u64>, Option<String>) {
    let gpu = std::env::var_os("SystemRoot")
        .and_then(|root| nvidia_smi(PathBuf::from(root).join("System32").join("nvidia-smi.exe")))
        .or_else(|| nvidia_smi("nvidia-smi.exe"));
    (windows_chip(), windows_memory(), gpu)
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
fn probe_hardware() -> (Option<String>, Option<u64>, Option<String>) {
    (None, None, None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hardware_is_cached_and_contains_predicted_capabilities() {
        let facts = hardware();
        assert_eq!(facts, hardware());
        assert_eq!(facts["name"], crate::desktop::discovery::device_name());
        let (accel, jobs) = predict_capabilities(
            facts["memoryBytes"].as_u64(),
            facts["gpu"].is_string(),
            cfg!(all(target_os = "macos", target_arch = "aarch64")),
        );
        assert_eq!(facts["accel"], accel);
        assert_eq!(facts["jobs"], json!(jobs));
        #[cfg(target_os = "macos")]
        assert!(facts["gpu"].is_null());
    }

    #[test]
    fn cpuinfo_uses_the_first_model_name() {
        assert_eq!(
            parse_cpuinfo(include_str!("../fixtures/hardware/cpuinfo.txt")).as_deref(),
            Some("Intel(R) Core(TM) i7-12700 CPU @ 2.10GHz")
        );
        for text in ["", "Hardware: ARM", "model name:   ", "model: 42"] {
            assert_eq!(parse_cpuinfo(text), None);
        }
    }

    #[test]
    fn meminfo_uses_total_kib_with_checked_conversion() {
        assert_eq!(
            parse_meminfo(include_str!("../fixtures/hardware/meminfo.txt")),
            Some(16 * 2_u64.pow(30))
        );
        for text in [
            "",
            "MemFree: 1024 kB",
            "MemTotal: nope kB",
            "MemTotal: -1 kB",
            "MemTotal: 0 kB",
            "MemTotal: 1024",
            "MemTotal: 1024 MB",
            "MemTotal: 1024 kB extra",
            "MemTotal: 18446744073709551615 kB",
        ] {
            assert_eq!(parse_meminfo(text), None, "{text}");
        }
    }

    #[test]
    fn nvidia_names_use_first_gpu_and_trim_platform_whitespace() {
        assert_eq!(
            parse_nvidia_smi(include_str!("../fixtures/hardware/nvidia-smi.txt")).as_deref(),
            Some("NVIDIA GeForce RTX 3060")
        );
        assert_eq!(
            parse_nvidia_smi(include_str!("../fixtures/hardware/nvidia-smi-windows.txt"))
                .as_deref(),
            Some("NVIDIA GeForce RTX 4070 Ti")
        );
        assert_eq!(
            parse_nvidia_smi("  Tesla T4  \r\nTesla V100\r\n").as_deref(),
            Some("Tesla T4")
        );
        assert_eq!(parse_nvidia_smi(""), None);
        assert_eq!(parse_nvidia_smi("  \r\n"), None);
        assert_eq!(
            parse_nvidia_information(include_str!("../fixtures/hardware/nvidia-information.txt"))
                .as_deref(),
            Some("NVIDIA GeForce GTX 1080 Ti")
        );
        for text in ["", "Model:  ", "GPU UUID: GPU-123", "OtherModel: Nvidia"] {
            assert_eq!(parse_nvidia_information(text), None);
        }
    }

    #[test]
    fn capability_predictions_obey_memory_and_architecture() {
        for (memory, nvidia, apple, accel, capable) in [
            (Some(8 * 2_u64.pow(30)), true, false, "cuda", true),
            (Some(16 * 2_u64.pow(30)), false, false, "cpu", true),
            (Some(8 * 2_u64.pow(30) - 1), true, false, "cuda", false),
            (Some(4 * 2_u64.pow(30)), false, true, "mlx", false),
            (None, false, true, "mlx", true),
            (None, true, false, "cuda", false),
            (None, false, false, "cpu", false),
        ] {
            let prediction = predict_capabilities(memory, nvidia, apple);
            assert_eq!(prediction.0, accel);
            assert_eq!(
                prediction.1,
                if capable {
                    vec!["align", "transcribe", "stems", "analysis"]
                } else {
                    vec!["analysis"]
                }
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn optional_probe_returns_none_on_failure_or_timeout() {
        assert!(probe_output(
            &mut Command::new("/nonexistent/krobi-hardware"),
            Duration::from_millis(50)
        )
        .is_none());
        assert!(probe_output(
            Command::new("sh").args(["-c", "exit 1"]),
            Duration::from_millis(50)
        )
        .is_none());
        let start = Instant::now();
        assert!(probe_output(Command::new("sleep").arg("5"), Duration::from_millis(50)).is_none());
        assert!(start.elapsed() < Duration::from_secs(2));
        assert_eq!(
            probe_output(Command::new("printf").arg("Nvidia"), Duration::from_secs(1)).as_deref(),
            Some("Nvidia")
        );
    }
}
