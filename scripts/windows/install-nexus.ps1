<#
.SYNOPSIS
    Registers NEXUS to start with Windows for the current user.

.DESCRIPTION
    NEXUS runs as a per-user background process started by Task Scheduler at
    logon. It is deliberately NOT a Windows service:

      * A service runs in session 0 and cannot show UI, so a tray or any
        user-facing surface would need a second process anyway.
      * NEXUS's work is per-user and per-session. Nothing it does needs to
        happen before someone logs in.
      * A logon task can be registered by a standard user for their own
        account, with no elevation at all. A service always needs an
        administrator to install.

    Least privilege is the default here: the task is registered at the normal
    integrity level. NEXUS will then report any control that needs elevation as
    unavailable, rather than silently failing to apply it.

    Pass -Elevated to register the task with highest privileges, which lets
    NEXUS write power-scheme settings. That switch requires running this script
    as an administrator, and it is a real increase in what NEXUS can do to the
    machine — read docs/startup.md before using it.

.PARAMETER Elevated
    Register the task to run with highest privileges. Requires administrator.

.PARAMETER TaskName
    Name of the scheduled task. Defaults to "NEXUS".

.PARAMETER NodePath
    Path to node.exe. Defaults to whatever is on PATH.

.PARAMETER Delay
    Delay after logon before NEXUS starts. Defaults to 30 seconds so NEXUS does
    not compete with everything else starting at logon.

.EXAMPLE
    .\install-nexus.ps1
    Registers NEXUS at normal privilege for the current user.

.NOTES
    STATUS: not yet executed on a Windows host from this repository. Validate
    on the target machine before relying on it. See docs/first-pc-init.md.
#>
[CmdletBinding()]
param(
    [switch]$Elevated,
    [string]$TaskName = 'NEXUS',
    [string]$NodePath = '',
    [int]$Delay = 30
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$entryPoint = Join-Path $repoRoot 'dist\cli\main.js'

if (-not (Test-Path $entryPoint)) {
    throw "NEXUS is not built. Run 'npm run build' in $repoRoot first (expected $entryPoint)."
}

if ([string]::IsNullOrWhiteSpace($NodePath)) {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if ($null -eq $node) {
        throw 'node.exe was not found on PATH. Install Node.js 20.11 or later, or pass -NodePath.'
    }
    $NodePath = $node.Source
}

if ($Elevated) {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Registering an elevated task requires running this script as an administrator.'
    }
}

$action = New-ScheduledTaskAction -Execute $NodePath -Argument "`"$entryPoint`" run" -WorkingDirectory $repoRoot

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$trigger.Delay = "PT$($Delay)S"

# Never wake the machine, never run on battery restrictions, and let NEXUS run
# indefinitely: it is a resident process, not a job with an end.
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -DontStopOnIdleEnd `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 5) `
    -StartWhenAvailable

$runLevel = if ($Elevated) { 'Highest' } else { 'Limited' }
$principalObject = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel $runLevel

$description = @"
NEXUS PC performance and hardware specialist. Starts at logon, observes the
machine, and applies optimizations only within its built-in safety policy.
Registered by install-nexus.ps1 at $runLevel privilege.
"@

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principalObject `
    -Description $description `
    -Force | Out-Null

Write-Host "Registered scheduled task '$TaskName'."
Write-Host "  Runs:       $NodePath `"$entryPoint`" run"
Write-Host "  Privilege:  $runLevel"
Write-Host "  Trigger:    at logon for $env:USERNAME, after ${Delay}s"
Write-Host ''
Write-Host 'NEXUS starts in observation mode: it measures and reports, and changes nothing.'
Write-Host 'Run "node dist\cli\main.js first-pc" to validate this machine before enabling changes.'
Write-Host 'Remove with uninstall-nexus.ps1.'

if (-not $Elevated) {
    Write-Host ''
    Write-Host 'Note: at normal privilege, power-scheme settings that require elevation will be'
    Write-Host 'reported as unavailable capabilities rather than silently failing.'
}
