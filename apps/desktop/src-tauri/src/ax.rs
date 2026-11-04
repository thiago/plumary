//! Thin, safe-ish wrapper over the macOS Accessibility API for the one thing we need:
//! read the focused text field in any app, know its selection, replace a range, and
//! find where it is on screen so the panel can anchor next to it.

use accessibility_sys::{
    kAXBoundsForRangeParameterizedAttribute, kAXErrorSuccess, kAXFocusedUIElementAttribute, kAXNumberOfCharactersAttribute,
    kAXPositionAttribute, kAXSelectedTextAttribute, kAXSelectedTextRangeAttribute, kAXSizeAttribute,
    kAXTrustedCheckOptionPrompt, kAXValueAttribute, kAXValueTypeCFRange, kAXValueTypeCGPoint,
    kAXValueTypeCGRect, kAXValueTypeCGSize, kAXWindowAttribute, kAXStringForRangeParameterizedAttribute, AXError, AXIsProcessTrustedWithOptions,
    AXUIElementCopyAttributeValue, AXUIElementCopyParameterizedAttributeValue, AXUIElementCreateSystemWide,
    AXUIElementGetPid, AXUIElementSetAttributeValue, AXValueCreate, AXValueGetValue, AXValueRef,
    AXUIElementRef,
};
use core_foundation::base::{CFRange, CFRelease, CFRetain, CFType, CFTypeRef, TCFType};
use core_foundation::boolean::CFBoolean;
use core_foundation::dictionary::CFDictionary;
use core_foundation::string::{CFString, CFStringRef};
use core_graphics::geometry::{CGPoint, CGRect, CGSize};
use serde::Serialize;
use std::ffi::c_void;

#[derive(Debug, thiserror::Error)]
pub enum AxError {
    #[error("accessibility permission not granted")]
    NotTrusted,
    #[error("no focused text element")]
    NoFocusedElement,
    #[error("AX call {0} failed with code {1}")]
    Call(&'static str, AXError),
    #[error("focused element has no readable text value")]
    NoValue,
}


#[derive(Debug, Clone, Serialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct FieldSnapshot {
    pub text: String,
    /// UTF-16 offsets into `text`, matching JS string indexing.
    pub selection_start: usize,
    pub selection_end: usize,
    pub pid: i32,
    pub bounds: Option<Rect>,
    #[serde(skip)]
    pub offsets: OffsetMap,
}

/// Translation between UTF-16 offsets in the `AXValue` text and the app's own range offsets.
#[derive(Debug, Clone, Default)]
pub struct OffsetMap {
    /// `to_ax[i]` is the range offset for value offset `i`; has `value_len + 1` entries.
    to_ax: Vec<usize>,
}

impl OffsetMap {
    pub fn identity(value_len: usize) -> Self {
        OffsetMap { to_ax: (0..=value_len).collect() }
    }

    /// Aligns the two texts; characters present only in the value (block separators) map to
    /// the position they would have in the range text. Returns None when the texts differ in
    /// ways other than line breaks.
    fn align(value: &[u16], ax: &[u16]) -> Option<Self> {
        const LF: u16 = b'\n' as u16;
        const CR: u16 = b'\r' as u16;
        let mut to_ax = Vec::with_capacity(value.len() + 1);
        let (mut i, mut j) = (0, 0);
        while i < value.len() {
            if j < ax.len() && value[i] == ax[j] {
                to_ax.push(j);
                i += 1;
                j += 1;
            } else if value[i] == LF || value[i] == CR {
                to_ax.push(j);
                i += 1;
            } else if j < ax.len() && (ax[j] == LF || ax[j] == CR) {
                j += 1;
            } else {
                return None;
            }
        }
        to_ax.push(ax.len());
        Some(OffsetMap { to_ax })
    }

    pub fn to_ax(&self, value_offset: usize) -> usize {
        self.to_ax.get(value_offset).copied().unwrap_or_else(|| self.to_ax.last().copied().unwrap_or(value_offset))
    }

    pub fn to_value(&self, ax_offset: usize) -> usize {
        self.to_ax.iter().position(|&a| a >= ax_offset).unwrap_or(self.to_ax.len().saturating_sub(1))
    }
}

