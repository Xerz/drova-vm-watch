#!/usr/bin/env python3
import json
import logging
import os

from utils_api import get_last_session_status, get_station_status, set_station_published, wait_for_status

from dotenv import load_dotenv

from utils_obs import start_record, stop_record_and_wait
from utils_virt_zfs import reset

# Загружаем переменные из .env
load_dotenv()

LOG_LEVEL = os.getenv("LOG_LEVEL", "ERROR").upper()
GRACE_PERIOD = int(os.getenv("GRACE_PERIOD", "120")) # время, которое даётся ВМ для мягкого выключения и станции для перехода из занятого состояния

ACTIVE_SESSION_STATUSES = ("ACTIVE", "HANDSHAKE", "NEW")  # Статусы активной сессии
BUSY_STATION_STATUSES = ("BUSY", "HANDSHAKE")

# Настройка логгера
logging.basicConfig(
    level=getattr(logging, LOG_LEVEL, logging.ERROR),
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger(__name__)

def main():
    while True:
        # Ждем активную сессию
        wait_for_status(get_status=get_last_session_status, statuses=ACTIVE_SESSION_STATUSES, desired=True)

        # Запускаем запись в OBS
        start_record()

        # Ждём пока сессия перестанет быть активной
        wait_for_status(get_status=get_last_session_status, statuses=ACTIVE_SESSION_STATUSES, desired=False)

        # Переводим сервер в приватный режим
        set_station_published(published=False)

        # Ждём, пока станция перестанет быть занятой
        wait_for_status(get_status=get_station_status, statuses=BUSY_STATION_STATUSES, desired=False, timeout=GRACE_PERIOD)

        # Сбрасываем ВМ
        reset()

        # Останавливаем запись в OBS
        stop_record_and_wait()

        # Возвращаем сервер в публичный режим
        set_station_published(published=True)


if __name__ == "__main__":
    main()
