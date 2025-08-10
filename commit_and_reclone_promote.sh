#!/usr/bin/env bash
set -euo pipefail

# === ПАРАМЕТРЫ ПО УМОЛЧАНИЮ ===
BASE_DS="tank/base"
SRC_CLONE="tank/win11-1-storage"
SNAP_NAME="clean"
CLONE1="tank/win11-1-storage"
CLONE2="tank/win11-2-storage"

VM1="win11-1"
VM2="win11-2"
HYP_CMD="virsh"          # virsh | qm | none

DRY_RUN=0
KEEP_OLD_BASE="yes"      # yes | no

# Явный URI важен, чтобы не попасть в qemu:///session
VIRSH="virsh -c qemu:///system"

print_usage(){
  cat <<'H'
commit_and_reclone_promote.sh [options]

Логика:
  1) Выключить обе ВМ
  2) zfs promote SRC_CLONE; переименовать BASE_DS -> BASE_DS-old-TS и SRC_CLONE -> BASE_DS
  3) Пересоздать снапшот BASE_DS@SNAP_NAME
  4) Пересоздать клоны CLONE1 и CLONE2 от BASE_DS@SNAP_NAME
  5) Сделать снапшоты на клонах: {CLONE1,CLONE2}@SNAP_NAME
  6) (опц.) удалить старый base; 7) запустить ВМ

Опции:
  --base <pool/ds>        (default: tank/base)
  --src-clone <pool/ds>   (default: tank/win11-1-storage)
  --snap <name>           (default: clean)
  --clone1 <pool/ds>      (default: tank/win11-1-storage)
  --clone2 <pool/ds>      (default: tank/win11-2-storage)
  --vm1 <name>            (default: win11-1)
  --vm2 <name>            (default: win11-2)
  --hyp <virsh|qm|none>   (default: virsh) — управляет только stop/start
  --keep-old-base yes|no  (default: yes)
  --dry-run               печатать команды, не выполнять
  -h|--help               показать помощь

Примеры:
  ./commit_and_reclone_promote.sh --dry-run
  ./commit_and_reclone_promote.sh --keep-old-base no
H
}

# --- парсинг аргументов ---
while (( $# )); do
  case "$1" in
    --base)       BASE_DS="$2"; shift 2;;
    --src-clone)  SRC_CLONE="$2"; shift 2;;
    --snap)       SNAP_NAME="$2"; shift 2;;
    --clone1)     CLONE1="$2"; shift 2;;
    --clone2)     CLONE2="$2"; shift 2;;
    --vm1)        VM1="$2"; shift 2;;
    --vm2)        VM2="$2"; shift 2;;
    --hyp)        HYP_CMD="$2"; shift 2;;
    --keep-old-base) KEEP_OLD_BASE="$2"; shift 2;;
    --dry-run)    DRY_RUN=1; shift;;
    -h|--help)    print_usage; exit 0;;
    *) echo "Неизвестный аргумент: $1"; print_usage; exit 1;;
  esac
done

# --- утилиты ---
log(){ printf '%s\n' "$*" >&2; }
die(){ log "Ошибка: $*"; exit 1; }

# общий раннер для любых команд (zfs, rm, etc.) — без eval
run_cmd() {
  if [[ ${DRY_RUN:-0} -eq 1 ]]; then
    printf 'DRY-RUN:'; for a in "$@"; do printf ' %q' "$a"; done; echo
  else
    "$@"
  fi
}

# раннер для virsh с явным URI
run_virsh() {
  if [[ ${DRY_RUN:-0} -eq 1 ]]; then
    printf 'DRY-RUN: %s' "$VIRSH"
    for a in "$@"; do printf ' %q' "$a"; done
    echo
  else
    # shellcheck disable=SC2086
    $VIRSH "$@"
  fi
}

exists_ds(){ zfs list -H "$1" >/dev/null 2>&1; }
is_zvol(){ [[ "$(zfs get -H -o value volsize "$1" 2>/dev/null || echo "-")" != "-" ]]; }

# --- функции управления ВМ ---
stop_vm(){
  case "$HYP_CMD" in
    virsh)
      run_virsh shutdown "$1" || true
      for i in {1..30}; do
        state="$( $VIRSH domstate "$1" 2>/dev/null || true )"
        [[ "$state" == "shut off" ]] && return 0
        sleep 2
      done
      run_virsh destroy "$1" || true
      ;;
    qm)
      if [[ ${DRY_RUN:-0} -eq 1 ]]; then
        echo "DRY-RUN: qm shutdown '$1' --forceStop 1"
      else
        qm shutdown "$1" --forceStop 1 >/dev/null 2>&1 || true
      fi
      for i in {1..30}; do
        st="$(qm status "$1" 2>/dev/null || true)"
        [[ "$st" == *stopped* ]] && return 0
        sleep 2
      done
      if [[ ${DRY_RUN:-0} -eq 1 ]]; then
        echo "DRY-RUN: qm stop '$1'"
      else
        qm stop "$1" >/dev/null 2>&1 || true
      fi
      ;;
    none) :;;
  esac
}

