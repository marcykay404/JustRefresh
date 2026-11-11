/** Minimal key-value contract implemented by chrome.storage areas and test fakes. */
export interface KeyValueStore {
  get(keys: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

export class MemoryKV implements KeyValueStore {
  data = new Map<string, unknown>();
  async get(keys: string | string[] | null) {
    const out: Record<string, unknown> = {};
    const list = keys === null ? [...this.data.keys()] : Array.isArray(keys) ? keys : [keys];
    for (const k of list) if (this.data.has(k)) out[k] = structuredClone(this.data.get(k));
    return out;
  }
  async set(items: Record<string, unknown>) {
    for (const [k, v] of Object.entries(items)) this.data.set(k, structuredClone(v));
  }
  async remove(keys: string | string[]) {
    for (const k of Array.isArray(keys) ? keys : [keys]) this.data.delete(k);
  }
}
