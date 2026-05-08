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
    expect(result.result.frames.map((frame) => frame.time)).toEqual([0, 0.01, 0.02, 0.025]);
    expect(result.result.frames.map((frame) => frame.index)).toEqual([0, 1, 2, 3]);
    expect(result.diagnostics.frameCount).toBe(4);
  });

  test("keeps frame arrays compatible with the static Tet4 result", () => {
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
      expect(frame.displacement.length).toBe(staticResult.result.displacement.length);
      expect(frame.velocity.length).toBe(staticResult.result.displacement.length);
      expect(frame.acceleration.length).toBe(staticResult.result.displacement.length);
      expect(frame.strain.length).toBe(staticResult.result.strain.length);
      expect(frame.stress.length).toBe(staticResult.result.stress.length);
      expect(frame.vonMises.length).toBe(staticResult.result.vonMises.length);
    }
  });

  test("preserves signed displacement, velocity, and acceleration over sinusoidal loading", () => {
    const result = solveDynamicTet4Cpu(singleTetStaticFixture, {
      endTime: 0.08,
      timeStep: 0.005,
      outputInterval: 0.005,
      dampingRatio: 0,
      loadProfile: "sinusoidal"
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const displacement = result.result.frames.flatMap((frame) => Array.from(frame.displacement));
    const velocity = result.result.frames.flatMap((frame) => Array.from(frame.velocity));
    const acceleration = result.result.frames.flatMap((frame) => Array.from(frame.acceleration));
    expect(displacement.some((value) => value < 0)).toBe(true);
    expect(displacement.some((value) => value > 0)).toBe(true);
    expect(velocity.some((value) => value < 0)).toBe(true);
    expect(velocity.some((value) => value > 0)).toBe(true);
    expect(acceleration.some((value) => value < 0)).toBe(true);
    expect(acceleration.some((value) => value > 0)).toBe(true);
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
