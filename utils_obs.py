import os
import time
import obsws_python as obs
import logging
from dotenv import load_dotenv

# Загружаем переменные из .env
load_dotenv()

logger = logging.getLogger(__name__)

OBS_WS_HOST = os.getenv("OBS_WS_HOST", "localhost")
OBS_WS_PORT = int(os.getenv("OBS_WS_PORT", "4444"))
OBS_WS_PASSWORD = os.getenv("OBS_WS_PASSWORD", "")

def start_record():
    try:
        client = obs.ReqClient(host=OBS_WS_HOST, port=OBS_WS_PORT, password=OBS_WS_PASSWORD)
        client.get_version()
        client.start_record()  # StartRecord (v5). :contentReference[oaicite:13]{index=13}
        st = client.get_record_status()
        logger.info(f"Recording: {st.output_active}")
    except Exception as e:
        logger.error(f"Ошибка при запуске записи в OBS: {e}")


def stop_record_and_wait():
    try:
        client = obs.ReqClient(host=OBS_WS_HOST, port=OBS_WS_PORT, password=OBS_WS_PASSWORD)
        client.get_version()
        res = client.stop_record()
        out_path = getattr(res, "output_path", None)
        for _ in range(120):
            st = client.get_record_status()     # GetRecordStatus. :contentReference[oaicite:15]{index=15}
            if not st.output_active:
                return out_path
            time.sleep(0.5)
        return out_path
    except Exception as e:
        logger.error(f"Ошибка при остановке записи в OBS: {e}")
        return None
