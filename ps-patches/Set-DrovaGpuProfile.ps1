#Requires -Version 5.1
[CmdletBinding()]
param([Parameter(Mandatory)][ValidateSet('Boot','Session')][string]$Mode)

$ErrorActionPreference = 'Stop'
$log = Join-Path $PSScriptRoot 'gpu.log'
$marker = Join-Path $PSScriptRoot 'session-boot.txt'

# Serialize the two tasks so a late boot action cannot overwrite the session profile.
$mutex = [Threading.Mutex]::new($false, 'Global\DrovaMiningGpuProfile')
try {
    try { $locked = $mutex.WaitOne(90000) }
    catch [Threading.AbandonedMutexException] { $locked = $true }
    if (-not $locked) { throw 'Timed out waiting for the other GPU task.' }
    if ($Mode -eq 'Session') {
        $miner = Get-ScheduledTask -TaskPath '\Drova\' -TaskName Miner -ErrorAction SilentlyContinue
        if ($miner) { Stop-ScheduledTask -InputObject $miner }
    }
    $bootId = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().Ticks.ToString()
    if ($Mode -eq 'Session') {
        Set-Content -LiteralPath $marker -Value $bootId
    } elseif ((Test-Path -LiteralPath $marker) -and (Get-Content -LiteralPath $marker) -eq $bootId) {
        return
    }

    $smi = Join-Path $env:SystemRoot 'System32\nvidia-smi.exe'
    if (-not (Test-Path -LiteralPath $smi)) {
        $smi = Join-Path $env:ProgramFiles 'NVIDIA Corporation\NVSMI\nvidia-smi.exe'
    }
    $rows = & $smi --query-gpu=uuid,power.default_limit,power.min_limit --format=csv,noheader,nounits
    if ($LASTEXITCODE -ne 0 -or -not $rows) { throw 'Could not query NVIDIA power limits.' }
    $failed = $false
    foreach ($gpu in ($rows | ConvertFrom-Csv -Header UUID,DefaultWatts,MinimumWatts)) {
        try {
            $watts = [double]::Parse($gpu.DefaultWatts, [cultureinfo]::InvariantCulture)
            if ($Mode -eq 'Boot') {
                $minimum = [double]::Parse($gpu.MinimumWatts, [cultureinfo]::InvariantCulture)
                $watts = [Math]::Max($minimum, [Math]::Round($watts * 0.8))
            }
            $target = $watts.ToString([cultureinfo]::InvariantCulture)
            $id = $gpu.UUID.Trim()
            $output = & $smi -i $id -pl $target
            if ($LASTEXITCODE -ne 0) { throw "Setting PL failed: $output" }
            $actual = & $smi -i $id --query-gpu=power.limit --format=csv,noheader,nounits
            if ($LASTEXITCODE -ne 0 -or [Math]::Abs([double]::Parse($actual, [cultureinfo]::InvariantCulture) - $watts) -gt 0.01) {
                throw "Requested $target W, reported $actual W."
            }
            Add-Content -LiteralPath $log -Value "$(Get-Date -Format s) $Mode $id $target W"
        } catch {
            $failed = $true
            Add-Content -LiteralPath $log -Value "$(Get-Date -Format s) $Mode $($gpu.UUID) ERROR $_"
        }
    }
    if ($failed) { throw 'Some GPU limits could not be applied.' }
} catch {
    Add-Content -LiteralPath $log -Value "$(Get-Date -Format s) $Mode ERROR $_"
    throw
} finally {
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
