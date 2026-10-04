use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use tokio::sync::oneshot;
use windows::core::PWSTR;
use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
};
use windows::Win32::System::Threading::{
    OpenProcess, OpenProcessToken, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
    PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Accessibility::{
    CUIAutomation, IUIAutomation, UIA_TextPatternId, UIA_ValuePatternId,
};
use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};

static PROBE_ACTIVE: AtomicBool = AtomicBool::new(false);

struct ProbeActiveGuard;

impl Drop for ProbeActiveGuard {
    fn drop(&mut self) {
        PROBE_ACTIVE.store(false, Ordering::SeqCst);
    }
}

struct ComGuard(bool);

impl Drop for ComGuard {
    fn drop(&mut self) {
        if self.0 {
            unsafe { CoUninitialize() };
        }
    }
}

#[derive(Serialize)]
pub enum ProbeStatus {
    Complete,
    Partial,
    RestrictedTarget,
    UnauthorizedProcess,
    ElevatedTarget,
    TargetDrift,
    PropertyQueryFailed,
    TargetVerificationFailed,
    ProcessAccessDenied,
    FocusQueryFailed,
    UiaInstantiationFailed,
    ComInitializationFailed,
    Busy,
    ThreadCommunicationFailed,
    ThreadSpawnFailed,
}

impl Default for ProbeStatus {
    fn default() -> Self {
        Self::ThreadCommunicationFailed
    }
}

#[derive(Serialize, Default)]
pub struct TargetProbeResult {
    pub status: ProbeStatus,
    pub process_path: Option<String>,
    pub class_name: Option<String>,
    pub control_type: Option<i32>,
    pub framework_id: Option<String>,
    pub automation_id: Option<String>,
    pub aria_role: Option<String>,
    pub is_keyboard_focusable: Option<bool>,
    pub has_value_pattern: Option<bool>,
    pub has_text_pattern: Option<bool>,
}

unsafe fn verify_target_process(pid: u32) -> Result<String, ProbeStatus> {
    let h_process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
        .map_err(|_| ProbeStatus::ProcessAccessDenied)?;

    let mut buffer = [0u16; 1024];
    let mut size = buffer.len() as u32;
    if QueryFullProcessImageNameW(
        h_process,
        PROCESS_NAME_WIN32,
        PWSTR(buffer.as_mut_ptr()),
        &mut size,
    )
    .is_err()
    {
        let _ = CloseHandle(h_process);
        return Err(ProbeStatus::TargetVerificationFailed);
    }

    let full_path = String::from_utf16_lossy(&buffer[..size as usize]).to_lowercase();
    if !full_path.ends_with("\\chrome.exe") && !full_path.ends_with("\\msedge.exe") {
        let _ = CloseHandle(h_process);
        return Err(ProbeStatus::UnauthorizedProcess);
    }

    let mut h_token = HANDLE::default();
    if OpenProcessToken(h_process, TOKEN_QUERY, &mut h_token).is_err() {
        let _ = CloseHandle(h_process);
        return Err(ProbeStatus::TargetVerificationFailed);
    }

    let mut elevation = TOKEN_ELEVATION::default();
    let mut return_length = 0;
    let token_result = GetTokenInformation(
        h_token,
        TokenElevation,
        Some(&mut elevation as *mut _ as *mut std::ffi::c_void),
        std::mem::size_of::<TOKEN_ELEVATION>() as u32,
        &mut return_length,
    );

    let _ = CloseHandle(h_token);
    let _ = CloseHandle(h_process);

    if token_result.is_err() {
        return Err(ProbeStatus::TargetVerificationFailed);
    }
    if elevation.TokenIsElevated != 0 {
        return Err(ProbeStatus::ElevatedTarget);
    }

    Ok(full_path)
}

