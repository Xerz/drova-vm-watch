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


# Настройка логгера
logging.basicConfig(
    level=getattr(logging, LOG_LEVEL, logging.INFO),
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger(__name__)

# Загружаем переменные из .env
load_dotenv()

# AUTH_TOKEN берём из token.json
with open("token.json", "r") as f:
    token_data = json.load(f)
AUTH_TOKEN = token_data.get("auth_token")

VM_NAME = os.getenv("VM_NAME", "my-vm")
SLEEP_TIME = int(os.getenv("SLEEP_TIME", "10"))
SNAPSHOT_NAME = os.getenv("SNAPSHOT_NAME", "clean")
LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO").upper()
ZFS_SNAPSHOTS = [
    f"tank/{VM_NAME}@clean",
    f"tank/{VM_NAME}-storage@clean"
]
GRACE_PERIOD = int(os.getenv("GRACE_PERIOD", "120")) # время, которое даётся ВМ для мягкого выключения и станции для перехода из занятого состояния
CHECK_INTERVAL = 1  # секунды между проверками статуса ВМ при выключении

OBS_WS_HOST = os.getenv("OBS_WS_HOST", "localhost")
OBS_WS_PORT = int(os.getenv("OBS_WS_PORT", "4444"))
OBS_WS_PASSWORD = os.getenv("OBS_WS_PASSWORD", "")

SERVER_UUID = os.getenv("SERVER_UUID")
USER_ID = os.getenv("USER_ID")
SESSIONS_ENDPOINT = "https://services.drova.io/session-manager/sessions"
SERVER_ENDPOINT = f"https://services.drova.io/server-manager/servers/{SERVER_UUID}"

# пустой POST https://services.drova.io/server-manager/servers/{SERVER_UUID}/set_published/true — убрать сервер в приват
# пустой POST https://services.drova.io/server-manager/servers/{SERVER_UUID}/set_published/false — опубликовать сервер
VISIBILITY_ENDPOINT = f"https://services.drova.io/server-manager/servers/{SERVER_UUID}/set_published/"

# POST https://services.drova.io/token-verifier/renewProxyToken with body {"proxy_token": AUTH_TOKEN}, возвращает
# {
# 	"proxyToken": "newToken",
# 	"verificationStatus": "success",
# 	"client_id": USER_ID,
# 	"client_roles": [
# 		"client",
# 		"merchant"
# 	],
# 	"server_id": null,
# 	"session_id": null
# }
RENEWAL_ENDPOINT = f"https://services.drova.io/server-manager/servers/{SERVER_UUID}/renew"
HEADERS = {"X-Auth-Token": AUTH_TOKEN}


def request_token_renewal():
    try:
        r = requests.post(RENEWAL_ENDPOINT, json={"proxy_token": AUTH_TOKEN}, timeout=5)
        r.raise_for_status()
        data = r.json()
        new_token = data.get("proxyToken")
        if new_token:
            global AUTH_TOKEN
            AUTH_TOKEN = new_token
            HEADERS["X-Auth-Token"] = AUTH_TOKEN
            logger.info("Token renewed successfully")
        else:
            logger.error("Failed to renew token: no new token in response")
    except Exception as e:
        logger.error(f"Ошибка при продлении токена: {e}")

# Функция для request и при необходимости обновления токена один раз перед окончательной ошибкой
def safe_request(method, url, **kwargs):
    try:
        r = requests.request(method, url, headers=HEADERS, timeout=5, **kwargs)
        r.raise_for_status()
        return r
    except requests.HTTPError as e:
        if e.response.status_code == 401:  # Unauthorized, возможно токен истёк
            logger.info("Token expired, attempting to renew")
            request_token_renewal()
            r = requests.request(method, url, headers=HEADERS, timeout=5, **kwargs)
            r.raise_for_status()
            return r
        else:
            raise

def get_last_session_status():
    try:
        params = [("status", status) for status in ACTIVE_SESSION_STATUSES]
        params.append(("server_id", SERVER_UUID))
        params.append(("limit" , "2"))
        r = safe_request("GET", SESSIONS_ENDPOINT, params=params)
        r.raise_for_status()
        sessions = r.json().get("sessions", [])
        if not sessions:
            # No active sessions returned from server, return "Inactive"
            return "INACTIVE"

        data = sessions[0]
        server_id = data.get("server_id")
        if server_id != SERVER_UUID:
            # Скорее всего, теперь бесполезная проверка (мы передаём параметр server_id)
            raise RuntimeError("Server UUID does not match, check your Token-Server pair")

        return data.get("status")
    except Exception as e:
        logger.error(f"Ошибка запроса: {e}")
        return None

def get_station_status():
    try:
        r = safe_request("GET", SERVER_ENDPOINT)
        r.raise_for_status()
        data = r.json()
        return data.get("state")
    except Exception as e:
        logger.error(f"Ошибка запроса статуса сервера: {e}")
        return None

def set_station_published(published: bool):
    try:
        url = VISIBILITY_ENDPOINT + ("true" if published else "false")
        r = safe_request("POST", url)
        r.raise_for_status()
        logger.info(f"Set server published={published} successfully")
    except Exception as e:
        logger.error(f"Ошибка установки видимости сервера: {e}")

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
    logger.info(f"Recording: {st.output_active}")

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

ACTIVE_SESSION_STATUSES = ("ACTIVE", "HANDSHAKE", "NEW")  # Статусы активной сессии
BUSY_STATION_STATUSES = ("BUSY", "HANDSHAKE")

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
            state = get_last_session_status()
            if state in ACTIVE_SESSION_STATUSES:
                logger.info(f"VM {VM_NAME} entered session state: {state}")
                try:
                    obs_client = obs.ReqClient(host=OBS_WS_HOST, port=OBS_WS_PORT, password=OBS_WS_PASSWORD)
                    obs_client.get_version()
                    start_record(obs_client)
                except Exception as e:
                    logger.error(f"Не удалось подключиться к OBS WebSocket и / или начать запись: {e}")
                finally:
                    obs_client = None
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
            state = get_last_session_status()
            if state and state not in ACTIVE_SESSION_STATUSES:
                logger.info(f"Session state changed to {state}")

                # Переводим сервера в приватный режим
                set_station_published(published=False)

                logger.info(f"Waiting for server station to be not in {BUSY_STATION_STATUSES} (current: {station_status})")

                # Ждем, пока сервер станет не BUSY или не пройдёт ограничение по времени
                waited = 0
                while True:
                    station_status = get_station_status()
                    if station_status not in BUSY_STATION_STATUSES and waited < GRACE_PERIOD:
                        logger.info(f"Server station status is now {station_status} → proceeding to reset VM {VM_NAME}")
                        break
                    time.sleep(SLEEP_TIME)
                    waited += SLEEP_TIME

                try:
                    reset_vm(dom)
                except libvirt.libvirtError as e:
                    logger.error(f"Ошибка при перезагрузке: {e}")

                try:
                    obs_client = obs.ReqClient(host=OBS_WS_HOST, port=OBS_WS_PORT, password=OBS_WS_PASSWORD)
                    obs_client.get_version()
                    stop_record_and_wait(obs_client)
                except Exception as e:
                    logger.error(f"Ошибка при остановке записи в OBS: {e}")
                finally:
                    obs_client = None

                set_station_published(published=True)
                break
            if not waiting_msg_printed:
                logger.info(f"Waiting for not in {ACTIVE_SESSION_STATUSES} (current: {state})")
                waiting_msg_printed = True
            else:
                logger.debug(f"Still in {ACTIVE_SESSION_STATUSES} (state={state})")
            time.sleep(SLEEP_TIME)


if __name__ == "__main__":
    main()
