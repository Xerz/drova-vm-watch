#!/usr/bin/env bash
set -euo pipefail

# === ПАРАМЕТРЫ ===
BASE_DS="tank/base"
SRC_CLONE="tank/win11-1-storage"
SNAP_NAME="clean"
CLONE1="tank/win11-1-storage"
CLONE2="tank/win11-2-storage"
VM1="win11-1"
VM2="win11-2"
HYP_CMD="virsh"         # virsh | qm | none
DRY_RUN=0
KEEP_OLD_BASE="yes"     # yes | no


print_usage(){
  cat <<'H'
commit_and_reclone_promote.sh [options]
Options:
  --base, --src-clone, --snap, --clone1, --clone2, --vm1, --vm2, --hyp
  --dry-run
  --keep-old-base yes|no (default: yes)
H
}

# --- парсинг
while (( $# )); do
  case "$1" in
    --keep-old-base) KEEP_OLD_BASE="$2"; shift 2 ;;
    --base) BASE_DS="$2"; shift 2 ;;
    --src-clone) SRC_CLONE="$2"; shift 2 ;;
    --snap) SNAP_NAME="$2"; shift 2 ;;
    --clone1) CLONE1="$2"; shift 2 ;;
    --clone2) CLONE2="$2"; shift 2 ;;
    --vm1) VM1="$2"; shift 2 ;;
    --vm2) VM2="$2"; shift 2 ;;
    --hyp) HYP_CMD="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) print_usage; exit 0 ;;
    *) echo "Неизвестный аргумент $1"; print_usage; exit 1 ;;
  esac
done

# --- утилиты
log(){ printf '%s\n' "$*" >&2; }
die(){ log "Ошибка: $*"; exit 1; }
run(){ (( DRY_RUN )) && printf 'DRY-RUN: %s\n' "$*" || eval "$@"; }
exists(){ zfs list -H "$1" >/dev/null 2>&1; }
isvol(){ [[ "$(zfs get -H -o value volsize "$1" 2>/dev/null || echo "-")" != "-" ]]; }
stop_vm(){
  case "$HYP_CMD" in
    virsh)
      run "virsh shutdown '$1' >/dev/null 2>&1 || true"
      for i in {1..30}; do
        [[ "$(virsh domstate "$1" 2>/dev/null)" == "shut off" ]] && return
        sleep 2
      done
      run "virsh destroy '$1' >/dev/null 2>&1 || true" ;;
    qm) run "qm shutdown '$1' --forceStop 1 >/dev/null 2>&1 || true";;
    none) :;;
  esac
}
start_vm(){
  case "$HYP_CMD" in
    virsh) run "virsh start '$1' >/dev/null 2>&1 || true";;
    qm)    run "qm start '$1' >/dev/null 2>&1 || true";;
    none)  :;;
  esac
}

# === Проверка sudo/root ===
if (( EUID != 0 )); then
  if sudo -v &>/dev/null; then
    log "Есть sudo-права — продолжаем..."
  else
    die "Требуются sudo-или root-права для выполнения скрипта."
  fi
else
  log "Запущен как root — продолжаем..."
fi

# --- проверки
command -v zfs >/dev/null 2>&1 || die "zfs не найден"
case "$HYP_CMD" in virsh) command -v virsh >/dev/null || die "virsh не найден";;
                    qm)   command -v qm    >/dev/null || die "qm не найден";;
                    none) :;; *) die "--hyp должен быть virsh|qm|none";; esac
exists "$BASE_DS"   || die "$BASE_DS не найден"
exists "$SRC_CLONE" || die "$SRC_CLONE не найден"
isvol "$BASE_DS"    || die "$BASE_DS не zvol"
isvol "$SRC_CLONE"  || die "$SRC_CLONE не zvol"
if [[ "$KEEP_OLD_BASE" == "yes" || "$KEEP_OLD_BASE" == "no" ]]; then
  :
else
  die "--keep-old-base должен быть 'yes' или 'no'"
fi

# === 1. выключение ВМ
log "[1] Останавливаю ВМ $VM1 и $VM2..."
[[ "$HYP_CMD" != "none" ]] && { stop_vm "$VM1"; stop_vm "$VM2"; }

TS="$(date +%Y%m%d-%H%M%S)"
OLD_BASE="${BASE_DS}-old-${TS}"

# === 2. promote + rename
log "[2] zfs promote ${SRC_CLONE} ..."
run "zfs promote '${SRC_CLONE}'"
log "[3] Переименование: ${BASE_DS} -> ${OLD_BASE}; ${SRC_CLONE} -> ${BASE_DS}"
run "zfs rename '${BASE_DS}' '${OLD_BASE}'"
run "zfs rename '${SRC_CLONE}' '${BASE_DS}'"

# === 3. новый снапшот базы
log "[4] snapshot ${BASE_DS}@${SNAP_NAME} ..."
run "zfs destroy -f '${BASE_DS}@${SNAP_NAME}' >/dev/null 2>&1 || true"
run "zfs snapshot '${BASE_DS}@${SNAP_NAME}'"

# === 4. пересоздаём клоны
log "[5a] Создаю клоны ${CLONE1} и ${CLONE2} ..."
run "zfs destroy -f '${CLONE1}' >/dev/null 2>&1 || true"
run "zfs destroy -f '${CLONE2}' >/dev/null 2>&1 || true"
run "zfs clone '${BASE_DS}@${SNAP_NAME}' '${CLONE1}'"
run "zfs clone '${BASE_DS}@${SNAP_NAME}' '${CLONE2}'"

# === 5. снапшоты клонов
log "[5b] Создаю снапшоты: ${CLONE1}@${SNAP_NAME}, ${CLONE2}@${SNAP_NAME}"
run "zfs snapshot '${CLONE1}@${SNAP_NAME}'"
run "zfs snapshot '${CLONE2}@${SNAP_NAME}'"

# === 6. удаление старого base (если нужно)
if [[ $KEEP_OLD_BASE == "no" ]]; then
  log "[6] Удаляю старый base: ${OLD_BASE}"
  run "zfs destroy -f '${OLD_BASE}'"
else
  log "[6] Сохраняю старый base как: ${OLD_BASE}"
fi

# === 7. запуск ВМ
log "[7] Запускаю ВМ..."
[[ "$HYP_CMD" != "none" ]] && { start_vm "$VM1"; start_vm "$VM2"; }

log "Готово."
