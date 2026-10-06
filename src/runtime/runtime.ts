/**
 * The NEXUS runtime.
 *
 * Startup is staged and non-blocking. `start()` brings up the critical core —
 * instance lock, session record, audit log, crash recovery — and then returns,
 * leaving the slow work (hardware discovery, capability probing, baseline
 * capture) to finish in the background. Until it does, NEXUS reports
 * `initializing` and says which stages are outstanding. It never claims to be
 * ready because the process is alive.
 *
 * The runtime is also the `VesperHost`: the small, explicit surface Vesper can
 * reach. Everything Vesper asks for goes through the same safety kernel, the
 * same capability checks and the same fidelity labelling as a request made at
 * the keyboard.
 */

import type { Clock } from '../core/clock.js';
import type { CommandRunner } from '../core/exec.js';
import { NodeCommandRunner } from '../core/exec.js';
import type { NexusError } from '../core/errors.js';
import { nexusError, toNexusError } from '../core/errors.js';
import { combineFidelity, type Fidelity } from '../core/fidelity.js';
import type { IdSource } from '../core/ids.js';
import { systemIds } from '../core/ids.js';
import type { Logger } from '../core/logger.js';
import type { NexusPaths } from '../core/paths.js';
import { allDirectories } from '../core/paths.js';
import { ensureDir } from '../core/fsx.js';
import type { Result } from '../core/result.js';
import { err, ok } from '../core/result.js';
import { NEXUS_VERSION } from '../version.js';

import type { CapabilityRecord } from '../domain/capability.js';
import type { ControlId, ControlValue } from '../domain/control.js';
import type { HealthReport, RunState, ShutdownKind } from '../domain/health.js';
import type { OptimizationOutcome, OptimizationProposal } from '../domain/optimization.js';
import type { ProfileDocument } from '../domain/profile.js';
import { OBSERVATION_PROFILE_ID } from '../domain/profile.js';
import type { HardwareInventory } from '../domain/hardware.js';
import type { TelemetrySnapshot, TelemetrySummary } from '../domain/telemetry.js';
import type { ContextHint, ProcessObservation, WorkloadClassification } from '../domain/workload.js';
import { hintIsFresh } from '../domain/workload.js';

import { EventLog } from '../audit/eventlog.js';
import { BaselineStore } from '../baseline/capture.js';
import type { Baseline } from '../baseline/capture.js';
import { CapabilityRegistry, summarize as summarizeCapabilities } from '../capabilities/registry.js';
import { buildCapabilityProbes } from '../capabilities/probes.js';
import { CheckpointStore } from '../checkpoint/store.js';
import type { RestoreResult } from '../checkpoint/store.js';
import type { NexusConfig } from '../config/config.js';
import { HardwareDiscovery } from '../hardware/discovery.js';
import { automaticProfileGuard, specializeTarget } from '../hardware/specialization.js';
import { selectPrimaryGpuFromInventory } from '../hardware/primary-gpu.js';
import { LinuxHardwareProvider } from '../hardware/providers/linux.js';
import { MockHardwareProvider } from '../hardware/providers/mock.js';
import { WindowsHardwareProvider } from '../hardware/providers/windows.js';
import type { ActuatorContext } from '../optimizer/actuator.js';
import { ActuatorRegistry, MockControlAdapter } from '../optimizer/actuator.js';
import { windowsPowerAdapters } from '../optimizer/actuators/windows-power.js';
import { WindowsPowerPlanSandbox, type PowerPlanWorkspace } from '../optimizer/power-plan-sandbox.js';
import { OptimizationEngine } from '../optimizer/engine.js';
import type { ExecutionEnvironment } from '../optimizer/engine.js';
import { OperationJournal } from '../optimizer/journal.js';
import { ProfileStore, applicability } from '../profiles/store.js';
import { SafetyKernel } from '../safety/kernel.js';
import { BASE_POLICY, narrowPolicy, TRANSACTIONAL_EXPERIMENT_CONTROLS } from '../safety/policy.js';
import { writableControls } from '../safety/controls.js';
import { TelemetryPipeline } from '../telemetry/pipeline.js';
import { LinuxTelemetrySource } from '../telemetry/sources/linux.js';
import { MockTelemetrySource, SIMULATED_IDLE } from '../telemetry/sources/mock.js';
import { OsMemorySource } from '../telemetry/sources/os-memory.js';
import { SelfTelemetrySource } from '../telemetry/sources/self.js';
import { SensorBridgeSource } from '../telemetry/sources/sensor-bridge.js';
import { LibreHardwareMonitorSource } from '../telemetry/sources/libre-hardware-monitor.js';
import { probeCoreinfoTopology } from '../hardware/coreinfo-topology.js';
import { PresentMonCollector } from '../performance/presentmon.js';
import type { FramePerformanceSummary } from '../performance/stats.js';

import { captureWindowsStability, diffWindowsStability } from '../stability/windows-event-oracle.js';
import { WindowsTelemetrySource } from '../telemetry/sources/windows.js';
import { mergeSummaries, summarize, summarizePresentMon } from '../telemetry/summary.js';
import { createProcessEnumerator } from '../process/enumerate.js';
import { getForegroundProcess } from '../process/windows-native.js';
import type { ProcessEnumerator } from '../process/enumerate.js';
import { WorkloadClassifier, signalsFromSnapshot } from '../workload/classifier.js';
import { decideExperiment, defaultPrivateX3dDimensions, fingerprintExperiment, makeCandidateGrid, frameScorePercent, type ExperimentCandidate, type ExperimentRunResult, type ExperimentTrialSummary } from '../optimizer/experiment-plan.js';
import { ExperimentStore, type ExperimentRecord } from '../optimizer/experiment-store.js';
import { ensureToken } from '../vesper/auth.js';
import type { ProfileView, RecommendationView, VesperHost } from '../vesper/handlers.js';
import { VesperServer } from '../vesper/server.js';

import { InstanceLock } from './instance-lock.js';
import { recoverInterruptedOperations } from './recovery.js';
import type { RecoveryOutcome } from './recovery.js';
import { SessionStore } from './session-state.js';
import type { SessionRecord } from './session-state.js';
import { StageTracker } from './stages.js';

/**
 * Window over which applications are counted for cooldowns and the hourly
 * rate limit. Matches the kernel's own window.
 */
const RATE_LIMIT_WINDOW_MS = 3_600_000;

export interface RuntimeOptions {
  readonly paths: NexusPaths;
  readonly config: NexusConfig;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly ids?: IdSource;
  readonly runner?: CommandRunner;
  readonly platform?: NodeJS.Platform;
  /** Skip the instance lock. Only for one-shot CLI commands that do not write. */
  readonly skipInstanceLock?: boolean;
  /** Injected in tests so the measurement window costs no real time. */
  readonly wait?: (ms: number) => Promise<void>;
}

export class NexusRuntime implements VesperHost {
  readonly sessionId: string;
  readonly requesterId = 'vesper';

  private readonly options: RuntimeOptions;
  private readonly logger: Logger;
  private readonly clock: Clock;
  private readonly ids: IdSource;
  private readonly runner: CommandRunner;
  private readonly platform: NodeJS.Platform;

  private readonly stages: StageTracker;
  private readonly kernel: SafetyKernel;
  private readonly registry = new ActuatorRegistry();
  private readonly capabilities: CapabilityRegistry;
  private readonly telemetry: TelemetryPipeline;
  private readonly classifier = new WorkloadClassifier();
  private readonly processEnumerator: ProcessEnumerator;
  private readonly discovery = new HardwareDiscovery();
  private readonly eventLog: EventLog;
  private readonly sessions: SessionStore;
  private readonly lock: InstanceLock;
  private readonly checkpoints: CheckpointStore;
  private readonly journal: OperationJournal;
  private readonly baselines: BaselineStore;
  private readonly profiles: ProfileStore;
  private readonly engine: OptimizationEngine;
  /** Mature frame collector; PresentMon owns ETW, NEXUS owns interpretation. */
  private readonly presentMon: PresentMonCollector;
  private readonly powerSandbox: WindowsPowerPlanSandbox;
  private readonly experimentStore: ExperimentStore;
  private vesper: VesperServer | null = null;

  private startedAtMs = 0;
  private runState: RunState = 'initializing';
  private degradedReasons: string[] = [];
  private inventory: HardwareInventory | null = null;
  private baseline: Baseline | null = null;
  private activeProfileId: string = OBSERVATION_PROFILE_ID;
  private activeProfileAppliedAtMs: number | null = null;
  private previousShutdown: ShutdownKind = 'never_started';
  private recovery: RecoveryOutcome | null = null;
  private contextHint: ContextHint | null = null;
  private readonly outcomes = new Map<string, OptimizationOutcome>();
  private readonly appliedHistory: { control: ControlId; appliedAtMs: number }[] = [];
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private optimizationInFlight = false;
  private shuttingDown = false;
  private backgroundInit: Promise<void> | null = null;

