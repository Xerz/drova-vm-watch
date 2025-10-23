
# `vm_watcher_zfs.py`

Скрипт для мониторинга состояния и отката виртуальной машины в `libvirt` после завершения игровой сессии (+ автоматического запуска и остановки записи через OBS)

## Установка и запуск

### 1. Клонируем репозиторий

```bash
git clone https://github.com/Xerz/drova-vm-watch.git
cd drova-vm-watch
````

### 2. Создаём виртуальное окружение

```bash
python -m venv rebooter-venv
source rebooter-venv/bin/activate
```

### 3. Устанавливаем зависимости

```bash
pip install -r requirements.txt
```

### 4. Настраиваем переменные окружения

Скопируйте пример файла и отредактируйте под свои значения:

```bash
cp .env.example .env
```

Переменные в `.env`:

* `SERVER_UUID` — UUID сервера (над именем сервера на странице "Мои серверы")
* `USER_ID` — ID пользователя (можно взять из файла реестра)
* `AUTH_TOKEN` — токен авторизации (из файла реестра)
* `VM_NAME` — имя виртуальной машины в `libvirt`
* `SLEEP_TIME` — задержка между проверками состояния (секунды)
* `LOG_LEVEL` — уровень логирования (`DEBUG`, `INFO`, `ERROR`)
* `OBS_WS_HOST`, `OBS_WS_PORT`, `OBS_WS_PASSWORD` — параметры подключения к OBS WebSocket (скрипт запускает и останавливает запись в OBS при начале и конце сессии)

### 5. Запускаем скрипт

```bash
source rebooter-venv/bin/activate
python vm_watcher_zfs.py
```

Для использования `libvirt` запускать нужно с **правами суперпользователя**

## Конфигурация

`python 3.13.5`

`Manjaro Linux`

## Пример работы

* Обнаружение окончания сессии:
  * Ждёт, пока статус последней сессии совпадёт с одним из `NEW`, `HANDSHAKE`, `ACTIVE` — так определяется начало сессии
  * Затем запускает запись в OBS и ждёт изменения состояния на одно из отличных от состояний выше — так определяется завершение сессии
* При завершении сессии останавливает запись в OBS, отправляет команду **shutdown** в выбранную виртуальную машину, ждёт её остановки 60 сек (если не дождался — force off), затем делает `zfs rollback` дисков этой машины к снепшоту `@clean` и запускает машину заново

---
### Другие полезности для drova

[Telegram Drova Session Manager Bot](https://github.com/Xerz/drova-telegram-server-info/tree/main) — телеграм-бот для просмотра сессий

[DrovaKeeneticDesktop](https://github.com/sergius-dart/DrovaKeeneticDesktop) — автоподготовка и откат машин через локальную сеть

[DrovaNotifierV2](https://github.com/IceBeerG/DrovaNotifierV2) — оповещение о начале и окончании сессии (и не только) через телеграм

[SteamCleaner](https://github.com/VoroninVladimirN93/steamCleaner/tree/main) — очищение временных папок стима

[steam bulk validate](https://github.com/dreamer2/steambulkvalidate) — проверка игр стима
