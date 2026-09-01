/** Version of the NEXUS runtime. Reported in health and audit records. */
export const NEXUS_VERSION = '0.1.0';

/**
 * Version of the Vesper integration contract. Independent of NEXUS_VERSION so
 * the two can evolve separately; Vesper negotiates on this value.
 */
export const VESPER_CONTRACT_VERSION = '1.0.0';
