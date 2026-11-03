#Requires -Version 5.1
#Requires -RunAsAdministrator
[CmdletBinding(DefaultParameterSetName='Install')]
param(
    [Parameter(Mandatory, ParameterSetName='Install')]
    [string]$MinerPath,
    [Parameter(Mandatory, ParameterSetName='Install')]
    [ValidatePattern('^[^\s"/\\]+$')]
    [string]$KryptexLogin,
    [Parameter(Mandatory, ParameterSetName='Uninstall')]
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$taskPath = '\Drova\'
$directory = Join-Path $env:ProgramFiles 'Drova\Mining'
$scriptPath = Join-Path $directory 'Set-DrovaGpuProfile.ps1'

$exclusionRecord = Join-Path $directory 'defender-exclusion.txt'

function Test-MinerExclusion([string]$Path) {
    foreach ($entry in (Get-MpPreference -ErrorAction Stop).ExclusionPath) {
        if ($entry -and $entry.TrimEnd('\') -eq $Path.TrimEnd('\')) { return $true }
    }
    return $false
}

function Clear-OwnedExclusion {
    if (Test-Path -LiteralPath $exclusionRecord) {
        $previous = Get-Content -LiteralPath $exclusionRecord -Encoding UTF8 -Raw
        if (Test-MinerExclusion $previous) {
            Remove-MpPreference -ExclusionPath $previous -ErrorAction Stop
            if (Test-MinerExclusion $previous) { throw "Defender kept the exclusion: $previous" }
        }
        Remove-Item -LiteralPath $exclusionRecord
    }
}

if ($Uninstall) {
    foreach ($name in 'Miner','PowerLimitBoot','PrepareGpuForSession') {
        $task = Get-ScheduledTask -TaskName $name -TaskPath $taskPath -ErrorAction SilentlyContinue
        if ($task) {
            Stop-ScheduledTask -InputObject $task
            Unregister-ScheduledTask -InputObject $task -Confirm:$false
        }
    }
    foreach ($file in $scriptPath,(Join-Path $directory 'session-boot.txt')) {
        if (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file }
    }
    Clear-OwnedExclusion
    return
}

$miner = Get-Item -LiteralPath $MinerPath
if ($miner.PSIsContainer -or $miner.Name -ine 'SRBMiner-MULTI.exe') {
    throw 'Specify the mounted path to SRBMiner-MULTI.exe.'
}

$minerDirectory = $miner.DirectoryName
if (-not $miner.Directory.Parent -or $minerDirectory -match '[%*?]') {
    throw 'Use a dedicated miner directory without Defender expansion characters.'
}

$scheduler = New-Object -ComObject Schedule.Service
$scheduler.Connect()
$root = $scheduler.GetFolder('\')
if (-not ($root.GetFolders(0) | Where-Object Name -eq 'Drova')) {
    $null = $root.CreateFolder('Drova')
}
New-Item -Path $directory -ItemType Directory -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Set-DrovaGpuProfile.ps1') -Destination $scriptPath -Force

if (Get-Command Get-MpPreference -ErrorAction SilentlyContinue) {
    if ((Test-Path -LiteralPath $exclusionRecord) -and
        (Get-Content -LiteralPath $exclusionRecord -Encoding UTF8 -Raw) -ne $minerDirectory) {
        Clear-OwnedExclusion
    }
    if (-not (Test-MinerExclusion $minerDirectory)) {
        Set-Content -LiteralPath $exclusionRecord -Value $minerDirectory -Encoding UTF8 -NoNewline
        Add-MpPreference -ExclusionPath $minerDirectory -ErrorAction Stop
        if (-not (Test-MinerExclusion $minerDirectory)) {
            throw "Could not verify the Defender exclusion: $minerDirectory"
        }
    }
} else {
    Write-Warning 'Microsoft Defender cmdlets unavailable; skipping the miner directory exclusion.'
}

$system = New-ScheduledTaskPrincipal -UserId 'S-1-5-18' -LogonType ServiceAccount -RunLevel Highest
$localService = New-ScheduledTaskPrincipal -UserId 'S-1-5-19' -LogonType ServiceAccount
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
$powerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$argsPrefix = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}"' -f $scriptPath
$boot = New-ScheduledTaskAction -Execute $powerShell -Argument "$argsPrefix -Mode Boot" -WorkingDirectory $directory
$session = New-ScheduledTaskAction -Execute $powerShell -Argument "$argsPrefix -Mode Session" -WorkingDirectory $directory
$event = New-CimInstance -Namespace 'Root/Microsoft/Windows/TaskScheduler' -ClassName MSFT_TaskEventTrigger -ClientOnly -Property @{
    Enabled = $true
    Subscription = '<QueryList><Query Id="0" Path="Application"><Select Path="Application">*[System[Provider[@Name=''esme''] and EventID=2001]]</Select></Query></QueryList>'
}

Register-ScheduledTask -TaskPath $taskPath -TaskName PrepareGpuForSession -Action $session -Trigger $event -Principal $system -Settings $settings -Force | Out-Null
$bootSettings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
Register-ScheduledTask -TaskPath $taskPath -TaskName PowerLimitBoot -Action $boot -Trigger (New-ScheduledTaskTrigger -AtStartup) -Principal $system -Settings $bootSettings -Force | Out-Null

# Kryptex email logins require a slash; Mining Usernames support dot-separated workers.
$separator = if ($KryptexLogin.Contains('@')) { '/' } else { '.' }
$arguments = '--disable-cpu --algorithm pearlhash --pool prl-ru.kryptex.network:8048 --wallet "{0}{1}{2}" --tls true' -f $KryptexLogin,$separator,$env:COMPUTERNAME
$minerAction = New-ScheduledTaskAction -Execute $miner.FullName -Argument $arguments -WorkingDirectory $miner.DirectoryName
$minerSettings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskPath $taskPath -TaskName Miner -Action $minerAction -Settings $minerSettings -Principal $localService -Force | Out-Null
Write-Host 'Installed \Drova\Miner, \Drova\PowerLimitBoot and \Drova\PrepareGpuForSession.'