  constructor(options: RuntimeOptions) {
    this.options = options;
    this.clock = options.clock;
    this.logger = options.logger.child('runtime');
    this.ids = options.ids ?? systemIds;
    this.runner = options.runner ?? new NodeCommandRunner();
    this.platform = options.platform ?? process.platform;
    this.presentMon = new PresentMonCollector({
      runner: this.runner,
      paths: options.paths,
      executablePath: options.config.tools.presentMonPath,
      executableSha256: options.config.tools.presentMonSha256,
    });
    this.powerSandbox = new WindowsPowerPlanSandbox(this.runner, 15_000, options.paths);
    this.experimentStore = new ExperimentStore(options.paths, this.clock, this.logger);
    this.processEnumerator = createProcessEnumerator({
      platform: this.platform,
      runner: this.runner,
      clock: this.clock,
    });
    this.sessionId = this.ids.next('sess');

    const narrowed = narrowPolicy(BASE_POLICY, options.config.policy);
    this.narrowingApplied = narrowed.applied.length;
    this.narrowingRejected = narrowed.rejected;
    this.kernel = new SafetyKernel(narrowed.policy);

    this.stages = new StageTracker(this.clock);
    this.capabilities = new CapabilityRegistry(this.clock, this.logger);
    this.eventLog = new EventLog({
      paths: options.paths,
      clock: this.clock,
      logger: this.logger,
      sessionId: this.sessionId,
    });
    this.sessions = new SessionStore({
      paths: options.paths,
      clock: this.clock,
      sessionId: this.sessionId,
      nexusVersion: NEXUS_VERSION,
    });
    this.lock = new InstanceLock({
      paths: options.paths,
      clock: this.clock,
      logger: this.logger,
      sessionId: this.sessionId,
      nexusVersion: NEXUS_VERSION,
      platform: this.platform,
    });
    this.checkpoints = new CheckpointStore({
      paths: options.paths,
      clock: this.clock,
      logger: this.logger,
      ids: this.ids,
      sessionId: this.sessionId,
      registry: this.registry,
    });
    this.journal = new OperationJournal(options.paths, this.clock, this.sessionId);
    this.baselines = new BaselineStore({
      paths: options.paths,
      clock: this.clock,
      logger: this.logger,
      ids: this.ids,
      sessionId: this.sessionId,
      nexusVersion: NEXUS_VERSION,
      registry: this.registry,
    });
    this.profiles = new ProfileStore(options.paths, this.logger, narrowed.policy);
    this.telemetry = new TelemetryPipeline({
      clock: this.clock,
      logger: this.logger,
      intervals: {
        low_activity: options.config.telemetry.lowActivityIntervalMs,
        active_workload: options.config.telemetry.activeIntervalMs,
        optimization: options.config.telemetry.optimizationIntervalMs,
      },
      historyLimit: options.config.telemetry.historyLimit,
      selfCpuBudgetPercent: narrowed.policy.global.selfCpuBudgetPercent,
    });
    this.engine = new OptimizationEngine({
      clock: this.clock,
      logger: this.logger,
      ids: this.ids,
      kernel: this.kernel,
      registry: this.registry,
      checkpoints: this.checkpoints,
      journal: this.journal,
      eventLog: this.eventLog,
      ...(options.wait ? { wait: options.wait } : {}),
    });
  }

  private readonly narrowingApplied: number;
  private readonly narrowingRejected: readonly { path: string; from: string; to: string }[];

  now(): number {
    return this.clock.now();
  }

  get actuatorContext(): ActuatorContext {
    return { clock: this.clock, logger: this.logger, runner: this.runner, timeoutMs: 15_000 };
  }

  /* ------------------------------------------------------------- startup */

  /**
   * Bring up the critical core, then continue initialization in the
   * background. Returns as soon as NEXUS can answer for itself.
   */
  async start(): Promise<Result<HealthReport, NexusError>> {
    this.startedAtMs = this.clock.now();

    for (const dir of allDirectories(this.options.paths)) {
      const made = await ensureDir(dir);
      if (!made.ok) return err(made.error);
    }

    /* ------------------------------------------------------------- core */
    const coreOk = await this.stages.run('core', async () => {
      if (!this.options.skipInstanceLock) {
        const acquired = await this.lock.acquire();
        if (!acquired.ok) throw acquired.error;
      }
      const previous = await this.sessions.previous();
      this.previousShutdown = SessionStore.classifyShutdown(previous);
      const begun = await this.sessions.begin();
      if (!begun.ok) throw begun.error;
      if (begun.value.restart.looping) {
        this.degrade(begun.value.restart.reason ?? 'restart loop detected');
      }
      await this.registerComponents();
      return `session ${this.sessionId}`;
    });

    if (!coreOk) {
      this.runState = 'failed';
      const detail = this.stages.all().find((s) => s.stage === 'core')?.detail ?? 'core stage failed';
      return err(nexusError('E_CONFLICT', detail));
    }

    /* ----------------------------------------------------------- health */
    this.stages.finish('health', 'complete', 'health reporting is available');

    /* ------------------------------------------------------------ audit */
    await this.stages.run('audit', async () => {
      const opened = await this.eventLog.open();
      if (!opened.ok) throw opened.error;
      const verified = await this.eventLog.verify();
      if (verified.ok && !verified.value.valid) {
        this.degrade(
          `The audit log's hash chain is broken at record ${verified.value.firstBrokenSeq ?? '?'} (${verified.value.reason ?? 'unknown'}). History before that point cannot be trusted.`,
        );
      }
      await this.eventLog.append({
        kind: 'session.start',
        severity: 'info',
        message: `NEXUS ${NEXUS_VERSION} starting in ${this.options.config.mode} mode`,
        data: { sessionId: this.sessionId, platform: this.platform, previousShutdown: this.previousShutdown },
      });
      if (this.previousShutdown === 'crash') {
        await this.eventLog.append({
          kind: 'session.crash_detected',
          severity: 'warning',
          message: 'the previous session did not shut down cleanly',
        });
      }
      if (this.narrowingRejected.length > 0) {
        await this.eventLog.append({
          kind: 'safety.policy_narrowed',
          severity: 'warning',
          message: `configuration attempted to widen the safety policy in ${this.narrowingRejected.length} place(s); those requests were ignored`,
          data: { rejected: this.narrowingRejected.map((r) => r.path) },
        });
      } else if (this.narrowingApplied > 0) {
        await this.eventLog.append({
          kind: 'safety.policy_narrowed',
          severity: 'info',
          message: `configuration narrowed the safety policy in ${this.narrowingApplied} place(s)`,
        });
      }
      return `chain head ${this.eventLog.headHash.slice(0, 12)}`;
    });

    /* --------------------------------------------------------- recovery */
    await this.stages.run('recovery', async () => {
      const outcome = await recoverInterruptedOperations({
        journal: this.journal,
        checkpoints: this.checkpoints,
        eventLog: this.eventLog,
        logger: this.logger,
        context: this.actuatorContext,
      });
      this.recovery = outcome;
      if (outcome.unresolved) {
        this.degrade(outcome.summary);
        this.runState = 'observation_only';
      }
      if (this.platform === 'win32') {
        const sandbox = await this.powerSandbox.recoverOrphaned();
        if (!sandbox.ok) {
          this.degrade(`An orphaned power-plan experiment could not be safely recovered: ${sandbox.error.message}`);
          this.runState = 'observation_only';
        } else if (sandbox.value === 'restored') {
          await this.eventLog.append({
            kind: 'power.sandbox.restored',
            severity: 'critical',
            message: 'recovered an orphaned power-plan experiment after an unexpected shutdown',
            data: { recovery: true },
          });
        }
      }

      const restored = await this.restoreAppliedHistory();
      return restored > 0 ? `${outcome.summary} Carried ${restored} recent change(s) forward.` : outcome.summary;
    });

    this.startHeartbeat();
    this.backgroundInit = this.continueInitialization();
    return ok(this.health());
  }

