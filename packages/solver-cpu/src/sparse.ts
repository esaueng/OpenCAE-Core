export type CsrMatrix = {
  rowCount: number;
  colCount: number;
  rowPtr: Int32Array;
  colInd: Int32Array;
  values: Float64Array;
};

export type SparseMatrixBuilder = {
  rowCount: number;
  colCount: number;
  rows: Map<number, number>[];
};

export type ConjugateGradientResult =
  | {
      ok: true;
      solution: Float64Array;
      iterations: number;
      residualNorm: number;
      relativeResidual: number;
    }
  | {
      ok: false;
      error: {
        code: string;
        message: string;
      };
      iterations: number;
      residualNorm: number;
      relativeResidual: number;
    };

export type ConjugateGradientOptions = {
  tolerance?: number;
  maxIterations?: number;
  preconditioner?: "none" | "jacobi";
};

export class CooAccumulator {
  private readonly builder: SparseMatrixBuilder;

  constructor(rowCount: number, colCount = rowCount) {
    this.builder = createSparseMatrixBuilder(rowCount, colCount);
  }

  addEntry(row: number, col: number, value: number): void {
    addSparseEntry(this.builder, row, col, value);
  }

  finalizeCsr(): CsrMatrix {
    return toCsrMatrix(this.builder);
  }
}

export function createSparseMatrixBuilder(rowCount: number, colCount = rowCount): SparseMatrixBuilder {
  return {
    rowCount,
    colCount,
    rows: Array.from({ length: rowCount }, () => new Map<number, number>())
  };
}

export function addSparseEntry(builder: SparseMatrixBuilder, row: number, col: number, value: number): void {
  if (value === 0) return;
  const rows = builder.rows[row];
  rows.set(col, (rows.get(col) ?? 0) + value);
}

export function toCsrMatrix(builder: SparseMatrixBuilder): CsrMatrix {
  const rowPtr = new Int32Array(builder.rowCount + 1);
  const columns: number[] = [];
  const values: number[] = [];
  for (let row = 0; row < builder.rowCount; row += 1) {
    const entries = [...builder.rows[row].entries()]
      .filter(([, value]) => value !== 0)
      .sort(([a], [b]) => a - b);
    rowPtr[row] = columns.length;
    for (const [col, value] of entries) {
      columns.push(col);
      values.push(value);
    }
  }
  rowPtr[builder.rowCount] = columns.length;
  return {
    rowCount: builder.rowCount,
    colCount: builder.colCount,
    rowPtr,
    colInd: new Int32Array(columns),
    values: new Float64Array(values)
  };
}

export function csrMatVec(matrix: CsrMatrix, vector: Float64Array): Float64Array {
  const result = new Float64Array(matrix.rowCount);
  for (let row = 0; row < matrix.rowCount; row += 1) {
    let sum = 0;
    for (let entry = matrix.rowPtr[row]; entry < matrix.rowPtr[row + 1]; entry += 1) {
      sum += matrix.values[entry] * vector[matrix.colInd[entry]];
    }
    result[row] = sum;
  }
  return result;
}

export const sparseMatVec = csrMatVec;

export function csrDiagonal(matrix: CsrMatrix): Float64Array {
  const diagonal = new Float64Array(matrix.rowCount);
  for (let row = 0; row < matrix.rowCount; row += 1) {
    for (let entry = matrix.rowPtr[row]; entry < matrix.rowPtr[row + 1]; entry += 1) {
      if (matrix.colInd[entry] === row) {
        diagonal[row] = matrix.values[entry];
        break;
      }
    }
  }
  return diagonal;
}

export function jacobiPreconditioner(matrix: CsrMatrix): Float64Array {
  const diagonal = csrDiagonal(matrix);
  const inverse = new Float64Array(diagonal.length);
  for (let i = 0; i < diagonal.length; i += 1) {
    inverse[i] = Math.abs(diagonal[i]) > 1e-30 ? 1 / diagonal[i] : 1;
  }
  return inverse;
}

export function conjugateGradient(
  matrix: CsrMatrix,
  rhs: Float64Array,
  options: { tolerance?: number; maxIterations?: number; jacobi?: boolean } = {}
): ConjugateGradientResult {
  return solveConjugateGradient(matrix, rhs, {
    tolerance: options.tolerance,
    maxIterations: options.maxIterations,
    preconditioner: options.jacobi === false ? "none" : "jacobi"
  });
}

