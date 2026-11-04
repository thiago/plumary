//! Writes a replacement by synthesising Unicode keyboard events posted straight to the target
//! process, the technique Grammarly's GRAccessibilityKit uses for apps that ignore Accessibility
//! writes (Chromium, Electron). Unlike a clipboard paste it never touches the pasteboard and does
//! not depend on the app honouring `AXSelectedText`; the events overwrite the current selection.

use core_graphics::event::{CGEvent, CGEventFlags};
use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
use std::thread::sleep;
use std::time::Duration;

/// UTF-16 units carried by a single synthesised event. A few at a time stays fast while keeping
/// under the burst size where apps start dropping characters.
const CHUNK: usize = 8;
/// Pause between events, so a slow field keeps up with the input (Grammarly jitters this; a small
/// fixed delay is enough for the short replacements we type).
const KEY_COOLDOWN: Duration = Duration::from_millis(6);

/// Types `text` into process `pid` as Unicode key events. Returns false if event creation fails.
/// An empty string is a no-op and succeeds.
pub fn type_text_to_pid(pid: i32, text: &str) -> bool {
    let Ok(source) = CGEventSource::new(CGEventSourceStateID::CombinedSessionState) else {
        return false;
    };
    let units: Vec<u16> = text.encode_utf16().collect();
    for chunk in units.chunks(CHUNK) {
        if !post_chunk(&source, pid, chunk) {
            return false;
        }
        sleep(KEY_COOLDOWN);
    }
    true
}

/// Posts one key-down/key-up pair whose payload is `chunk` of text. Keycode 0 with an attached
/// Unicode string makes the event insert text rather than act as a physical key.
fn post_chunk(source: &CGEventSource, pid: i32, chunk: &[u16]) -> bool {
    let (Ok(down), Ok(up)) = (
        CGEvent::new_keyboard_event(source.clone(), 0, true),
        CGEvent::new_keyboard_event(source.clone(), 0, false),
    ) else {
        return false;
    };
    // Clear modifiers so a held Shift/Cmd from a real keystroke can't bleed into the text.
    down.set_flags(CGEventFlags::CGEventFlagNull);
    up.set_flags(CGEventFlags::CGEventFlagNull);
    down.set_string_from_utf16_unchecked(chunk);
    up.set_string_from_utf16_unchecked(chunk);
    down.post_to_pid(pid);
    up.post_to_pid(pid);
    true
}
