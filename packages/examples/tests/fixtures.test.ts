import { validateModelJson } from "@opencae/core";
import { describe, expect, test } from "vitest";
import {
  invalidConnectivityFixture,
  singleTetStaticFixture,
  twoTetStaticFixture
} from "../src";

describe("Phase 1 fixtures", () => {
  test("single-tet-static is valid", () => {
    expect(validateModelJson(singleTetStaticFixture).ok).toBe(true);
  });

  test("two-tet-static is valid", () => {
    expect(validateModelJson(twoTetStaticFixture).ok).toBe(true);
  });

  test("invalid-connectivity is invalid", () => {
    const report = validateModelJson(invalidConnectivityFixture);

    expect(report.ok).toBe(false);
    expect(report.errors.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "invalid-connectivity-length",
        "duplicate-tet-node",
        "node-index-out-of-range"
      ])
    );
  });
});
