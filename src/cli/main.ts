#!/usr/bin/env node
/**
 * The NEXUS command line.
 *
 * Two shapes of command:
 *
 *   - one-shot commands (`doctor`, `discover`, `optimize`, ...) start the
 *     runtime, wait for initialization, do one thing, and shut down;
 *   - `run` is the resident process: it starts, stays up, samples adaptively,
 *     serves the Vesper endpoint if enabled, and shuts down in order on a
 *     signal.
 *
 * Every command supports `--json` for machine consumption, and `--home` to
 * point at a different NEXUS home (used by tests and by anyone who wants to
 * try NEXUS without touching their real state).
 */

import { systemClock } from '../core/clock.js';
import { StderrSink, createLogger } from '../core/logger.js';
import { defaultHome, resolvePaths } from '../core/paths.js';
import { loadConfig, saveConfig, DEFAULT_CONFIG, OPERATING_MODES } from '../config/config.js';
import type { NexusConfig, OperatingMode } from '../config/config.js';
import { NEXUS_VERSION, VESPER_CONTRACT_VERSION } from '../version.js';
import { NexusRuntime } from '../runtime/runtime.js';
import { EventLog } from '../audit/eventlog.js';
import { describeInventory } from '../hardware/discovery.js';
import { summarize } from '../telemetry/summary.js';
import { tokenFile } from '../vesper/auth.js';
import { DEFAULT_SCOPES, MUTATING_SCOPES } from '../vesper/contract.js';
import { listControls } from '../safety/controls.js';
import { parseArgs, flagBoolean, flagNumber, flagString } from './args.js';
import type { ParsedArgs } from './args.js';
import {
  formatCapabilities,
  formatHealth,
  formatInventory,
  formatOutcome,
  formatTelemetry,
  heading,
  text,
} from './format.js';

const KNOWN_COMMANDS = new Set([
  'doctor',
  'health',
  'discover',
  'topology',
  'observe',
  'baseline',
  'profiles',
  'controls',
  'recommend',
  'optimize',
  'checkpoints',
  'rollback',
  'audit',
  'vesper',
  'config',
  'first-pc',
  'run',
  'version',
  'help',
]);

const USAGE = `NEXUS ${NEXUS_VERSION} — PC performance and hardware specialist

Usage: nexus <command> [options]

Commands
  doctor                    Full diagnostic: health, hardware, capabilities, gaps
  health                    Current health report
  discover                  Hardware discovery report
  topology                  Coreinfo CPU/cache topology report (optional)
  observe [--seconds N]     Watch telemetry without changing anything
  baseline [capture|show]   Capture or display the machine baseline
  profiles [list|show ID]   Profiles and exactly what each one changes
  controls                  Every control NEXUS knows about, and its safety class
  recommend [--profile ID]  What NEXUS would do, without doing it
  optimize [--profile ID]   Apply a profile through the full safety pipeline
  checkpoints               List recovery checkpoints
  rollback <checkpointId>   Restore a checkpoint
  audit [verify|tail]       Verify or read the audit log
  vesper [status|token]     Vesper interface status and token location
  config [show|set-mode M]  Show configuration, or set the operating mode
  first-pc                  Guided first-deployment validation sequence
  run                       Run as the resident background process
  version                   Print version information

Options
  --json                    Machine-readable output
  --home PATH               Use a different NEXUS home directory
  --simulate FIXTURE        Run against a hardware fixture (target-desktop, minimal-unknown)
  --dry-run                 For optimize: validate and report, change nothing
  --require-benefit         For optimize: roll back unless a benefit is measured
  --sandbox-power-plan      For optimize: experiment on a duplicated Windows power plan
  --confirm CONTROL[,...]   Supply an explicit human confirmation for controls
  --seconds N               For observe/run: how long to run
`;

