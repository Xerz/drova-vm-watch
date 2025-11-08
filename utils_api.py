import json
import os
import time
import logging
import requests

from dotenv import load_dotenv

# Загружаем переменные из .env
load_dotenv()

logger = logging.getLogger(__name__)

# пустой POST https://services.drova.io/server-manager/servers/{SERVER_UUID}/set_published/true — убрать сервер в приват
# пустой POST https://services.drova.io/server-manager/servers/{SERVER_UUID}/set_published/false — опубликовать сервер

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

# AUTH_TOKEN берём из token.json

with open("token.json", "r") as f:
    token_data = json.load(f)

SLEEP_TIME = int(os.getenv("SLEEP_TIME", "10"))
SERVER_UUID = os.getenv("SERVER_UUID")
USER_ID = os.getenv("USER_ID")
SESSIONS_ENDPOINT = "https://services.drova.io/session-manager/sessions"
SERVER_ENDPOINT = f"https://services.drova.io/server-manager/servers/{SERVER_UUID}"
VISIBILITY_ENDPOINT = f"https://services.drova.io/server-manager/servers/{SERVER_UUID}/set_published/"
RENEWAL_ENDPOINT = f"https://services.drova.io/server-manager/servers/{SERVER_UUID}/renew"
AUTH_TOKEN = token_data.get("auth_token")
HEADERS = {"X-Auth-Token": AUTH_TOKEN}


# Функция для request и при необходимости обновления токена один раз перед окончательной ошибкой
def request_token_renewal():
    global AUTH_TOKEN
    try:
        r = requests.post(RENEWAL_ENDPOINT, json={"proxy_token": AUTH_TOKEN}, timeout=5)
        r.raise_for_status()
        data = r.json()
        new_token = data.get("proxyToken")
        if new_token:
            AUTH_TOKEN = new_token
            HEADERS["X-Auth-Token"] = AUTH_TOKEN
            with open("token.json", "w") as f:
                json.dump({"auth_token": AUTH_TOKEN}, f)
            logger.info("Token renewed successfully")
        else:
            logger.error("Failed to renew token: no new token in response")
    except Exception as e:
        logger.error(f"Ошибка при продлении токена: {e}")


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


def get_last_session_status(statuses):
    try:
        params = [("status", status) for status in statuses]
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


def get_station_status(statuses):
    try:
        r = safe_request("GET", SERVER_ENDPOINT)
        r.raise_for_status()
        data = r.json()
        return data.get("state")
    except Exception as e:
        logger.error(f"Ошибка запроса статуса сервера: {e}")
        return None

def get_station_published():
    try:
        r = safe_request("GET", SERVER_ENDPOINT)
        r.raise_for_status()
        data = r.json()
        return data.get("published") == "true"
    except Exception as e:
        logger.error(f"Ошибка запроса статуса публикации сервера: {e}")
        return "false"

def set_station_published(published: bool):
    try:
        url = VISIBILITY_ENDPOINT + ("true" if published else "false")
        r = safe_request("POST", url)
        r.raise_for_status()
        logger.info(f"Set server published={published} successfully")
    except Exception as e:
        logger.error(f"Ошибка установки видимости сервера: {e}")


def wait_for_status(get_status, statuses, desired: bool, timeout=0):
    waiting_msg_printed = False
    waited = 0
    while True:
        if not waiting_msg_printed:
            logger.info(f"Waiting for station to become {'in' if desired else 'not in'} {statuses} (current: {station_status})")
            waiting_msg_printed = True
        else:
            logger.debug(f"Still waiting (station_status={station_status})")
        station_status = get_status(statuses)
        if desired:
            if station_status and station_status in statuses:
                return
        else:
            if station_status and station_status not in statuses:
                return
        time.sleep(SLEEP_TIME)
        if timeout:
            waited += SLEEP_TIME
            if waited >= timeout:
                logger.warning(f"Timeout reached ({timeout} seconds) while waiting for station status")
                return
