# Set-NvidiaGlobalFpsLimit.ps1
# Запуск: powershell -ExecutionPolicy Bypass -File .\Set-NvidiaGlobalFpsLimit.ps1 -Fps 60

param(
  [ValidateRange(20, 1000)]
  [int]$Fps = 60
)

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

# === Формируем .nip для Base Profile ===
# Frame Rate Limiter SettingID:
# 0x10834FEE -> 277041134
# 0x1083500A -> 277041162 (значение слайдера/отображаемое)
# Кодирование: 0x80000000 (включить) + fps (в младшем байте), плюс опционально 0x20000000 (разрешить windowed)
$frlValue = [uint32](0x80000000 + $Fps) -bor [uint32]0x20000000

$nipPath = Join-Path $Here ("BaseProfile_{0}fps.nip" -f $Fps)

$xml = @"
<?xml version="1.0" encoding="utf-16"?>
<ArrayOfProfile>
  <Profile>
    <ProfileName>Base Profile</ProfileName>
    <Executeables />
    <Settings>
      <ProfileSetting>
        <SettingID>277041134</SettingID>
        <SettingValue>$frlValue</SettingValue>
        <ValueType>Dword</ValueType>
      </ProfileSetting>
      <ProfileSetting>
        <SettingID>277041162</SettingID>
        <SettingValue>$Fps</SettingValue>
        <ValueType>Dword</ValueType>
      </ProfileSetting>
    </Settings>
  </Profile>
</ArrayOfProfile>
"@

[System.IO.File]::WriteAllText($nipPath, $xml, [System.Text.Encoding]::Unicode)

Write-Host "Импортирую профиль (silent): $nipPath"
& $NpiExe -silentImport $nipPath

Write-Host "Готово: глобальный лимит FPS = $Fps. Перезапусти игры/приложения."
