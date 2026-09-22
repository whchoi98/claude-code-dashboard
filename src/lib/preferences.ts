// Preferences are optional. Private browsing, embedded contexts, or a full
// storage quota must not prevent the dashboard from mounting or switching org.
export function readPreference(key: string): string | null {
  try { return window.localStorage.getItem(key) }
  catch { return null }
}

export function writePreference(key: string, value: string): void {
  try { window.localStorage.setItem(key, value) }
  catch { /* Keep using the in-memory selection for this visit. */ }
}

export function removePreference(key: string): void {
  try { window.localStorage.removeItem(key) }
  catch { /* Storage may be unavailable. */ }
}