/// Owned reference to an AXUIElement. AX calls are safe from any thread in practice.
pub struct Element(AXUIElementRef);

unsafe impl Send for Element {}
unsafe impl Sync for Element {}

impl Drop for Element {
    fn drop(&mut self) {
        unsafe { CFRelease(self.0 as CFTypeRef) }
    }
}

impl Clone for Element {
    fn clone(&self) -> Self {
        unsafe { CFRetain(self.0 as CFTypeRef) };
        Element(self.0)
    }
}

pub fn is_trusted(prompt: bool) -> bool {
    unsafe {
        let key = CFString::wrap_under_get_rule(kAXTrustedCheckOptionPrompt);
        let options = CFDictionary::from_CFType_pairs(&[(key.as_CFType(), CFBoolean::from(prompt).as_CFType())]);
        AXIsProcessTrustedWithOptions(options.as_concrete_TypeRef())
    }
}

pub fn focused_element() -> Result<Element, AxError> {
    if !is_trusted(false) {
        return Err(AxError::NotTrusted);
    }
    unsafe {
        let system = AXUIElementCreateSystemWide();
        let result = copy_attribute(system, kAXFocusedUIElementAttribute);
        CFRelease(system as CFTypeRef);
        match result {
            Ok(value) => Ok(Element(value as AXUIElementRef)),
            Err(_) => Err(AxError::NoFocusedElement),
        }
    }
}

impl Element {
    pub fn pid(&self) -> i32 {
        let mut pid = 0;
        unsafe { AXUIElementGetPid(self.0, &mut pid) };
        pid
    }

    pub fn snapshot(&self) -> Result<FieldSnapshot, AxError> {
        let text = self.string_attribute(kAXValueAttribute)?;
        let offsets = self.offset_map(&text);
        let (ax_start, ax_end) = self.selected_range().unwrap_or((0, 0));
        let bounds = self.anchor_rect(ax_start, ax_end.max(ax_start));
        let snapshot = FieldSnapshot {
            selection_start: offsets.to_value(ax_start),
            selection_end: offsets.to_value(ax_end),
            text,
            offsets,
            pid: self.pid(),
            bounds,
        };
        Ok(snapshot)
    }

    /// Maps offsets in the `AXValue` text to the app's own range space. Native text views use
    /// the same space for both. Chromium's `AXValue` joins block elements with "\n" but its
    /// ranges don't count those separators, so every paragraph after the first is shifted;
    /// aligning `AXValue` with `AXStringForRange` over the whole text recovers the mapping.
    pub fn offset_map(&self, value: &str) -> OffsetMap {
        let value: Vec<u16> = value.encode_utf16().collect();
        let Some(ax_text) = self.full_range_string() else { return OffsetMap::identity(value.len()) };
        let ax_text: Vec<u16> = ax_text.encode_utf16().collect();
        if ax_text == value {
            return OffsetMap::identity(value.len());
        }
        OffsetMap::align(&value, &ax_text).unwrap_or_else(|| OffsetMap::identity(value.len()))
    }

