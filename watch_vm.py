#!/usr/bin/env python3
import time
import requests
import libvirt
import os
import logging
from dotenv import load_dotenv

# Загружаем переменные из .env
load_dotenv()

SERVER_UUID = os.getenv("SERVER_UUID")
USER_ID = os.getenv("USER_ID")
AUTH_TOKEN = os.getenv("AUTH_TOKEN")
VM_NAME = os.getenv("VM_NAME", "my-vm")
SLEEP_TIME = int(os.getenv("SLEEP_TIME", "10"))
LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO").upper()

ENDPOINT = f"https://services.drova.io/server-manager/servers/{SERVER_UUID}?user_id={USER_ID}"
HEADERS = {"X-Auth-Token": AUTH_TOKEN}

# Настройка логгера
logging.basicConfig(
    level=getattr(logging, LOG_LEVEL, logging.INFO),
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger(__name__)


def get_state():
    try:
        r = requests.get(ENDPOINT, headers=HEADERS, timeout=5)
        r.raise_for_status()
        data = r.json()
        return data.get("state")
    except Exception as e:
        logger.error(f"Ошибка запроса: {e}")
        return None


def main():
    # Подключаемся к libvirt
    conn = libvirt.open("qemu:///system")
    if conn is None:
        logger.error("Не удалось подключиться к libvirt")
        return

    try:
        dom = conn.lookupByName(VM_NAME)
    except libvirt.libvirtError:
        logger.error(f"Виртуальная машина {VM_NAME} не найдена")
        return

    while True:
        # Ждем BUSY или HANDSHAKE
        waiting_msg_printed = False
        while True:
            state = get_state()
            if state in ("BUSY", "HANDSHAKE"):
                logger.info(f"VM {VM_NAME} entered session state: {state}")
                break
            if not waiting_msg_printed:
                logger.info(f"Waiting for BUSY/HANDSHAKE (current: {state})")
                waiting_msg_printed = True
            else:
                logger.debug(f"Still waiting (state={state})")
            time.sleep(SLEEP_TIME)

        # Ждем окончания BUSY/HANDSHAKE
        waiting_msg_printed = False
        while True:
            state = get_state()
            if state is not None and state not in ("BUSY", "HANDSHAKE"):
                logger.info(f"State changed to {state} → rebooting {VM_NAME}")
                try:
                    dom.reboot(flags=0)
                except libvirt.libvirtError as e:
                    logger.error(f"Ошибка при перезагрузке: {e}")
                break
            if not waiting_msg_printed:
                logger.info(f"Waiting end of BUSY/HANDSHAKE (current: {state})")
                waiting_msg_printed = True
            else:
                logger.debug(f"Still BUSY/HANDSHAKE (state={state})")
            time.sleep(SLEEP_TIME)


if __name__ == "__main__":
    main()
