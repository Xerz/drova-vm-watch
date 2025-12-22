# Set-NvidiaGlobalFpsLimit.ps1
# Запуск: powershell -ExecutionPolicy Bypass -File .\Set-NvidiaGlobalFpsLimit.ps1

Start-Sleep -Seconds 15


$Here   = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }
$NpiExe = Join-Path $Here "nvidiaProfileInspector.exe"

function Ensure-NPI {
  param([string]$ExePath, [string]$Folder)

  if (Test-Path $ExePath) { return }

  $zipUrl  = "https://github.com/Orbmu2k/nvidiaProfileInspector/releases/latest/download/nvidiaProfileInspector.zip"
  $zipPath = Join-Path $Folder "nvidiaProfileInspector.zip"

  Write-Host "NVIDIA Profile Inspector не найден. Скачиваю в: $Folder"
  Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath

  Write-Host "Распаковываю..."
  Expand-Archive -Path $zipPath -DestinationPath $Folder -Force
  Remove-Item $zipPath -Force

  if (!(Test-Path $ExePath)) {
    throw "Не удалось найти nvidiaProfileInspector.exe после распаковки. Проверьте содержимое папки: $Folder"
  }
}

Ensure-NPI -ExePath $NpiExe -Folder $Here

$Here  = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }
$Npi   = Join-Path $Here "nvidiaProfileInspector.exe"
$Nip   = Join-Path $Here "60fps.nip"

if (!(Test-Path $Npi)) { throw "Не найден: $Npi" }
if (!(Test-Path $Nip)) { throw "Не найден: $Nip" }

# Иногда встречаются разные “тихие” ключи в разных версиях.
# 1) Пробуем undocumented -silentImport :contentReference[oaicite:5]{index=5}
try {
  & $Npi -silentImport $Nip
  exit 0
} catch {
  # 2) Фолбэк: формат "exe file.nip -silent" встречается в обсуждениях :contentReference[oaicite:6]{index=6}
  & $Npi $Nip -silent
}