    /// The whole text as the app sees it for ranges. `AXNumberOfCharacters` may overshoot the
    /// real range length (Chromium reports the `AXValue` length), so probe downwards for the
    /// longest range the app accepts.
    fn full_range_string(&self) -> Option<String> {
        let reported = self.number_of_characters().ok()?;
        if let Ok(s) = self.string_for_range(0, reported) {
            return Some(s);
        }
        let (mut lo, mut hi) = (0usize, reported); // string_for_range(0, lo) works; (0, hi) doesn't
        while hi - lo > 1 {
            let mid = lo + (hi - lo) / 2;
            if self.string_for_range(0, mid).is_ok() {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        self.string_for_range(0, lo).ok()
    }


    /// Where to anchor the panel. Native text views answer `AXBoundsForRange`; Electron/Chromium
    /// return a zero rect for it, so fall back to the element's own frame, then its window's.
    fn anchor_rect(&self, start: usize, end: usize) -> Option<Rect> {
        self.bounds_for_range(start, end)
            .ok()
            .filter(|r| r.width > 0.0 && r.height > 0.0)
            .or_else(|| self.frame().ok())
            .or_else(|| self.window().and_then(|w| w.frame().ok()))
    }

    fn window(&self) -> Option<Element> {
        unsafe { copy_attribute(self.0, kAXWindowAttribute).ok().map(|v| Element(v as AXUIElementRef)) }
    }

    fn frame(&self) -> Result<Rect, AxError> {
        unsafe {
            let pos = copy_attribute(self.0, kAXPositionAttribute)?;
            let mut point = CGPoint::new(0.0, 0.0);
            let ok_pos = AXValueGetValue(pos as AXValueRef, kAXValueTypeCGPoint, &mut point as *mut CGPoint as *mut c_void);
            CFRelease(pos);
            let size = copy_attribute(self.0, kAXSizeAttribute)?;
            let mut sz = CGSize::new(0.0, 0.0);
            let ok_size = AXValueGetValue(size as AXValueRef, kAXValueTypeCGSize, &mut sz as *mut CGSize as *mut c_void);
            CFRelease(size);
            if !(ok_pos && ok_size) || sz.width <= 0.0 || sz.height <= 0.0 {
                return Err(AxError::NoValue);
            }
            Ok(Rect { x: point.x, y: point.y, width: sz.width, height: sz.height })
        }
    }

    pub fn text(&self) -> Result<String, AxError> {
        self.string_attribute(kAXValueAttribute)
    }

    /// Selects `[start, end)` (UTF-16 offsets) in the target field.
    pub fn select_range(&self, start: usize, end: usize) -> Result<(), AxError> {
        let range = CFRange { location: start as isize, length: (end - start) as isize };
        unsafe {
            let range_value = AXValueCreate(kAXValueTypeCFRange, &range as *const CFRange as *const c_void);
            let status = AXUIElementSetAttributeValue(self.0, cfstr(kAXSelectedTextRangeAttribute), range_value as CFTypeRef);
            CFRelease(range_value as CFTypeRef);
            check(status, "set AXSelectedTextRange")
        }
    }

    /// Replaces `[start, end)` with `replacement` by selecting the range and setting the
    /// selected text, which keeps undo history in native apps. Chromium/Electron accept this
    /// call and do nothing, so callers must verify by re-reading the text.
    /// Replaces the current selection through `AXSelectedText`. Some apps accept this silently
    /// without changing anything (Chromium); callers must verify.
    pub fn replace_selection(&self, replacement: &str) -> Result<(), AxError> {
        unsafe {
            let text = CFString::new(replacement);
            let status = AXUIElementSetAttributeValue(self.0, cfstr(kAXSelectedTextAttribute), text.as_CFTypeRef());
            check(status, "set AXSelectedText")
        }
    }

    fn string_attribute(&self, name: &'static str) -> Result<String, AxError> {
        unsafe {
            let value = copy_attribute(self.0, name).map_err(|_| AxError::NoValue)?;
            let cf = CFType::wrap_under_create_rule(value);
            cf.downcast::<CFString>().map(|s| s.to_string()).ok_or(AxError::NoValue)
        }
    }

    fn selected_range(&self) -> Result<(usize, usize), AxError> {
        unsafe {
            let value = copy_attribute(self.0, kAXSelectedTextRangeAttribute)?;
            let mut range = CFRange { location: 0, length: 0 };
            let ok = AXValueGetValue(value as AXValueRef, kAXValueTypeCFRange, &mut range as *mut CFRange as *mut c_void);
            CFRelease(value);
            if !ok {
                return Err(AxError::NoValue);
            }
            let start = range.location.max(0) as usize;
            Ok((start, start + range.length.max(0) as usize))
        }
    }

    /// Length of the text in the app's own offset space (the one selection ranges use).
    pub fn number_of_characters(&self) -> Result<usize, AxError> {
        unsafe {
            let value = copy_attribute(self.0, kAXNumberOfCharactersAttribute)?;
            let cf = CFType::wrap_under_create_rule(value);
            cf.downcast::<core_foundation::number::CFNumber>()
                .and_then(|n| n.to_i64())
                .map(|n| n.max(0) as usize)
                .ok_or(AxError::NoValue)
        }
    }

    /// Text for a range expressed in the app's own offset space.
    pub fn string_for_range(&self, start: usize, end: usize) -> Result<String, AxError> {
        let range = CFRange { location: start as isize, length: (end - start) as isize };
        unsafe {
            let param = AXValueCreate(kAXValueTypeCFRange, &range as *const CFRange as *const c_void);
            let mut out: CFTypeRef = std::ptr::null();
            let status = AXUIElementCopyParameterizedAttributeValue(
                self.0,
                cfstr(kAXStringForRangeParameterizedAttribute),
                param as CFTypeRef,
                &mut out,
            );
            CFRelease(param as CFTypeRef);
            check(status, "AXStringForRange")?;
            if out.is_null() {
                return Err(AxError::NoValue);
            }
            let cf = CFType::wrap_under_create_rule(out);
            cf.downcast::<CFString>().map(|s| s.to_string()).ok_or(AxError::NoValue)
        }
    }

    fn bounds_for_range(&self, start: usize, end: usize) -> Result<Rect, AxError> {
        let range = CFRange { location: start as isize, length: (end - start) as isize };
        unsafe {
            let param = AXValueCreate(kAXValueTypeCFRange, &range as *const CFRange as *const c_void);
            let mut out: CFTypeRef = std::ptr::null();
            let status = AXUIElementCopyParameterizedAttributeValue(
                self.0,
                cfstr(kAXBoundsForRangeParameterizedAttribute),
                param as CFTypeRef,
                &mut out,
            );
            CFRelease(param as CFTypeRef);
            check(status, "AXBoundsForRange")?;
            let mut rect = CGRect::new(&Default::default(), &Default::default());
            let ok = AXValueGetValue(out as AXValueRef, kAXValueTypeCGRect, &mut rect as *mut CGRect as *mut c_void);
            CFRelease(out);
            if !ok {
                return Err(AxError::NoValue);
            }
            Ok(Rect { x: rect.origin.x, y: rect.origin.y, width: rect.size.width, height: rect.size.height })
        }
    }
}

unsafe fn copy_attribute(element: AXUIElementRef, name: &'static str) -> Result<CFTypeRef, AxError> {
    let mut out: CFTypeRef = std::ptr::null();
    let status = AXUIElementCopyAttributeValue(element, cfstr(name), &mut out);
    check(status, "AXUIElementCopyAttributeValue")?;
    if out.is_null() {
        return Err(AxError::NoValue);
    }
    Ok(out)
}

/// Leaks one small CFString per distinct attribute name; names are static and few.
fn cfstr(name: &'static str) -> CFStringRef {
    let s = CFString::from_static_string(name);
    let r = s.as_concrete_TypeRef();
    std::mem::forget(s);
    r
}

fn check(status: AXError, call: &'static str) -> Result<(), AxError> {
    if status == kAXErrorSuccess {
        Ok(())
    } else {
        Err(AxError::Call(call, status))
    }
}

/// Brings the app that owns the text field back to the front (after our panel took focus).
pub fn activate_pid(pid: i32) {
    use objc2_app_kit::{NSApplicationActivationOptions, NSRunningApplication};
    if let Some(app) = NSRunningApplication::runningApplicationWithProcessIdentifier(pid) {
        app.activateWithOptions(NSApplicationActivationOptions::empty());
    }
}

/// Pid of the active (frontmost) application, i.e. the one that receives keyboard events.
pub fn frontmost_pid() -> Option<i32> {
    use objc2_app_kit::NSWorkspace;
    NSWorkspace::sharedWorkspace().frontmostApplication().map(|app| app.processIdentifier())
}

/// Activates `pid` and blocks until it is actually frontmost, so simulated keystrokes that
/// follow land in that app and not in ours. Returns false if it never came to the front.
pub fn activate_and_wait(pid: i32, timeout: std::time::Duration) -> bool {
    const POLL: std::time::Duration = std::time::Duration::from_millis(10);
    let deadline = std::time::Instant::now() + timeout;
    activate_pid(pid);
    while frontmost_pid() != Some(pid) {
        if std::time::Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(POLL);
    }
    true
}