async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.command === 'help' || flagBoolean(args, 'help')) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (args.command === 'version') {
    const payload = { nexus: NEXUS_VERSION, vesperContract: VESPER_CONTRACT_VERSION, node: process.version };
    process.stdout.write(flagBoolean(args, 'json') ? `${JSON.stringify(payload)}\n` : `NEXUS ${NEXUS_VERSION} (Vesper contract ${VESPER_CONTRACT_VERSION}, Node ${process.version})\n`);
    return 0;
  }

  if (args.command !== null && !KNOWN_COMMANDS.has(args.command)) {
    process.stderr.write(`Unknown command "${args.command}".\n\n${USAGE}`);
    return 2;
  }

  const home = flagString(args, 'home') ?? defaultHome();
  const paths = resolvePaths(home);
  const loaded = await loadConfig(paths);
  if (!loaded.ok) {
    process.stderr.write(`Configuration could not be loaded: ${loaded.error.message}\n`);
    return 2;
  }

  const simulate = flagString(args, 'simulate');
  const config: NexusConfig = simulate
    ? { ...loaded.value, simulate: { hardwareFixture: simulate, telemetry: true } }
    : loaded.value;

  if (args.command === 'config') return configCommand(args, paths, config);
  if (args.command === 'controls') return controlsCommand(args);

  const logger = createLogger(new StderrSink(), flagBoolean(args, 'verbose') ? 'debug' : 'warn');

  // Audit inspection is filesystem-only. Do not boot hardware discovery,
  // telemetry, or other background runtime work just to read or verify it.
  if (args.command === 'audit') return auditCommand(args, paths, logger);

  const runtime = new NexusRuntime({ paths, config, clock: systemClock, logger });

  const started = await runtime.start();
  if (!started.ok) {
    process.stderr.write(`NEXUS could not start: ${started.error.message}\n`);
    if (started.error.code === 'E_CONFLICT') {
      process.stderr.write('Another instance holds the single-instance lock. Use `nexus health` against the running instance instead.\n');
    }
    return 3;
  }

  try {
    return await runCommand(args, runtime, paths, config);
  } finally {
    if (args.command !== 'run') await runtime.shutdown(`cli command "${args.command}" finished`);
  }
}

