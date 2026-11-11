import { migrateConfig, MigrationError } from "@/storage/migrations";
import { MemoryKV } from "@/storage/kv";
import { CONFIG_BACKUP_KEY, CONFIG_KEY, ConfigRepository } from "@/storage/repositories";
import { restoreTabOverrides } from "@/background/tab-manager";
import { makeRule } from "../helpers/fixtures";
import type { TabInfo, TabOverride } from "@/core/types";

describe("migrations", () => {
  it("upgrades unversioned v0 configs", () => {
    const rule = makeRule({ id: "a" });
    const { config, migrated } = migrateConfig({ settings: { paused: true }, rules: [rule] });
    expect(migrated).toBe(true);
    expect(config.schemaVersion).toBe(1);
    expect(config.settings.paused).toBe(true);
    expect(config.settings.defaultSafety.inactivityGraceSeconds).toBe(60);
    expect(config.rules.a.id).toBe("a");
  });
  it("refuses configs from the future", () => {
    expect(() => migrateConfig({ schemaVersion: 99 })).toThrow(MigrationError);
  });
});

describe("ConfigRepository", () => {
  it("serializes concurrent updates", async () => {
    const repo = new ConfigRepository(new MemoryKV());
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        repo.update((c) => {
          c.exclusions.push({ id: String(i), pattern: "a.com", createdAt: 0 });
        }),
      ),
    );
    expect((await repo.get()).exclusions).toHaveLength(20);
  });
  it("recovers from a corrupt primary copy using the backup and drops invalid rules", async () => {
    const kv = new MemoryKV();
    const good = makeRule({ id: "good" });
    await kv.set({ [CONFIG_KEY]: { schemaVersion: 99 }, [CONFIG_BACKUP_KEY]: { schemaVersion: 1, rules: { good, bad: { id: "bad" } } } });
    const repo = new ConfigRepository(kv);
    const c = await repo.get();
    expect(Object.keys(c.rules)).toEqual(["good"]);
    expect(repo.loadWarnings.join(" ")).toMatch(/backup/);
  });
  it("failed updates leave state untouched", async () => {
    const repo = new ConfigRepository(new MemoryKV());
    await expect(
      repo.update(() => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect((await repo.get()).exclusions).toEqual([]);
  });
});

describe("tab override restoration", () => {
  const tab = (id: number, url: string, index = 0): TabInfo => ({ id, url, index, windowId: 1, title: "", active: false, discarded: false, restricted: false });
  const o = (tabId: number, url: string, tabIndex = 0): TabOverride => ({
    tabId,
    mode: "custom",
    revision: 1,
    createdAt: 0,
    restore: { url, windowIndex: 0, tabIndex },
  });
  it("keeps, reassigns, disambiguates, and drops", () => {
    const r = restoreTabOverrides(
      { "1": o(1, "https://a/"), "2": o(2, "https://b/"), "3": o(3, "https://c/", 5), "4": o(4, "https://d/"), "5": o(5, "https://e/", 1) },
      [tab(1, "https://a/"), tab(20, "https://b/"), tab(30, "https://c/", 4), tab(31, "https://c/", 5), tab(50, "https://e/", 2), tab(51, "https://e/", 3)],
    );
    expect(Object.keys(r.overrides).sort()).toEqual(["1", "20", "31"]);
    expect(r.ambiguous.map((x) => x.tabId)).toEqual([5]);
    expect(r.dropped.map((x) => x.tabId)).toEqual([4]);
  });
});
