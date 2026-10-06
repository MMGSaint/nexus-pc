$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$project = Join-Path $root "native-windows-helper\Nexus.NativeHelper.csproj"
$destination = Join-Path $root "..\dist\native-windows-helper"

$dotnetCommand = Get-Command dotnet -ErrorAction SilentlyContinue
if (-not $dotnetCommand) {
  throw "dotnet SDK is required to build the NEXUS native Windows helper (target framework: net9.0-windows). Install the .NET 9 SDK first."
}

$sdks = @(& $dotnetCommand.Source --list-sdks 2>$null)
if ($LASTEXITCODE -ne 0 -or $sdks.Count -eq 0) {
  throw "The 'dotnet' command is present but no .NET SDK is installed. Install the .NET 9 SDK first."
}

& $dotnetCommand.Source publish $project -c Release -o $destination
if ($LASTEXITCODE -ne 0) {
  throw "dotnet publish failed with exit code $LASTEXITCODE. No native helper was published."
}

$helper = Join-Path $destination "nexus-native-helper.exe"
if (-not (Test-Path $helper -PathType Leaf)) {
  throw "dotnet publish completed without producing $helper."
}

$sha256 = (Get-FileHash $helper -Algorithm SHA256).Hash.ToLowerInvariant()
Write-Host "Published native helper to $destination"
Write-Host "Native helper SHA-256: $sha256"
