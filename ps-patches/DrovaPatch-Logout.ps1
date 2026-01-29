$ErrorActionPreference = "SilentlyContinue"

$parsecServiceName = "Parsec"

$processes = @(
    "EpicGamesLauncher",
    "steam",
    "upc",
    "parsecd",
    "wgc"
)

$filesToRemove = @(
    "$env:PROGRAMFILES(X86)\Steam\config\loginusers.vdf",
    "$env:LOCALAPPDATA\Ubisoft Game Launcher\ConnectSecureStorage.dat",
    "$env:LOCALAPPDATA\Ubisoft Game Launcher\user.dat",
    "$env:APPDATA\Parsec\user.bin",
    "$env:APPDATA\Wargaming.net\GameCenter\user_info.xml"
)

# 0. Остановить службу Parsec перед убийством процессов
$parsecSvc = Get-Service -Name $parsecServiceName -ErrorAction SilentlyContinue
if ($parsecSvc -and $parsecSvc.Status -ne 'Stopped') {
    Stop-Service -Name $parsecServiceName -Force -ErrorAction SilentlyContinue
}

# 1. Завершить целевые процессы
foreach ($proc in $processes) {
    Get-Process -Name $proc -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
}

# 2. Удалить файлы авторизации
foreach ($file in $filesToRemove) {
    if (Test-Path $file) {
        Remove-Item $file -Force -ErrorAction SilentlyContinue
    }
}

# Steam авторизация: оставить пустой loginusers.vdf
$steamLogin = "${env:ProgramFiles(x86)}\Steam\config\loginusers.vdf"
if (-not (Test-Path $steamLogin)) { New-Item -Path (Split-Path $steamLogin) -ItemType Directory -Force | Out-Null }
Set-Content -Path $steamLogin -Value '"users"\n{' -Encoding ASCII

# 3. Снова включить службу Parsec
$parsecSvc = Get-Service -Name $parsecServiceName -ErrorAction SilentlyContinue
if ($parsecSvc -and $parsecSvc.Status -ne 'Running') {
    Start-Service -Name $parsecServiceName -ErrorAction SilentlyContinue
}
