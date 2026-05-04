import { detectWebGPUCapability, type WebGPUCapability } from "@opencae/solver-webgpu";

export async function createApp(root: HTMLElement): Promise<void> {
  root.innerHTML = renderShell();

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
    </section>
  `;
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
