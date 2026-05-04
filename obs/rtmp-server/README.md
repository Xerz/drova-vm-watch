# OBS RTMP Server

Контейнер собирает `nginx` с `nginx-rtmp-module`, принимает RTMP publish на порту `1935`, автоматически пишет потоки в `/recordings` и индексирует готовые `.flv` через `yamdi`.

## Что изменилось

- Образ больше не зависит от локальных `whitelist.conf` и `tokens.conf`.
- Конфигурация генерируется на старте из env-переменных.
- После завершения stream записанный `.flv` индексируется через `yamdi`.
- Образ можно публиковать в `ghcr.io` и ставить в `TrueNAS 24.10+` как `Custom App`.

## Локальный запуск

```bash
cd obs/rtmp-server
cp .env.example .env
docker compose up --build -d
```

RTMP ingest URL:

```text
rtmp://<host>:1935/<RTMP_APP>/<stream-key>
```

`stream-key` здесь используется только как имя потока и влияет на имя каталога/файла записи. Отдельная токен-аутентификация в этой версии не включена.

## Индексирование FLV

После завершения записи `nginx-rtmp` вызывает `/usr/local/bin/index-flv.sh` через `exec_record_done`. Скрипт создаёт временный файл рядом с записью, запускает `yamdi`, затем заменяет исходный `.flv`.

Для mounted storage процесс записи должен иметь права на создание, запись, удаление и переименование файлов в `/recordings`.

## Переменные окружения

- `RTMP_APP`: имя `application` в RTMP URL. По умолчанию `live`.
- `RECORD_PATH`: путь внутри контейнера, куда пишутся записи. По умолчанию `/recordings`.
- `HOST_RECORD_PATH`: путь на хосте для локального `docker compose`. Для TrueNAS не используется.
- `RECORD_SUFFIX`: суффикс имени файла записи. По умолчанию `_%Y-%m-%d_%H-%M-%S.flv`.
- `PUBLISH_ALLOWLIST`: список IP/CIDR через запятую, `;` или перенос строки. Если пусто, publish разрешён с любого IP.
- `RTMP_PORT`: нужен только для локального `docker compose`, контейнер внутри всегда слушает `1935`.

## Публикация в GHCR

Workflow в [`.github/workflows/obs-rtmp-image.yml`](/Users/xrzvs/PycharmProjects/drova-vm-watch/.github/workflows/obs-rtmp-image.yml) собирает и публикует образ:

- `ghcr.io/<owner>/obs-rtmp-server:latest` для default branch;
- `ghcr.io/<owner>/obs-rtmp-server:sha-<commit>`;
- `ghcr.io/<owner>/obs-rtmp-server:<git-tag>` для release tag.

## TrueNAS

Готовый шаблон для `Install via YAML` лежит в [truenas/obs-rtmp/docker-compose.yaml](/Users/xrzvs/PycharmProjects/drova-vm-watch/truenas/obs-rtmp/docker-compose.yaml), инструкция — в [truenas/obs-rtmp/README.md](/Users/xrzvs/PycharmProjects/drova-vm-watch/truenas/obs-rtmp/README.md).
