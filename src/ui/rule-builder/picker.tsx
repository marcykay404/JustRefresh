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

const newSession = () => `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

export function PickButton({ tabId, onPicked }: { tabId: number | null; onPicked: (selector: string) => void }) {
  /** The running pick (its session), or null. */
  const [session, setSession] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [positional, setPositional] = useState(false);
  const picked = useRef(onPicked);
  picked.current = onPicked;

  useEffect(() => {
    if (session === null || tabId === null) return;
    const onMessage = (msg: unknown, sender: chrome.runtime.MessageSender) => {
      const m = msg as PickMessage | undefined;
      // Only this button's pick, from the tab we asked, sent by our own content script.
      if (m?.channel !== PICK_CHANNEL || m.session !== session || sender.id !== chrome.runtime.id || sender.tab?.id !== tabId) return;
      setSession(null);
      if (m.replaced) return; // another Pick took over that tab
      if (m.selector) {
        picked.current(m.selector);
        setPositional(m.positional === true);
      }
      void focusThisPage();
    };
    chrome.runtime.onMessage.addListener(onMessage);
    return () => {
      chrome.runtime.onMessage.removeListener(onMessage);
    };
  }, [session, tabId]);

  // Leaving the builder mid-pick: don't leave the picker swallowing clicks in that tab.
  const running = useRef<{ session: string | null; tabId: number | null }>({ session: null, tabId: null });
  running.current = { session, tabId };
  useEffect(
    () => () => {
      const { session: s, tabId: t } = running.current;
      if (s !== null && t !== null) void api("cancelPicker", { tabId: t }).catch(() => undefined);
    },
    [],
  );

  const start = async () => {
    if (tabId === null) return;
    setError(null);
    setPositional(false);
    const s = newSession();
    setSession(s); // listen before the picker can answer
    try {
      await api("startPicker", { tabId, session: s });
    } catch (e) {
      setSession(null);
      setError(e);
    }
  };
  const cancel = () => {
    setSession(null);
    if (tabId !== null) void api("cancelPicker", { tabId }).catch(() => undefined);
  };

  return (
    <>
      {session !== null ? (
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
      {positional && (
        <span className="small warn-text" title="The selector counts the element's position among its siblings">
          By position: may match another item if the list changes
        </span>
      )}
      {error !== null && <ErrorBox error={error} />}
    </>
  );
}