  /** The slow stages. Failures here degrade NEXUS; they do not stop it. */
  private async continueInitialization(): Promise<void> {
    await this.stages.run('telemetry', async () => {
      await this.telemetry.startSources();
      await this.telemetry.sampleOnce();
      if (!this.telemetry.working) {
        this.degrade('No telemetry source produced a usable reading.');
      }
      return `${this.telemetry.registeredSources.length} source(s)`;
    });

    await this.stages.run('hardware', async () => {
      const discovered = await this.discovery.discover({
        clock: this.clock,
        logger: this.logger,
        runner: this.runner,
        platform: this.platform,
        paths: this.options.paths,
      });
      if (!discovered.ok) {
        await this.eventLog.append({
          kind: 'hardware.discovery_failed',
          severity: 'warning',
          message: discovered.error.message,
        });
        this.degrade(`Hardware discovery failed: ${discovered.error.message}`);
        throw discovered.error;
      }
      this.inventory = discovered.value;
      await this.eventLog.append({
        kind: 'hardware.discovered',
        severity: 'info',
        message: `discovered by ${discovered.value.provider}`,
        data: {
          fidelity: discovered.value.fidelity,
          cpu: discovered.value.cpu.model,
          gpu: discovered.value.gpus[0]?.model ?? null,
          warnings: discovered.value.warnings.length,
        },
      });
      return discovered.value.cpu.model ?? discovered.value.provider;
    });

    await this.stages.run('capabilities', async () => {
      const records = await this.capabilities.probeAll();
      const summary = summarizeCapabilities(records);
      for (const record of records) {
        if (record.state === 'unavailable' || record.state === 'unsupported') {
          await this.eventLog.append({
            kind: 'capability.failed',
            severity: 'info',
            message: `${record.id} is ${record.state}: ${record.detail}`,
          });
        }
      }
      await this.eventLog.append({
        kind: 'capability.probed',
        severity: 'info',
        message: `${summary.byState.available} of ${summary.total} capabilities are available`,
        data: { available: summary.available },
      });
      return `${summary.byState.available}/${summary.total} available`;
    });

    await this.stages.run('profiles', async () => {
      const { loaded, rejected } = await this.profiles.load();
      for (const bad of rejected) {
        await this.eventLog.append({
          kind: 'profile.rejected',
          severity: 'warning',
          message: `profile "${bad.id}" was rejected`,
          data: { errors: bad.errors },
        });
      }
      await this.eventLog.append({
        kind: 'profile.loaded',
        severity: 'info',
        message: `${loaded.length} profile(s) loaded`,
      });
      return `${loaded.length} loaded, ${rejected.length} rejected`;
    });

    await this.stages.run('baseline', async () => {
      const existing = await this.baselines.latest();
      if (existing.ok) {
        this.baseline = existing.value;
        return `loaded ${existing.value.id}`;
      }
      const captured = await this.captureBaseline();
      if (!captured.ok) {
        await this.eventLog.append({
          kind: 'baseline.failed',
          severity: 'warning',
          message: captured.error.message,
        });
        throw captured.error;
      }
      return `captured ${captured.value.id}`;
    });

    this.stages.finish('optimizer', 'complete', `mode ${this.options.config.mode}`);

    if (!this.options.config.vesper.enabled) {
      this.stages.finish('vesper', 'skipped', 'the Vesper interface is disabled in configuration');
    } else {
      await this.stages.run('vesper', async () => {
      const token = await ensureToken(this.options.paths, this.ids);
      if (!token.ok) throw token.error;
      const explicitPipe = this.platform === 'win32' ? this.options.config.vesper.pipeName : null;
      const endpoint = explicitPipe ?? ipcEndpointForToken(this.options.paths, token.value, this.platform);
      const server = new VesperServer({
        paths: this.options.paths,
        clock: this.clock,
        logger: this.logger,
        eventLog: this.eventLog,
        token: token.value,
        scopes: this.options.config.vesper.scopes,
        host: this,
        platform: this.platform,
        endpoint,
      });
      const started = await server.start();
      if (!started.ok) throw started.error;
      this.vesper = server;
      return started.value;
      });
    }

    this.settleRunState();
    this.telemetry.start();
    await this.sessions.markStable();
    this.logger.info('initialization complete', { runState: this.runState });
  }

  /** Wait for background initialization. Used by one-shot CLI commands. */
  async waitUntilInitialized(): Promise<RunState> {
    if (this.backgroundInit) await this.backgroundInit;
    return this.runState;
  }

  private async registerComponents(): Promise<void> {
    const simulateHardware = this.options.config.simulate.hardwareFixture;

    // Telemetry sources.
    this.telemetry.register(new SelfTelemetrySource());
    this.telemetry.register(new OsMemorySource());
    if (this.options.config.simulate.telemetry) {
      this.telemetry.register(new MockTelemetrySource(SIMULATED_IDLE));
    } else if (this.platform === 'win32') {
      this.telemetry.register(new WindowsTelemetrySource({ clock: this.clock, logger: this.logger }));
      // Prefer a mature hardware monitor when it is running; the existing file bridge
      // remains available for installations that use a custom native helper instead.
      this.telemetry.register(new LibreHardwareMonitorSource({ clock: this.clock, logger: this.logger }));
    } else if (this.platform === 'linux') {
      this.telemetry.register(new LinuxTelemetrySource());
    }
    this.telemetry.register(new SensorBridgeSource({ paths: this.options.paths }));

    // Hardware providers. A configured fixture takes precedence, so a
    // developer machine can model the target hardware deliberately.
    if (simulateHardware) {
      // Awaited, not fired off: registering after discovery has already run
      // would silently fall through to the real provider.
      const provider = await MockHardwareProvider.fromName(simulateHardware);
      if (provider.ok) this.discovery.register(provider.value);
      else this.logger.warn('hardware fixture could not be loaded', { error: provider.error.message });
    }
    this.discovery.register(new WindowsHardwareProvider());
    this.discovery.register(new LinuxHardwareProvider());

    // Control adapters.
    if (this.platform === 'win32' && !simulateHardware) {
      for (const adapter of windowsPowerAdapters()) this.registry.register(adapter);
    } else if (simulateHardware) {
      // Simulation registers mock adapters so the whole pipeline is
      // exercisable. Everything they produce is labelled `mocked`.
      for (const descriptor of writableControls()) {
        const initial: ControlValue =
          descriptor.valueSpec.kind === 'integer'
            ? descriptor.valueSpec.min
            : descriptor.valueSpec.kind === 'boolean'
              ? false
              : descriptor.valueSpec.kind === 'enum'
                ? (descriptor.valueSpec.values[0]?.value ?? 'normal')
                : 'simulated-value';
        this.registry.register(new MockControlAdapter(descriptor.id, { initial }));
      }
    }

    // Capability probes read whatever state exists when they run.
    this.capabilities.registerAll(
      buildCapabilityProbes(() => ({
        inventory: this.inventory,
        snapshot: this.telemetry.latest(),
        registry: this.registry,
        actuatorContext: this.actuatorContext,
        platform: this.platform,
        vesperListening: this.vesper?.listening ?? false,
        processEnumerator: this.processEnumerator,
      })),
    );
  }

  /**
   * Rebuild the recent-application history from the journal.
   *
   * Cooldowns and the hourly rate limit are only meaningful if they survive a
   * restart. Keeping them in memory alone would mean restarting NEXUS — which
   * a crash loop does automatically — silently cleared every limit that exists
   * to stop a control being hammered.
   */
  private async restoreAppliedHistory(): Promise<number> {
    const cutoff = this.clock.now() - RATE_LIMIT_WINDOW_MS;
    let restored = 0;
    for (const record of await this.journal.list()) {
      if (record.updatedAtMs < cutoff) continue;
      for (const control of record.appliedControls) {
        this.appliedHistory.push({ control, appliedAtMs: record.updatedAtMs });
        restored += 1;
      }
    }
    return restored;
  }

  /** Drop applications that have aged out of the rate-limit window. */
  private pruneAppliedHistory(): void {
    const cutoff = this.clock.now() - RATE_LIMIT_WINDOW_MS;
    for (let i = this.appliedHistory.length - 1; i >= 0; i -= 1) {
      const entry = this.appliedHistory[i];
      if (entry && entry.appliedAtMs < cutoff) this.appliedHistory.splice(i, 1);
    }
  }

  private degrade(reason: string): void {
    if (!this.degradedReasons.includes(reason)) this.degradedReasons.push(reason);
    this.logger.warn('degraded', { reason });
  }