start_vm(){
  case "$HYP_CMD" in
    virsh) run_virsh start "$1" || true;;
    qm)
      if [[ ${DRY_RUN:-0} -eq 1 ]]; then
        echo "DRY-RUN: qm start '$1'"
      else
        qm start "$1" >/dev/null 2>&1 || true
      fi
      ;;
    none) :;;
  esac
}

# === Проверка sudo/root ===
if (( EUID != 0 )); then
  if sudo -v &>/dev/null; then
    log "Есть sudo-права — продолжаем..."
  else
    die "Нужны sudo- или root-права."
  fi
else
  log "Запущен как root — ок."
fi

# --- проверки окружения/зависимостей ---
command -v zfs   >/dev/null 2>&1 || die "zfs не найден"
case "$HYP_CMD" in
  virsh)
    command -v virsh >/dev/null 2>&1 || die "virsh не найден"
    # проверим подключение к qemu:///system
    $VIRSH list --all >/dev/null 2>&1 || die "virsh connection failed (qemu:///system)"
    ;;
  qm)   command -v qm >/dev/null 2>&1 || die "qm не найден";;
  none) :;;
  *)    die "--hyp должен быть virsh|qm|none";;
esac

exists_ds "$BASE_DS"   || die "$BASE_DS не найден"
exists_ds "$SRC_CLONE" || die "$SRC_CLONE не найден"
is_zvol   "$BASE_DS"   || die "$BASE_DS не zvol"
is_zvol   "$SRC_CLONE" || die "$SRC_CLONE не zvol"

if [[ "$KEEP_OLD_BASE" != "yes" && "$KEEP_OLD_BASE" != "no" ]]; then
  die "--keep-old-base должен быть 'yes' или 'no'"
fi

# === 1. выключение ВМ ===
log "[1] Останавливаю ВМ $VM1 и $VM2..."
[[ "$HYP_CMD" != "none" ]] && { stop_vm "$VM1"; stop_vm "$VM2"; }

TS="$(date +%Y%m%d-%H%M%S)"
OLD_BASE="${BASE_DS}-old-${TS}"

# === 2. promote + rename ===
log "[2] zfs promote ${SRC_CLONE} ..."
run_cmd zfs promote "$SRC_CLONE"

log "[3] Переименование: ${BASE_DS} -> ${OLD_BASE}; ${SRC_CLONE} -> ${BASE_DS}"
run_cmd zfs rename "$BASE_DS" "$OLD_BASE"
run_cmd zfs rename "$SRC_CLONE" "$BASE_DS"

# === 3. пересоздаём эталонный снапшот ===
log "[4] Снэп: ${BASE_DS}@${SNAP_NAME}"
run_cmd zfs destroy -f "${BASE_DS}@${SNAP_NAME}" >/dev/null 2>&1 || true
run_cmd zfs snapshot "${BASE_DS}@${SNAP_NAME}"

# === 4. пересоздаём клоны от base@snap ===
log "[5a] Клоны: ${CLONE1}, ${CLONE2}"
run_cmd zfs destroy -f "$CLONE1" >/dev/null 2>&1 || true
run_cmd zfs destroy -f "$CLONE2" >/dev/null 2>&1 || true
run_cmd zfs clone "${BASE_DS}@${SNAP_NAME}" "$CLONE1"
run_cmd zfs clone "${BASE_DS}@${SNAP_NAME}" "$CLONE2"

# === 5. снапшоты на клонах ===
log "[5b] Снэпы клонов: ${CLONE1}@${SNAP_NAME}, ${CLONE2}@${SNAP_NAME}"
run_cmd zfs snapshot "${CLONE1}@${SNAP_NAME}"
run_cmd zfs snapshot "${CLONE2}@${SNAP_NAME}"

# === 6. удаление старого base (опционально) ===
if [[ "$KEEP_OLD_BASE" == "no" ]]; then
  log "[6] Удаляю старый base: ${OLD_BASE}"
  run_cmd zfs destroy -f "$OLD_BASE"
else
  log "[6] Сохраняю старый base как: ${OLD_BASE}"
fi

# === 7. запуск ВМ ===
log "[7] Запускаю ВМ..."
[[ "$HYP_CMD" != "none" ]] && { start_vm "$VM1"; start_vm "$VM2"; }

log "Готово."
