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
import { ensureDir, readJson, removeFile, writeJson } from '../core/fsx.js';
import { err, ok } from '../core/result.js';
import type { NexusPaths } from '../core/paths.js';
import { vBoolean, vObject, vString } from '../core/validate.js';

const GUID = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/;
const workspaceSchema = vObject({
  originalGuid: vString({ maxLength: 64 }),
  sandboxGuid: vString({ maxLength: 64 }),
  active: vBoolean(),
  mode: vString({ maxLength: 32 }),
});

export interface PowerPlanWorkspace {
  readonly originalGuid: string;
  readonly sandboxGuid: string;
  readonly active: boolean;
  readonly mode: 'transaction' | 'kept';
}

export class WindowsPowerPlanSandbox {
  private readonly statePath: string | null;

  constructor(
    private readonly runner: CommandRunner,
    private readonly timeoutMs = 15_000,
    paths?: NexusPaths,
  ) {
    this.statePath = paths ? path.join(paths.state, 'power-plan-sandbox.json') : null;
  }

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

    const workspace: PowerPlanWorkspace = { originalGuid: original.toLowerCase(), sandboxGuid: sandbox.toLowerCase(), active: true, mode: 'transaction' };
    const persisted = await this.persist(workspace);
    if (!persisted.ok) {
      await this.restoreAndDelete(workspace.originalGuid, workspace.sandboxGuid);
      return err(persisted.error);
    }
    return ok(workspace);
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
    await this.clearPersisted();
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
    const persisted = await this.persist({ ...workspace, mode: 'kept' });
    if (!persisted.ok) return persisted;
    return ok(true);
  }

  async recoverOrphaned(): Promise<Result<'none' | 'restored', NexusError>> {
    if (!this.statePath) return ok('none');
    const loaded = await readJson(this.statePath, workspaceSchema);
    if (!loaded.ok) {
      if (loaded.error.code === 'E_UNAVAILABLE') return ok('none');
      return err(loaded.error);
    }
    const workspace = loaded.value as unknown as PowerPlanWorkspace;
    if (workspace.mode === 'kept') return ok('none');
    if (!workspace.active) { await this.clearPersisted(); return ok('none'); }
    const restored = await this.restoreAndDeleteResult(workspace.originalGuid, workspace.sandboxGuid);
    if (!restored.ok) return restored;
    await this.clearPersisted();
    return ok('restored');
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

  private async persist(workspace: PowerPlanWorkspace): Promise<Result<true, NexusError>> {
    if (!this.statePath) return ok(true);
    const ready = await ensureDir(path.dirname(this.statePath));
    if (!ready.ok) return ready;
    return writeJson(this.statePath, workspace, { fsyncData: true });
  }

  private async clearPersisted(): Promise<void> {
    if (this.statePath) await removeFile(this.statePath);
  }

  private async restoreAndDeleteResult(original: string, sandbox: string): Promise<Result<true, NexusError>> {
    const restored = await this.runner.run({ file: 'powercfg.exe', args: ['/setactive', original], timeoutMs: this.timeoutMs });
    if (!restored.ok) return restored;
    if (restored.value.code !== 0) return err(nexusError('E_IO', `powercfg could not restore the original scheme: ${restored.value.stderr.trim() || `exit ${restored.value.code}`}`));
    const verified = await this.runner.run({ file: 'powercfg.exe', args: ['/getactivescheme'], timeoutMs: this.timeoutMs });
    if (!verified.ok) return err(verified.error);
    const observed = GUID.exec(verified.value.stdout)?.[0]?.toLowerCase();
    if (observed !== original.toLowerCase()) return err(nexusError('E_VERIFY_FAILED', 'powercfg did not verify orphaned-sandbox recovery')); 
    const deleted = await this.delete(sandbox);
    if (!deleted.ok) return deleted;
    return ok(true);
  }

  private async restoreAndDelete(original: string, sandbox: string): Promise<void> {
    await this.restoreAndDeleteResult(original, sandbox);
  }
}
