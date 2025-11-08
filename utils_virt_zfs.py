import os
import subprocess
import time
import logging
import libvirt

from dotenv import load_dotenv

# Загружаем переменные из .env
load_dotenv()

logger = logging.getLogger(__name__)

GRACE_PERIOD = int(os.getenv("GRACE_PERIOD", "120"))
CHECK_INTERVAL = 1

VM_NAME = os.getenv("VM_NAME", "my-vm")
SNAPSHOT_NAME = os.getenv("SNAPSHOT_NAME", "clean")
ZFS_SNAPSHOTS = [
    f"tank/{VM_NAME}@clean",
    f"tank/{VM_NAME}-storage@clean"
]


def reset():
    try:

        conn = libvirt.open("qemu:///system")
        if conn is None:
            logger.error("Не удалось подключиться к libvirt")
            return

        try:
            dom = conn.lookupByName(VM_NAME)
        except libvirt.libvirtError:
            logger.error(f"Виртуальная машина {VM_NAME} не найдена")
            return

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

        # Ждём 30 секунд, чтобы гость успел загрузиться
        time.sleep(30)

    except libvirt.libvirtError as e:
        # Специально ловим ошибки libvirt
        logger.error("Libvirt error при сбросе VM '%s': %s", VM_NAME, e)
    except Exception as e:
        logger.error("Ошибка при сбросе VM '%s': %s", VM_NAME, e)
