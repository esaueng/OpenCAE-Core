import type { NormalizedOpenCAEModel, OpenCAEModelJson, ValidationReport } from "@opencae/core";

export type CpuSolverInput = OpenCAEModelJson | NormalizedOpenCAEModel;

export type CpuSolverOptions = {
  stepIndex?: number;
  maxDofs?: number;
  singularTolerance?: number;
  solverMode?: "auto" | "dense" | "sparse";
  method?: "auto" | "dense" | "sparse";
  tolerance?: number;
  maxIterations?: number;
};

export type DynamicLoadProfile = "step" | "ramp" | "quasiStatic" | "quasi_static" | "sinusoidal";

export type DynamicTet4CpuOptions = CpuSolverOptions & {
  startTime?: number;
  endTime?: number;
  timeStep?: number;
  outputInterval?: number;
  dampingRatio?: number;
  loadProfile?: DynamicLoadProfile;
  massDensity?: number;
};

export type CpuSolverError = {
  code: string;
  message: string;
  report?: ValidationReport;
};

export type CpuSolverDiagnostics = {
  dofs: number;
  freeDofs: number;
  constrainedDofs: number;
  relativeResidual: number;
  maxDisplacement: number;
  maxVonMisesStress: number;
  solverMode?: "dense" | "sparse";
  iterations?: number;
  converged?: boolean;
};

export type StaticLinearTet4CpuResult = {
  displacement: Float64Array;
  reactionForce: Float64Array;
  strain: Float64Array;
  stress: Float64Array;
  vonMises: Float64Array;
  provenance?: {
    kind: "opencae_core_fea" | "local_estimate";
    solver: "opencae-core-sparse-tet" | "opencae-core-preview-sdof";
    resultSource: "computed" | "computed_preview";
    meshSource: "actual_volume_mesh" | "structured_block";
  };
};

export type StaticLinearTet4CpuSolveResult =
  | {
      ok: true;
      result: StaticLinearTet4CpuResult;
      diagnostics: CpuSolverDiagnostics;
    }
  | {
      ok: false;
      error: CpuSolverError;
      diagnostics?: Partial<CpuSolverDiagnostics>;
    };

export type DynamicTet4CpuFrame = {
  frameIndex: number;
  timeSeconds: number;
  loadScale: number;
  displacement: DynamicResultField;
  velocity: DynamicResultField;
  acceleration: DynamicResultField;
  stress: DynamicResultField;
  vonMises: DynamicResultField;
  safety_factor: DynamicResultField;
};

export type DynamicResultField = {
  values: Float64Array;
  samples: number[];
  frameIndex: number;
  timeSeconds: number;
};

export type DynamicTet4CpuResult = {
  staticResult: StaticLinearTet4CpuResult;
  frames: DynamicTet4CpuFrame[];
};

export type DynamicTet4CpuDiagnostics = CpuSolverDiagnostics & {
  frameCount: number;
  startTime: number;
  endTime: number;
  timeStep: number;
  outputInterval: number;
  dampingRatio: number;
  loadProfile: DynamicLoadProfile;
  equivalentMass: number;
  equivalentStiffness: number;
  peakDisplacement: number;
  peakVelocity: number;
  peakAcceleration: number;
  solver: "opencae-core-mdof-newmark";
};

export type DynamicTet4CpuSolveResult =
  | {
      ok: true;
      result: DynamicTet4CpuResult;
      diagnostics: DynamicTet4CpuDiagnostics;
    }
  | {
      ok: false;
      error: CpuSolverError;
      diagnostics?: Partial<DynamicTet4CpuDiagnostics>;
    };

export type Tet4GeometryResult =
  | {
      ok: true;
      signedVolume: number;
      volume: number;
      gradients: Float64Array;
    }
  | {
      ok: false;
      error: CpuSolverError;
    };

export type Tet4ElementStiffnessResult =
  | {
      ok: true;
      stiffness: Float64Array;
    }
  | {
      ok: false;
      error: CpuSolverError;
    };

export type DenseLinearSolveResult =
  | {
      ok: true;
      solution: Float64Array;
    }
  | {
      ok: false;
      error: CpuSolverError;
    };
