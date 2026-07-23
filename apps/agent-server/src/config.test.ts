import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_CONFIG,
  effectiveEnv,
  loadConfig,
  maskKey,
  saveConfig,
  toSettingsView,
} from "./config";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "vdx-config-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// -- loadConfig ---------------------------------------------------------------

test("loadConfig returns defaults when no config.json exists", () => {
  const config = loadConfig(root);
  expect(config).toEqual(DEFAULT_CONFIG);
});

test("loadConfig never throws on malformed JSON — falls back to defaults", () => {
  writeFileSync(join(root, "config.json"), "{not valid json");
  const config = loadConfig(root);
  expect(config).toEqual(DEFAULT_CONFIG);
});

test("loadConfig merges shallow over defaults so old/partial files don't crash", () => {
  writeFileSync(join(root, "config.json"), JSON.stringify({ plannerModel: "custom-model" }));
  const config = loadConfig(root);
  expect(config.plannerModel).toBe("custom-model");
  expect(config.plannerEffort).toBe(DEFAULT_CONFIG.plannerEffort);
  expect(config.anthropicApiKey).toBeNull();
});

// -- saveConfig -----------------------------------------------------------------

test("saveConfig round-trips through config.json", () => {
  const saved = saveConfig(root, { plannerModel: "opus-test", plannerEffort: "low" });
  expect(saved.plannerModel).toBe("opus-test");
  expect(saved.plannerEffort).toBe("low");

  const reloaded = loadConfig(root);
  expect(reloaded.plannerModel).toBe("opus-test");
  expect(reloaded.plannerEffort).toBe("low");

  const onDisk = JSON.parse(readFileSync(join(root, "config.json"), "utf8"));
  expect(onDisk.plannerModel).toBe("opus-test");
});

test("saveConfig leaves fields unchanged when the patch omits them", () => {
  saveConfig(root, { anthropicApiKey: "sk-ant-1234567890" });
  const after = saveConfig(root, { plannerModel: "another-model" });
  expect(after.anthropicApiKey).toBe("sk-ant-1234567890");
  expect(after.plannerModel).toBe("another-model");
});

test("saveConfig clears a key field on an empty-string patch value", () => {
  saveConfig(root, { falApiKey: "fal-key-1234567890" });
  expect(loadConfig(root).falApiKey).toBe("fal-key-1234567890");

  const cleared = saveConfig(root, { falApiKey: "" });
  expect(cleared.falApiKey).toBeNull();
  expect(loadConfig(root).falApiKey).toBeNull();
});

test("saveConfig sets non-empty key values", () => {
  const saved = saveConfig(root, { elevenLabsApiKey: "eleven-1234567890" });
  expect(saved.elevenLabsApiKey).toBe("eleven-1234567890");
});

// -- maskKey ----------------------------------------------------------------

test("maskKey passes null through", () => {
  expect(maskKey(null)).toBeNull();
});

test("maskKey masks short keys (<10 chars) without slicing", () => {
  expect(maskKey("short")).toBe("…");
  expect(maskKey("123456789")).toBe("…"); // exactly 9 chars
});

test("maskKey previews long keys as first4…last4", () => {
  expect(maskKey("sk-ant-abcdefgh1234")).toBe("sk-a…1234");
  expect(maskKey("0123456789")).toBe("0123…6789"); // exactly 10 chars boundary
});

// -- effectiveEnv -------------------------------------------------------------

const ENV_KEYS = ["ANTHROPIC_API_KEY", "FAL_KEY", "ELEVENLABS_API_KEY"] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

test("effectiveEnv falls back to process.env when config key is null", () => {
  process.env.ANTHROPIC_API_KEY = "env-anthropic-key";
  process.env.FAL_KEY = "env-fal-key";
  const env = effectiveEnv(DEFAULT_CONFIG);
  expect(env.ANTHROPIC_API_KEY).toBe("env-anthropic-key");
  expect(env.FAL_KEY).toBe("env-fal-key");
  expect(env.ELEVENLABS_API_KEY).toBeUndefined();
});

test("effectiveEnv prefers the config value over process.env when set", () => {
  process.env.FAL_KEY = "env-fal-key";
  const config = { ...DEFAULT_CONFIG, falApiKey: "config-fal-key" };
  const env = effectiveEnv(config);
  expect(env.FAL_KEY).toBe("config-fal-key");
});

test("effectiveEnv omits keys that end up empty", () => {
  const env = effectiveEnv(DEFAULT_CONFIG);
  expect(env).toEqual({});
});

// -- toSettingsView -------------------------------------------------------------

test("toSettingsView masks keys and reports set/unset correctly", () => {
  const config = { ...DEFAULT_CONFIG, anthropicApiKey: "sk-ant-abcdefgh1234" };
  const view = toSettingsView(config);
  expect(view.anthropicKeySet).toBe(true);
  expect(view.anthropicKeyPreview).toBe("sk-a…1234");
  expect(view.anthropicKeyPreview).not.toBe(config.anthropicApiKey);
  expect(view.falKeySet).toBe(false);
  expect(view.falKeyPreview).toBeNull();
  expect(view.plannerModel).toBe(DEFAULT_CONFIG.plannerModel);
  expect(view.editorEffort).toBe(DEFAULT_CONFIG.editorEffort);
});
