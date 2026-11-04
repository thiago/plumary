//! Clipboard-based fallbacks: simulate ⌘C to read a selection from apps that don't expose
//! text through Accessibility. Writing into apps that ignore `AXSelectedText` is handled by
//! synthesised typing in `typing.rs`, not here.

use core_graphics::event::{CGEvent, CGEventFlags, CGEventTapLocation};
use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
use std::thread::sleep;
use std::time::Duration;

const KEY_C: u16 = 8;
const SETTLE: Duration = Duration::from_millis(150);

pub fn copy_selection() -> Option<String> {
    let mut clipboard = arboard::Clipboard::new().ok()?;
    let previous = clipboard.get_text().ok();
    clipboard.set_text("").ok()?;
    press_cmd(KEY_C)?;
    sleep(SETTLE);
    let copied = clipboard.get_text().ok().filter(|t| !t.is_empty());
    if copied.is_none() {
        if let Some(prev) = previous {
            clipboard.set_text(prev).ok();
        }
    }
    copied
}

pub fn set_text(text: &str) -> bool {
    arboard::Clipboard::new().and_then(|mut c| c.set_text(text.to_owned())).is_ok()
}

fn press_cmd(key: u16) -> Option<()> {
    let source = CGEventSource::new(CGEventSourceStateID::CombinedSessionState).ok()?;
    let down = CGEvent::new_keyboard_event(source.clone(), key, true).ok()?;
    let up = CGEvent::new_keyboard_event(source, key, false).ok()?;
    down.set_flags(CGEventFlags::CGEventFlagCommand);
    up.set_flags(CGEventFlags::CGEventFlagCommand);
    down.post(CGEventTapLocation::HID);
    up.post(CGEventTapLocation::HID);
    Some(())
}
