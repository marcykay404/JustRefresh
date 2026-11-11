/**
 * For an address with a "?…" part: does the rule cover only this exact
 * address, or this page whatever comes after "?"? Some sites change that
 * part on every load (the tab would then drop out of an exact-address rule);
 * on others it decides what the page is (?id=42 is one product).
 */
import { useId } from "react";

export function QueryChoice({ url, anyQuery, onChange }: { url: string; anyQuery: boolean; onChange: (anyQuery: boolean) => void }) {
  const name = useId();
  let query = "";
  try {
    query = new URL(url).search;
  } catch {
    /* not a URL: nothing to show */
  }
  if (query.length <= 1) return null;
  const shown = query.length > 32 ? `${query.slice(0, 31)}…` : query;
  return (
    <fieldset className="query-choice">
      <legend className="small muted">Which address?</legend>
      <label className="small">
        <input type="radio" name={name} checked={!anyQuery} onChange={() => onChange(false)} />
        <span>
          Only this exact address <code className="query-part">{shown}</code>
        </span>
      </label>
      <label className="small">
        <input type="radio" name={name} checked={anyQuery} onChange={() => onChange(true)} />
        <span>This page, whatever comes after “?” (for sites that change it on every load)</span>
      </label>
    </fieldset>
  );
}