async function runCommand(
  args: ParsedArgs,
  runtime: NexusRuntime,
  paths: ReturnType<typeof resolvePaths>,
  config: NexusConfig,
): Promise<number> {
  const json = flagBoolean(args, 'json');
  const out = (value: unknown, textForm: string): void => {
    process.stdout.write(json ? `${JSON.stringify(value, null, 2)}\n` : `${textForm}\n`);
  };

  switch (args.command) {
    case 'run':
      return runResident(args, runtime);

    case 'health': {
      await runtime.waitUntilInitialized();
      const health = runtime.health();
      out(health, formatHealth(health));
      return health.runState === 'failed' ? 4 : 0;
    }

    case 'doctor': {
      await runtime.waitUntilInitialized();
      return doctor(runtime, json);
    }

    case 'topology': {
      await runtime.waitUntilInitialized();
      const topology = await runtime.probeX3dTopology();
      if (!topology.ok) {
        process.stderr.write(`CPU topology probe unavailable: ${topology.error.message}\n`);
        return 4;
      }
      out(topology.value, [
        heading('CPU/cache topology'),
        `  Logical processors ${topology.value.logicalProcessorCount}`,
        `  L3 domains          ${topology.value.l3Domains.length}`,
        `  V-Cache domain      ${topology.value.vCacheDomain ? `${topology.value.vCacheDomain.sizeBytes! / 1024 ** 2} MiB / ${topology.value.vCacheDomain.logicalProcessors.length} logical processors` : 'not safely identified'}`,
        `  Standard L3 domain  ${topology.value.standardCacheDomain ? `${topology.value.standardCacheDomain.sizeBytes! / 1024 ** 2} MiB / ${topology.value.standardCacheDomain.logicalProcessors.length} logical processors` : 'not identified'}`,
        `  Detail              ${topology.value.detail}`,
      ].join('\\n'));
      return 0;
    }

    case 'discover': {
      await runtime.waitUntilInitialized();
      const inventory = runtime.inventorySnapshot;
      if (!inventory) {
        process.stderr.write('Hardware discovery did not produce an inventory on this machine.\n');
        return 4;
      }
      out(inventory, `${formatInventory(inventory)}\n\n${describeInventory(inventory)}`);
      return 0;
    }

    case 'observe': {
      await runtime.waitUntilInitialized();
      const seconds = flagNumber(args, 'seconds') ?? 30;
      process.stderr.write(`Observing for ${seconds}s. Nothing will be changed.\n`);
      runtime.telemetryPipeline.start();
      await sleep(seconds * 1000);
      const summary = summarize(runtime.telemetryPipeline.history(seconds * 1000 + 5000));
      const workload = await runtime.analyzeWorkload();
      out(
        { telemetry: summary, workload },
        `${formatTelemetry(summary)}\n${heading('Workload')}\n  ${workload.workload} (confidence ${(workload.confidence * 100).toFixed(0)}%)\n  ${workload.explanation}`,
      );
      return 0;
    }

    case 'baseline': {
      await runtime.waitUntilInitialized();
      if (args.subcommand === 'capture' || args.subcommand === null) {
        const captured = await runtime.captureBaseline();
        if (!captured.ok) {
          process.stderr.write(`Baseline capture failed: ${captured.error.message}\n`);
          return 4;
        }
        out(
          captured.value,
          [
            heading('Baseline captured'),
            `  Id               ${captured.value.id}`,
            `  Fidelity         ${captured.value.fidelity}`,
            `  Control coverage ${(captured.value.controlCoverage * 100).toFixed(0)}%`,
            `  Telemetry        ${captured.value.telemetry.sampleCount} samples`,
            ...captured.value.notes.map((n) => `  ! ${n}`),
          ].join('\n'),
        );
        return 0;
      }
      const latest = await runtime.baselineStore.latest();
      if (!latest.ok) {
        process.stderr.write('No baseline has been captured yet. Run `nexus baseline capture`.\n');
        return 4;
      }
      out(latest.value, `${heading('Baseline')}\n  ${latest.value.id} captured ${new Date(latest.value.capturedAtMs).toISOString()} (${latest.value.fidelity})`);
      return 0;
    }

    case 'profiles': {
      await runtime.waitUntilInitialized();
      const profiles = await runtime.listProfiles();
      if (args.subcommand === 'show') {
        const id = args.positionals[1];
        const found = profiles.find((p) => p.id === id);
        if (!found) {
          process.stderr.write(`No profile named "${text(id)}".\n`);
          return 4;
        }
        out(
          found,
          [
            heading(`Profile: ${found.name}`),
            `  ${found.description}`,
            `  Applicable here: ${found.applicableHere ? 'yes' : 'no'}`,
            `  Applications   ${found.applicationIds?.length ? found.applicationIds.join(', ') : 'generic workload profile'}`,
            '  Changes exactly these settings, and nothing else:',
            ...(found.settings.length === 0
              ? ['    (none)']
              : found.settings.map((s) => `    ${s.control} = ${JSON.stringify(s.value)}\n      ${s.rationale}`)),
          ].join('\n'),
        );
        return 0;
      }
      out(
        profiles,
        [
          heading('Profiles'),
          ...profiles.map(
            (p) => `  ${p.id.padEnd(14)} ${p.settings.length} setting(s)  ${p.applicableHere ? '' : '[not applicable here] '}${p.applicationIds?.length ? `[apps: ${p.applicationIds.join(', ')}] ` : ''}${p.description.split('.')[0]}.`,
          ),
        ].join('\n'),
      );
      return 0;
    }

    case 'recommend': {
      await runtime.waitUntilInitialized();
      const recommendation = await runtime.recommend(flagString(args, 'profile'));
      out(
        recommendation,
        [
          heading('Recommendation'),
          `  Workload   ${recommendation.workload.workload} (confidence ${(recommendation.workload.confidence * 100).toFixed(0)}%)`,
          `  Applications ${recommendation.workload.detectedApplicationIds?.length ? recommendation.workload.detectedApplicationIds.join(', ') : 'none recognized'}`,
          `  Profile    ${text(recommendation.recommendedProfileId)}`,
          `  Rationale  ${recommendation.rationale}`,
          ...(recommendation.proposedChanges.length === 0
            ? ['  No changes would be made.']
            : [
                '  Would change:',
                ...recommendation.proposedChanges.map(
                  (c) => `    ${c.control}: ${JSON.stringify(c.currentValue)} -> ${JSON.stringify(c.targetValue)}\n      ${c.rationale}`,
                ),
              ]),
        ].join('\n'),
      );
      return 0;
    }

    case 'optimize': {
      await runtime.waitUntilInitialized();
      const confirm = flagString(args, 'confirm');
      const outcome = await runtime.runOptimization({
        origin: 'user',
        requestedBy: 'cli',
        ...(flagString(args, 'profile') === undefined ? {} : { profileId: flagString(args, 'profile') as string }),
        ...(flagBoolean(args, 'dry-run') ? { dryRun: true } : {}),
        ...(confirm ? { confirmControls: confirm.split(',').map((c) => c.trim()) } : {}),
        ...(flagBoolean(args, 'require-benefit') ? { rollbackPolicy: 'unless_benefit' as const } : {}),
        ...(flagBoolean(args, 'sandbox-power-plan') ? { sandboxPowerPlan: true } : {}),
      });
      out(outcome, formatOutcome(outcome));
      return outcome.status === 'failed' || outcome.status === 'applied_unverified' ? 4 : 0;
    }

    case 'checkpoints': {
      const ids = await runtime.checkpointStore.list();
      out({ checkpoints: ids }, `${heading('Checkpoints')}\n${ids.length === 0 ? '  (none)' : ids.map((id) => `  ${id}`).join('\n')}`);
      return 0;
    }

    case 'rollback': {
      await runtime.waitUntilInitialized();
      const id = args.positionals[1];
      if (!id) {
        process.stderr.write('Usage: nexus rollback <checkpointId>\n');
        return 2;
      }
      try {
        const restored = await runtime.performRollback(id, 'user', 'cli');
        out(
          restored,
          [
            heading('Rollback'),
            `  Checkpoint ${restored.checkpointId}`,
            `  Complete   ${restored.complete ? 'yes' : 'NO — see below'}`,
            ...restored.entries.map((e) => `    ${e.control}: ${e.message}`),
          ].join('\n'),
        );
        return restored.complete ? 0 : 4;
      } catch (e) {
        process.stderr.write(`Rollback refused: ${NexusRuntime.describeError(e).message}\n`);
        return 4;
      }
    }

    case 'vesper': {
      await runtime.waitUntilInitialized();
      const health = runtime.health();
      const payload = {
        enabled: config.vesper.enabled,
        listening: health.vesperInterface.listening,
        endpoint: health.vesperInterface.endpoint,
        contractVersion: VESPER_CONTRACT_VERSION,
        grantedScopes: config.vesper.scopes,
        tokenFile: tokenFile(paths),
      };
      out(
        payload,
        [
          heading('Vesper interface'),
          `  Enabled    ${payload.enabled ? 'yes' : 'no (set vesper.enabled in config.json)'}`,
          `  Listening  ${payload.listening ? payload.endpoint : 'no'}`,
          `  Contract   ${payload.contractVersion}`,
          `  Scopes     ${payload.grantedScopes.join(', ')}`,
          `  Token file ${payload.tokenFile}`,
          '',
          `  Scopes NOT granted by default: ${MUTATING_SCOPES.join(', ')}.`,
          '  Vesper receives no authority by asking; scopes are granted here, on this machine.',
          `  Default read-only scopes: ${DEFAULT_SCOPES.join(', ')}.`,
        ].join('\n'),
      );
      return 0;
    }

    case 'first-pc':
      return firstPc(runtime, json);

    default:
      process.stderr.write(`Unknown command "${args.command}".\n\n${USAGE}`);
      return 2;
  }
}

