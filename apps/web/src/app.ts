import { validateModelJson, type ValidationReport } from "@opencae/core";
import { singleTetStaticFixture } from "@opencae/examples";
import { solveStaticLinearTet4Cpu, type StaticLinearTet4CpuSolveResult } from "@opencae/solver-cpu";
import { detectWebGPUCapability, type WebGPUCapability } from "@opencae/solver-webgpu";

export async function createApp(root: HTMLElement): Promise<void> {
  root.innerHTML = renderShell();
  renderPhase1Validation(root);
  renderPhase2CpuSummary(root);

  const statusElement = root.querySelector<HTMLElement>("[data-webgpu-status]");
  if (!statusElement) {
    throw new Error("WebGPU status element was not found.");
  }

  try {
    const capability = await detectWebGPUCapability();
    statusElement.innerHTML = renderCapability(capability);
  } catch (error) {
    statusElement.innerHTML = `
      <section class="status status-error">
        <h2>WebGPU status</h2>
        <p class="status-label">Error</p>
        <p>${escapeHtml(error instanceof Error ? error.message : "Unknown error")}</p>
      </section>
    `;
  }
}

function renderShell(): string {
  return `
    <section class="page">
      <header class="intro">
        <p class="repo-name">opencae-core</p>
        <h1>OpenCAE Core</h1>
        <p class="phase">Phase 0 Repository Foundation</p>
      </header>
      <div data-webgpu-status>
        <section class="status">
          <h2>WebGPU status</h2>
          <p>Checking local browser capability...</p>
        </section>
      </div>
      <div data-phase1-validation></div>
      <div data-phase2-cpu-summary></div>
    </section>
  `;
}

function renderPhase1Validation(root: HTMLElement): void {
  const validationElement = root.querySelector<HTMLElement>("[data-phase1-validation]");
  if (!validationElement) {
    throw new Error("Phase 1 validation element was not found.");
  }

  validationElement.innerHTML = renderValidationReport(validateModelJson(singleTetStaticFixture));
}

function renderPhase2CpuSummary(root: HTMLElement): void {
  const summaryElement = root.querySelector<HTMLElement>("[data-phase2-cpu-summary]");
  if (!summaryElement) {
    throw new Error("Phase 2 CPU summary element was not found.");
  }

  summaryElement.innerHTML = renderCpuSolveSummary(solveStaticLinearTet4Cpu(singleTetStaticFixture));
}

function renderCapability(capability: WebGPUCapability): string {
  const modifier = capability.available ? "status-available" : "status-unavailable";

  return `
    <section class="status ${modifier}">
      <h2>WebGPU status</h2>
      <dl class="summary">
        <div>
          <dt>Availability</dt>
          <dd>${capability.available ? "Supported" : "Unavailable"}</dd>
        </div>
        <div>
          <dt>Reason</dt>
          <dd>${escapeHtml(capability.reason)}</dd>
        </div>
        <div>
          <dt>Message</dt>
          <dd>${escapeHtml(capability.message)}</dd>
        </div>
      </dl>
      ${capability.adapter ? renderAdapter(capability.adapter) : ""}
    </section>
  `;
}

