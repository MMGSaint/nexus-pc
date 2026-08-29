<#
.SYNOPSIS
    Removes the NEXUS scheduled task.

.DESCRIPTION
    Unregisters the logon task. This stops NEXUS starting with Windows; it does
    not remove NEXUS's state directory, and it does not revert any setting
    NEXUS changed.

    To put settings back first, run NEXUS's own rollback while it is still
    installed:

        node dist\cli\main.js checkpoints
        node dist\cli\main.js rollback <checkpointId>

    State, baselines, checkpoints and the audit log live under
    %LOCALAPPDATA%\NEXUS and are left in place deliberately — they are the
    evidence of what was changed. Delete that directory yourself if you want
    them gone.

.PARAMETER TaskName
    Name of the scheduled task. Defaults to "NEXUS".

.PARAMETER StopRunning
    Also stop the task if it is currently running.
#>
[CmdletBinding()]
param(
    [string]$TaskName = 'NEXUS',
    [switch]$StopRunning
)

$ErrorActionPreference = 'Stop'

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($null -eq $task) {
    Write-Host "No scheduled task named '$TaskName' is registered. Nothing to do."
    return
}

if ($StopRunning) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
}

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
Write-Host "Removed scheduled task '$TaskName'."
Write-Host ''
Write-Host 'NEXUS state was NOT removed. It is under %LOCALAPPDATA%\NEXUS and contains'
Write-Host 'your baselines, checkpoints and audit log. Delete it manually if you want it gone.'
