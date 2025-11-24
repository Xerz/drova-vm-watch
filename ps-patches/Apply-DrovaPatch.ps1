$ErrorActionPreference = "SilentlyContinue"

$parsecServiceName = "Parsec"

$processes = @(
    "EpicGamesLauncher",
    "steam",
    "upc",
    "parsecd",
    "wgc",
    "explorer"
)

$filesToRemove = @(
    "$env:LOCALAPPDATA\EpicGamesLauncher\Saved\Config\Windows\GameUserSettings.ini",
    "$env:LOCALAPPDATA\EpicGamesLauncher\Saved\Config\WindowsEditor\GameUserSettings.ini",
    "$env:PROGRAMFILES(X86)\Steam\config\loginusers.vdf",
    "$env:LOCALAPPDATA\Ubisoft Game Launcher\ConnectSecureStorage.dat",
    "$env:LOCALAPPDATA\Ubisoft Game Launcher\user.dat",
    "$env:APPDATA\Parsec\user.bin",
    "$env:APPDATA\Wargaming.net\GameCenter\user_info.xml"
)

$registryPatches = @(
    @{ Path = "HKCU:\Software\Policies\Microsoft\Windows\System"; Name = "DisableCMD"; Type = "DWORD"; Value = 2 },
    @{ Path = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Policies\System"; Name = "DisableTaskMgr"; Type = "DWORD"; Value = 1 },
    @{ Path = "HKCU:\Software\Policies\Microsoft\Windows Script Host"; Name = "Enabled"; Type = "DWORD"; Value = 0 },
    @{ Path = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Policies\Explorer"; Name = "NoClose"; Type = "DWORD"; Value = 1 },
    @{ Path = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Policies\Explorer"; Name = "StartMenuLogoff"; Type = "DWORD"; Value = 1 },
    @{ Path = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Policies\Explorer"; Name = "ShutdownWithoutLogon"; Type = "DWORD"; Value = 0 },
    @{ Path = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Policies\Explorer"; Name = "NoLogoff"; Type = "DWORD"; Value = 0 },
    @{ Path = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Policies\System"; Name = "DisableGpedit"; Type = "DWORD"; Value = 1 },
    @{ Path = "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System"; Name = "HideFastUserSwitching"; Type = "DWORD"; Value = 1 },
    @{ Path = "HKCU:\Software\Policies\Microsoft\MMC"; Name = "RestrictToPermittedSnapins"; Type = "DWORD"; Value = 1 },
    @{ Path = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Policies\Explorer"; Name = "DisallowRun"; Type = "DWORD"; Value = 1 }
)

$blockedApps = @(
    "regedit.exe","powershell.exe","powershell_ise.exe","mmc.exe","gpedit.msc",
    "perfmon.exe","anydesk.exe","rustdesk.exe","ProcessHacker.exe","procexp.exe",
    "autoruns.exe","psexplorer.exe","procexp64.exe","procexp64a.exe",
    "soundpad.exe","SoundpadService.exe","MSIAfterburner.exe", "Commit.exe"
)

function Set-RegistryValue {
    param($Path, $Name, $Type, $Value)
    if (-not (Test-Path $Path)) { New-Item -Path $Path -Force | Out-Null }
    Set-ItemProperty -Path $Path -Name $Name -Value $Value -Type $Type -Force
}

# 0. Остановить службу Parsec перед убийством процессов
$parsecSvc = Get-Service -Name $parsecServiceName -ErrorAction SilentlyContinue
if ($parsecSvc -and $parsecSvc.Status -ne 'Stopped') {
    Stop-Service -Name $parsecServiceName -Force -ErrorAction SilentlyContinue
}

# 1. Завершить целевые процессы
foreach ($proc in $processes) {
    Get-Process -Name $proc -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
}

# 2. Удалить/обнулить файлы
foreach ($file in $filesToRemove) {
    if (Test-Path $file) {
        Remove-Item $file -Force -ErrorAction SilentlyContinue
    }
}
# Steam авторизация: оставить пустой loginusers.vdf
$steamLogin = "${env:ProgramFiles(x86)}\Steam\config\loginusers.vdf"
if (-not (Test-Path $steamLogin)) { New-Item -Path (Split-Path $steamLogin) -ItemType Directory -Force | Out-Null }
Set-Content -Path $steamLogin -Value '"users"\n{' -Encoding ASCII

# 3. Применить реестровые изменения
foreach ($patch in $registryPatches) {
    Set-RegistryValue @patch
}

# 4. Заблокировать запуск нежелательных приложений через DisallowRun
$disallowRun = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Policies\Explorer\DisallowRun"
if (-not (Test-Path $disallowRun)) { New-Item -Path $disallowRun -Force | Out-Null }
for ($i = 0; $i -lt $blockedApps.Count; $i++) {
    Set-ItemProperty -Path $disallowRun -Name $i -Value $blockedApps[$i] -Type String -Force
}

# 5. Применить групповые политики и вернуть explorer
Start-Process -FilePath "gpupdate.exe" -ArgumentList "/target:user","/force" -Wait
Start-Process -FilePath "$env:WINDIR\explorer.exe"

# 6. Снова включить службу Parsec
$parsecSvc = Get-Service -Name $parsecServiceName -ErrorAction SilentlyContinue
if ($parsecSvc -and $parsecSvc.Status -ne 'Running') {
    Start-Service -Name $parsecServiceName -ErrorAction SilentlyContinue
}