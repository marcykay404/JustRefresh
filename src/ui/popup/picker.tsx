/** The interval chips' state: the chosen interval, whether it's allowed, and the picker itself. */
import { useState } from "react";
import { intervalChips } from "./describe";
import { IntervalPicker } from "./parts";

export function useIntervalPicker(currentInterval: number, fastAllowed: boolean) {
  /** Interval picked in the chips (null = the tab's current one). */
  const [picked, setPicked] = useState<number | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const [customValue, setCustomValue] = useState("");
  const [customUnit, setCustomUnit] = useState(60);

  const minSeconds = fastAllowed ? 5 : 30;
  const customSeconds = customOpen && customValue ? Math.round(Number(customValue) * customUnit) : null;
  const chosen = customSeconds ?? picked ?? currentInterval;
  const valid = Number.isFinite(chosen) && chosen >= minSeconds;
  const tooShort = valid
    ? null
    : fastAllowed
      ? "The shortest interval is 5 seconds."
      : "The shortest interval is 30 seconds. Shorter ones can be turned on in Dashboard → Settings → Advanced.";

  const reset = () => {
    setPicked(null);
    setCustomOpen(false);
    setCustomValue("");
  };
  /** Pick an interval (e.g. the one a click asked for before the popup closed). */
  const choose = (seconds: number) => {
    setCustomOpen(false);
    setPicked(seconds);
  };

  const element = (
    <IntervalPicker
      chips={intervalChips(fastAllowed)}
      value={chosen}
      customOpen={customOpen}
      customValue={customValue}
      customUnit={customUnit}
      minSeconds={minSeconds}
      onPick={(v) => {
        setPicked(v);
        setCustomOpen(false);
      }}
      onCustom={() => {
        setCustomOpen(true);
        if (customValue) return;
        const unit = chosen % 3600 === 0 ? 3600 : chosen % 60 === 0 ? 60 : 1;
        setCustomUnit(unit);
        setCustomValue(String(chosen / unit));
      }}
      onCustomValue={setCustomValue}
      onCustomUnit={setCustomUnit}
    />
  );

  return { chosen, valid, tooShort, reset, element, choose };
}
