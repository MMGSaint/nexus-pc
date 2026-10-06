$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$project = Join-Path $root "native-windows-helper\Nexus.NativeHelper.csproj"
$destination = Join-Path $root "..\dist\native-windows-helper"

if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) {
  throw "dotnet SDK is required to build the NEXUS native Windows helper."
}

dotnet publish $project -c Release -o $destination
Write-Host "Published native helper to $destination"
