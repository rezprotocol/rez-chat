//! OS authorization gate (macOS owner authentication / Windows Hello).
//!
//! Host authentication contract:
//!   - `is_available()` -> platform supports a biometric prompt right now
//!   - `authenticate(reason)` -> Ok(true) on success, Ok(false) on user
//!     cancel, Err on platform failure
//!   - Linux: unavailable, fail-closed (SECURITY_AUDIT MED-18) — the
//!     password unlock remains available; device unlock never skips consent.
//!
//! macOS authentication permits the OS password fallback even when the
//! separate biometric capability probe reports unavailable.
//! This is the user-authorization GESTURE only; the cryptographic boundary
//! remains the keychain-held device key (see keychain.rs).

#[cfg(target_os = "macos")]
mod imp {
    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2_foundation::{NSError, NSString};
    use objc2_local_authentication::{LAContext, LAError, LAPolicy};
    use std::ptr::NonNull;
    use std::sync::mpsc;
    use std::time::Duration;

    pub fn is_available() -> bool {
        unsafe {
            let context = LAContext::new();
            context
                .canEvaluatePolicy_error(LAPolicy::DeviceOwnerAuthenticationWithBiometrics)
                .is_ok()
        }
    }

    pub fn authenticate(reason: &str) -> Result<bool, String> {
        let (tx, rx) = mpsc::channel::<Result<bool, String>>();
        // Retain this request context until its asynchronous reply completes.
        let context = unsafe { LAContext::new() };
        unsafe {
            if context
                .canEvaluatePolicy_error(LAPolicy::DeviceOwnerAuthentication)
                .is_err()
            {
                return Err("Native authentication unavailable; unlock with your Rez password".to_string());
            }
            let localized = NSString::from_str(reason);
            let reply = RcBlock::new(move |success: objc2::runtime::Bool, error: *mut NSError| {
                if success.as_bool() {
                    let _ = tx.send(Ok(true));
                    return;
                }
                let outcome = match NonNull::new(error) {
                    Some(ptr) => {
                        let err: Retained<NSError> = Retained::retain(ptr.as_ptr()).unwrap();
                        if is_cancellation(err.code()) {
                            Ok(false)
                        } else {
                            Err(err.localizedDescription().to_string())
                        }
                    }
                    None => Err("native authentication failed".to_string()),
                };
                let _ = tx.send(outcome);
            });
            context.evaluatePolicy_localizedReason_reply(
                LAPolicy::DeviceOwnerAuthentication,
                &localized,
                &reply,
            );
        }
        match rx.recv_timeout(Duration::from_secs(120)) {
            Ok(outcome) => outcome,
            Err(_) => {
                unsafe { context.invalidate() };
                Err("native authentication timed out".to_string())
            },
        }
    }

    fn is_cancellation(code: isize) -> bool {
        [LAError::UserCancel, LAError::UserFallback, LAError::SystemCancel, LAError::AppCancel]
            .iter()
            .any(|error| error.0 == code)
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn cancellation_is_independent_of_os_message_language() {
            for error in [LAError::UserCancel, LAError::UserFallback, LAError::SystemCancel, LAError::AppCancel] {
                assert!(is_cancellation(error.0));
            }
        }

        #[test]
        fn authentication_errors_never_count_as_cancellation() {
            for error in [LAError::AuthenticationFailed, LAError::PasscodeNotSet, LAError::NotInteractive] {
                assert!(!is_cancellation(error.0));
            }
        }
    }

}

#[cfg(target_os = "windows")]
mod imp {
    use windows::Security::Credentials::UI::{
        UserConsentVerificationResult, UserConsentVerifier, UserConsentVerifierAvailability,
    };
    use windows::core::HSTRING;

    pub fn is_available() -> bool {
        UserConsentVerifier::CheckAvailabilityAsync()
            .and_then(|op| op.get())
            .map(|availability| availability == UserConsentVerifierAvailability::Available)
            .unwrap_or(false)
    }

    pub fn authenticate(reason: &str) -> Result<bool, String> {
        // NOTE: in a Win32 (non-UWP) process the plain RequestVerificationAsync
        // can fail without a CoreWindow; the documented escape hatch is
        // IUserConsentVerifierInterop::RequestVerificationForWindowAsync with
        // the main window HWND. Verify on real hardware; if the plain call
        // errors, surface it (fail closed) rather than skipping the gesture.
        let op = UserConsentVerifier::RequestVerificationAsync(&HSTRING::from(reason))
            .map_err(|err| format!("verification request failed: {}", err))?;
        let result = op
            .get()
            .map_err(|err| format!("verification wait failed: {}", err))?;
        match result {
            UserConsentVerificationResult::Verified => Ok(true),
            UserConsentVerificationResult::Canceled => Ok(false),
            other => Err(format!("verification failed: {:?}", other)),
        }
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod imp {
    pub fn is_available() -> bool {
        false
    }

    pub fn authenticate(_reason: &str) -> Result<bool, String> {
        Err("biometric unavailable on this platform".to_string())
    }
}

pub fn is_available() -> bool {
    imp::is_available()
}

pub fn authenticate(reason: &str) -> Result<bool, String> {
    imp::authenticate(reason)
}
