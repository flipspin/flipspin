//! Suspend before assigning the job, so the onefile launcher cannot escape it
//! by starting Python before AssignProcessToJobObject has run.
use super::*;
use std::os::windows::{
    ffi::OsStringExt,
    io::{AsRawHandle, FromRawHandle, OwnedHandle},
    process::CommandExt,
};
use windows_sys::Win32::{
    Foundation::{
        ERROR_INSUFFICIENT_BUFFER, FILETIME, HANDLE, INVALID_HANDLE_VALUE, WAIT_OBJECT_0,
    },
    NetworkManagement::IpHelper::{
        GetExtendedTcpTable, MIB_TCPROW_OWNER_PID, TCP_TABLE_OWNER_PID_LISTENER,
    },
    Networking::WinSock::AF_INET,
    System::{
        Console::{GenerateConsoleCtrlEvent, CTRL_BREAK_EVENT},
        Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
        },
        JobObjects::*,
        Threading::*,
    },
};

fn owned(handle: HANDLE) -> io::Result<OwnedHandle> {
    if handle.is_null() || handle == INVALID_HANDLE_VALUE {
        Err(io::Error::last_os_error())
    } else {
        // SAFETY: a successful API call returned a new owned kernel handle.
        Ok(unsafe { OwnedHandle::from_raw_handle(handle) })
    }
}

pub(super) fn spawn(command: &mut Command) -> io::Result<ChildTree> {
    // SAFETY: no security attributes or name; the handle is not inherited.
    let job = owned(unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) })?;
    let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    // SAFETY: properly sized, initialized limits and a live job handle.
    if unsafe {
        SetInformationJobObject(
            job.as_raw_handle(),
            JobObjectExtendedLimitInformation,
            (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            std::mem::size_of_val(&limits) as u32,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    let mut child = command
        .creation_flags(CREATE_SUSPENDED | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW)
        .spawn()?;
    let attach = || -> io::Result<()> {
        // SAFETY: both handles remain live; the process is still suspended.
        if unsafe { AssignProcessToJobObject(job.as_raw_handle(), child.as_raw_handle()) } == 0 {
            return Err(io::Error::last_os_error());
        }
        // Command does not expose CreateProcess's initial thread handle. The
        // suspended process has exactly one thread; find it via ToolHelp.
        // SAFETY: the snapshot contains threads only, no pointer arguments.
        let snapshot = owned(unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) })?;
        let mut entry = THREADENTRY32 {
            dwSize: std::mem::size_of::<THREADENTRY32>() as u32,
            ..Default::default()
        };
        // SAFETY: live snapshot and initialized, correctly sized entry.
        let mut more = unsafe { Thread32First(snapshot.as_raw_handle(), &mut entry) } != 0;
        while more {
            if entry.th32OwnerProcessID == child.id() {
                // SAFETY: request only resume access to the selected thread.
                let thread =
                    owned(unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID) })?;
                // SAFETY: the thread handle is live and belongs to this child.
                if unsafe { ResumeThread(thread.as_raw_handle()) } == u32::MAX {
                    return Err(io::Error::last_os_error());
                }
                return Ok(());
            }
            // SAFETY: same live snapshot and entry as Thread32First.
            more = unsafe { Thread32Next(snapshot.as_raw_handle(), &mut entry) } != 0;
        }
        Err(io::Error::other(
            "could not find the nest launcher's thread",
        ))
    };
    if let Err(error) = attach() {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }
    Ok(ChildTree {
        child,
        job,
        stopped: false,
    })
}

