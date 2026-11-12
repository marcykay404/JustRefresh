/**
 * "Loading…" that explains itself: after a few seconds without an answer it
 * asks the service worker what it is busy with (answered at once, even while
 * it starts up) and shows that, with a way to try again.
 */
import { useEffect, useState } from "react";
import { HEALTH_CHANNEL, type HealthReport } from "../../shared/messaging-types";

/** How long "Loading…" shows on its own before explaining. */
export const EXPLAIN_AFTER_MS = 5000;

const seconds = (ms: number) => `${Math.round(ms / 1000)} s`;

async function askHealth(): Promise<HealthReport | null> {
  try {
    return ((await chrome.runtime.sendMessage({ channel: HEALTH_CHANNEL })) as HealthReport | undefined) ?? null;
  } catch {
    return null;
  }
}

export function StillLoading({ onRetry }: { onRetry: () => void }) {
  const [late, setLate] = useState(false);
  const [health, setHealth] = useState<HealthReport | null>(null);
  const [asked, setAsked] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setLate(true), EXPLAIN_AFTER_MS);
    return () => clearTimeout(t);
  }, []);
  useEffect(() => {
    if (!late) return;
    let stop = false;
    const tick = async () => {
      const h = await askHealth();
      if (stop) return;
      setHealth(h);
      setAsked(true);
    };
    void tick();
    const t = setInterval(() => void tick(), 2000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [late]);

  if (!late) return <div className="muted">Loading…</div>;
  return (
    <div className="notice small col" role="status" style={{ gap: 6 }}>
      <strong>JustRefresh is taking longer than usual to answer.</strong>
      {!asked && <span className="muted">Asking it what it's doing…</span>}
      {asked && !health && <span>Its background part isn't responding at all. Reloading the extension in chrome://extensions should fix it.</span>}
      {health && <HealthLines h={health} />}
      <div className="row">
        <button className="small" onClick={onRetry}>
          Retry
        </button>
      </div>
    </div>
  );
}

function HealthLines({ h }: { h: HealthReport }) {
  const waiting = [...h.waiting].sort((a, b) => b.forMs - a.forMs).slice(0, 4);
  return (
    <>
      {h.ready ? (
        <span>Started up in {seconds(h.startupTookMs ?? 0)}.</span>
      ) : (
        <span>
          Still starting up ({seconds(h.upForMs)} so far): {h.startupStep} for {seconds(h.startupStepForMs ?? 0)}.
        </span>
      )}
      {waiting.length > 0 && (
        <span>
          Waiting: {waiting.map((w) => `${w.what} (${seconds(w.forMs)})`).join(", ")}
          {h.waiting.length > waiting.length ? `, and ${h.waiting.length - waiting.length} more` : ""}.
        </span>
      )}
      {h.slow.length > 0 && (
        <span className="muted">
          Slow lately:{" "}
          {h.slow
            .slice(-3)
            .map((s) => `${s.what} (${seconds(s.ms)})`)
            .join(", ")}
          .
        </span>
      )}
      <span className="muted">Please send a screenshot of this to whoever helps you with JustRefresh.</span>
    </>
  );
}
