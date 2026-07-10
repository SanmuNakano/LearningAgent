import { CodexWorkerAdapter, type CodexWorkerAdapterOptions, type CodexWorkerSource } from "./codex-worker-adapter.js";
import type { WorkerRuntimeConfig, WorkerRuntimeStatus } from "./supervisor-types.js";
import { normalizeWorkerRuntimeConfig } from "./supervisor-config.js";

type WorkerAdapter = Pick<CodexWorkerAdapter, "start" | "stop">;
type WorkerAdapterFactory = (source: CodexWorkerSource, options: CodexWorkerAdapterOptions) => WorkerAdapter;

function providerOverrides(provider: NonNullable<WorkerRuntimeConfig["provider"]>): string[] {
  const prefix = `model_providers.${provider.id}`;
  return [
    `model_provider="${provider.id}"`,
    `${prefix}.name="${provider.id}"`,
    `${prefix}.base_url="${provider.baseUrl}"`,
    `${prefix}.env_key="${provider.envKey}"`,
    `${prefix}.wire_api="${provider.wireApi ?? "responses"}"`
  ];
}

export class ManagedCodexWorkerRuntime {
  private adapter: WorkerAdapter | null = null;
  private readonly config: ReturnType<typeof normalizeWorkerRuntimeConfig>;
  private status: WorkerRuntimeStatus;

  constructor(
    private readonly source: CodexWorkerSource,
    config: WorkerRuntimeConfig | undefined,
    private readonly projectDir: string,
    private readonly onError: (message: string) => void = () => undefined,
    private readonly adapterFactory: WorkerAdapterFactory = (source, options) => new CodexWorkerAdapter(source, options)
  ) {
    this.config = normalizeWorkerRuntimeConfig(config);
    this.status = {
      enabled: this.config.enabled,
      running: false,
      workerId: this.config.workerId,
      model: this.config.model,
      profile: this.config.profile,
      providerId: this.config.provider?.id,
      sandbox: this.config.sandbox
    };
  }

  start(): void {
    if (!this.config.enabled || this.adapter) return;
    this.adapter = this.adapterFactory(this.source, {
      projectDir: this.projectDir,
      workerId: this.config.workerId,
      model: this.config.model,
      profile: this.config.profile,
      sandbox: this.config.sandbox,
      pollIntervalMs: this.config.pollIntervalMs,
      timeoutMs: this.config.timeoutMs,
      configOverrides: this.config.provider ? providerOverrides(this.config.provider) : undefined,
      onPoll: (at) => { this.status = { ...this.status, lastPollAt: at }; },
      onError: (error) => {
        const message = `Codex worker poll failed (${error instanceof Error ? error.name : "unknown error"}).`;
        this.status = { ...this.status, lastError: message };
        this.onError(message);
      }
    });
    this.status = { ...this.status, running: true, startedAt: new Date().toISOString(), stoppedAt: undefined, lastError: undefined };
    this.adapter.start();
  }

  stop(): void {
    if (!this.adapter) return;
    this.adapter.stop();
    this.adapter = null;
    this.status = { ...this.status, running: false, stoppedAt: new Date().toISOString() };
  }

  getStatus(): WorkerRuntimeStatus {
    return { ...this.status };
  }
}
