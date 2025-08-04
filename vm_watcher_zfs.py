#!/usr/bin/env python3
import subprocess
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
CHECK_INTERVAL = 2  # секунды между проверками статуса ВМ
PROCESS_NAME = os.getenv("PROCESS_NAME", "ese.exe")
SNAPSHOT_NAME = os.getenv("SNAPSHOT_NAME", "clean-state")
LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO").upper()
ZFS_SNAPSHOTS = [
    f"tank/{VM_NAME}@clean",
    f"tank/{VM_NAME}-storage@clean"
]

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
            status_result = dom.qemuAgentCommand(json.dumps(status_cmd), libvirt.VIR_DOMAIN_QEMU_AGENT_COMMAND_DEFAULT, 0)
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
