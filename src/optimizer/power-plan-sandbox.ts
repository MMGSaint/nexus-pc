/**
 * Power-plan transaction workspace.
 *
 * Windows supports duplicating a scheme and activating the clone. NEXUS can
 * therefore experiment on an isolated copy instead of rewriting the user's
 * long-lived plan in place. The workspace owns only lifecycle; the normal
 * power adapters still perform individual setting reads/writes and the normal
 * checkpoint/rollback machinery remains authoritative.
 *
 * Source: Microsoft powercfg documentation (/duplicatescheme, /setactive, /delete).
 */

import type { CommandRunner } from '../core/exec.js';
import { nexusError, type NexusError } from '../core/errors.js';
import type { Result } from '../core/result.js';
import { err, ok } from '../core/result.js';

const GUID = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/;

export interface PowerPlanWorkspace {
  readonly originalGuid: string;
  readonly sandboxGuid: string;
  readonly active: boolean;
}

export class WindowsPowerPlanSandbox {
  constructor(private readonly runner: CommandRunner, private readonly timeoutMs = 15_000) {}

  async prepare(): Promise<Result<PowerPlanWorkspace, NexusError>> {
    const active = await this.runner.run({
      file: 'powercfg.exe',
      args: ['/getactivescheme'],
      timeoutMs: this.timeoutMs,
    });
    if (!active.ok) return err(active.error);
    const original = GUID.exec(active.value.stdout)?.[0];
    if (!original) return err(nexusError('E_UNAVAILABLE', 'powercfg did not report a usable active scheme GUID'));

    const duplicate = await this.runner.run({
      file: 'powercfg.exe',
      args: ['/duplicatescheme', original],
      timeoutMs: this.timeoutMs,
    });
    if (!duplicate.ok) return err(duplicate.error);
    if (duplicate.value.code !== 0) {
      return err(nexusError('E_IO', `powercfg could not duplicate the active scheme: ${duplicate.value.stderr.trim() || `exit ${duplicate.value.code}`}`));
    }

    const sandbox = GUID.exec(duplicate.value.stdout)?.[0];
    if (!sandbox) {
      return err(nexusError('E_IO', 'powercfg duplicated a scheme but did not return the new GUID'));
    }

    const activated = await this.runner.run({
      file: 'powercfg.exe',
      args: ['/setactive', sandbox],
      timeoutMs: this.timeoutMs,
    });
    if (!activated.ok) return err(activated.error);
    if (activated.value.code !== 0) {
      await this.delete(sandbox);
      return err(nexusError('E_IO', `powercfg could not activate the sandbox scheme: ${activated.value.stderr.trim() || `exit ${activated.value.code}`}`));
    }

    const verified = await this.runner.run({
      file: 'powercfg.exe',
      args: ['/getactivescheme'],
      timeoutMs: this.timeoutMs,
    });
    if (!verified.ok) return err(verified.error);
    const observed = GUID.exec(verified.value.stdout)?.[0]?.toLowerCase();
    if (observed !== sandbox.toLowerCase()) {
      await this.restoreAndDelete(original, sandbox);
      return err(nexusError('E_VERIFY_FAILED', 'powercfg did not verify the sandbox scheme became active'));
    }

    return ok({ originalGuid: original.toLowerCase(), sandboxGuid: sandbox.toLowerCase(), active: true });
  }

  async restore(workspace: PowerPlanWorkspace): Promise<Result<true, NexusError>> {
    const activated = await this.runner.run({
      file: 'powercfg.exe',
      args: ['/setactive', workspace.originalGuid],
      timeoutMs: this.timeoutMs,
    });
    if (!activated.ok) return err(activated.error);
    if (activated.value.code !== 0) {
      return err(nexusError('E_IO', `powercfg could not restore the original scheme: ${activated.value.stderr.trim() || `exit ${activated.value.code}`}`));
    }

    const verified = await this.runner.run({
      file: 'powercfg.exe',
      args: ['/getactivescheme'],
      timeoutMs: this.timeoutMs,
    });
    if (!verified.ok) return err(verified.error);
    const observed = GUID.exec(verified.value.stdout)?.[0]?.toLowerCase();
    if (observed !== workspace.originalGuid.toLowerCase()) {
      return err(nexusError('E_VERIFY_FAILED', 'powercfg did not verify restoration of the original scheme'));
    }

    const deleted = await this.delete(workspace.sandboxGuid);
    if (!deleted.ok) return deleted;
    return ok(true);
  }

  async keep(workspace: PowerPlanWorkspace, name?: string): Promise<Result<true, NexusError>> {
    // Optional rename gives the user a durable, human-readable plan while keeping
    // the original intact. The sandbox remains active.
    if (name && !/^[A-Za-z0-9 ._-]{1,64}$/.test(name)) {
      return err(nexusError('E_INVALID_INPUT', 'power plan name contains unsupported characters'));
    }
    if (name) {
      const renamed = await this.runner.run({
        file: 'powercfg.exe',
        args: ['/changename', workspace.sandboxGuid, name, 'NEXUS measured plan'],
        timeoutMs: this.timeoutMs,
      });
      if (!renamed.ok) return err(renamed.error);
      if (renamed.value.code !== 0) {
        return err(nexusError('E_IO', `powercfg could not name the kept plan: ${renamed.value.stderr.trim() || `exit ${renamed.value.code}`}`));
      }
    }
    return ok(true);
  }

  async delete(guid: string): Promise<Result<true, NexusError>> {
    if (!GUID.test(guid)) return err(nexusError('E_INVALID_INPUT', 'invalid power scheme GUID'));
    const result = await this.runner.run({
      file: 'powercfg.exe',
      args: ['/delete', guid],
      timeoutMs: this.timeoutMs,
    });
    if (!result.ok) return err(result.error);
    if (result.value.code !== 0) {
      return err(nexusError('E_IO', `powercfg could not delete the sandbox scheme: ${result.value.stderr.trim() || `exit ${result.value.code}`}`));
    }
    return ok(true);
  }

  private async restoreAndDelete(original: string, sandbox: string): Promise<void> {
    await this.runner.run({ file: 'powercfg.exe', args: ['/setactive', original], timeoutMs: this.timeoutMs });
    await this.delete(sandbox);
  }
}
