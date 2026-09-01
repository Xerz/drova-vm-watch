[CmdletBinding()]
param(
    [switch]$Uninstall
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$TaskName = 'ClientBlacklistGuard'
$TaskPath = '\Drova\'
$DestinationDirectory = Join-Path -Path $env:ProgramData -ChildPath 'Drova'
$DestinationScript = Join-Path -Path $DestinationDirectory -ChildPath 'DrovaBlacklistGuard.ps1'
$SourceScript = Join-Path -Path $PSScriptRoot -ChildPath 'DrovaBlacklistGuard.ps1'
$BlacklistPath = 'D:\bads.txt'
$LogPath = Join-Path -Path $DestinationDirectory -ChildPath 'ClientBlacklistGuard.log'

function Assert-Administrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object -TypeName Security.Principal.WindowsPrincipal -ArgumentList $identity

    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Запустите установщик из PowerShell с правами администратора.'
    }

    if ($identity.IsSystem -or $identity.User.Value -eq 'S-1-5-18') {
        throw 'Нельзя устанавливать задачу от SYSTEM. Запустите установщик из интерактивной игровой учётной записи.'
    }

    if (-not [Environment]::UserInteractive) {
        throw 'Установщик должен быть запущен в интерактивном сеансе игровой учётной записи.'
    }

    return $identity
}

function Remove-GuardTask {
    $task = Get-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -ErrorAction SilentlyContinue
    if ($null -ne $task) {
        Unregister-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -Confirm:$false -ErrorAction Stop
        Write-Host ("Задача {0}{1} удалена." -f $TaskPath, $TaskName)
    }
    else {
        Write-Host ("Задача {0}{1} не найдена." -f $TaskPath, $TaskName)
    }
}

function Ensure-GuardTaskFolder {
    $scheduler = New-Object -ComObject 'Schedule.Service'
    $scheduler.Connect()

    try {
        $scheduler.GetFolder('\Drova') | Out-Null
    }
    catch {
        $rootFolder = $scheduler.GetFolder('\')
        $rootFolder.CreateFolder('Drova', $null) | Out-Null
    }
}

$currentIdentity = Assert-Administrator

if ($Uninstall) {
    Remove-GuardTask

    if (Test-Path -LiteralPath $DestinationScript -PathType Leaf) {
        Remove-Item -LiteralPath $DestinationScript -Force
        Write-Host ("Скрипт {0} удалён." -f $DestinationScript)
    }
    else {
        Write-Host ("Скрипт {0} не найден." -f $DestinationScript)
    }

    Write-Host ("Чёрный список {0} и журнал {1} сохранены." -f $BlacklistPath, $LogPath)
    return
}

if (-not (Test-Path -LiteralPath $SourceScript -PathType Leaf)) {
    throw ("Рядом с установщиком отсутствует файл {0}." -f $SourceScript)
}

New-Item -Path $DestinationDirectory -ItemType Directory -Force | Out-Null
Copy-Item -LiteralPath $SourceScript -Destination $DestinationScript -Force

if (-not (Test-Path -LiteralPath $BlacklistPath -PathType Leaf)) {
    Write-Warning ("Файл {0} пока отсутствует. Задача будет разрешать подключения, пока файл не появится." -f $BlacklistPath)
}

$registrationDate = (Get-Date).ToString('s')
$author = [Security.SecurityElement]::Escape($currentIdentity.Name)
$userSid = [Security.SecurityElement]::Escape($currentIdentity.User.Value)
$powerShellPath = [Security.SecurityElement]::Escape((Join-Path -Path $env:SystemRoot -ChildPath 'System32\WindowsPowerShell\v1.0\powershell.exe'))
$arguments = [Security.SecurityElement]::Escape(('-NoProfile -NonInteractive -ExecutionPolicy Bypass -STA -WindowStyle Hidden -File "{0}"' -f $DestinationScript))

$taskXml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Date>$registrationDate</Date>
    <Author>$author</Author>
    <Description>Checks the first Drova session client against D:\bads.txt and blocks blacklisted clients.</Description>
    <URI>\Drova\ClientBlacklistGuard</URI>
  </RegistrationInfo>
  <Triggers>
    <EventTrigger>
      <Enabled>true</Enabled>
      <Subscription>&lt;QueryList&gt;&lt;Query Id="0" Path="Application"&gt;&lt;Select Path="Application"&gt;*[System[Provider[@Name='esme'] and EventID=2006]]&lt;/Select&gt;&lt;/Query&gt;&lt;/QueryList&gt;</Subscription>
    </EventTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>$userSid</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>HighestAvailable</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>false</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT10M</ExecutionTimeLimit>
    <Priority>4</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>$powerShellPath</Command>
      <Arguments>$arguments</Arguments>
      <WorkingDirectory>$([Security.SecurityElement]::Escape($DestinationDirectory))</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
"@

Ensure-GuardTaskFolder
Register-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -Xml $taskXml -Force | Out-Null

Write-Host ("Установлен скрипт: {0}" -f $DestinationScript)
Write-Host ("Зарегистрирована задача: {0}{1}" -f $TaskPath, $TaskName)
Write-Host ("Задача привязана к интерактивному пользователю: {0}" -f $currentIdentity.Name)
Write-Host 'Триггер: журнал Application, источник esme, EventID 2006.'