export function solveConjugateGradient(
  matrix: CsrMatrix,
  rhs: Float64Array,
  options: ConjugateGradientOptions = {}
): ConjugateGradientResult {
  const tolerance = options.tolerance ?? 1e-10;
  const maxIterations = options.maxIterations ?? Math.max(100, matrix.rowCount * 20);
  const x = new Float64Array(rhs.length);
  const r = Float64Array.from(rhs);
  const z = new Float64Array(rhs.length);
  const p = new Float64Array(rhs.length);
  const diagonal = options.preconditioner === "none" ? undefined : csrDiagonal(matrix);
  applyPreconditioner(r, z, diagonal);
  p.set(z);
  let rzOld = dot(r, z);
  const rhsNorm = Math.max(norm(rhs), 1);
  const initialResidualNorm = norm(r);
  if (initialResidualNorm / rhsNorm <= tolerance) {
    return { ok: true, solution: x, iterations: 0, residualNorm: initialResidualNorm, relativeResidual: 0 };
  }

  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    const ap = csrMatVec(matrix, p);
    const denominator = dot(p, ap);
    if (!Number.isFinite(denominator) || Math.abs(denominator) <= 1e-30) {
      return {
        ok: false,
        error: {
          code: "singular-system",
          message: "Sparse CG encountered a singular or indefinite system."
        },
        iterations: iteration,
        residualNorm: norm(r),
        relativeResidual: norm(r) / rhsNorm
      };
    }
    const alpha = rzOld / denominator;
    for (let i = 0; i < x.length; i += 1) {
      x[i] += alpha * p[i];
      r[i] -= alpha * ap[i];
    }
    const relativeResidual = norm(r) / rhsNorm;
    if (relativeResidual <= tolerance) {
      return { ok: true, solution: x, iterations: iteration, residualNorm: norm(r), relativeResidual };
    }
    applyPreconditioner(r, z, diagonal);
    const rzNew = dot(r, z);
    const beta = rzNew / rzOld;
    for (let i = 0; i < p.length; i += 1) {
      p[i] = z[i] + beta * p[i];
    }
    rzOld = rzNew;
  }

  return {
    ok: false,
    error: {
      code: "cg-not-converged",
      message: "Sparse CG did not converge within maxIterations."
    },
    iterations: maxIterations,
    residualNorm: norm(r),
    relativeResidual: norm(r) / rhsNorm
  };
}

export function reduceCsrSystem(
  matrix: CsrMatrix,
  rhs: Float64Array,
  free: Int32Array,
  constraints: Map<number, number>
): { matrix: CsrMatrix; rhs: Float64Array } {
  const freeIndexByDof = new Map<number, number>();
  free.forEach((dof, index) => freeIndexByDof.set(dof, index));
  const builder = createSparseMatrixBuilder(free.length);
  const reducedRhs = new Float64Array(free.length);

  for (let reducedRow = 0; reducedRow < free.length; reducedRow += 1) {
    const fullRow = free[reducedRow];
    reducedRhs[reducedRow] = rhs[fullRow];
    for (let entry = matrix.rowPtr[fullRow]; entry < matrix.rowPtr[fullRow + 1]; entry += 1) {
      const fullCol = matrix.colInd[entry];
      const value = matrix.values[entry];
      const reducedCol = freeIndexByDof.get(fullCol);
      if (reducedCol !== undefined) {
        addSparseEntry(builder, reducedRow, reducedCol, value);
      } else {
        const constrainedValue = constraints.get(fullCol);
        if (constrainedValue !== undefined) {
          reducedRhs[reducedRow] -= value * constrainedValue;
        }
      }
    }
  }

  return {
    matrix: toCsrMatrix(builder),
    rhs: reducedRhs
  };
}

function applyPreconditioner(source: Float64Array, target: Float64Array, diagonal: Float64Array | undefined): void {
  for (let i = 0; i < source.length; i += 1) {
    const d = diagonal?.[i];
    target[i] = d && Math.abs(d) > 1e-30 ? source[i] / d : source[i];
  }
}

export function dot(a: Float64Array, b: Float64Array): number {
  let result = 0;
  for (let i = 0; i < a.length; i += 1) result += a[i] * b[i];
  return result;
}

export function axpy(alpha: number, x: Float64Array, y: Float64Array): void {
  for (let i = 0; i < y.length; i += 1) {
    y[i] += alpha * x[i];
  }
}

export function norm(values: Float64Array): number {
  return Math.sqrt(dot(values, values));
}