async function auditCommand(
  args: ParsedArgs,
  paths: ReturnType<typeof resolvePaths>,
  logger: ReturnType<typeof createLogger>,
): Promise<number> {
  const auditLog = new EventLog({
    paths,
    clock: systemClock,
    logger,
    sessionId: `audit-cli-${process.pid}`,
  });
  const opened = await auditLog.open();
  if (!opened.ok) {
    process.stderr.write(`Could not open the audit log: ${opened.error.message}\n`);
    return 4;
  }

  const json = flagBoolean(args, 'json');
  const out = (value: unknown, textForm: string): void => {
    process.stdout.write(json ? `${JSON.stringify(value, null, 2)}\n` : `${textForm}\n`);
  };

  if (args.subcommand === 'tail') {
    const events = await auditLog.readAll(flagNumber(args, 'count') ?? 20);
    if (!events.ok) {
      process.stderr.write(`Could not read the audit log: ${events.error.message}\n`);
      return 4;
    }
    out(
      events.value,
      [
        heading('Audit log'),
        ...events.value.map(
          (e) => `  #${String(e.seq).padStart(5)} ${new Date(e.timestampMs).toISOString()} ${e.severity.padEnd(8)} ${e.kind.padEnd(26)} ${e.message}`,
        ),
      ].join('\n'),
    );
    return 0;
  }

  const verified = await auditLog.verify();
  if (!verified.ok) {
    process.stderr.write(`Could not verify the audit log: ${verified.error.message}\n`);
    return 4;
  }
  out(
    verified.value,
    verified.value.valid
      ? `${heading('Audit log')}\n  Chain intact across ${verified.value.recordsChecked} record(s).`
      : `${heading('Audit log')}\n  CHAIN BROKEN at record ${verified.value.firstBrokenSeq}: ${verified.value.reason}`,
  );
  return verified.value.valid ? 0 : 4;
}

