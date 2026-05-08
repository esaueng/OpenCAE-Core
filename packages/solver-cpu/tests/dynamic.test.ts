import { describe, expect, test } from "vitest";
import { singleTetStaticFixture } from "@opencae/examples";
import { solveDynamicTet4Cpu, solveStaticLinearTet4Cpu } from "../src";

describe("solveDynamicTet4Cpu", () => {
  test("generates dynamic frames at the requested cadence including the final end time", () => {
    const result = solveDynamicTet4Cpu(singleTetStaticFixture, {
      endTime: 0.025,
      timeStep: 0.005,
      outputInterval: 0.01
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.frames.map((frame) => frame.timeSeconds)).toEqual([0, 0.01, 0.02, 0.025]);
    expect(result.result.frames.map((frame) => frame.frameIndex)).toEqual([0, 1, 2, 3]);
    expect(result.diagnostics.frameCount).toBe(4);
    expect(result.diagnostics.solver).toBe("opencae-core-mdof-newmark");
  });

  test("keeps frame field arrays compatible with the static Tet4 result", () => {
    const staticResult = solveStaticLinearTet4Cpu(singleTetStaticFixture);
    const dynamicResult = solveDynamicTet4Cpu(singleTetStaticFixture, {
      endTime: 0.02,
      timeStep: 0.005,
      outputInterval: 0.005
    });

    expect(staticResult.ok).toBe(true);
    expect(dynamicResult.ok).toBe(true);
    if (!staticResult.ok || !dynamicResult.ok) return;
    for (const frame of dynamicResult.result.frames) {
      expect(frame.displacement.values.length).toBe(staticResult.result.displacement.length);
      expect(frame.velocity.values.length).toBe(staticResult.result.displacement.length);
      expect(frame.acceleration.values.length).toBe(staticResult.result.displacement.length);
      expect(frame.stress.values.length).toBe(staticResult.result.stress.length);
      expect(frame.vonMises.values.length).toBe(staticResult.result.vonMises.length);
      expect(frame.safety_factor.values.length).toBe(staticResult.result.vonMises.length);
      expect(frame.displacement.samples.length).toBeGreaterThan(0);
      expect(frame.displacement.frameIndex).toBe(frame.frameIndex);
      expect(frame.displacement.timeSeconds).toBe(frame.timeSeconds);
    }
  });

  test("starts ramp, quasi-static, and half-sine profiles near zero", () => {
    for (const loadProfile of ["ramp", "quasi_static", "sinusoidal"] as const) {
      const result = solveDynamicTet4Cpu(singleTetStaticFixture, {
        endTime: 0.04,
        timeStep: 0.005,
        outputInterval: 0.01,
        loadProfile
      });

      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(maxAbs(result.result.frames[0].displacement.values)).toBeLessThan(1e-14);
      expect(maxAbs(result.result.frames.at(-1)?.displacement.values ?? new Float64Array())).toBeGreaterThan(0);
    }
  });

  test("computes real MDOF frames instead of reusing a static scale parser", () => {
    const result = solveDynamicTet4Cpu(singleTetStaticFixture, {
      endTime: 0.08,
      timeStep: 0.005,
      outputInterval: 0.005,
      dampingRatio: 0,
      loadProfile: "step"
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const frames = result.result.frames.map((frame) => Array.from(frame.displacement.values));
    const uniqueFrames = new Set(frames.map((frame) => frame.map((value) => value.toExponential(6)).join(",")));
    expect(uniqueFrames.size).toBeGreaterThan(2);
    expect(result.diagnostics.freeDofs).toBeGreaterThan(1);
  });

  test("responds to density and damping inputs", () => {
    const light = solveDynamicTet4Cpu(singleTetStaticFixture, { massDensity: 1200, dampingRatio: 0.01 });
    const heavy = solveDynamicTet4Cpu(singleTetStaticFixture, { massDensity: 7800, dampingRatio: 0.01 });
    const damped = solveDynamicTet4Cpu(singleTetStaticFixture, { massDensity: 1200, dampingRatio: 0.25 });

    expect(light.ok && heavy.ok && damped.ok).toBe(true);
    if (!light.ok || !heavy.ok || !damped.ok) return;
    expect(heavy.diagnostics.peakDisplacement).not.toBe(light.diagnostics.peakDisplacement);
    expect(damped.diagnostics.peakDisplacement).not.toBe(light.diagnostics.peakDisplacement);
    expect(light.diagnostics.peakVelocity).toBeGreaterThan(0);
    expect(damped.diagnostics.peakAcceleration).toBeGreaterThan(0);
  });
});

function maxAbs(values: Float64Array): number {
  let max = 0;
  for (const value of values) max = Math.max(max, Math.abs(value));
  return max;
}
