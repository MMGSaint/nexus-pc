import assert from 'node:assert/strict';
import test from 'node:test';
import { LibreHardwareMonitorSource, validateLhmPayload } from '../../../src/telemetry/sources/libre-hardware-monitor.js';
import { validateReading } from '../../../src/telemetry/validation.js';

const payload = { Text: 'Computer', Type: 'Root', Children: [
  { Text: 'AMD Ryzen', Type: 'Hardware', Children: [{ Text: 'CPU Package', Type: 'Temperature', Value: '64.5 °C', SensorId: '/0/temperature/0' }] },
  { Text: 'Radeon Graphics', Type: 'Hardware', Children: [{ Text: 'GPU Core', Type: 'Temperature', Value: '71.0 °C', SensorId: '/1/temperature/0' }, { Text: 'Hot Spot', Type: 'Temperature', Value: '86.0 °C', SensorId: '/1/temperature/1' }, { Text: 'Memory Used', Type: 'Data', Value: '8.2 GB', SensorId: '/1/data/0' }] },
] };

test('LHM payload validation rejects malformed trees', () => {
  assert.equal(validateLhmPayload(payload), true);
  assert.equal(validateLhmPayload({ Text: 'bad', Children: 'not-array' }), false);
  assert.equal(validateLhmPayload(null), false);
});

test('LHM source stays on loopback and parses sensor values', async () => {
  const source = new LibreHardwareMonitorSource({ url: 'http://127.0.0.1:8085', fetchImpl: async () => new Response(JSON.stringify(payload), { status: 200 }), logger: {} as never });
  const readings = await source.sample({ clock: { now: () => 1000 } as never, logger: {} as never, timeoutMs: 1000 });
  assert.equal(readings.find((r) => r.metric === 'cpu.temperature')?.value, 64.5);
  assert.equal(readings.find((r) => r.metric === 'gpu.hotspot')?.value, 86);
  assert.equal(readings.find((r) => r.metric === 'gpu.vram.used')?.value, 8.2 * 1024 ** 3);
});

test('LHM parser handles both decimal-comma and thousands-grouped values', async () => {
  const localized = {
    Text: 'Radeon Graphics',
    Type: 'Hardware',
    Children: [{ Text: 'Memory Used', Type: 'Data', Value: '1,234.5 MB', SensorId: '/1/data/0' }],
  };
  const source = new LibreHardwareMonitorSource({
    url: 'http://127.0.0.1:8085',
    fetchImpl: async () => new Response(JSON.stringify(localized), { status: 200 }),
    logger: {} as never,
  });
  const readings = await source.sample({ clock: { now: () => 1000 } as never, logger: {} as never, timeoutMs: 1000 });
  assert.equal(readings.find((r) => r.metric === 'gpu.vram.used')?.value, 1234.5 * 1024 ** 2);
});

test('LHM endpoint rejects non-loopback before network access', async () => {
  let calls = 0;
  const source = new LibreHardwareMonitorSource({ url: 'http://example.com:8085', fetchImpl: async () => { calls += 1; return new Response('{}'); }, logger: {} as never });
  const readings = await source.sample({ clock: { now: () => 1000 } as never, logger: {} as never, timeoutMs: 1000 });
  assert.equal(calls, 0);
  assert.ok(readings.every((r) => r.status === 'unsupported'));
});

test('range validation demotes impossible LHM readings', () => {
  const result = validateReading({ metric: 'gpu.temperature', value: 500, unit: 'celsius', timestampMs: 1000, source: 'lhm', fidelity: 'live', status: 'ok', confidence: 1 }, 1000);
  assert.equal(result.rejected, true);
  assert.equal(result.reading.status, 'invalid');
  assert.equal(result.reading.value, null);
});

test('freshness validation demotes delayed sensor evidence', () => {
  const result = validateReading({ metric: 'gpu.temperature', value: 70, unit: 'celsius', timestampMs: 0, source: 'lhm', fidelity: 'live', status: 'ok', confidence: 1 }, 20_000);
  assert.equal(result.rejected, true);
  assert.equal(result.reading.status, 'stale');
  assert.equal(result.reading.value, null);
});