#Requires AutoHotkey v2.0
#SingleInstance Force

; ---------- АВТОПОВЫШЕНИЕ ПРАВ ДО АДМИНА (для записи в реестр) ----------
if !A_IsAdmin {
    try {
        Run '*RunAs "' A_ScriptFullPath '"'
    }
    ExitApp
}

; ================== КОНФИГ ЧЕРЕЗ ПЕРЕМЕННЫЕ ==================

; --- Пути к установленной GTA 5 по платформам ---
gtaPaths := Map()
gtaPaths["Steam"]            := "C:\Program Files (x86)\Steam\steamapps\common\Grand Theft Auto V"
gtaPaths["Epic Games Store"] := "C:\Program Files\Epic Games\GTAV"
gtaPaths["Rockstar Launcher"]:= "C:\Program Files\Rockstar Games\Grand Theft Auto V Legacy"

; --- Коды платформ для Majestic (как в .reg: egs / rgl / steam) ---
majesticPlatformCode := Map()
majesticPlatformCode["Steam"]            := "steam"
majesticPlatformCode["Epic Games Store"] := "egs"
majesticPlatformCode["Rockstar Launcher"]:= "rgl"

; --- Пути к лаунчерам ---
majesticExe := EnvGet("LOCALAPPDATA") "\MajesticLauncher\Majestic Launcher.exe"
gta5rpExe   := "C:\Program Files (x86)\GTA5RP\GTA5RPLauncher.exe"

; --- Ветви реестра ---
REG_MAJESTIC := "HKCU\Software\MAJESTIC-LAUNCHER"
REG_RAGEMP   := "HKCU\Software\RAGE-MP"


; ================== GUI ==================

mainGui := Gui("+AlwaysOnTop", "Лаунчер для лаунчеров")
mainGui.MarginX := 15
mainGui.MarginY := 15

mainGui.Add(
    "Text"
  , "w400"
  , "На сервере установлены GTA5RP Launcher и Majestic Launcher`n"
  . "для трёх разных версий GTA5 Legacy: Steam, Epic Games Store, Rockstar Launcher.`n`n"
  . "Выберите, в каком лаунчере у вас куплена GTA 5 Legacy:"
)

platSteam := mainGui.Add("Radio", "Group Checked", "Steam")
platEpic  := mainGui.Add("Radio", "", "Epic Games Store")
platRgl   := mainGui.Add("Radio", "", "Rockstar Launcher")

mainGui.Add("Text", "y+15", "Выберите, какой из RP лаунчеров запустить:")
rpGta5rp  := mainGui.Add("Radio", "Group Checked", "GTA5RP")
rpMajestic:= mainGui.Add("Radio", "", "Majestic")

mainGui.Add("Text", "w400", "После запуска никакой дополнительной настройки не требуется, просто выберите сервер для запуска и нажмите играть, а нужная версия GTAV будет использоваться автоматически")

btnRun    := mainGui.Add("Button", "y+20 w100 Default", "Запустить")
btnCancel := mainGui.Add("Button", "x+10 w100", "Выход")

btnRun.OnEvent("Click", LaunchSelected)
btnCancel.OnEvent("Click", (*) => ExitApp())

mainGui.Show()

; ================== ЛОГИКА ЗАПУСКА ЧЕРЕЗ ПЕРЕМЕННЫЕ ==================

LaunchSelected(*) {
    global mainGui, gtaPaths, majesticPlatformCode
    global majesticExe, gta5rpExe
    global REG_MAJESTIC, REG_RAGEMP
    ; добавляем сюда radio-контролы:
    global platSteam, platEpic, platRgl, rpGta5rp, rpMajestic

    ; -------- Определяем платформу по радиокнопкам --------
    if (platSteam.Value)
        platform := "Steam"
    else if (platEpic.Value)
        platform := "Epic Games Store"
    else if (platRgl.Value)
        platform := "Rockstar Launcher"
    else {
        MsgBox "Не выбрана платформа GTA 5.", "Ошибка", 0x10
        return
    }

    ; -------- Определяем RP-лаунчер по радиокнопкам --------
    if (rpGta5rp.Value)
        rpLaunch := "GTA5RP"
    else if (rpMajestic.Value)
        rpLaunch := "Majestic"
    else {
        MsgBox "Не выбран RP лаунчер.", "Ошибка", 0x10
        return
    }

    ; дальше оставляешь твой код как был:
    ; if !gtaPaths.Has(platform) { ... }
    ; ветка Majestic / ветка GTA5RP и т.д.


    if !gtaPaths.Has(platform) {
        MsgBox "Не задан путь к GTA 5 для платформы:`n" platform, "Ошибка", 0x10
        return
    }

    gtaPath := gtaPaths[platform]

    ; ---------- ВЕТКА: MAJESTIC ----------
    if (rpLaunch = "Majestic") {
        if !majesticPlatformCode.Has(platform) {
            MsgBox "Не задан код платформы для Majestic для:`n" platform, "Ошибка", 0x10
            return
        }
        platformCode := majesticPlatformCode[platform]

        RegWrite(gtaPath,      "REG_SZ", REG_MAJESTIC, "gta_v_path")
        RegWrite(platformCode, "REG_SZ", REG_MAJESTIC, "gta_v_platform")

        if !FileExist(majesticExe) {
            MsgBox "Не найден Majestic Launcher:`n" majesticExe, "Ошибка", 0x10
            return
        }

        Run '"' majesticExe '"'
        ExitApp
    }

    ; ---------- ВЕТКА: GTA5RP ----------
    if (rpLaunch = "GTA5RP") {
        RegWrite(gtaPath, "REG_SZ", REG_RAGEMP, "game_v_path")

        if !FileExist(gta5rpExe) {
            MsgBox "Не найден GTA5RP Launcher:`n" gta5rpExe, "Ошибка", 0x10
            return
        }

        Run '"' gta5rpExe '"'
        ExitApp
    }

    MsgBox "Неизвестный тип лаунчера: " rpLaunch, "Ошибка", 0x10
}