#[tauri::command]
pub async fn perform_target_probe() -> TargetProbeResult {
    if PROBE_ACTIVE
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return TargetProbeResult {
            status: ProbeStatus::Busy,
            ..Default::default()
        };
    }

    let (tx, rx) = oneshot::channel();
    let spawn_result = thread::Builder::new()
        .name("uia_target_probe".to_string())
        .spawn(move || {
            let _active_guard = ProbeActiveGuard;
            unsafe {
                let hr = CoInitializeEx(None, COINIT_MULTITHREADED);
                let initialized = hr.is_ok();
                let _com_guard = ComGuard(initialized);

                if !initialized {
                    let _ = tx.send(TargetProbeResult {
                        status: ProbeStatus::ComInitializationFailed,
                        ..Default::default()
                    });
                    return;
                }

                let fg_hwnd = GetForegroundWindow();
                let mut fg_pid = 0;
                GetWindowThreadProcessId(fg_hwnd, Some(&mut fg_pid));
                if fg_pid == 0 {
                    let _ = tx.send(TargetProbeResult {
                        status: ProbeStatus::TargetVerificationFailed,
                        ..Default::default()
                    });
                    return;
                }

                match verify_target_process(fg_pid) {
                    Ok(process_path) => {
                        if let Ok(uia) = CoCreateInstance::<_, IUIAutomation>(
                            &CUIAutomation,
                            None,
                            CLSCTX_INPROC_SERVER,
                        ) {
                            if let Ok(element) = uia.GetFocusedElement() {
                                let element_pid = match u32::try_from(
                                    element.CurrentProcessId().unwrap_or(-1),
                                ) {
                                    Ok(pid) if pid != 0 => pid,
                                    _ => {
                                        let _ = tx.send(TargetProbeResult {
                                            status: ProbeStatus::TargetVerificationFailed,
                                            ..Default::default()
                                        });
                                        return;
                                    }
                                };

                                if element_pid != fg_pid {
                                    let _ = tx.send(TargetProbeResult {
                                        status: ProbeStatus::TargetDrift,
                                        ..Default::default()
                                    });
                                    return;
                                }

                                match element.CurrentIsPassword() {
                                    Ok(value) if value.as_bool() => {
                                        let _ = tx.send(TargetProbeResult {
                                            status: ProbeStatus::RestrictedTarget,
                                            ..Default::default()
                                        });
                                        return;
                                    }
                                    Ok(_) => {}
                                    Err(_) => {
                                        let _ = tx.send(TargetProbeResult {
                                            status: ProbeStatus::PropertyQueryFailed,
                                            ..Default::default()
                                        });
                                        return;
                                    }
                                }

                                let class_name = element
                                    .CurrentClassName()
                                    .ok()
                                    .map(|value| value.to_string());
                                let control_type = element
                                    .CurrentControlType()
                                    .ok()
                                    .map(|value| value.0);
                                let framework_id = element
                                    .CurrentFrameworkId()
                                    .ok()
                                    .map(|value| value.to_string());
                                let automation_id = element
                                    .CurrentAutomationId()
                                    .ok()
                                    .map(|value| value.to_string());
                                let aria_role = element
                                    .CurrentAriaRole()
                                    .ok()
                                    .map(|value| value.to_string());
                                let is_keyboard_focusable = element
                                    .CurrentIsKeyboardFocusable()
                                    .ok()
                                    .map(|value| value.as_bool());
                                let has_value_pattern =
                                    element.GetCurrentPattern(UIA_ValuePatternId).is_ok();
                                let has_text_pattern =
                                    element.GetCurrentPattern(UIA_TextPatternId).is_ok();
                                let status = if class_name.is_some()
                                    && control_type.is_some()
                                    && framework_id.is_some()
                                {
                                    ProbeStatus::Complete
                                } else {
                                    ProbeStatus::Partial
                                };

                                let _ = tx.send(TargetProbeResult {
                                    status,
                                    process_path: Some(process_path),
                                    class_name,
                                    control_type,
                                    framework_id,
                                    automation_id,
                                    aria_role,
                                    is_keyboard_focusable,
                                    has_value_pattern: Some(has_value_pattern),
                                    has_text_pattern: Some(has_text_pattern),
                                });
                            } else {
                                let _ = tx.send(TargetProbeResult {
                                    status: ProbeStatus::FocusQueryFailed,
                                    ..Default::default()
                                });
                            }
                        } else {
                            let _ = tx.send(TargetProbeResult {
                                status: ProbeStatus::UiaInstantiationFailed,
                                ..Default::default()
                            });
                        }
                    }
                    Err(status) => {
                        let _ = tx.send(TargetProbeResult {
                            status,
                            ..Default::default()
                        });
                    }
                }
            }
        });

    if spawn_result.is_err() {
        PROBE_ACTIVE.store(false, Ordering::SeqCst);
        return TargetProbeResult {
            status: ProbeStatus::ThreadSpawnFailed,
            ..Default::default()
        };
    }

    rx.await.unwrap_or(TargetProbeResult {
        status: ProbeStatus::ThreadCommunicationFailed,
        ..Default::default()
    })
}
