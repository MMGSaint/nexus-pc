/**
 * Human-readable output helpers.
 *
 * Every command also supports `--json`; this module is only for the text form.
 * The formatting deliberately shows unknowns as "unknown" rather than as a
 * dash or a zero, so the terminal output carries the same honesty as the data.
 */

import type { CapabilityRecord } from '../domain/capability.js';
import type { HealthReport } from '../domain/health.js';
import type { HardwareInventory } from '../domain/hardware.js';
import type { TelemetrySummary } from '../domain/telemetry.js';
import type { OptimizationOutcome } from '../domain/optimization.js';

export function heading(text: string): string {
  return `\n${text}\n${'-'.repeat(text.length)}`;
}

export function bytes(value: number | null): string {
  if (value === null) return 'unknown';
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GiB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MiB`;
  return `${value} B`;
}

export function num(value: number | null, unit = '', digits = 1): string {
  return value === null ? 'unknown' : `${value.toFixed(digits)}${unit}`;
}

export function text(value: string | null | undefined): string {
  return value === null || value === undefined || value === '' ? 'unknown' : value;
}

export function formatInventory(inventory: HardwareInventory): string {
  const gpu = inventory.gpus[0];
  const lines = [
    heading('Hardware'),
    `  Provider     ${inventory.provider} (${inventory.fidelity})`,
    `  CPU          ${text(inventory.cpu.model)}`,
    `               ${text(inventory.cpu.physicalCores?.toString())} cores / ${text(inventory.cpu.logicalProcessors?.toString())} threads, socket ${text(inventory.cpu.socket)}`,
    `  GPU          ${text(gpu?.model)}`,
    `               ${bytes(gpu?.vramBytes ?? null)} dedicated memory (source: ${text(gpu?.vramSource)})`,
    `               driver ${text(gpu?.driverVersion)}`,
    `  Memory       ${bytes(inventory.memory.installedBytes)} installed, ${bytes(inventory.memory.totalBytes)} usable, ${bytes(inventory.memory.availableBytes)} available`,
    `               ${text(inventory.memory.memoryType)} at ${text(inventory.memory.configuredSpeedMhz?.toString())} MT/s (rated ${text(inventory.memory.ratedSpeedMhz?.toString())})`,
    `  OS           ${text(inventory.os.name)} ${text(inventory.os.version)} (${text(inventory.os.architecture)})`,
    `  Power scheme ${text(inventory.power.activeSchemeName)}`,
  ];
  if (inventory.storage.length > 0) {
    lines.push('  Storage');
    for (const disk of inventory.storage) {
      lines.push(`    - ${text(disk.model)} ${bytes(disk.sizeBytes)} ${text(disk.busType)}/${text(disk.mediaType)}`);
    }
  }
  if (inventory.warnings.length > 0) {
    lines.push('  Notes');
    for (const warning of inventory.warnings) lines.push(`    ! ${warning}`);
  }
  return lines.join('\n');
}

export function formatCapabilities(records: readonly CapabilityRecord[]): string {
  const lines = [heading('Capabilities')];
  const order = ['available', 'mocked', 'unverified', 'unavailable', 'unsupported'];
  for (const state of order) {
    const matching = records.filter((r) => r.state === state);
    if (matching.length === 0) continue;
    lines.push(`  ${state.toUpperCase()} (${matching.length})`);
    for (const record of matching) {
      lines.push(`    ${record.id.padEnd(32)} ${record.detail}`);
    }
  }
  return lines.join('\n');
}

export function formatHealth(health: HealthReport): string {
  const lines = [
    heading('NEXUS health'),
    `  Version           ${health.nexusVersion}`,
    `  Session           ${health.sessionId} (pid ${health.pid})`,
    `  Run state         ${health.runState.toUpperCase()}`,
    `  Uptime            ${(health.uptimeMs / 1000).toFixed(0)}s`,
    `  Hardware detected ${health.hardwareDetected ? `yes (${health.hardwareFidelity})` : 'no'}`,
    `  Telemetry working ${health.telemetryWorking ? `yes (${health.telemetryFidelity})` : 'no'}`,
    `  Capabilities      ${health.capabilities.byState.available} available, ${health.capabilities.byState.mocked} mocked, ${health.capabilities.byState.unavailable} unavailable, ${health.capabilities.byState.unsupported} unsupported, ${health.capabilities.byState.unverified} unverified`,
    `  Active profile    ${health.activeProfileId ?? 'none'}`,
    `  Optimization      ${health.optimizationEnabled ? 'enabled' : `disabled — ${health.optimizationDisabledReason ?? 'unknown reason'}`}`,
    `  Previous shutdown ${health.previousShutdown}`,
    `  Recovery required ${health.recoveryRequired ? 'yes' : 'no'}`,
    `  Vesper interface  ${health.vesperInterface.enabled ? (health.vesperInterface.listening ? `listening on ${health.vesperInterface.endpoint}` : 'enabled but not listening') : 'disabled'}`,
    `  Self footprint    ${bytes(health.selfFootprint.rssBytes)} RSS, ${num(health.selfFootprint.cpuPercent, '% of one core')}, sampling ${health.selfFootprint.samplingMode} every ${health.selfFootprint.telemetryIntervalMs}ms`,
  ];

  if (health.recoverySummary) lines.push(`  Recovery          ${health.recoverySummary}`);
  if (health.degraded) {
    lines.push('  Degraded because:');
    for (const reason of health.degradedReasons) lines.push(`    ! ${reason}`);
  }

  lines.push(heading('Startup stages'));
  for (const stage of health.stages) {
    const detail = stage.detail ? ` — ${stage.detail}` : '';
    lines.push(`  ${stage.stage.padEnd(14)} ${stage.status.padEnd(9)}${detail}`);
  }
  return lines.join('\n');
}

export function formatTelemetry(summary: TelemetrySummary): string {
  const lines = [heading(`Telemetry (${summary.sampleCount} samples, ${summary.fidelity})`)];
  if (summary.metrics.length === 0) {
    lines.push('  No metrics were collected.');
    return lines.join('\n');
  }
  for (const metric of summary.metrics) {
    if (metric.samples === 0) {
      lines.push(`  ${metric.metric.padEnd(22)} unknown (no usable samples)`);
      continue;
    }
    const scale = metric.unit === 'byte' ? bytes : (v: number | null) => num(v, ` ${metric.unit}`);
    lines.push(
      `  ${metric.metric.padEnd(22)} mean ${scale(metric.mean)}  min ${scale(metric.min)}  max ${scale(metric.max)}  coverage ${(metric.coverage * 100).toFixed(0)}%`,
    );
  }
  return lines.join('\n');
}

export function formatOutcome(outcome: OptimizationOutcome): string {
  const lines = [
    heading('Optimization result'),
    `  Id          ${outcome.id}`,
    `  Status      ${outcome.status.toUpperCase()}`,
    `  Fidelity    ${outcome.fidelity}`,
    `  Workload    ${outcome.workload}`,
    `  Summary     ${outcome.summary}`,
  ];
  if (outcome.noActionReason) lines.push(`  Reason      ${outcome.noActionReason}`);
  if (outcome.checkpointId) lines.push(`  Checkpoint  ${outcome.checkpointId}`);

  if (outcome.appliedChanges.length > 0) {
    lines.push('  Changes');
    for (const change of outcome.appliedChanges) {
      lines.push(
        `    ${change.control}: ${JSON.stringify(change.previousValue)} -> ${JSON.stringify(change.appliedValue)}${change.verified ? '' : ' (NOT VERIFIED)'}`,
      );
    }
  }
  const blocking = outcome.findings.filter((f) => f.severity === 'blocking');
  if (blocking.length > 0) {
    lines.push('  Blocked by');
    for (const finding of blocking) lines.push(`    [${finding.code}] ${finding.message}`);
  }
  const significant = outcome.measurements.filter((m) => m.significant);
  if (significant.length > 0) {
    lines.push('  Measured');
    for (const m of significant) {
      lines.push(`    ${m.metric}: ${num(m.before)} -> ${num(m.after)} (${m.delta === null ? 'unknown' : m.delta > 0 ? `+${m.delta.toFixed(1)}` : m.delta.toFixed(1)} ${m.unit})`);
    }
  }
  return lines.join('\n');
}