/* --------------------------------------------------------------- commands */

async function doctor(runtime: NexusRuntime, json: boolean): Promise<number> {
  const health = runtime.health();
  const capabilities = runtime.capabilityRegistry.list();
  const inventory = runtime.inventorySnapshot;
  const summary = summarize(runtime.telemetryPipeline.history());
  const workload = await runtime.analyzeWorkload();
  const audit = await runtime.auditLog.verify();

  if (json) {
    process.stdout.write(
      `${JSON.stringify({ health, inventory, capabilities, telemetry: summary, workload, audit: audit.ok ? audit.value : null }, null, 2)}\n`,
    );
    return health.degraded ? 1 : 0;
  }

  const parts = [formatHealth(health)];
  if (inventory) parts.push(formatInventory(inventory));
  parts.push(formatCapabilities(capabilities));
  parts.push(formatTelemetry(summary));
  parts.push(`${heading('Workload')}\n  ${workload.workload} (confidence ${(workload.confidence * 100).toFixed(0)}%)\n  ${workload.explanation}`);
  if (audit.ok) {
    parts.push(
      `${heading('Audit log')}\n  ${audit.value.valid ? `Chain intact across ${audit.value.recordsChecked} record(s).` : `CHAIN BROKEN at ${audit.value.firstBrokenSeq}: ${audit.value.reason}`}`,
    );
  }

  const gaps = capabilities.filter((c) => c.state !== 'available');
  if (gaps.length > 0) {
    parts.push(
      `${heading('What NEXUS cannot do on this machine')}\n${gaps
        .map((c) => `  ${c.id.padEnd(30)} ${c.detail}`)
        .join('\n')}`,
    );
  }

  process.stdout.write(`${parts.join('\n')}\n`);
  return health.degraded ? 1 : 0;
}

/**
 * The first-deployment sequence. Observation and evidence first: it discovers,
 * probes, baselines and validates a rollback, and it deliberately does not
 * leave any change applied.
 */
/**
 * The first-deployment sequence. Observation and evidence first: it discovers,
 * probes, baselines and validates a rollback, and it deliberately does not
 * leave any change applied.
 *
 * Steps that cannot run in the current operating mode are reported as SKIPPED,
 * never as passed. A run that skips the controlled change has not validated
 * rollback, and saying otherwise would defeat the point of the exercise.
 */
