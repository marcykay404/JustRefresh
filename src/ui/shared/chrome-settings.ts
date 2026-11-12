/** JustRefresh's own page in Chrome's extension settings (site access, "Allow access to file URLs"). */
export function openChromeSiteAccess() {
  void chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
}

/**
 * Whether Chrome lets JustRefresh into local files ("Allow access to file
 * URLs"). While it's off, asking for file:/// access is refused without a
 * prompt, so only Chrome's settings can turn it on.
 */
export async function fileAccessAllowed(): Promise<boolean> {
  try {
    return await chrome.extension.isAllowedFileSchemeAccess();
  } catch {
    return false;
  }
}
