import { test, expect } from "bun:test";
import {
  resolveTheme,
  DEFAULT_THEME,
  SYSTEM_DARK,
  SYSTEM_LIGHT,
} from "../../src/lib/themes";

test("system preference resolves to the dark member when the OS is dark", () => {
  expect(resolveTheme("system", true)).toBe(SYSTEM_DARK);
});

test("system preference resolves to the light member when the OS is light", () => {
  expect(resolveTheme("system", false)).toBe(SYSTEM_LIGHT);
});

test("a known theme id resolves to itself", () => {
  expect(resolveTheme("tokyo-night", false)).toBe("tokyo-night");
  expect(resolveTheme("handy-light", true)).toBe("handy-light");
});

test("an unknown or legacy theme id falls back to the default", () => {
  expect(resolveTheme("does-not-exist", false)).toBe(DEFAULT_THEME);
  expect(resolveTheme("", true)).toBe(DEFAULT_THEME);
});