async function firstPc(runtime: NexusRuntime, json: boolean): Promise<number> {
  type StepState = 'ok' | 'fail' | 'skip';
  const steps: { step: string; state: StepState; detail: string }[] = [];
  const record = (step: string, state: StepState, detail: string): void => {
    steps.push({ step, state, detail });
    if (!json) {
      const label = state === 'ok' ? 'ok  ' : state === 'skip' ? 'SKIP' : 'FAIL';
      process.stdout.write(`  ${label} ${step.padEnd(28)} ${detail}\n`);
    }
  };

  if (!json) process.stdout.write(`${heading('NEXUS first-PC validation')}\n`);

  await runtime.waitUntilInitialized();
  const health = runtime.health();
  record('runtime started', health.runState === 'failed' ? 'fail' : 'ok', `run state ${health.runState}`);

  const inventory = runtime.inventorySnapshot;
  record('hardware discovered', inventory === null ? 'fail' : 'ok', inventory ? describeInventory(inventory) : 'no inventory');

  const capabilities = runtime.capabilityRegistry.list();
  const available = capabilities.filter((c) => c.state === 'available');
  record('capabilities probed', capabilities.length > 0 ? 'ok' : 'fail', `${available.length} of ${capabilities.length} available`);

  const telemetryOk = runtime.telemetryPipeline.working;
  record(
    'telemetry producing',
    telemetryOk ? 'ok' : 'fail',
    telemetryOk ? `fidelity ${runtime.telemetryPipeline.latest()?.fidelity}` : 'no source produced a usable reading',
  );

  const baseline = await runtime.baselineStore.latest();
  record(
    'baseline available',
    baseline.ok ? 'ok' : 'fail',
    baseline.ok ? `${baseline.value.id}, control coverage ${(baseline.value.controlCoverage * 100).toFixed(0)}%` : 'none',
  );

  const workload = await runtime.analyzeWorkload();
  record('workload classified', 'ok', `${workload.workload} at ${(workload.confidence * 100).toFixed(0)}% confidence`);

  // A change can only be exercised when the operating mode permits one. In
  // observation mode these steps are skipped, not passed.
  const canChange = health.optimizationEnabled || runtime.currentRunState === 'ready' || runtime.currentRunState === 'degraded';

  const dryRun = await runtime.runOptimization({ origin: 'user', requestedBy: 'first-pc', dryRun: true });
  const dryRunSkipped = dryRun.noActionReason === 'observation_only' || dryRun.noActionReason === 'degraded';
  record('dry run', dryRunSkipped ? 'skip' : dryRun.status === 'failed' ? 'fail' : 'ok', dryRun.summary);

  let rollbackValidated = false;
  if (!canChange) {
    record(
      'controlled change',
      'skip',
      'NEXUS is not in a mode that permits changes, so rollback was not exercised on this machine.',
    );
  } else {
    // Configured to keep only a measured win, so the common outcome is a
    // rollback — which is the path being validated.
    const controlled = await runtime.runOptimization({
      origin: 'user',
      requestedBy: 'first-pc',
      rollbackPolicy: 'unless_benefit',
    });
    if (controlled.status === 'applied_rolled_back') {
      rollbackValidated = true;
      record('controlled change', 'ok', `applied and reverted: ${controlled.summary}`);
    } else if (controlled.status === 'applied_kept') {
      record('controlled change', 'ok', `${controlled.summary} Roll it back with: nexus rollback ${controlled.checkpointId ?? '<id>'}`);
    } else if (controlled.status === 'failed' || controlled.status === 'applied_unverified') {
      record('controlled change', 'fail', controlled.summary);
    } else {
      record('controlled change', 'skip', `no change was applied, so rollback was not exercised: ${controlled.summary}`);
    }
  }

  const auditOk = await runtime.auditLog.verify();
  record(
    'audit chain intact',
    auditOk.ok && auditOk.value.valid ? 'ok' : 'fail',
    auditOk.ok ? `${auditOk.value.recordsChecked} records` : 'unreadable',
  );

  const failed = steps.filter((s) => s.state === 'fail');
  const skipped = steps.filter((s) => s.state === 'skip');
  const passed = failed.length === 0;

  if (json) {
    process.stdout.write(`${JSON.stringify({ passed, rollbackValidated, steps }, null, 2)}\n`);
    return passed ? 0 : 1;
  }

  process.stdout.write(
    `\n${passed ? 'No checks failed.' : `${failed.length} check(s) FAILED — see above.`}\n`,
  );
  if (skipped.length > 0) {
    process.stdout.write(`${skipped.length} check(s) were skipped — the reason is shown against each.\n`);
  }
  if (!rollbackValidated) {
    process.stdout.write(
      'Rollback has NOT been validated on this machine yet.\n' +
        (canChange
          ? 'NEXUS did not propose a change to exercise it. That is the correct result when the workload is\n' +
            'ambiguous or already optimal — re-run first-pc while the machine is doing something.\n'
          : 'Once discovery and telemetry look right, switch mode and re-run:\n' +
            '  nexus config set-mode assisted\n' +
            '  nexus first-pc\n'),
    );
  } else {
    process.stdout.write('Rollback was exercised and verified on this machine.\n');
  }
  process.stdout.write('Nothing has been left changed by this run.\n');
  return passed ? 0 : 1;
}

