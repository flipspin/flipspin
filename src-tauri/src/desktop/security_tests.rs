//! The packaged policy is deliberately local-only; IPC HTTP hosts are Tauri's
//! custom-protocol aliases, not listening network services.
use serde_json::{json, Value};

#[test]
fn packaged_csp_allows_only_required_local_sources() {
    let config: Value = serde_json::from_str(include_str!("../../tauri.conf.json")).unwrap();
    let policy = &config["app"]["security"]["csp"];
    // An exact allowlist catches null, missing directives and accidentally added
    // remote sources, unsafe-eval or inline script execution.
    assert_eq!(
        policy,
        &json!({
            "default-src": "'self'",
            "script-src": "'self' 'wasm-unsafe-eval'",
            "worker-src": "'self' blob:",
            // data:/blob: let the renderer fetch Vite-inlined assets (the stems Opus probe) and worker blobs.
            "connect-src": "'self' data: blob: ipc: http://ipc.localhost krobi-media: http://krobi-media.localhost",
            // Browse shows catalog artwork straight from provider CDNs (images only).
            "img-src": "'self' data: blob: krobi-media: http://krobi-media.localhost https:",
            "media-src": "'self' data: blob: krobi-media: http://krobi-media.localhost",
            // Menu/Popover positioning, ModalLayer and UI token variables use React
            // style attributes. Scripts still disallow unsafe-inline and unsafe-eval.
            "style-src": "'self' 'unsafe-inline'",
            "font-src": "'self'",
            "object-src": "'none'",
            "base-uri": "'none'",
            "form-action": "'none'",
            "frame-src": "'none'",
            "frame-ancestors": "'none'"
        })
    );
    assert!(config["app"]["security"]["dangerousDisableAssetCspModification"].is_null());
}