  private settleRunState(): void {
    if (this.runState === 'observation_only' || this.runState === 'stopping' || this.runState === 'stopped') return;
    if (this.options.config.mode === 'observation') {
      this.runState = 'observation_only';
      return;
    }
    if (this.stages.requiredComplete() && this.degradedReasons.length === 0) {
      this.runState = 'ready';
      return;
    }
    this.runState = this.stages.requiredComplete() ? 'degraded' : 'initializing';
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      void this.sessions.heartbeat(this.runState);
    }, 30_000);
    this.heartbeatTimer.unref?.();
  }

  /* -------------------------------------------------------------- health */

  health(): HealthReport {
    const records = this.capabilities.list();
    const summary = summarizeCapabilities(records);
    const latest = this.telemetry.latest();
    const optimizationEnabled = this.runState === 'ready' && this.options.config.mode !== 'observation';

    return {
      generatedAtMs: this.clock.now(),
      nexusVersion: NEXUS_VERSION,
      sessionId: this.sessionId,
      pid: process.pid,
      uptimeMs: this.startedAtMs === 0 ? 0 : this.clock.now() - this.startedAtMs,
      runState: this.runState,
      stages: this.stages.all(),

      hardwareDetected: this.inventory !== null,
      hardwareFidelity: this.inventory?.fidelity ?? 'unavailable',
      telemetryWorking: this.telemetry.working,
      telemetryFidelity: latest?.fidelity ?? 'unavailable',
      capabilities: {
        total: summary.total,
        byState: summary.byState,
        available: summary.available,
        unavailable: summary.unavailable,
      },

      activeProfileId: this.activeProfileId,
      optimizationEnabled,
      optimizationDisabledReason: optimizationEnabled
        ? null
        : this.options.config.mode === 'observation'
          ? 'NEXUS is in observation mode; it is measuring and reporting only.'
          : this.runState === 'observation_only'
            ? 'NEXUS has dropped to observation-only.'
            : `NEXUS is ${this.runState}.`,

      degraded: this.degradedReasons.length > 0,
      degradedReasons: [...this.degradedReasons],

      previousShutdown: this.previousShutdown,
      recoveryRequired: this.recovery?.required ?? false,
      recoverySummary: this.recovery?.summary ?? null,

      vesperInterface: {
        enabled: this.options.config.vesper.enabled,
        listening: this.vesper?.listening ?? false,
        endpoint: this.vesper?.listening ? this.vesper.endpoint : null,
        clientSeen: this.vesper?.hasSeenClient ?? false,
        lastRequestAtMs: this.vesper?.lastRequestMs ?? null,
      },

      selfFootprint: {
        rssBytes: process.memoryUsage.rss(),
        cpuPercent: this.telemetry.selfCpuPercentEstimate,
        samplingMode: this.telemetry.currentMode,
        telemetryIntervalMs: this.telemetry.currentIntervalMs,
      },
    };
  }

  /* -------------------------------------------------------------- actions */

  async captureBaseline(): Promise<Result<Baseline, NexusError>> {
    if (!this.inventory) {
      return err(nexusError('E_STATE', 'a baseline needs a hardware inventory, and discovery has not produced one'));
    }
    const snapshots = this.telemetry.history();
    const classification = await this.analyzeWorkload();
    const captured = await this.baselines.capture({
      inventory: this.inventory,
      capabilities: this.capabilities.snapshot(),
      snapshots,
      workload: classification,
      context: this.actuatorContext,
    });
    if (!captured.ok) return captured;
    this.baseline = captured.value;
    await this.eventLog.append({
      kind: 'baseline.captured',
      severity: 'info',
      message: `baseline ${captured.value.id} captured`,
      data: {
        fidelity: captured.value.fidelity,
        controlCoverage: Number(captured.value.controlCoverage.toFixed(2)),
      },
    });
    return captured;
  }

  async analyzeWorkload(): Promise<WorkloadClassification> {
    const snapshot: TelemetrySnapshot | null = this.telemetry.latest();
    if (!snapshot) {
      return {
        timestampMs: this.clock.now(),
        workload: 'unknown',
        confidence: 0,
        candidates: [],
        fidelity: 'unavailable',
        missingSignals: ['telemetry'],
        contextConflict: false,
        explanation: 'No telemetry has been sampled yet, so the workload cannot be classified.',
      };
    }
    const hint =
      this.contextHint && hintIsFresh(this.contextHint, this.clock.now()) ? this.contextHint : undefined;

    // Process evidence corroborates classification the same way a context hint
    // does: it can raise a candidate's score, never invent telemetry, and an
    // empty/failed enumeration simply leaves process.enumerate in missingSignals.
    let processes: readonly ProcessObservation[] = [];
    const enumerated = await this.processEnumerator.enumerate();
    if (enumerated.ok) {
      processes = enumerated.value.processes;
    }

    return this.classifier.classify(signalsFromSnapshot(snapshot, processes), hint, this.clock.now());
  }

  async currentControlValues(): Promise<Map<ControlId, ControlValue | null>> {
    const values = new Map<ControlId, ControlValue | null>();
    for (const control of this.registry.controls()) {
      const adapter = this.registry.get(control);
      if (!adapter) continue;
      const value = await adapter.read(this.actuatorContext);
      values.set(control, value.ok ? value.value : null);
    }
    return values;
  }

  /* ---------------------------------------------------------- VesperHost */

  async getStatus(): Promise<HealthReport> {
    return this.health();
  }

  async getCapabilities(): Promise<readonly CapabilityRecord[]> {
    return this.capabilities.list();
  }

  async getTelemetrySummary(windowMs: number): Promise<TelemetrySummary> {
    return summarize(this.telemetry.history(windowMs));
  }

  async getCurrentProfile(): Promise<{ profile: ProfileDocument | null; appliedAtMs: number | null }> {
    return {
      profile: this.profiles.get(this.activeProfileId)?.profile ?? null,
      appliedAtMs: this.activeProfileAppliedAtMs,
    };
  }

  async listProfiles(): Promise<readonly ProfileView[]> {
    const caps = this.capabilities.snapshot();
    return this.profiles.list().map((loaded) => {
      const applies = applicability(loaded.profile, caps);
      return {
        id: loaded.profile.id,
        name: loaded.profile.name,
        description: loaded.profile.description,
        targets: loaded.profile.targets,
        ...(loaded.profile.applicationIds === undefined ? {} : { applicationIds: loaded.profile.applicationIds }),
        settings: loaded.profile.settings.map((s) => ({
          control: s.control,
          value: s.value,
          rationale: s.rationale,
        })),
        applicableHere: applies.applicable || loaded.profile.id === OBSERVATION_PROFILE_ID,
      };
    });
  }

  /**
   * Record intent Vesper observed. NEXUS stores who said it and when, applies
   * a TTL, and treats it as evidence in classification — never as an
   * instruction, and never as a reason to skip a safety check.
   */
  async declareContext(hint: ContextHint): Promise<{ accepted: boolean; note: string }> {
    this.contextHint = hint;
    await this.eventLog.append({
      kind: 'vesper.context_declared',
      severity: 'info',
      message: `${hint.declaredBy} declared a "${hint.workload}" workload`,
      data: { ttlMs: hint.ttlMs, note: hint.note ?? null },
    });
    return {
      accepted: true,
      note: 'Recorded as context. NEXUS will weigh it against what it can observe and will report any disagreement rather than assuming it is correct.',
    };
  }

  async recommend(profileId?: string): Promise<RecommendationView> {
    const workload = await this.analyzeWorkload();
    const chosen = profileId
      ? this.profiles.get(profileId)
      : this.profiles.suggestFor(workload.workload, workload.detectedApplicationIds ?? []);

    if (!chosen) {
      return {
        workload,
        recommendedProfileId: null,
        rationale: profileId
          ? `There is no profile named "${profileId}".`
          : `No profile targets a ${workload.workload} workload.`,
        proposedChanges: [],
        noActionReason: 'no_proposal_generated',
      };
    }

    if (profileId === undefined) {
      const guard = automaticProfileGuard(chosen.profile, specializeTarget(this.inventory));
      if (guard !== null) {
        return {
          workload,
          recommendedProfileId: null,
          rationale: guard,
          proposedChanges: [],
          noActionReason: 'no_proposal_generated',
        };
      }
    }

    const current = await this.currentControlValues();
    const result = this.engine.propose({
      workload,
      profile: chosen.profile,
      currentValues: current,
      origin: 'vesper',
      requestedBy: this.requesterId,
    });

    if (result.kind === 'no_action') {
      return {
        workload,
        recommendedProfileId: chosen.profile.id,
        rationale: result.summary,
        proposedChanges: [],
        noActionReason: result.reason,
      };
    }

    return {
      workload,
      recommendedProfileId: chosen.profile.id,
      rationale: `Profile "${chosen.profile.name}" targets a ${workload.workload} workload.`,
      proposedChanges: result.proposal.changes.map((c) => ({
        control: c.control,
        currentValue: current.get(c.control) ?? null,
        targetValue: c.targetValue,
        rationale: c.rationale,
      })),
      noActionReason: null,
    };
  }

  async optimize(params: { profileId?: string; dryRun?: boolean }): Promise<OptimizationOutcome> {
    return this.runOptimization({
      origin: 'vesper',
      requestedBy: this.requesterId,
      ...(params.profileId === undefined ? {} : { profileId: params.profileId }),
      ...(params.dryRun === undefined ? {} : { dryRun: params.dryRun }),
    });
  }

  /** Vesper's rollback. Gated as a `vesper`-origin request. */
  async rollback(checkpointId: string): Promise<RestoreResult> {
    return this.performRollback(checkpointId, 'vesper', this.requesterId);
  }

  /**
   * Restore a checkpoint, through the safety kernel.
   *
   * Every write NEXUS performs goes through the kernel, and a rollback is a
   * write. Calling the checkpoint store directly — as this used to — meant
   * `observationOnly` and the run-state gate could be sidestepped by asking
   * for a rollback rather than an optimization.
   */
  async performRollback(
    checkpointId: string,
    origin: 'user' | 'vesper' | 'internal',
    requestedBy: string = origin,
  ): Promise<RestoreResult> {
    const checkpoint = await this.checkpoints.load(checkpointId);
    if (!checkpoint.ok) {
      await this.eventLog.append({
        kind: 'rollback.refused',
        severity: 'warning',
        message: checkpoint.error.message,
        data: { checkpointId },
      });
      throw checkpoint.error;
    }

    const verdict = this.safetyKernel.evaluateRollback(
      {
        checkpointId,
        origin,
        requestedBy,
        controls: checkpoint.value.entries.filter((e) => e.restorable).map((e) => e.control),
      },
      {
        nowMs: this.clock.now(),
        runState: this.runState,
        capabilities: this.capabilities.snapshot(),
        telemetry: this.telemetry.latest(),
        baselineAvailable: this.baseline !== null,
        recentApplications: this.appliedHistory,
        actuatorFidelity: (control) => this.registry.fidelityOf(control),
      },
    );

    if (verdict.decision !== 'allow') {
      const reason = verdict.findings
        .filter((f) => f.severity === 'blocking')
        .map((f) => f.message)
        .join(' ');
      await this.eventLog.append({
        kind: 'rollback.refused',
        severity: 'warning',
        message: `rollback of ${checkpointId} refused: ${reason}`,
        data: { checkpointId, origin, findings: verdict.findings.map((f) => f.code) },
      });
      throw nexusError('E_SAFETY_REJECTED', reason || 'the safety kernel refused this rollback', {
        checkpointId,
      });
    }

    const restored = await this.checkpoints.restore(checkpointId, this.actuatorContext);
    if (!restored.ok) {
      await this.eventLog.append({
        kind: 'rollback.refused',
        severity: 'error',
        message: restored.error.message,
        data: { checkpointId },
      });
      throw restored.error;
    }
    await this.eventLog.append({
      kind: 'rollback.performed',
      severity: 'notice',
      message: `rollback of checkpoint ${checkpointId} ${restored.value.complete ? 'completed' : 'was incomplete'}`,
      data: { checkpointId, complete: restored.value.complete },
    });
    if (!restored.value.complete) {
      this.degrade('A rollback did not fully restore the captured state.');
      this.runState = 'observation_only';
    }
    return restored.value;
  }

  async getOptimizationResult(outcomeId: string): Promise<OptimizationOutcome | null> {
    return this.outcomes.get(outcomeId) ?? null;
  }

  /* ------------------------------------------------------------ optimize */

  /**
   * Resolve a concrete game process for PresentMon. This is intentionally
   * heuristic: process enumeration corroborates the workload, while the
   * resulting PID is only used to collect frame evidence for this experiment.
   */
  private async resolveFrameTarget(applicationId?: string): Promise<{ processId: number; processName: string } | null> {
    const enumerated = await this.processEnumerator.enumerate({ maxProcesses: 256 });
    if (!enumerated.ok) return null;

    const names = applicationId && APPLICATION_HINTS[applicationId]
      ? APPLICATION_HINTS[applicationId]
      : Object.values(APPLICATION_HINTS).flat();
    const foreground = this.platform === 'win32'
      ? await getForegroundProcess(
          this.runner,
          this.options.config.tools.nativeHelperPath === null
            ? (this.options.config.tools.nativeHelperSha256 === null
                ? undefined
                : { expectedSha256: this.options.config.tools.nativeHelperSha256 })
            : {
                executable: this.options.config.tools.nativeHelperPath,
                ...(this.options.config.tools.nativeHelperSha256 === null
                  ? {}
                  : { expectedSha256: this.options.config.tools.nativeHelperSha256 }),
              },
        ).catch(() => null)
      : null;
    const foregroundPid = foreground?.ok && foreground.value.available ? foreground.value.pid : null;

    const matches = enumerated.value.processes
      .filter((p) => p.pid !== null && names.some((hint) => p.name.toLowerCase().includes(hint)))
      .sort((a, b) => {
        const aForeground = foregroundPid !== null && a.pid === foregroundPid ? 1 : 0;
        const bForeground = foregroundPid !== null && b.pid === foregroundPid ? 1 : 0;
        return bForeground - aForeground ||
          (b.workingSetBytes ?? -1) - (a.workingSetBytes ?? -1) ||
          (a.pid ?? 0) - (b.pid ?? 0);
      });

    const match = matches[0];
    if (!match?.pid || match.pid <= 0) return null;
    return { processId: match.pid, processName: match.name };
  }

  async getPerformanceEvidence(
    windowMs: number,
    applicationId?: string,
  ): Promise<{
    readonly capturedAtMs: number;
    readonly telemetry: TelemetrySummary;
    readonly frame: FramePerformanceSummary | null;
    readonly frameTarget: { readonly processId: number; readonly processName: string } | null;
    readonly topologyAware: boolean;
    readonly fidelity: Fidelity;
  }> {
    const boundedMs = Math.max(1_000, Math.min(120_000, Math.round(windowMs)));
    const telemetry = summarize(this.telemetry.history(boundedMs));
    const frameTarget = this.platform === 'win32' ? await this.resolveFrameTarget(applicationId) : null;
    let frame: FramePerformanceSummary | null = null;

    if (frameTarget && this.platform === 'win32') {
      const seconds = Math.max(1, Math.min(10, Math.ceil(boundedMs / 1000)));
      const captured = await this.presentMon.capture({
        processId: frameTarget.processId,
        seconds,
      });
      if (captured.ok) frame = captured.value.summary;
    }

    return {
      capturedAtMs: this.clock.now(),
      telemetry,
      frame,
      frameTarget,
      topologyAware: this.platform === 'win32' && this.capabilities.get('cpu.topology')?.state === 'available',
      fidelity: frame && telemetry.fidelity === 'live' ? 'live' : telemetry.fidelity,
    };
  }

  async getDecisionEvidence(outcomeId: string): Promise<unknown> {
    const outcome = this.outcomes.get(outcomeId);
    if (!outcome) return null;

    return {
      outcomeId,
      status: outcome.status,
      workload: outcome.workload,
      fidelity: outcome.fidelity,
      summary: outcome.summary,
      proposal: outcome.proposalId,
      findings: outcome.findings,
      measurements: outcome.measurements,
      checkpointId: outcome.checkpointId,
      rolledBack: outcome.rolledBack,
      stabilityRegression: outcome.stabilityRegression ?? false,
      safetyDecision: outcome.verdict
        ? {
            decision: outcome.verdict.decision,
            findings: outcome.verdict.findings,
            policyDigest: outcome.verdict.policyDigest,
          }
        : null,
      stabilityGuard: this.degradedReasons.filter((reason) => /stability|WHEA|TDR/i.test(reason)),
    };
  }

  async getTopology(): Promise<unknown> {
    if (this.platform !== 'win32') {
      return { available: false, platform: this.platform, detail: 'Windows topology evidence is not currently available on this platform.' };
    }
    const helperOptions =
      this.options.config.tools.nativeHelperPath === null
        ? (this.options.config.tools.nativeHelperSha256 === null
            ? undefined
            : { expectedSha256: this.options.config.tools.nativeHelperSha256 })
        : {
            executable: this.options.config.tools.nativeHelperPath,
            ...(this.options.config.tools.nativeHelperSha256 === null
              ? {}
              : { expectedSha256: this.options.config.tools.nativeHelperSha256 }),
          };
    const native = await import('../process/windows-native.js').then((module) =>
      module.getSystemCpuSets(this.runner, helperOptions),
    );
    if (!native.ok) {
      return { available: false, platform: this.platform, detail: native.error.message, fidelity: 'unavailable' };
    }
    const groups = new Map<number, number>();
    for (const cpuSet of native.value) {
      groups.set(cpuSet.lastLevelCacheIndex, (groups.get(cpuSet.lastLevelCacheIndex) ?? 0) + 1);
    }
    return {
      available: native.value.length > 0,
      fidelity: 'live',
      cpuSetCount: native.value.length,
      cacheDomains: [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([cacheDomain, logicalProcessors]) => ({
        cacheDomain,
        logicalProcessors,
      })),
      cpuSets: native.value,
    };
  }

  async runExperiment(request: {
    applicationId: string;
    repetitions?: number;
    maxCandidates?: number;
    practicalThresholdPercent?: number;
  }): Promise<ExperimentRunResult> {
    const origin: 'vesper' = 'vesper';
    const requestedBy = this.requesterId;
    const applicationId = request.applicationId.trim().toLowerCase();
    if (!/^[a-z0-9._-]{1,63}$/.test(applicationId)) {
      return {
        status: 'blocked',
        fidelity: 'unavailable',
        applicationId,
        fingerprint: null,
        candidates: [],
        trials: [],
        winner: null,
        scoreMetric: 'frame.1pct_low',
        score: decideExperiment([]).score,
        finalOutcomeId: null,
        detail: 'Application id is malformed.',
      };
    }

    if (this.options.config.mode === 'observation' || this.runState === 'observation_only') {
      return {
        status: 'blocked',
        fidelity: 'unavailable',
        applicationId,
        fingerprint: null,
        candidates: [],
        trials: [],
        winner: null,
        scoreMetric: 'frame.1pct_low',
        score: decideExperiment([]).score,
        finalOutcomeId: null,
        detail: this.runState === 'observation_only'
          ? 'NEXUS is observation-only and cannot run tuner trials.'
          : 'NEXUS is configured for observation-only operation.',
      };
    }

    if (this.platform !== 'win32') {
      return {
        status: 'blocked',
        fidelity: 'unavailable',
        applicationId,
        fingerprint: null,
        candidates: [],
        trials: [],
        winner: null,
        scoreMetric: 'frame.1pct_low',
        score: decideExperiment([]).score,
        finalOutcomeId: null,
        detail: 'The private tuner currently requires Windows power-plan and PresentMon support.',
      };
    }

    const inventory = this.inventory;
    const specialization = specializeTarget(inventory);
    if (!inventory || !specialization.x3dSchedulingSensitive) {
      return {
        status: 'blocked',
        fidelity: 'unavailable',
        applicationId,
        fingerprint: null,
        candidates: [],
        trials: [],
        winner: null,
        scoreMetric: 'frame.1pct_low',
        score: decideExperiment([]).score,
        finalOutcomeId: null,
        detail: 'The private tuner is currently restricted to the Ryzen 9 9950X3D family.',
      };
    }

    // Require the target game to be the current foreground application. This stops
    // a background Steam process from triggering a long sequence of power changes.
    const target = await this.resolveFrameTarget(applicationId);
    const foreground = await getForegroundProcess(this.runner).catch(() => null);
    if (!target || !foreground?.ok || foreground.value.pid !== target.processId) {
      return {
        status: 'blocked',
        fidelity: 'unavailable',
        applicationId,
        fingerprint: null,
        candidates: [],
        trials: [],
        winner: null,
        scoreMetric: 'frame.1pct_low',
        score: decideExperiment([]).score,
        finalOutcomeId: null,
        detail: 'The requested game is not the observed foreground process; tuner trials were refused.',
      };
    }

    if (!this.baseline) {
      const baseline = await this.captureBaseline();
      if (!baseline.ok) {
        return {
          status: 'failed',
        fidelity: 'unavailable',
          applicationId,
          fingerprint: null,
          candidates: [],
          trials: [],
          winner: null,
          scoreMetric: 'frame.1pct_low',
          score: decideExperiment([]).score,
          finalOutcomeId: null,
          detail: `Could not establish a baseline: ${baseline.error.message}`,
        };
      }
    }

    await this.eventLog.append({
      kind: 'experiment.started',
      severity: 'notice',
      message: `started private tuner experiment for ${applicationId}`,
      data: {
        applicationId,
        repetitions: Math.max(2, Math.min(4, Math.floor(request.repetitions ?? 3))),
        maxCandidates: Math.max(2, Math.min(8, request.maxCandidates ?? 6)),
        controls: [...TRANSACTIONAL_EXPERIMENT_CONTROLS],
      },
    });

    const current = await this.currentControlValues();
    const dimensions = defaultPrivateX3dDimensions(current);
    const candidates = makeCandidateGrid(dimensions, Math.max(2, Math.min(8, request.maxCandidates ?? 6)));
    const repetitions = Math.max(2, Math.min(4, Math.floor(request.repetitions ?? 3)));
    const trials: ExperimentTrialSummary[] = [];
    let experimentFidelity: Fidelity = 'unavailable';

    const scoreFor = (outcome: OptimizationOutcome) => frameScorePercent(outcome.measurements);

    for (const candidate of candidates) {
      const deltas: number[] = [];
      const outcomeIds: string[] = [];
      let stabilityRegression = false;

      for (let repetition = 0; repetition < repetitions; repetition += 1) {
        const outcome = await this.runOptimization({
          origin,
          requestedBy,
          applicationId,
          experimentCandidate: candidate.values,
          transactionalExperiment: true,
          sandboxPowerPlan: true,
          rollbackPolicy: 'always',
        });

        outcomeIds.push(outcome.id);
        experimentFidelity = combineFidelity(experimentFidelity, outcome.fidelity);
        const score = scoreFor(outcome);
        if (score) deltas.push(score.deltaPercent);
        stabilityRegression ||= outcome.stabilityRegression === true;

        if (outcome.status === 'applied_unverified') {
          this.runState = 'observation_only';
          await this.eventLog.append({
            kind: 'experiment.aborted',
            severity: 'critical',
            message: 'Private tuner aborted after an incomplete rollback; no further candidates will be applied.',
            data: { applicationId, candidateId: candidate.id, outcomeId: outcome.id },
          });
          break;
        }
        if (stabilityRegression || this.runState === 'observation_only') {
          break;
        }
      }

      const decision = decideExperiment(deltas, {
        practicalThresholdPercent: request.practicalThresholdPercent ?? 1,
        seed: candidate.id.length * 97 + deltas.length,
        stabilityRegression,
      });

      trials.push({
        candidateId: candidate.id,
        candidate: candidate.values,
        repetitions: outcomeIds.length,
        deltaPercent: deltas,
        decision,
        stabilityRegression,
        outcomeIds,
      });
      
      await this.eventLog.append({
        kind: 'experiment.trial',
        severity: stabilityRegression ? 'error' : 'info',
        message: `candidate ${candidate.id} completed: ${decision.explanation}`,
        data: {
          applicationId,
          candidateId: candidate.id,
          repetitions: outcomeIds.length,
          deltaPercent: deltas,
          keep: decision.keep,
          stabilityRegression,
          confidenceLowPercent: decision.score.low,
          confidenceHighPercent: decision.score.high,
        },
      });

      if (stabilityRegression || this.runState === 'observation_only') break;
    }

    if (this.runState === 'observation_only') {
      return {
        fidelity: experimentFidelity,
        status: 'inconclusive',
        applicationId,
        fingerprint,
        candidates,
        trials,
        winner: null,
        scoreMetric: 'frame.1pct_low',
        score: decideExperiment([]).score,
        finalOutcomeId: null,
        detail: 'Private tuner aborted after machine-state uncertainty; no winner was selected or re-applied.',
      };
    }

    const viable = trials
      .filter((trial) => trial.decision.keep && !trial.stabilityRegression)
      .sort((a, b) =>
        (b.decision.score.low ?? Number.NEGATIVE_INFINITY) - (a.decision.score.low ?? Number.NEGATIVE_INFINITY) ||
        (b.decision.score.estimate ?? Number.NEGATIVE_INFINITY) - (a.decision.score.estimate ?? Number.NEGATIVE_INFINITY),
      );
    const bestTrial = viable[0] ?? null;
    const winner = bestTrial
      ? candidates.find((candidate) => candidate.id === bestTrial.candidateId) ?? null
      : null;

    const primaryGpu = selectPrimaryGpuFromInventory(inventory);
    const fingerprint = fingerprintExperiment({
      machine: {
        cpu: inventory.cpu.model,
        gpu: primaryGpu?.model ?? null,
        memoryBytes: inventory.memory.installedBytes,
      },
      os: {
        version: inventory.os.version,
        build: inventory.os.build,
      },
      platform: {
        driverVersion: primaryGpu?.driverVersion ?? null,
        biosVersion: null,
        chipsetVersion: null,
      },
      workload: {
        applicationId,
        gameBuild: null,
      },
    });

    let finalOutcomeId: string | null = null;
    if (winner) {
      const finalOutcome = await this.runOptimization({
        origin,
        requestedBy,
        applicationId,
        experimentCandidate: winner.values,
        sandboxPowerPlan: true,
        rollbackPolicy: 'unless_benefit',
        transactionalExperiment: false,
        sandboxPowerPlanName: `NEXUS ${applicationId}`,
      });
      finalOutcomeId = finalOutcome.id;
      experimentFidelity = combineFidelity(experimentFidelity, finalOutcome.fidelity);
      if (finalOutcome.status !== 'applied_kept') {
        // A candidate can win the multi-trial comparison and still fail the final
        // confirmation window. Conservatively report that no durable change won.
        const record: ExperimentRecord = {
          id: this.ids.next('exp'),
          fingerprint,
          applicationId,
          candidate: winner.values,
          decision: 'rollback',
          scorePercent: bestTrial?.decision.score.estimate ?? null,
          confidenceLowPercent: bestTrial?.decision.score.low ?? null,
          confidenceHighPercent: bestTrial?.decision.score.high ?? null,
          createdAtMs: this.clock.now(),
          detail: `Winner failed its final verification window: ${finalOutcome.summary}`,
        };
        await this.experimentStore.save(record);
        return {
          status: 'inconclusive',
          fidelity: experimentFidelity,
          applicationId,
          fingerprint,
          candidates,
          trials,
          winner,
          scoreMetric: bestTrial ? (trials.find((t) => t.candidateId === bestTrial.candidateId)?.decision ? 'frame.1pct_low' : 'frame.1pct_low') : 'frame.1pct_low',
          score: bestTrial?.decision.score ?? decideExperiment([]).score,
          finalOutcomeId,
          detail: `A winner was measured, but its final keep attempt did not pass: ${finalOutcome.summary}`,
        };
      }
    }

    const bestScore = bestTrial?.decision.score ?? decideExperiment([]).score;
    const decision: ExperimentRecord['decision'] = winner ? 'keep' : 'inconclusive';
    const record: ExperimentRecord = {
      id: this.ids.next('exp'),
      fingerprint,
      applicationId,
      candidate: winner?.values ?? {},
      decision,
      scorePercent: bestScore.estimate,
      confidenceLowPercent: bestScore.low,
      confidenceHighPercent: bestScore.high,
      createdAtMs: this.clock.now(),
      detail: winner
        ? `Measured winner across ${bestTrial?.repetitions ?? repetitions} repetition(s); final outcome ${finalOutcomeId ?? 'none'}.`
        : `No candidate cleared the practical threshold after ${trials.length} candidate(s).`,
    };
    await this.experimentStore.save(record);

    const finalStatus = winner ? 'kept' : 'inconclusive';

    await this.eventLog.append({
      kind: 'experiment.completed',
      severity: finalStatus === 'kept' ? 'notice' : 'info',
      message: winner
        ? `private tuner selected and verified a winner for ${applicationId}`
        : `private tuner found no candidate worth keeping for ${applicationId}`,
      data: {
        applicationId,
        status: finalStatus,
        winner: winner?.id ?? null,
        scoreMetric: bestTrial ? 'frame.1pct_low' : 'frame.1pct_low',
        scorePercent: bestScore.estimate,
        confidenceLowPercent: bestScore.low,
        confidenceHighPercent: bestScore.high,
        finalOutcomeId,
      },
    });

    return {
      fidelity: experimentFidelity,
      status: finalStatus,
      applicationId,
      fingerprint,
      candidates,
      trials,
      winner,
      scoreMetric: 'frame.1pct_low',
      score: bestScore,
      finalOutcomeId,
      detail: winner
        ? `NEXUS measured a credible frame-performance winner for ${applicationId} and applied its final verification pass.`
        : `NEXUS found no statistically credible ${applicationId} tuner winner worth keeping.`,
    };
  }

  async runOptimization(request: {
    origin: 'user' | 'vesper' | 'internal';
    requestedBy: string;
    profileId?: string;
    dryRun?: boolean;
    confirmControls?: readonly ControlId[];
    rollbackPolicy?: ExecutionEnvironment['rollbackPolicy'];
    /** Experimental: run power-setting experiments on a duplicated plan. */
    sandboxPowerPlan?: boolean;
    /** Optional target application for frame evidence. */
    applicationId?: string;
    /** Internal experiment candidate; only the dedicated tuner should set this. */
    experimentCandidate?: Readonly<Record<ControlId, ControlValue>>;
    /** Marks a temporary trial; never exposed directly over Vesper IPC. */
    transactionalExperiment?: boolean;
    /** Human-readable name for a kept sandbox plan. */
    sandboxPowerPlanName?: string;
  }): Promise<OptimizationOutcome> {
    const workload = await this.analyzeWorkload();

    /*
     * One at a time. Cooldowns and the hourly rate limit are evaluated against
     * a history that is only appended to once an operation finishes, and an
     * operation spends its measurement window awaiting. Two concurrent
     * requests would therefore both read an empty history and both be
     * permitted, and the second would checkpoint the value the first had just
     * written — so an out-of-order rollback would restore the wrong state.
     */
    if (this.optimizationInFlight) {
      return this.engine.noAction(
        'cooldown',
        'Another optimization is already running. NEXUS applies one change at a time so that measurement and rollback stay meaningful.',
        workload,
      );
    }

    if (this.options.config.mode === 'observation') {
      return this.engine.noAction(
        'observation_only',
        'NEXUS is in observation mode. Switch to assisted or autonomous mode to allow changes.',
        workload,
      );
    }
    if (this.runState === 'observation_only') {
      return this.engine.noAction('degraded', this.degradedReasons.join(' ') || 'NEXUS is observation-only.', workload);
    }
    if (this.options.config.mode === 'assisted' && request.origin === 'internal') {
      return this.engine.noAction(
        'observation_only',
        'NEXUS is in assisted mode, so it does not act on its own initiative.',
        workload,
      );
    }

    if (request.transactionalExperiment && !request.sandboxPowerPlan) {
      return this.engine.noAction(
        'unsafe',
        'Temporary tuner trials must run inside an isolated duplicated power plan.',
        workload,
      );
    }

    if (request.experimentCandidate && request.profileId !== undefined) {
      return this.engine.noAction(
        'no_proposal_generated',
        'A tuner candidate cannot be combined with a named profile.',
        workload,
      );
    }

    let chosen = request.profileId
      ? this.profiles.get(request.profileId)
      : this.profiles.suggestFor(workload.workload, workload.detectedApplicationIds ?? []);

    const current = await this.currentControlValues();
    let proposal: OptimizationProposal;

    if (request.experimentCandidate) {
      const entries = Object.entries(request.experimentCandidate);
      if (entries.length === 0) {
        return this.engine.noAction('no_proposal_generated', 'The tuner candidate contained no controls.', workload);
      }

      const invalid = entries.filter(([control]) => !TRANSACTIONAL_EXPERIMENT_CONTROLS.has(control));
      if (invalid.length > 0) {
        return this.engine.noAction(
          'unsafe',
          `The tuner can only exercise: ${[...TRANSACTIONAL_EXPERIMENT_CONTROLS].join(', ')}.`,
          workload,
        );
      }

      const changes = entries
        .filter(([control, value]) => !structurallyEqual(current.get(control) ?? null, value))
        .map(([control, targetValue]) => ({
          control,
          targetValue,
          rationale: 'Bounded private per-game experiment candidate.',
          expectedEffect: 'Measure frame-time and system evidence under this temporary power policy.',
        }));

      if (changes.length === 0) {
        return this.engine.noAction('already_optimal', 'This tuner candidate already matches the current control state.', workload);
      }

      proposal = {
        id: this.ids.next('prop'),
        createdAtMs: this.clock.now(),
        origin: request.origin,
        requestedBy: request.requestedBy,
        workload: workload.workload,
        changes,
        profileId: 'experiment',
        notes: 'private per-game tuner candidate; always rollback unless explicitly selected as the final winner',
      };
      chosen = undefined;
    } else {
      if (!chosen) {
        return this.engine.noAction(
          'no_proposal_generated',
          request.profileId
            ? `There is no profile named "${request.profileId}".`
            : `No profile targets a ${workload.workload} workload.`,
          workload,
        );
      }

      if (request.profileId === undefined) {
        const guard = automaticProfileGuard(chosen.profile, specializeTarget(this.inventory));
        if (guard !== null) {
          return this.engine.noAction('no_proposal_generated', guard, workload);
        }
      }

      const proposed = this.engine.propose({
        workload,
        profile: chosen.profile,
        currentValues: current,
        origin: request.origin,
        requestedBy: request.requestedBy,
      });

      if (proposed.kind === 'no_action') {
        return this.engine.noAction(proposed.reason, proposed.summary, workload);
      }

      proposal =
        request.confirmControls && request.origin === 'user'
          ? {
              ...proposed.proposal,
              confirmation: {
                confirmedAtMs: this.clock.now(),
                controls: request.confirmControls,
                acknowledgement: 'confirmed at the NEXUS command line',
              },
            }
          : proposed.proposal;
    }

    if (request.dryRun) {
      const verdict = this.kernel.evaluate(proposal, {
        nowMs: this.clock.now(),
        runState: this.runState,
        capabilities: this.capabilities.snapshot(),
        telemetry: this.telemetry.latest(),
        baselineAvailable: this.baseline !== null,
        recentApplications: this.appliedHistory,
        actuatorFidelity: (control) => this.registry.fidelityOf(control),
        ...(request.transactionalExperiment === undefined ? {} : { transactionalExperiment: request.transactionalExperiment }),
      });
      const outcome: OptimizationOutcome = {
        id: this.ids.next('opt'),
        proposalId: proposal.id,
        status: verdict.decision === 'allow' ? 'no_action' : verdict.decision === 'reject' ? 'rejected' : 'requires_confirmation',
        startedAtMs: this.clock.now(),
        finishedAtMs: this.clock.now(),
        fidelity: this.registry.combinedFidelity(proposal.changes.map((c) => c.control)),
        workload: workload.workload,
        ...(verdict.decision === 'allow' ? { noActionReason: 'observation_only' as const } : {}),
        verdict,
        appliedChanges: [],
        rolledBack: false,
        checkpointId: null,
        measurements: [],
        summary:
          verdict.decision === 'allow'
            ? `Dry run: ${proposal.changes.length} change(s) would be applied. Nothing was changed.`
            : `Dry run: the safety kernel would return "${verdict.decision}".`,
        findings: verdict.findings,
      };
      this.outcomes.set(outcome.id, outcome);
      return outcome;
    }

    let powerWorkspace: PowerPlanWorkspace | null = null;
    const usesPowerControls = proposal.changes.some((change) => change.control.startsWith('power.'));
    if (request.sandboxPowerPlan && this.platform === 'win32' && usesPowerControls) {
      const prepared = await this.powerSandbox.prepare();
      if (!prepared.ok) {
        return this.engine.noAction('unsafe', `Power-plan sandbox could not be prepared: ${prepared.error.message}`, workload);
      }
      powerWorkspace = prepared.value;
      await this.eventLog.append({
        kind: 'power.sandbox.prepared',
        severity: 'info',
        message: `duplicated active power scheme ${powerWorkspace.originalGuid} into isolated scheme ${powerWorkspace.sandboxGuid}`,
        data: { originalGuid: powerWorkspace.originalGuid, sandboxGuid: powerWorkspace.sandboxGuid },
      });
    }

    const beforeSystemSummary = summarize(this.telemetry.history(60_000));
    const frameTarget = workload.workload === 'gaming' || workload.workload === 'gpu_bound'
      ? await this.resolveFrameTarget(request.applicationId)
      : null;
    const beforeFrame = frameTarget && this.platform === 'win32'
      ? await this.presentMon.capture({ processId: frameTarget.processId, seconds: 10 }).catch(() => null)
      : null;
    const beforeSummary = beforeFrame?.ok
      ? mergeSummaries(beforeSystemSummary, summarizePresentMon(beforeFrame.value.summary, this.clock.now()))
      : beforeSystemSummary;
    const stabilityBefore =
      this.platform === 'win32'
        ? await captureWindowsStability(this.runner, this.clock.now() - 5 * 60_000, this.clock.now()).catch(() => null)
        : null;
    this.optimizationInFlight = true;
    let executed;
    try {
      executed = await this.engine.execute(
        proposal,
        {
          runState: this.runState,
          capabilities: this.capabilities.snapshot(),
          telemetry: this.telemetry.latest(),
          baselineAvailable: this.baseline !== null,
          recentApplications: this.appliedHistory,
          workload,
          beforeSummary,
          measureAfter: async (windowMs) => {
            const systemSummary = summarize(this.telemetry.history(windowMs));
            if (!frameTarget || this.platform !== 'win32') return systemSummary;
            const captured = await this.presentMon.capture({
              processId: frameTarget.processId,
              seconds: Math.max(5, Math.min(120, Math.ceil(windowMs / 1000))),
            });
            return captured.ok
              ? mergeSummaries(systemSummary, summarizePresentMon(captured.value.summary, this.clock.now()))
              : systemSummary;
          },
          onMeasurementWindow: (windowMs) => this.telemetry.enterOptimizationMode(windowMs),
          ...(request.rollbackPolicy === undefined ? {} : { rollbackPolicy: request.rollbackPolicy }),
          ...(request.transactionalExperiment === undefined ? {} : { transactionalExperiment: request.transactionalExperiment }),
          ...(stabilityBefore?.ok
            ? {
                stabilityCheck: async () => {
                  const after = await captureWindowsStability(
                    this.runner,
                    stabilityBefore.value.capturedAtMs,
                    this.clock.now(),
                  ).catch(() => null);
                  if (!after?.ok) return null;
                  const delta = diffWindowsStability(stabilityBefore.value, after.value);
                  return {
                    unstable: delta.unstable,
                    detail: delta.unstable
                      ? `new WHEA/TDR/application-crash evidence: WHEA ${delta.whea}, TDR ${delta.displayTdr}, app crashes ${delta.appCrashes}`
                      : 'stability oracle observed no new WHEA/TDR/application-crash events while the candidate was active',
                  };
                },
              }
            : {}),
        },
        this.actuatorContext,
      );
    } finally {
      this.optimizationInFlight = false;
      this.telemetry.exitOptimizationMode();
    }

    if (!executed.ok) {
      if (powerWorkspace) {
        const restored = await this.powerSandbox.restore(powerWorkspace);
        if (!restored.ok) this.runState = 'observation_only';
      }
      return this.engine.noAction('unsafe', executed.error.message, workload);
    }

    let outcome = executed.value;

    if (powerWorkspace) {
      if (outcome.status === 'applied_kept') {
        const named = await this.powerSandbox.keep(powerWorkspace, request.sandboxPowerPlanName ?? `NEXUS ${workload.workload}`);
        if (!named.ok) {
          this.degrade(`Power-plan sandbox commit failed: ${named.error.message}`);
          this.runState = 'observation_only';
          outcome = {
            ...outcome,
            status: 'applied_unverified',
            rolledBack: false,
            summary: `${outcome.summary} The isolated winner could not be durably committed; NEXUS has quarantined further writes.`,
            finishedAtMs: this.clock.now(),
          };
        } else {
          await this.eventLog.append({
            kind: 'power.sandbox.kept',
            severity: 'notice',
            message: `kept isolated power scheme ${powerWorkspace.sandboxGuid} active after a measured experiment`,
            data: { sandboxGuid: powerWorkspace.sandboxGuid, originalGuid: powerWorkspace.originalGuid },
          });
        }
      } else {
        const restored = await this.powerSandbox.restore(powerWorkspace);
        if (!restored.ok) {
          this.degrade(`Power-plan sandbox cleanup failed: ${restored.error.message}`);
          this.runState = 'observation_only';
          outcome = {
            ...outcome,
            status: 'applied_unverified',
            summary: `${outcome.summary} The isolated power-plan experiment could not be cleanly restored.`,
            rolledBack: false,
            finishedAtMs: this.clock.now(),
          };
        } else {
          await this.eventLog.append({
            kind: 'power.sandbox.restored',
            severity: 'info',
            message: `restored original power scheme ${powerWorkspace.originalGuid} and deleted the experiment clone`,
            data: { originalGuid: powerWorkspace.originalGuid, sandboxGuid: powerWorkspace.sandboxGuid },
          });
        }
      }
    }


    this.outcomes.set(outcome.id, outcome);
    if (!request.transactionalExperiment) {
      for (const change of outcome.appliedChanges) {
        this.appliedHistory.push({ control: change.control, appliedAtMs: change.appliedAtMs });
      }
      this.pruneAppliedHistory();
    }
    if (outcome.status === 'applied_kept' && chosen) {
      this.activeProfileId = chosen.profile.id;
      this.activeProfileAppliedAtMs = this.clock.now();
      await this.eventLog.append({
        kind: 'profile.activated',
        severity: 'notice',
        message: `profile "${chosen.profile.id}" is now active`,
      });
    }
    if (outcome.status === 'applied_unverified') {
      this.degrade(outcome.summary);
      this.runState = 'observation_only';
    }
    return outcome;
  }

  /* ------------------------------------------------------------ shutdown */

  /**
   * Ordered shutdown:
   *   stop accepting new work -> stop sampling -> close the Vesper endpoint ->
   *   flush the session record -> release the lock -> exit.
   *
   * Bounded: each step has a deadline, so shutdown cannot hang.
   */
  async shutdown(reason: string, timeoutMs = 10_000): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.runState = 'stopping';
    this.logger.info('shutting down', { reason });

    const deadline = async <T>(label: string, fn: () => Promise<T>): Promise<void> => {
      try {
        await Promise.race([
          fn(),
          new Promise<void>((_, rejectWith) =>
            setTimeout(() => rejectWith(new Error(`${label} did not finish in time`)), timeoutMs).unref?.(),
          ),
        ]);
      } catch (e) {
        this.logger.warn('shutdown step failed', { step: label, error: String(e) });
      }
    };

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    // Background initialization may still be writing state. Let it finish
    // before tearing anything down, so shutdown does not race a half-written
    // baseline or capability probe.
    await deadline('initialization', async () => {
      if (this.backgroundInit) await this.backgroundInit;
    });

    await deadline('telemetry', () => this.telemetry.stop());
    const vesper = this.vesper;
    this.vesper = null;
    await deadline('vesper', async () => {
      if (vesper) await vesper.stop();
    });
    await deadline('audit', async () => {
      await this.eventLog.append({
        kind: 'session.end',
        severity: 'info',
        message: `NEXUS shutting down: ${reason}`,
        data: { uptimeMs: this.clock.now() - this.startedAtMs },
      });
      await this.eventLog.prune();
    });
    await deadline('journal', () => this.journal.prune().then(() => undefined));
    await deadline('session', () => this.sessions.end('stopped'));
    await deadline('lock', () => this.lock.release());

    this.runState = 'stopped';
    this.logger.info('shutdown complete');
  }

  /** Install signal handlers so a console Ctrl+C shuts down in order. */
  installSignalHandlers(onExit?: () => void): () => void {
    const handler = (signal: NodeJS.Signals): void => {
      void this.shutdown(`received ${signal}`).then(() => onExit?.());
    };
    process.on('SIGINT', handler);
    process.on('SIGTERM', handler);
    return () => {
      process.off('SIGINT', handler);
      process.off('SIGTERM', handler);
    };
  }

  /* -------------------------------------------------------------- access */

  get telemetryPipeline(): TelemetryPipeline {
    return this.telemetry;
  }

  /** On-demand PresentMon evidence for bounded A/B experiments and the future UI. */
  get presentMonCollector(): PresentMonCollector {
    return this.presentMon;
  }

  async probeX3dTopology() {
    if (this.platform !== 'win32') {
      return { ok: false as const, error: nexusError('E_UNSUPPORTED', 'X3D topology probing is currently Windows-only') };
    }
    return probeCoreinfoTopology(
      this.runner,
      this.options.config.tools.coreInfoPath,
      this.options.config.tools.coreInfoSha256,
    );
  }

  get capabilityRegistry(): CapabilityRegistry {
    return this.capabilities;
  }

  get profileStore(): ProfileStore {
    return this.profiles;
  }

  get checkpointStore(): CheckpointStore {
    return this.checkpoints;
  }

  get baselineStore(): BaselineStore {
    return this.baselines;
  }

  get auditLog(): EventLog {
    return this.eventLog;
  }

  get inventorySnapshot(): HardwareInventory | null {
    return this.inventory;
  }

  get actuatorRegistry(): ActuatorRegistry {
    return this.registry;
  }

  get safetyKernel(): SafetyKernel {
    return this.kernel;
  }

  get currentRunState(): RunState {
    return this.runState;
  }

  get previousSessionShutdown(): ShutdownKind {
    return this.previousShutdown;
  }

  get capabilityFidelity(): Fidelity {
    return this.inventory?.fidelity ?? 'unavailable';
  }

  get lastSession(): Promise<SessionRecord | null> {
    return this.sessions.previous();
  }

  static describeError(e: unknown): NexusError {
    return toNexusError(e);
  }
}