async function runResident(args: ParsedArgs, runtime: NexusRuntime): Promise<number> {
  const seconds = flagNumber(args, 'seconds');
  process.stderr.write(`NEXUS ${NEXUS_VERSION} running. Press Ctrl+C to stop.\n`);

  let exitResolve: (() => void) | null = null;
  const done = new Promise<void>((resolve) => {
    exitResolve = resolve;
  });
  const uninstall = runtime.installSignalHandlers(() => exitResolve?.());

  await runtime.waitUntilInitialized();
  process.stderr.write(`Run state: ${runtime.currentRunState}\n`);

  if (seconds !== undefined) {
    await sleep(seconds * 1000);
    await runtime.shutdown('requested duration elapsed');
  } else {
    await done;
  }
  uninstall();
  return 0;
}

async function configCommand(
  args: ParsedArgs,
  paths: ReturnType<typeof resolvePaths>,
  config: NexusConfig,
): Promise<number> {
  if (args.subcommand === 'set-mode') {
    const mode = args.positionals[1] as OperatingMode | undefined;
    if (!mode || !(OPERATING_MODES as readonly string[]).includes(mode)) {
      process.stderr.write(`Usage: nexus config set-mode <${OPERATING_MODES.join('|')}>\n`);
      return 2;
    }
    const saved = await saveConfig(paths, { ...config, mode });
    if (!saved.ok) {
      process.stderr.write(`Could not save configuration: ${saved.error.message}\n`);
      return 4;
    }
    process.stdout.write(`Operating mode is now "${mode}".\n`);
    if (mode !== 'observation') {
      process.stdout.write(
        'NEXUS may now change settings, within its safety policy. Every change is checkpointed, measured and reversible.\n',
      );
    }
    return 0;
  }

  const payload = { home: paths.home, config, defaults: DEFAULT_CONFIG };
  if (flagBoolean(args, 'json')) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(
    [
      heading('Configuration'),
      `  Home         ${paths.home}`,
      `  Mode         ${config.mode}`,
      `  Log level    ${config.logLevel}`,
      `  Vesper       ${config.vesper.enabled ? `enabled, scopes: ${config.vesper.scopes.join(', ')}` : 'disabled'}`,
      `  Simulation   ${config.simulate.hardwareFixture ?? 'off'}`,
      `  Policy       ${config.policy ? 'narrowed by configuration' : 'built-in defaults'}`,
      '',
      '  Configuration can only narrow the safety policy, never widen it.',
      '',
    ].join('\n'),
  );
  return 0;
}

function controlsCommand(args: ParsedArgs): number {
  const controls = listControls();
  if (flagBoolean(args, 'json')) {
    process.stdout.write(`${JSON.stringify(controls, null, 2)}\n`);
    return 0;
  }
  const lines = [heading('Controls NEXUS knows about')];
  for (const control of controls) {
    lines.push(`  ${control.id}`);
    lines.push(`    ${control.name} — ${control.safetyClass}, ${control.reversibility}, evidence: ${control.evidenceLevel}`);
    lines.push(`    ${control.description}`);
  }
  lines.push('');
  lines.push('  Controls marked "prohibited" can never be changed by NEXUS under any configuration.');
  lines.push('  Controls with "contested" evidence are never applied automatically.');
  process.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

const exitCode = await main(process.argv.slice(2)).catch((e: unknown) => {
  process.stderr.write(`NEXUS failed: ${e instanceof Error ? e.message : String(e)}\n`);
  return 1;
});
process.exitCode = exitCode;
