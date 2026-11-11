/**
 * "Pick" next to a selector field: shows the element picker in the tab chosen
 * under Test, and fills the field with the element the user clicks there.
 */
import { useEffect, useRef, useState } from "react";
import { api } from "../shared/api";
import { ErrorBox } from "../shared/components";
import { PICK_CHANNEL, type PickMessage } from "../../shared/messaging-types";

/** Bring this builder page back to the front after picking. */
async function focusThisPage() {
  const tab = await chrome.tabs.getCurrent().catch(() => undefined);
  if (tab?.id === undefined) return;
  await chrome.tabs.update(tab.id, { active: true }).catch(() => undefined);
  await chrome.windows.update(tab.windowId, { focused: true }).catch(() => undefined);
}

export function PickButton({ tabId, onPicked }: { tabId: number | null; onPicked: (selector: string) => void }) {
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const picked = useRef(onPicked);
  picked.current = onPicked;

  useEffect(() => {
    if (!picking || tabId === null) return;
    const onMessage = (msg: unknown, sender: chrome.runtime.MessageSender) => {
      const m = msg as PickMessage | undefined;
      // Only the answer from the tab we asked, sent by our own content script.
      if (m?.channel !== PICK_CHANNEL || sender.id !== chrome.runtime.id || sender.tab?.id !== tabId) return;
      setPicking(false);
      if (m.selector) picked.current(m.selector);
      void focusThisPage();
    };
    chrome.runtime.onMessage.addListener(onMessage);
    return () => chrome.runtime.onMessage.removeListener(onMessage);
  }, [picking, tabId]);

  const start = async () => {
    if (tabId === null) return;
    setError(null);
    setPicking(true); // listen before the picker can answer
    try {
      await api("startPicker", { tabId });
    } catch (e) {
      setPicking(false);
      setError(e);
    }
  };
  const cancel = () => {
    setPicking(false);
    if (tabId !== null) void api("cancelPicker", { tabId }).catch(() => undefined);
  };

  return (
    <>
      {picking ? (
        <button className="small" type="button" onClick={cancel} title="Stop picking">
          Picking… Cancel
        </button>
      ) : (
        <button
          className="small"
          type="button"
          disabled={tabId === null}
          onClick={() => void start()}
          title={tabId === null ? "Choose a tab under Test first" : "Point at an element in the tab chosen under Test and click it"}
        >
          Pick
        </button>
      )}
      {error !== null && <ErrorBox error={error} />}
    </>
  );
}
