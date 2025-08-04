#!/usr/bin/env python3
import time
import libvirt
import json
import logging
import os
from dotenv import load_dotenv

# Загружаем переменные из .env
load_dotenv()

VM_NAME = os.getenv("VM_NAME", "my-vm")
SLEEP_TIME = int(os.getenv("SLEEP_TIME", "10"))
PROCESS_NAME = os.getenv("PROCESS_NAME", "ese.exe")
SNAPSHOT_NAME = os.getenv("SNAPSHOT_NAME", "clean-state")
LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO").upper()

# Настройка логгера
logging.basicConfig(
    level=getattr(logging, LOG_LEVEL, logging.INFO),
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger(__name__)


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
            status_result = dom.qemuAgentCommand(json.dumps(status_cmd), libvirt.VIR_DOMAIN_QEMU_AGENT_COMMAND_DEFAULT, 0)
            status = json.loads(status_result)["return"]
            if status["exited"]:
                output = status.get("out-data", "")
                return process_name.lower() in output.lower()
            time.sleep(1)
    except Exception as e:
        logger.error(f"Ошибка при проверке процесса: {e}")
        return False


def reset_vm(dom):
    """Форс выключение → откат снапшота → включение"""
    try:
        logger.info("Выключаем ВМ (force off)…")
        dom.destroy()

        logger.info(f"Откат к снапшоту {SNAPSHOT_NAME}…")
        snap = dom.snapshotLookupByName(SNAPSHOT_NAME, 0)
        dom.revertToSnapshot(snap, flags=0)

        logger.info("Запускаем ВМ…")
        dom.create()
        logger.info("ВМ успешно восстановлена из снапшота и запущена")
    except libvirt.libvirtError as e:
        logger.error(f"Ошибка при восстановлении ВМ: {e}")


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
        running = is_process_running(dom, PROCESS_NAME)

        if not in_session and running:
            in_session = True
            logger.info(f"Процесс {PROCESS_NAME} запущен → сессия началась")

        elif in_session and not running:
            in_session = False
            logger.info(f"Процесс {PROCESS_NAME} завершён → выполняем восстановление ВМ")
            reset_vm(dom)

        time.sleep(SLEEP_TIME)


if __name__ == "__main__":
    main()
