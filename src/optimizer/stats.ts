/** Shared statistical primitives for optimizer decisions.
 * The canonical implementation lives with the frame-performance domain so
 * PresentMon and optimizer A/B decisions use exactly the same math.
 */
export { bootstrapInterval, mean, statisticallyCredibleImprovement } from '../performance/stats.js';
export type { BootstrapInterval } from '../performance/stats.js';
