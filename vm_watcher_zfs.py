#!/usr/bin/env python3
import subprocess
import time
import libvirt
import requests
import json
import logging
import os
from dotenv import load_dotenv

# Загружаем переменные из .env
load_dotenv()

SERVER_UUID = os.getenv("SERVER_UUID")
USER_ID = os.getenv("USER_ID")
AUTH_TOKEN = os.getenv("AUTH_TOKEN")

VM_NAME = os.getenv("VM_NAME", "my-vm")
SLEEP_TIME = int(os.getenv("SLEEP_TIME", "10"))
CHECK_INTERVAL = 2  # секунды между проверками статуса ВМ
PROCESS_NAME = os.getenv("PROCESS_NAME", "ese.exe")
SNAPSHOT_NAME = os.getenv("SNAPSHOT_NAME", "clean-state")
LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO").upper()
ZFS_SNAPSHOTS = [
    f"tank/{VM_NAME}@clean",
    f"tank/{VM_NAME}-storage@clean"
]


ENDPOINT = f"https://services.drova.io/server-manager/servers/{SERVER_UUID}?user_id={USER_ID}"
HEADERS = {"X-Auth-Token": AUTH_TOKEN}

def get_state():
    try:
        r = requests.get(ENDPOINT, headers=HEADERS, timeout=5)
        r.raise_for_status()
        data = r.json()
        return data.get("state")
    except Exception as e:
        logger.error(f"Ошибка запроса: {e}")
        return None

# Настройка логгера
logging.basicConfig(
    level=getattr(logging, LOG_LEVEL, logging.INFO),
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger(__name__)

def reset_vm(dom):
    try:
        logger.info(f"Откатываем {VM_NAME}")
        logger.debug("Запрашиваем destroy для VM '%s'", VM_NAME)
        dom.destroy()

        logger.debug("Ожидаем, пока VM '%s' выключится…", dom.name())
        # Ждём, пока дом не будет выключен (isActive()==0)
        while dom.isActive():
            time.sleep(CHECK_INTERVAL)
        logger.debug("VM '%s' остановлена", dom.name())

        # Откатываем оба ZFS-тома к clean
        for snap in ZFS_SNAPSHOTS:
            logger.debug("Откат ZFS к %s", snap)
            # потребует sudo-пароль или запуск скрипта под рута
            subprocess.run(
                ["sudo", "zfs", "rollback", "-r", snap],
                check=True
            )

        # Запускаем VM заново
        logger.debug("Запускаем VM '%s'", VM_NAME)
        dom.create()

        logger.info("VM '%s' запущена в clean-состоянии", VM_NAME)
    except Exception as e:
        logger.error("Ошибка при откате: %s", e)

def is_process_running(dom, process_name):
    """Проверяем, запущен ли процесс внутри Windows-гостя через qemu-guest-agent"""
    try:
        # запускаем tasklist внутри гостя
        cmd = {
            "execute": "guest-exec",
            "arguments": {
                "path": "cmd.exe",
                "arg": ["/c", "tasklist"],
                "capture-output": True,
            },
        }
        result = dom.qemuAgentCommand(json.dumps(cmd), libvirt.VIR_DOMAIN_QEMU_AGENT_COMMAND_DEFAULT, 0)
        pid = json.loads(result)["return"]["pid"]

        # ждём завершения команды
        while True:
            status_cmd = {"execute": "guest-exec-status", "arguments": {"pid": pid}}
            status_result = libvirt.virDomainQemuAgentCommand(dom, json.dumps(status_cmd), libvirt.VIR_DOMAIN_QEMU_AGENT_COMMAND_DEFAULT, 0)
            status = json.loads(status_result)["return"]
            if status["exited"]:
                output = status.get("out-data", "")
                logger.debug(output)
                return process_name.lower() in output.lower()
            time.sleep(1)
    except Exception as e:
        logger.error(f"Ошибка при проверке процесса: {e}")
        return False


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

    in_session = False


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

        # Ждем LISTEN
        waiting_msg_printed = False
        while True:
            state = get_state()
            if state == "LISTEN":
                logger.info(f"State changed to LISTEN → rebooting {VM_NAME}")
                try:
                    reset_vm(dom)
                except libvirt.libvirtError as e:
                    logger.error(f"Ошибка при перезагрузке: {e}")
                break
            if not waiting_msg_printed:
                logger.info(f"Waiting for LISTEN (current: {state})")
                waiting_msg_printed = True
            else:
                logger.debug(f"Still not LISTEN (state={state})")
            time.sleep(SLEEP_TIME)


if __name__ == "__main__":
    main()