export function renderCpuSolveSummary(result: StaticLinearTet4CpuSolveResult): string {
  const modifier = result.ok ? "status-available" : "status-unavailable";
  const diagnostics = result.diagnostics;
  const coreResult = result.ok ? result.result.coreResult : undefined;
  const engineeringStress = coreResult?.summary.maxStress ?? diagnostics?.maxVonMisesStress;
  const engineeringStressUnits = coreResult?.summary.maxStressUnits;
  const plotStressField = coreResult?.fields.find((field) => field.id === "stress-surface");
  const showPlotStress =
    engineeringStress !== undefined &&
    plotStressField !== undefined &&
    Math.abs(engineeringStress - plotStressField.max) > Math.max(Math.abs(engineeringStress), 1) * 1e-9;

  return `
    <section class="status phase2-status ${modifier}">
      <h2>Phase 2 CPU reference solve</h2>
      <dl class="summary">
        <div>
          <dt>Fixture</dt>
          <dd>single-tet-static</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>${result.ok ? "Solved" : "Failed"}</dd>
        </div>
        <div>
          <dt>DOFs</dt>
          <dd>${diagnostics?.dofs ?? "n/a"}</dd>
        </div>
        <div>
          <dt>Free DOFs</dt>
          <dd>${diagnostics?.freeDofs ?? "n/a"}</dd>
        </div>
        <div>
          <dt>Constrained DOFs</dt>
          <dd>${diagnostics?.constrainedDofs ?? "n/a"}</dd>
        </div>
        <div>
          <dt>Relative residual</dt>
          <dd>${formatNumber(diagnostics?.relativeResidual)}</dd>
        </div>
        <div>
          <dt>Max displacement</dt>
          <dd>${formatNumber(diagnostics?.maxDisplacement)}</dd>
        </div>
        <div>
          <dt>Max von Mises stress</dt>
          <dd>${formatStress(engineeringStress, engineeringStressUnits)}</dd>
        </div>
        ${
          showPlotStress
            ? `
              <div>
                <dt>Engineering max</dt>
                <dd>${formatStress(engineeringStress, engineeringStressUnits)}</dd>
              </div>
              <div>
                <dt>Plot max</dt>
                <dd>${formatStress(plotStressField.max, plotStressField.units)}</dd>
              </div>
            `
            : ""
        }
      </dl>
      ${result.ok ? "" : `<p>${escapeHtml(result.error.message)}</p>`}
    </section>
  `;
}

function renderValidationReport(report: ValidationReport): string {
  const modifier = report.ok ? "status-available" : "status-unavailable";
  const issues = [...report.errors, ...report.warnings];

  return `
    <section class="status phase1-status ${modifier}">
      <h2>Phase 1 fixture validation</h2>
      <dl class="summary">
        <div>
          <dt>Fixture</dt>
          <dd>single-tet-static</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>${report.ok ? "Valid" : "Invalid"}</dd>
        </div>
        <div>
          <dt>Issues</dt>
          <dd>${issues.length}</dd>
        </div>
      </dl>
      ${issues.length > 0 ? renderIssues(issues) : ""}
    </section>
  `;
}

function renderIssues(issues: ValidationReport["errors"]): string {
  return `
    <ul>
      ${issues
        .map(
          (issue) => `
            <li>
              <strong>${escapeHtml(issue.code)}</strong>
              <span>${escapeHtml(issue.path)}: ${escapeHtml(issue.message)}</span>
            </li>
          `
        )
        .join("")}
    </ul>
  `;
}

function renderAdapter(adapter: NonNullable<WebGPUCapability["adapter"]>): string {
  const features =
    adapter.features.length > 0
      ? adapter.features.map((feature) => `<li>${escapeHtml(feature)}</li>`).join("")
      : "<li>No adapter features reported.</li>";
  const limitEntries = Object.entries(adapter.limits);
  const limits =
    limitEntries.length > 0
      ? limitEntries
          .map(
            ([key, value]) => `
              <tr>
                <th scope="row">${escapeHtml(key)}</th>
                <td>${value}</td>
              </tr>
            `
          )
          .join("")
      : `
        <tr>
          <th scope="row">limits</th>
          <td>No adapter limits reported.</td>
        </tr>
      `;

  return `
    <div class="adapter">
      <h3>Adapter info</h3>
      ${adapter.name ? `<p><strong>Name:</strong> ${escapeHtml(adapter.name)}</p>` : ""}
      <h4>Features</h4>
      <ul>${features}</ul>
      <h4>Limits</h4>
      <table>
        <tbody>${limits}</tbody>
      </table>
    </div>
  `;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatNumber(value: number | undefined): string {
  if (value === undefined) {
    return "n/a";
  }

  return Number.isFinite(value) ? value.toExponential(4) : "n/a";
}

function formatStress(value: number | undefined, units: string | undefined): string {
  if (value === undefined || !Number.isFinite(value)) {
    return "n/a";
  }
  if (units === "Pa") {
    return `${(value / 1_000_000).toExponential(4)} MPa`;
  }
  if (units && units.length > 0) {
    return `${value.toExponential(4)} ${units}`;
  }
  return value.toExponential(4);
}
