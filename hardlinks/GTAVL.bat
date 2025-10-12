@echo off
REM === Настройки ===
set "SOURCE=D:\GTAV-Common"

REM Список целевых директорий (через пробел)
set TARGETS="D:\GTAVRGL\Grand Theft Auto V Legacy" "D:\EGS\GTAV" "D:\SteamLibrary\steamapps\common\Grand Theft Auto V"

REM === Проверка прав администратора ===
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo Требуются права администратора. Перезапуск...
    powershell -Command "Start-Process '%~f0' -Verb runAs"
    exit /b
)

echo ===============================================
echo   СОЗДАНИЕ ССЫЛОК НА ФАЙЛЫ GTA V
echo ===============================================

for %%~T in (%TARGETS%) do (
    echo.
    echo === Обработка %%~T ===

    if not exist "%%~T" (
        echo   Папка не найдена, создаю...
        mkdir "%%~T"
    )

    REM --- x64*.rpf ---
    for %%F in ("%SOURCE%\x64*.rpf") do (
        if not exist "%%~T\%%~nxF" (
            mklink /H "%%~T\%%~nxF" "%%~F" >nul
            echo   Связь: %%~nxF
        )
    )

    REM --- Папка update ---
    if exist "%SOURCE%\update" (
        if not exist "%%~T\update" (
            mklink /J "%%~T\update" "%SOURCE%\update" >nul
            echo   Ссылка на папку update создана.
        )
    )

    REM --- Папка x64 ---
    if exist "%SOURCE%\x64" (
        if not exist "%%~T\x64" (
            mklink /J "%%~T\x64" "%SOURCE%\x64" >nul
            echo   Ссылка на папку x64 создана.
        )
    )

    echo   Готово для %%~T
)

echo.
echo Все ссылки успешно созданы!
pause
