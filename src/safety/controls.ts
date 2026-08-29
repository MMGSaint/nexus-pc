/**
 * The built-in control registry.
 *
 * This table is the *only* way a control comes into existence. It is frozen at
 * module load, it is not reachable from configuration, and there is no
 * registration function. A request naming anything not in this table is
 * refused as unknown rather than attempted.
 *
 * `prohibited` entries are present on purpose: NEXUS refuses them by name and
 * explains why, which is more useful (and more auditable) than pretending the
 * control does not exist.
 */

import type { ControlDescriptor, ControlId } from '../domain/control.js';

function freezeAll(list: ControlDescriptor[]): readonly ControlDescriptor[] {
  return Object.freeze(list.map((c) => Object.freeze(c)));
}

export const BUILTIN_CONTROLS: readonly ControlDescriptor[] = freezeAll([
  /* ------------------------------------------------------------- power plan */
  {
    id: 'power.scheme.active',
    name: 'Active Windows power scheme',
    description:
      'The GUID of the power scheme Windows is currently using. NEXUS applies its own duplicated scheme rather than editing a scheme the user configured.',
    domain: 'power',
    valueSpec: { kind: 'opaque', note: 'power scheme GUID, restored verbatim from a checkpoint' },
    access: 'read-write',
    safetyClass: 'reversible',
    reversibility: 'reversible',
    applyTiming: 'immediate',
    requiresElevation: false,
    requiresCapabilities: ['power.scheme.read', 'power.scheme.write'],
    evidenceLevel: 'documented',
    autoProposable: true,
  },
  {
    id: 'power.processor.boost_mode',
    name: 'Processor performance boost mode',
    description:
      'How aggressively the processor is permitted to boost above its guaranteed frequency. Directly affects the power and thermal envelope.',
    domain: 'power',
    valueSpec: { kind: 'integer', min: 0, max: 6, unit: 'none' },
    access: 'read-write',
    safetyClass: 'sensitive',
    reversibility: 'reversible',
    applyTiming: 'immediate',
    requiresElevation: true,
    requiresCapabilities: ['power.setting.read', 'power.setting.write'],
    evidenceLevel: 'documented',
    autoProposable: true,
    notes: '0 disabled, 1 enabled, 2 aggressive, 3 efficient enabled, 4 efficient aggressive, 5 aggressive at guaranteed, 6 efficient aggressive at guaranteed.',
  },
  {
    id: 'power.processor.min_state',
    name: 'Minimum processor state',
    description: 'Floor on processor performance state, as a percentage.',
    domain: 'power',
    valueSpec: { kind: 'integer', min: 0, max: 100, unit: 'percent' },
    access: 'read-write',
    safetyClass: 'sensitive',
    reversibility: 'reversible',
    applyTiming: 'immediate',
    requiresElevation: true,
    requiresCapabilities: ['power.setting.read', 'power.setting.write'],
    evidenceLevel: 'documented',
    autoProposable: true,
    notes: 'A high floor keeps clocks up at the cost of idle power and heat.',
  },
  {
    id: 'power.processor.max_state',
    name: 'Maximum processor state',
    description: 'Ceiling on processor performance state, as a percentage.',
    domain: 'power',
    valueSpec: { kind: 'integer', min: 0, max: 100, unit: 'percent' },
    access: 'read-write',
    safetyClass: 'sensitive',
    reversibility: 'reversible',
    applyTiming: 'immediate',
    requiresElevation: true,
    requiresCapabilities: ['power.setting.read', 'power.setting.write'],
    evidenceLevel: 'documented',
    autoProposable: true,
    notes: 'Policy floors this well above zero so a bad value cannot cripple the machine.',
  },
  {
    id: 'power.processor.core_parking_min',
    name: 'Processor core parking minimum cores',
    description: 'Minimum percentage of cores kept unparked.',
    domain: 'power',
    valueSpec: { kind: 'integer', min: 0, max: 100, unit: 'percent' },
    access: 'read-write',
    safetyClass: 'sensitive',
    reversibility: 'reversible',
    applyTiming: 'immediate',
    requiresElevation: true,
    requiresCapabilities: ['power.setting.read', 'power.setting.write'],
    evidenceLevel: 'documented',
    autoProposable: true,
  },
  {
    id: 'power.processor.idle_disable',
    name: 'Processor idle state disable',
    description:
      'Disables processor idle (C) states. Raises idle power and temperature substantially and is rarely a net win outside specialised latency work.',
    domain: 'power',
    valueSpec: { kind: 'integer', min: 0, max: 1, unit: 'none' },
    access: 'read-write',
    safetyClass: 'restricted',
    reversibility: 'reversible',
    applyTiming: 'immediate',
    requiresElevation: true,
    requiresCapabilities: ['power.setting.read', 'power.setting.write'],
    evidenceLevel: 'contested',
    autoProposable: false,
  },
  {
    id: 'power.pcie.aspm',
    name: 'PCI Express link state power management',
    description: 'Active State Power Management for PCIe links.',
    domain: 'power',
    valueSpec: { kind: 'integer', min: 0, max: 2, unit: 'none' },
    access: 'read-write',
    safetyClass: 'sensitive',
    reversibility: 'reversible',
    applyTiming: 'immediate',
    requiresElevation: true,
    requiresCapabilities: ['power.setting.read', 'power.setting.write'],
    evidenceLevel: 'documented',
    autoProposable: true,
  },

  /* ------------------------------------------------------------------- OS */
  {
    id: 'os.gpu.hardware_scheduling',
    name: 'Hardware-accelerated GPU scheduling',
    description:
      'Moves GPU scheduling work to the GPU. Its effect varies by driver, title and configuration, and it only takes effect after a reboot — so NEXUS cannot measure the result or revert it within a session.',
    domain: 'os',
    valueSpec: { kind: 'boolean' },
    access: 'read-write',
    safetyClass: 'restricted',
    reversibility: 'reversible-after-reboot',
    applyTiming: 'requires-reboot',
    requiresElevation: true,
    requiresCapabilities: [],
    evidenceLevel: 'contested',
    autoProposable: false,
  },
  {
    id: 'os.game_mode',
    name: 'Windows Game Mode',
    description: 'Per-user Game Mode setting.',
    domain: 'os',
    valueSpec: { kind: 'boolean' },
    access: 'read-write',
    safetyClass: 'benign',
    reversibility: 'reversible',
    applyTiming: 'immediate',
    requiresElevation: false,
    requiresCapabilities: [],
    evidenceLevel: 'contested',
    autoProposable: false,
  },
  {
    id: 'os.mmcss.system_responsiveness',
    name: 'MMCSS SystemResponsiveness',
    description:
      'Share of CPU reserved for background tasks by the multimedia class scheduler. Widely repeated tuning advice for this value is not supported by measurement.',
    domain: 'os',
    valueSpec: { kind: 'integer', min: 0, max: 100, unit: 'percent' },
    access: 'read-write',
    safetyClass: 'restricted',
    reversibility: 'reversible',
    applyTiming: 'requires-reboot',
    requiresElevation: true,
    requiresCapabilities: [],
    evidenceLevel: 'contested',
    autoProposable: false,
  },
  {
    id: 'os.mmcss.network_throttling_index',
    name: 'MMCSS NetworkThrottlingIndex',
    description:
      'Caps non-multimedia network packet processing while multimedia playback is active. Commonly recommended by tuning guides on weak evidence.',
    domain: 'os',
    valueSpec: { kind: 'integer', min: 1, max: 70, unit: 'none' },
    access: 'read-write',
    safetyClass: 'restricted',
    reversibility: 'reversible',
    applyTiming: 'requires-reboot',
    requiresElevation: true,
    requiresCapabilities: [],
    evidenceLevel: 'contested',
    autoProposable: false,
  },

  /* -------------------------------------------------------------- process */
  {
    id: 'process.priority.foreground',
    name: 'Foreground process priority class',
    description:
      'Scheduling priority of the identified foreground workload process. Realtime is deliberately not representable: it can starve input, audio and storage threads and make the machine unresponsive.',
    domain: 'process',
    valueSpec: {
      kind: 'enum',
      values: [
        { value: 'idle', label: 'Idle' },
        { value: 'below_normal', label: 'Below normal' },
        { value: 'normal', label: 'Normal' },
        { value: 'above_normal', label: 'Above normal' },
        { value: 'high', label: 'High' },
      ],
    },
    access: 'read-write',
    safetyClass: 'reversible',
    reversibility: 'reversible',
    applyTiming: 'immediate',
    requiresElevation: false,
    requiresCapabilities: ['process.enumerate', 'process.priority.write'],
    evidenceLevel: 'plausible',
    autoProposable: false,
    notes: 'Does not persist across process restart, by design.',
  },

  /* ----------------------------------------------------------- prohibited */
  {
    id: 'gpu.tuning.core_clock_offset',
    name: 'GPU core clock offset',
    description:
      'Overclock/underclock offset for the GPU core. NEXUS does not perform silicon-level tuning: a wrong value produces instability or data loss, and validating it requires a stress methodology NEXUS does not own.',
    domain: 'gpu',
    valueSpec: { kind: 'integer', min: -1000, max: 1000, unit: 'megahertz' },
    access: 'read',
    safetyClass: 'prohibited',
    reversibility: 'unknown',
    applyTiming: 'immediate',
    requiresElevation: true,
    requiresCapabilities: ['gpu.tuning.write'],
    evidenceLevel: 'contested',
    autoProposable: false,
  },
  {
    id: 'gpu.tuning.voltage_offset',
    name: 'GPU voltage offset',
    description: 'Voltage offset for the GPU. Prohibited for the same reasons as the clock offset.',
    domain: 'gpu',
    valueSpec: { kind: 'integer', min: -500, max: 500, unit: 'none' },
    access: 'read',
    safetyClass: 'prohibited',
    reversibility: 'unknown',
    applyTiming: 'immediate',
    requiresElevation: true,
    requiresCapabilities: ['gpu.tuning.write'],
    evidenceLevel: 'contested',
    autoProposable: false,
  },
  {
    id: 'cpu.tuning.power_limits',
    name: 'CPU package power limits',
    description:
      'Precision Boost Overdrive style package power, current and thermal limits. Prohibited: these change the silicon operating envelope and validating them safely is outside what NEXUS can measure.',
    domain: 'cpu',
    valueSpec: { kind: 'integer', min: 0, max: 1000, unit: 'watt' },
    access: 'read',
    safetyClass: 'prohibited',
    reversibility: 'unknown',
    applyTiming: 'immediate',
    requiresElevation: true,
    requiresCapabilities: ['cpu.tuning.write'],
    evidenceLevel: 'contested',
    autoProposable: false,
  },
  {
    id: 'fan.curve.custom',
    name: 'Custom fan curve',
    description:
      'Direct fan curve control. Prohibited: an incorrect curve is a thermal hazard, and NEXUS cannot guarantee it can restore the curve if it loses the interface mid-change.',
    domain: 'gpu',
    valueSpec: { kind: 'opaque', note: 'fan curve document' },
    access: 'read',
    safetyClass: 'prohibited',
    reversibility: 'unknown',
    applyTiming: 'immediate',
    requiresElevation: true,
    requiresCapabilities: ['fan.control'],
    evidenceLevel: 'contested',
    autoProposable: false,
  },
  {
    id: 'memory.working_set_trim',
    name: 'Working set trimming',
    description:
      'Forcing processes to release their working sets — the mechanism behind "RAM cleaner" tools. Prohibited: it evicts pages the OS deliberately cached, so the pages are faulted straight back in, costing time and I/O for a cosmetically lower memory figure.',
    domain: 'memory',
    valueSpec: { kind: 'boolean' },
    access: 'read',
    safetyClass: 'prohibited',
    reversibility: 'irreversible',
    applyTiming: 'immediate',
    requiresElevation: false,
    requiresCapabilities: [],
    evidenceLevel: 'contested',
    autoProposable: false,
  },
]);

const BY_ID: ReadonlyMap<ControlId, ControlDescriptor> = new Map(
  BUILTIN_CONTROLS.map((c) => [c.id, c]),
);

export function getControl(id: ControlId): ControlDescriptor | undefined {
  return BY_ID.get(id);
}

export function controlExists(id: ControlId): boolean {
  return BY_ID.has(id);
}

export function listControls(): readonly ControlDescriptor[] {
  return BUILTIN_CONTROLS;
}

export function writableControls(): readonly ControlDescriptor[] {
  return BUILTIN_CONTROLS.filter((c) => c.access === 'read-write' && c.safetyClass !== 'prohibited');
}
