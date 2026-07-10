export function renderDashboardHtml(routePrefix: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Project Supervisor</title>
  <style>
    :root { color-scheme: light dark; font-family: Inter, system-ui, -apple-system, Segoe UI, sans-serif; }
    body { margin: 0; background: #f7f4ed; color: #1f2933; }
    main { max-width: 1080px; margin: 0 auto; padding: 20px; }
    header { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 18px; }
    h1 { font-size: 26px; margin: 0; letter-spacing: 0; }
    button, input, select, textarea { min-height: 38px; border-radius: 6px; border: 1px solid #9aa5b1; background: #ffffff; color: #1f2933; padding: 0 12px; font: inherit; }
    button { cursor: pointer; }
    .toolbar { display: flex; flex-wrap: wrap; gap: 8px; }
    .inline-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
    .grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
    .panel { border: 1px solid #d3cec4; border-radius: 8px; background: #fffdf8; padding: 14px; margin-bottom: 12px; }
    .metric { font-size: 12px; color: #52606d; }
    .value { font-size: 24px; font-weight: 700; margin-top: 4px; }
    .ok { color: #207227; } .watch { color: #9a5b00; } .blocked { color: #b42318; }
    pre { white-space: pre-wrap; word-break: break-word; margin: 0; font-size: 13px; line-height: 1.45; }
    textarea { box-sizing: border-box; min-height: 76px; padding: 10px 12px; resize: vertical; width: 100%; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    td, th { text-align: left; border-bottom: 1px solid #e4ded4; padding: 8px 4px; vertical-align: top; }
    @media (max-width: 760px) { main { padding: 12px; } header { align-items: flex-start; flex-direction: column; } .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>Project Supervisor</h1>
        <div id="sub" class="metric">Loading...</div>
      </div>
      <div class="toolbar">
        <button onclick="refresh(true)">Refresh</button>
        <select id="project"></select>
        <button onclick="activateProject()">Use</button>
        <select id="command"></select>
        <button onclick="runCommand()">Run</button>
      </div>
    </header>
    <section class="grid">
      <div class="panel"><div class="metric">Health</div><div id="health" class="value">-</div></div>
      <div class="panel"><div class="metric">Git Changes</div><div id="changes" class="value">-</div></div>
      <div class="panel"><div class="metric">Recent Files</div><div id="recent" class="value">-</div></div>
      <div class="panel"><div class="metric">Tasks</div><div id="tasks" class="value">-</div></div>
    </section>
    <section class="panel"><h2>Summary</h2><pre id="summary"></pre></section>
    <section class="panel"><h2>Registered Projects</h2><table id="projectSummaries"></table></section>
    <section class="panel"><h2>Change & Failure Review</h2><pre id="reviewSummary"></pre></section>
    <section class="panel"><h2>Risks</h2><pre id="risks"></pre></section>
    <section class="panel"><h2>Signals</h2><pre id="signals"></pre></section>
    <section class="panel">
      <h2>Alerts</h2>
      <table id="notifications"></table>
      <div class="inline-actions"><button onclick="ackAllNotifications()">Acknowledge All</button></div>
    </section>
    <section class="panel">
      <h2>Codex Accounts & Quotas</h2>
      <table id="accounts"></table>
      <table id="quotas"></table>
      <table id="quotaLogSources"></table>
      <div class="inline-actions">
        <input id="accountId" placeholder="account id">
        <input id="accountName" placeholder="display name">
        <button onclick="registerAccount()">Add account</button>
      </div>
      <div class="inline-actions">
        <input id="quotaAccountId" placeholder="account id">
        <input id="quotaId" placeholder="window id">
        <select id="quotaType"><option>rolling</option><option>daily</option><option>weekly</option><option>monthly</option><option>credits</option><option>custom</option></select>
        <select id="quotaStatus"><option>exhausted</option><option>available</option><option>low</option><option>unknown</option></select>
        <input id="quotaResetAt" placeholder="reset time (ISO, optional)">
        <button onclick="setQuota()">Save quota</button>
      </div>
      <div class="inline-actions">
        <input id="observeAccountId" placeholder="account id">
        <textarea id="quotaSignal" placeholder="Paste a Codex usage-limit message"></textarea>
        <button onclick="observeQuota()">Observe signal</button>
      </div>
      <div class="inline-actions">
        <input id="watchAccountId" placeholder="account id">
        <input id="watchSourceId" placeholder="source id">
        <input id="watchFile" placeholder="absolute log file path">
        <button onclick="registerQuotaWatch()">Watch log</button>
        <button onclick="scanQuotaWatches()">Scan logs</button>
      </div>
      <div class="metric">Account records contain metadata only; no passwords or login tokens are stored.</div>
    </section>
    <section class="panel"><h2>Worker AI</h2><pre id="worker"></pre></section>
    <section class="panel"><h2>Next Actions</h2><pre id="nextActions"></pre></section>
    <section class="panel">
      <h2>Instruction</h2>
      <textarea id="instructionInput" placeholder="Instruction"></textarea>
      <div class="inline-actions">
        <button onclick="proposeInstruction()">Propose</button>
        <button onclick="tellInstruction()">Tell</button>
        <button id="pauseButton" onclick="pauseWorker()">Pause</button>
        <button id="resumeButton" onclick="resumeWorker()">Resume</button>
      </div>
    </section>
    <section class="panel"><h2>Pending Instructions</h2><table id="instructions"></table></section>
    <section class="panel"><h2>Recent Instruction Execution</h2><table id="instructionExecution"></table></section>
    <section class="panel"><h2>Recent Files</h2><table id="files"></table></section>
    <section class="panel"><h2>Tasks</h2><table id="taskTable"></table></section>
  </main>
  <script>
    const apiBase = ${JSON.stringify(routePrefix)};
    async function api(path, options = {}) {
      const res = await fetch(apiBase + path, { ...options, credentials: "same-origin", headers: { "content-type": "application/json", ...(options.headers || {}) } });
      if (!res.ok) throw new Error(await res.text());
      return await res.json();
    }
    function esc(value) {
      return String(value ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    }
    function rows(items, cols) {
      return "<tbody>" + items.map(item => "<tr>" + cols.map(col => "<td>" + esc(col(item)) + "</td>").join("") + "</tr>").join("") + "</tbody>";
    }
    function pendingRows(items) {
      if (!items.length) return "<tbody><tr><td colspan='5'>None</td></tr></tbody>";
      return "<tbody>" + items.map(item => "<tr>"
        + "<td>" + esc(item.id) + "</td>"
        + "<td>" + esc(item.targetWorker) + "</td>"
        + "<td>" + esc(item.instruction) + "</td>"
        + "<td>" + esc(item.createdAt) + "</td>"
        + "<td><button onclick=\"approveInstruction('" + esc(item.id) + "')\">Approve</button> <button onclick=\"rejectInstruction('" + esc(item.id) + "')\">Reject</button></td>"
        + "</tr>").join("") + "</tbody>";
    }
    function instructionExecutionRows(items) {
      if (!items.length) return "<tbody><tr><td colspan='8'>None</td></tr></tbody>";
      return "<thead><tr><th>ID</th><th>Worker</th><th>Dispatch</th><th>Execution</th><th>Resolution</th><th>Updated</th><th>Message</th><th>Action</th></tr></thead><tbody>" + items.map(item => "<tr>"
        + "<td>" + esc(item.id) + "</td><td>" + esc(item.targetWorker) + "</td><td>" + esc(item.status) + "</td>"
        + "<td>" + esc(item.workerStatus || "awaiting_ack") + "</td><td>" + esc(item.resolutionStatus || "open") + "</td><td>" + esc(item.resolutionAt || item.workerUpdatedAt || item.dispatchedAt || "-") + "</td>"
        + "<td>" + esc(item.resolutionNote || item.workerMessage || "-") + "</td><td>" + instructionResolutionActions(item) + "</td></tr>").join("") + "</tbody>";
    }
    function instructionResolutionActions(item) {
      if (item.resolutionStatus || (item.workerStatus !== "failed" && item.workerStatus !== "ignored")) return "-";
      return "<button onclick=\"resolveInstruction('" + esc(item.id) + "','resolved')\">Resolve</button> "
        + "<button onclick=\"supersedeInstruction('" + esc(item.id) + "')\">Supersede</button> "
        + "<button onclick=\"resolveInstruction('" + esc(item.id) + "','closed')\">Close</button>";
    }
    function notificationRows(items) {
      if (!items.length) return "<tbody><tr><td colspan='7'>None</td></tr></tbody>";
      return "<thead><tr><th>Project</th><th>Severity</th><th>Delivery</th><th>Title</th><th>Detail</th><th>Updated</th><th>Action</th></tr></thead><tbody>" + items.map(item => "<tr>"
        + "<td>" + esc(item.projectId) + "</td>"
        + "<td>" + esc(item.severity) + "</td>"
        + "<td>" + esc(item.deliveryStatus || "pending") + "</td>"
        + "<td>" + esc(item.title) + "</td>"
        + "<td>" + esc(item.detail) + "</td>"
        + "<td>" + esc(item.updatedAt) + "</td>"
        + "<td><button onclick=\"ackNotification('" + esc(item.id) + "')\">Ack</button></td>"
        + "</tr>").join("") + "</tbody>";
    }
    function projectSummaryRows(items) {
      if (!items.length) return "<tbody><tr><td colspan='6'>No registered projects</td></tr></tbody>";
      return "<thead><tr><th>Project</th><th>Health</th><th>Open</th><th>Critical</th><th>Scanned</th><th>Summary</th></tr></thead><tbody>" + items.map(item => "<tr>"
        + "<td>" + esc(item.projectId) + "</td><td>" + esc(item.health) + "</td><td>" + esc(item.openAlerts) + "</td>"
        + "<td>" + esc(item.criticalAlerts) + "</td><td>" + esc(item.scannedAt) + "</td><td>" + esc(item.scanError || item.summary) + "</td></tr>").join("") + "</tbody>";
    }
    function accountRows(accounts) {
      if (!accounts.length) return "<tbody><tr><td colspan='5'>No Codex accounts</td></tr></tbody>";
      return "<thead><tr><th>Account</th><th>Name</th><th>Type</th><th>Workspace</th><th>Timezone</th></tr></thead><tbody>" + accounts.map(item => "<tr>"
        + "<td>" + esc(item.id) + "</td><td>" + esc(item.displayName) + "</td><td>" + esc(item.accountType) + "</td>"
        + "<td>" + esc(item.workspaceName || "-") + "</td><td>" + esc(item.timezone) + "</td></tr>").join("") + "</tbody>";
    }
    function quotaRows(items) {
      if (!items.length) return "<tbody><tr><td colspan='7'>No quota windows</td></tr></tbody>";
      return "<thead><tr><th>Account</th><th>Window</th><th>Type</th><th>Status</th><th>Reset</th><th>Source</th><th>Confidence</th></tr></thead><tbody>" + items.map(item => "<tr>"
        + "<td>" + esc(item.accountId) + "</td><td>" + esc(item.label) + "</td><td>" + esc(item.quotaType) + "</td>"
        + "<td>" + esc(item.status) + "</td><td>" + esc(item.resetAt || "-") + "</td><td>" + esc(item.source) + "</td><td>" + esc(item.confidence) + "</td></tr>").join("") + "</tbody>";
    }
    function quotaLogSourceRows(items, cursors) {
      if (!items.length) return "<tbody><tr><td colspan='6'>No quota log sources</td></tr></tbody>";
      const cursorMap = new Map((cursors || []).map(cursor => [cursor.sourceId, cursor]));
      return "<thead><tr><th>Source</th><th>Account</th><th>File</th><th>Enabled</th><th>Offset</th><th>Error</th></tr></thead><tbody>" + items.map(item => {
        const cursor = cursorMap.get(item.id);
        return "<tr><td>" + esc(item.id) + "</td><td>" + esc(item.accountId) + "</td><td>" + esc(item.file) + "</td><td>" + esc(item.enabled) + "</td>"
          + "<td>" + esc(cursor ? cursor.offset : 0) + "</td><td>" + esc(cursor && cursor.lastError ? cursor.lastError : "-") + "</td></tr>";
      }).join("") + "</tbody>";
    }
    function updateProjects(registry) {
      const select = document.getElementById("project");
      if (!registry || !Array.isArray(registry.projects)) {
        select.innerHTML = "";
        return;
      }
      const current = select.value || registry.activeProjectId || "";
      select.innerHTML = "";
      for (const project of registry.projects) {
        const opt = document.createElement("option");
        opt.value = project.id;
        opt.textContent = project.id + (project.id === registry.activeProjectId ? " *" : "");
        select.appendChild(opt);
      }
      select.value = registry.projects.some(p => p.id === current) ? current : (registry.activeProjectId || "");
    }
    async function refresh(force) {
      if (force) await api("/api/scan", { method: "POST", body: "{}" });
      const data = await api("/api/overview");
      const s = data.snapshot;
      updateProjects(data.registry || s.projects);
      document.getElementById("sub").textContent = s.projectDir + " | " + s.scannedAt;
      const h = document.getElementById("health");
      h.textContent = s.health.toUpperCase();
      h.className = "value " + s.health;
      document.getElementById("changes").textContent = s.git.available ? s.git.changedFiles : "n/a";
      document.getElementById("recent").textContent = s.fileScan.recent.length;
      document.getElementById("tasks").textContent = s.tasks.length;
      document.getElementById("summary").textContent = s.summary + "\\nGit: " + (s.git.available ? s.git.status || "clean" : s.git.error);
      document.getElementById("projectSummaries").innerHTML = projectSummaryRows(data.projectSummaries || []);
      const review = s.review || { readiness: "review_required", summary: "Review data unavailable in this snapshot.", recommendation: "Refresh the project scan.", failedTasks: [], logFindings: [] };
      document.getElementById("reviewSummary").textContent = [
        "Decision: " + review.readiness,
        review.summary,
        "Recommendation: " + review.recommendation,
        "Diff stat: " + (s.git.diffStat || "(none)"),
        "Failed tasks: " + (review.failedTasks.length ? review.failedTasks.map(x => x.name + ": " + x.excerpt).join("\\n- ") : "none"),
        "Log findings: " + (review.logFindings.length ? review.logFindings.map(x => x.path + ": " + x.excerpt).join("\\n- ") : "none")
      ].join("\\n");
      document.getElementById("risks").textContent = s.risks.length ? s.risks.map(r => "- " + r).join("\\n") : "- none";
      document.getElementById("signals").textContent = (data.signals || []).length ? data.signals.map(x => "- [" + x.severity + "] " + x.title + ": " + x.detail + (x.command ? " (" + x.command + ")" : "")).join("\\n") : "- none";
      document.getElementById("notifications").innerHTML = notificationRows(data.notifications || []);
      document.getElementById("accounts").innerHTML = accountRows(data.accounts || []);
      document.getElementById("quotas").innerHTML = quotaRows(data.quotaWindows || []);
      document.getElementById("quotaLogSources").innerHTML = quotaLogSourceRows(data.quotaLogSources || [], data.quotaLogCursors || []);
      document.getElementById("worker").textContent = [
        "Worker: " + s.worker.workerId,
        "Status: " + s.worker.status,
        "Source: " + s.worker.source,
        "Goal: " + (s.worker.goal || "(not reported)"),
        "Step: " + (s.worker.currentStep || "(not reported)"),
        "Needs approval: " + (s.worker.needsUserApproval ? "yes" : "no"),
        "Blocker: " + (s.worker.blocker || "(none)"),
        "Control: " + (data.control ? data.control.mode : "active"),
        "Runtime enabled: " + (data.workerRuntime && data.workerRuntime.enabled ? "yes" : "no"),
        "Runtime running: " + (data.workerRuntime && data.workerRuntime.running ? "yes" : "no"),
        "Runtime last poll: " + (data.workerRuntime && data.workerRuntime.lastPollAt || "(not started)"),
        "Runtime last error: " + (data.workerRuntime && data.workerRuntime.lastError || "(none)")
      ].join("\\n");
      const controlMode = data.control ? data.control.mode : "active";
      document.getElementById("pauseButton").disabled = controlMode !== "active";
      document.getElementById("resumeButton").disabled = controlMode !== "paused";
      document.getElementById("nextActions").textContent = data.nextActions.length ? data.nextActions.map(a => "- [" + a.priority + "] " + a.title + ": " + a.detail + (a.command ? " (" + a.command + ")" : "")).join("\\n") : "- none";
      document.getElementById("instructions").innerHTML = pendingRows((data.pendingInstructions || []).slice(-12).reverse());
      document.getElementById("instructionExecution").innerHTML = instructionExecutionRows((data.recentInstructions || []).filter(x => x.status === "dispatched").slice(0, 12));
      document.getElementById("files").innerHTML = rows(s.fileScan.recent, [x => x.path, x => x.modifiedAt, x => x.size + " B"]);
      document.getElementById("taskTable").innerHTML = rows(s.tasks.slice(-12).reverse(), [x => x.name, x => x.status, x => x.startedAt, x => (x.log || "").slice(-240)]);
      const select = document.getElementById("command");
      if (data.commands) {
        const current = select.value;
        select.innerHTML = "";
        for (const command of data.commands) {
          const opt = document.createElement("option");
          opt.value = command; opt.textContent = command; select.appendChild(opt);
        }
        if (data.commands.includes(current)) select.value = current;
      }
    }
    async function runCommand() {
      const command = document.getElementById("command").value;
      await api("/api/run", { method: "POST", body: JSON.stringify({ command }) });
      await refresh(false);
    }
    async function activateProject() {
      const id = document.getElementById("project").value;
      if (!id) return;
      await api("/api/activate-project", { method: "POST", body: JSON.stringify({ id }) });
      await refresh(true);
    }
    async function approveInstruction(id) {
      await api("/api/approve", { method: "POST", body: JSON.stringify({ id }) });
      await refresh(true);
    }
    async function rejectInstruction(id) {
      const reason = prompt("Reason") || "";
      await api("/api/reject", { method: "POST", body: JSON.stringify({ id, reason }) });
      await refresh(true);
    }
    async function resolveInstruction(id, status) {
      const note = prompt("Resolution note") || "";
      await api("/api/resolve-instruction", { method: "POST", body: JSON.stringify({ id, status, note, resolvedBy: "dashboard" }) });
      await refresh(true);
    }
    async function supersedeInstruction(id) {
      const replacementId = prompt("Completed replacement instruction id") || "";
      if (!replacementId) return;
      const note = prompt("Resolution note") || "";
      await api("/api/resolve-instruction", { method: "POST", body: JSON.stringify({ id, status: "superseded", supersededByInstructionId: replacementId, note, resolvedBy: "dashboard" }) });
      await refresh(true);
    }
    async function ackNotification(id) {
      await api("/api/ack-notification", { method: "POST", body: JSON.stringify({ id, acknowledgedBy: "dashboard" }) });
      await refresh(true);
    }
    async function ackAllNotifications() {
      await api("/api/ack-notifications", { method: "POST", body: JSON.stringify({ acknowledgedBy: "dashboard" }) });
      await refresh(true);
    }
    async function proposeInstruction() {
      const input = document.getElementById("instructionInput");
      const instruction = input.value.trim();
      if (!instruction) return;
      await api("/api/propose", { method: "POST", body: JSON.stringify({ instruction }) });
      input.value = "";
      await refresh(true);
    }
    async function tellInstruction() {
      const input = document.getElementById("instructionInput");
      const instruction = input.value.trim();
      if (!instruction) return;
      await api("/api/tell", { method: "POST", body: JSON.stringify({ instruction }) });
      input.value = "";
      await refresh(true);
    }
    async function pauseWorker() {
      await api("/api/pause", { method: "POST", body: "{}" });
      await refresh(true);
    }
    async function resumeWorker() {
      await api("/api/resume", { method: "POST", body: "{}" });
      await refresh(true);
    }
    async function registerAccount() {
      const id = document.getElementById("accountId").value.trim();
      const displayName = document.getElementById("accountName").value.trim();
      if (!id) return;
      await api("/api/accounts/register", { method: "POST", body: JSON.stringify({ id, displayName: displayName || id }) });
      document.getElementById("accountId").value = "";
      document.getElementById("accountName").value = "";
      await refresh(false);
    }
    async function setQuota() {
      const accountId = document.getElementById("quotaAccountId").value.trim();
      const id = document.getElementById("quotaId").value.trim();
      const quotaType = document.getElementById("quotaType").value;
      const status = document.getElementById("quotaStatus").value;
      const resetAt = document.getElementById("quotaResetAt").value.trim();
      if (!accountId || !id) return;
      await api("/api/quotas/set", { method: "POST", body: JSON.stringify({ accountId, id, quotaType, status, resetAt: resetAt || null, source: "manual", confidence: "observed" }) });
      await refresh(false);
    }
    async function observeQuota() {
      const accountId = document.getElementById("observeAccountId").value.trim();
      const text = document.getElementById("quotaSignal").value.trim();
      if (!accountId || !text) return;
      const result = await api("/api/quotas/observe", { method: "POST", body: JSON.stringify({ accountId, text }) });
      document.getElementById("quotaSignal").value = result.observation.matched ? "" : text;
      await refresh(false);
    }
    async function registerQuotaWatch() {
      const accountId = document.getElementById("watchAccountId").value.trim();
      const id = document.getElementById("watchSourceId").value.trim();
      const file = document.getElementById("watchFile").value.trim();
      if (!accountId || !id || !file) return;
      await api("/api/quota-log-sources/register", { method: "POST", body: JSON.stringify({ accountId, id, file }) });
      await refresh(false);
    }
    async function scanQuotaWatches() {
      await api("/api/quota-log-sources/scan", { method: "POST", body: "{}" });
      await refresh(false);
    }
    refresh(false).catch(err => document.getElementById("summary").textContent = err.message);
    setInterval(() => refresh(false).catch(() => {}), 5000);
  </script>
</body>
</html>`;
}