pub(super) fn job_empty(job: &OwnedHandle) -> io::Result<bool> {
    let mut info = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
    // SAFETY: live handle and correctly sized writable information buffer.
    if unsafe {
        QueryInformationJobObject(
            job.as_raw_handle(),
            JobObjectBasicAccountingInformation,
            (&mut info as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
            std::mem::size_of_val(&info) as u32,
            std::ptr::null_mut(),
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(info.ActiveProcesses == 0)
}

pub(super) fn kill_job(job: &OwnedHandle) -> io::Result<()> {
    // SAFETY: this job contains only this shell's backend tree.
    if unsafe { TerminateJobObject(job.as_raw_handle(), 1) } == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

pub(super) fn process_executable(pid: u32) -> Option<PathBuf> {
    // SAFETY: query-only handle to the process identified by the OS.
    let process = owned(unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) }).ok()?;
    image_path(&process)
}

pub(super) fn process_generation(pid: u32) -> Option<u128> {
    // SAFETY: query-only handle and initialized writable FILETIME records.
    unsafe {
        let process = owned(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid)).ok()?;
        let mut creation = FILETIME::default();
        let mut exit = FILETIME::default();
        let mut kernel = FILETIME::default();
        let mut user = FILETIME::default();
        if GetProcessTimes(
            process.as_raw_handle(),
            &mut creation,
            &mut exit,
            &mut kernel,
            &mut user,
        ) == 0
        {
            return None;
        }
        Some((u128::from(creation.dwHighDateTime) << 32) | u128::from(creation.dwLowDateTime))
    }
}

fn image_path(process: &OwnedHandle) -> Option<PathBuf> {
    let mut buffer = vec![0u16; 32768];
    let mut length = buffer.len() as u32;
    // SAFETY: live query handle and writable UTF-16 buffer of the given size.
    if unsafe {
        QueryFullProcessImageNameW(process.as_raw_handle(), 0, buffer.as_mut_ptr(), &mut length)
    } == 0
    {
        return None;
    }
    Some(PathBuf::from(std::ffi::OsString::from_wide(
        &buffer[..length as usize],
    )))
}

pub(super) fn listens_on(pid: u32, port: u16) -> bool {
    let mut size = 0;
    // SAFETY: the first call only obtains the required table size.
    if unsafe {
        GetExtendedTcpTable(
            std::ptr::null_mut(),
            &mut size,
            0,
            AF_INET as u32,
            TCP_TABLE_OWNER_PID_LISTENER,
            0,
        )
    } != ERROR_INSUFFICIENT_BUFFER
    {
        return false;
    }
    let mut buffer = vec![0u32; (size as usize).div_ceil(4)];
    // SAFETY: DWORD-aligned buffer large enough for the requested table.
    if unsafe {
        GetExtendedTcpTable(
            buffer.as_mut_ptr().cast(),
            &mut size,
            0,
            AF_INET as u32,
            TCP_TABLE_OWNER_PID_LISTENER,
            0,
        )
    } != 0
    {
        return false;
    }
    let count = buffer[0] as usize;
    let row_size = std::mem::size_of::<MIB_TCPROW_OWNER_PID>();
    if 4 + count * row_size > buffer.len() * 4 {
        return false;
    }
    // SAFETY: checked row count/size; table starts after the DWORD count.
    let rows = unsafe {
        std::slice::from_raw_parts(buffer.as_ptr().add(1).cast::<MIB_TCPROW_OWNER_PID>(), count)
    };
    rows.iter()
        .any(|row| row.dwOwningPid == pid && u16::from_be(row.dwLocalPort as u16) == port)
}

pub(super) fn stop_existing(pid: u32, executable: &Path) -> io::Result<()> {
    // Hold a process handle through the grace period to prevent PID reuse
    // from targeting another process during escalation.
    // SAFETY: request query, wait and termination rights only.
    let process = owned(unsafe {
        OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE | PROCESS_SYNCHRONIZE,
            0,
            pid,
        )
    })?;
    if image_path(&process).as_deref() != Some(executable) {
        return Err(io::Error::other("local nest process changed"));
    }
    // SAFETY: best-effort console signal to a dedicated process group only;
    // Windows has no SIGTERM. A legacy GUI child may have no console at all.
    unsafe {
        GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, pid);
    }
    // SAFETY: a live process handle, with a bounded wait.
    if unsafe { WaitForSingleObject(process.as_raw_handle(), GRACE.as_millis() as u32) }
        == WAIT_OBJECT_0
    {
        return Ok(());
    }
    // SAFETY: still the verified process, held by its handle throughout.
    if unsafe { TerminateProcess(process.as_raw_handle(), 1) } == 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: wait for termination to release the listening socket.
    if unsafe { WaitForSingleObject(process.as_raw_handle(), 1000) } != WAIT_OBJECT_0 {
        return Err(io::Error::other("old local nest did not stop"));
    }
    Ok(())
}
