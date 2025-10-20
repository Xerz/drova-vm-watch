#!/usr/bin/env python3
import subprocess
import time
import libvirt
import requests
import json
import logging
import os
from dotenv import load_dotenv
import obsws_python as obs

# Загружаем переменные из .env
load_dotenv()

SERVER_UUID = os.getenv("SERVER_UUID")
USER_ID = os.getenv("USER_ID")
AUTH_TOKEN = os.getenv("AUTH_TOKEN")

VM_NAME = os.getenv("VM_NAME", "my-vm")
SLEEP_TIME = int(os.getenv("SLEEP_TIME", "10"))
PROCESS_NAME = os.getenv("PROCESS_NAME", "ese.exe")
SNAPSHOT_NAME = os.getenv("SNAPSHOT_NAME", "clean")
LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO").upper()
ZFS_SNAPSHOTS = [
    f"tank/{VM_NAME}@clean",
    f"tank/{VM_NAME}-storage@clean"
]
GRACE_PERIOD = int(os.getenv("GRACE_PERIOD", "60")) # время, которое даётся ВМ для мягкого выключения
CHECK_INTERVAL = 2  # секунды между проверками статуса ВМ при выключении

OBS_WS_HOST = os.getenv("OBS_WS_HOST", "localhost")
OBS_WS_PORT = int(os.getenv("OBS_WS_PORT", "4444"))
OBS_WS_PASSWORD = os.getenv("OBS_WS_PASSWORD", "")

ENDPOINT = "https://services.drova.io/session-manager/sessions"
HEADERS = {"X-Auth-Token": AUTH_TOKEN}

ACTIVE_SESSION_STATUSES = ("ACTIVE", "HANDSHAKE", "NEW")  # Статусы активной сессии

# Настройка логгера
logging.basicConfig(
    level=getattr(logging, LOG_LEVEL, logging.INFO),
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger(__name__)

def get_state():
    try:
        params = [("status", status) for status in ACTIVE_SESSION_STATUSES]
        r = requests.get(ENDPOINT, params=params, headers=HEADERS, timeout=5)
        r.raise_for_status()
        sessions = r.json().get("sessions", [])
        if not sessions:
            # No active sessions returned from server, return "Inactive"
            return "INACTIVE"

        data = sessions[0]
        server_id = data.get("server_id")
        if server_id != SERVER_UUID:
            raise RuntimeError("Server UUID does not match, check your Token-Server pair")

        return data.get("status")
    except Exception as e:
        logger.error(f"Ошибка запроса: {e}")
        return None

def reset_vm(dom):
    try:
        # Сначала проверяем, активна ли ВМ
        if dom.isActive():
            logger.info(f"Попытка корректного завершения работы VM '{VM_NAME}'")
            dom.shutdown()

            # Ожидаем graceful shutdown до GRACE_PERIOD секунд
            waited = 0
            while dom.isActive() and waited < GRACE_PERIOD:
                time.sleep(CHECK_INTERVAL)
                waited += CHECK_INTERVAL

            if dom.isActive():
                logger.warning(
                    "VM '%s' не завершила работу за %s секунд, выполняем принудительное отключение",
                    VM_NAME, GRACE_PERIOD
                )
                dom.destroy()
            else:
                logger.info("VM '%s' корректно завершила работу за %s секунд", VM_NAME, waited)

            # Дожидаемся окончательной остановки
            while dom.isActive():
                time.sleep(CHECK_INTERVAL)
            logger.debug("VM '%s' остановлена", VM_NAME)
        else:
            logger.info("VM '%s' уже остановлена — пропускаем shutdown/destroy", VM_NAME)

        # Откатываем оба ZFS-тома к clean
        for snap in ZFS_SNAPSHOTS:
            logger.debug("Откат ZFS-тома к снимку %s", snap)
            subprocess.run(
                ["sudo", "zfs", "rollback", "-r", snap],
                check=True
            )

        # Запускаем VM заново
        logger.debug("Запускаем VM '%s'", VM_NAME)
        dom.create()

        logger.info("VM '%s' запущена в clean-состоянии", VM_NAME)

    except libvirt.libvirtError as e:
        # Специально ловим ошибки libvirt
        logger.error("Libvirt error при сбросе VM '%s': %s", VM_NAME, e)
    except Exception as e:
        logger.error("Ошибка при сбросе VM '%s': %s", VM_NAME, e)

def start_record(client: obs.ReqClient):
    client.start_record()  # StartRecord (v5). :contentReference[oaicite:13]{index=13}
    st = client.get_record_status()
    logger.info(f"Recording: {st.output_path}")

def stop_record_and_wait(client: obs.ReqClient):
    # StopRecord вернёт путь (в 5.x), но подождём гарантированно. :contentReference[oaicite:14]{index=14}
    res = client.stop_record()
    out_path = getattr(res, "output_path", None)
    for _ in range(120):
        st = client.get_record_status()     # GetRecordStatus. :contentReference[oaicite:15]{index=15}
        if not st.output_active:
            return out_path
        time.sleep(0.5)
    return out_path

def main():
    conn = libvirt.open("qemu:///system")
    if conn is None:
        logger.error("Не удалось подключиться к libvirt")
        return

    try:
        dom = conn.lookupByName(VM_NAME)
    except libvirt.libvirtError:
        logger.error(f"Виртуальная машина {VM_NAME} не найдена")
        return

    obs_client = None

    # Статусы активной сессии: ACTIVE_SESSION_STATUSES
    while True:
        # Ждем любой из статусов активной сессии
        waiting_msg_printed = False
        while True:
            state = get_state()
            if state in ACTIVE_SESSION_STATUSES:
                logger.info(f"VM {VM_NAME} entered session state: {state}")
                try:
                    obs_client = obs.ReqClient(host=OBS_WS_HOST, port=OBS_WS_PORT, password=OBS_WS_PASSWORD)
                    obs_client.get_version()
                    start_record(obs_client)
                except Exception as e:
                    obs_client = None
                    logger.error(f"Не удалось подключиться к OBS WebSocket и / или начать запись: {e}")
                break
            if not waiting_msg_printed:
                logger.info(f"Waiting for {ACTIVE_SESSION_STATUSES} (last session state: {state})")
                waiting_msg_printed = True
            else:
                logger.debug(f"Still waiting (state={state})")
            time.sleep(SLEEP_TIME)


        # Ждем, когда статус станет неактивным
        waiting_msg_printed = False
        while True:
            state = get_state()
            if state and state not in ACTIVE_SESSION_STATUSES:
                logger.info(f"State changed to {state} → reverting {VM_NAME}")
                try:
                    reset_vm(dom)
                except libvirt.libvirtError as e:
                    logger.error(f"Ошибка при перезагрузке: {e}")
                if obs_client:
                    try:
                        stop_record_and_wait(obs_client)
                    except Exception as e:
                        logger.error(f"Ошибка при остановке записи в OBS: {e}")
                    finally:
                        try:
                            obs_client.close()
                        except Exception as e:
                            logger.error(f"Ошибка при закрытии OBS WebSocket: {e}")
                        obs_client = None
                break
            if not waiting_msg_printed:
                logger.info(f"Waiting for not in {ACTIVE_SESSION_STATUSES} (current: {state})")
                waiting_msg_printed = True
            else:
                logger.debug(f"Still in {ACTIVE_SESSION_STATUSES} (state={state})")
            time.sleep(SLEEP_TIME)


if __name__ == "__main__":
    main()
