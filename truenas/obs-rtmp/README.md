# TrueNAS 24.10+ install

Этот сервис рассчитан на установку в `Apps > Discover > more_vert > Install via YAML`.

## Перед установкой

1. Соберите и опубликуйте образ в `ghcr.io`.
2. Создайте dataset, например:

```text
/mnt/<pool>/apps/obs-rtmp/recordings
```

3. Убедитесь, что app сможет писать в этот dataset.

## Что подставить в YAML

Шаблон лежит в [docker-compose.yaml](/Users/xrzvs/PycharmProjects/drova-vm-watch/truenas/obs-rtmp/docker-compose.yaml).

Замените:

- `ghcr.io/<owner>/obs-rtmp-server:latest` на свой опубликованный образ;
- `/mnt/<pool>/apps/obs-rtmp/recordings` на путь к вашему dataset;
- `PUBLISH_ALLOWLIST` на нужные IP/CIDR, либо оставьте пустым для publish с любого IP.

## Параметры для TrueNAS UI

- `Image repository`: `ghcr.io/<owner>/obs-rtmp-server`
- `Image tag`: `latest` или конкретный release tag
- `Container port`: `1935`
- `Host port`: `1935` или свой внешний порт
- `Host path volume`: `/mnt/<pool>/apps/obs-rtmp/recordings` -> `/recordings`

## Пример RTMP URL для OBS

```text
rtmp://<truenas-ip>:1935/live/<stream-key>
```

`stream-key` в этой версии используется как имя потока. Отдельная token auth не включена.

## Если образ private

Для private `ghcr.io` image в TrueNAS нужно сначала добавить registry credentials и использовать их при установке app.
