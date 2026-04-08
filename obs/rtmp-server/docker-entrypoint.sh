#!/bin/sh
set -eu

RTMP_APP="${RTMP_APP:-live}"
RECORD_PATH="${RECORD_PATH:-/recordings}"
RECORD_SUFFIX="${RECORD_SUFFIX:-_%Y-%m-%d_%H-%M-%S.flv}"
PUBLISH_ALLOWLIST="${PUBLISH_ALLOWLIST:-}"

escape_sed_replacement() {
    printf '%s' "$1" | sed 's/[&|\\]/\\&/g'
}

generate_allowlist() {
    target_file="/etc/nginx/publish-allowlist.conf"

    : > "${target_file}"

    if [ -z "${PUBLISH_ALLOWLIST}" ]; then
        cat <<'EOF' > "${target_file}"
# Empty allowlist: publishing is allowed from any source IP.
EOF
        return
    fi

    printf '%s' "${PUBLISH_ALLOWLIST}" | tr ',;' '\n' | while IFS= read -r raw || [ -n "${raw}" ]; do
        entry="$(printf '%s' "${raw}" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"

        if [ -z "${entry}" ]; then
            continue
        fi

        printf '        allow publish %s;\n' "${entry}" >> "${target_file}"
    done

    if [ ! -s "${target_file}" ]; then
        cat <<'EOF' > "${target_file}"
# Empty allowlist after parsing: publishing is allowed from any source IP.
EOF
        return
    fi

    printf '        deny publish all;\n' >> "${target_file}"
}

render_nginx_config() {
    escaped_app="$(escape_sed_replacement "${RTMP_APP}")"
    escaped_record_path="$(escape_sed_replacement "${RECORD_PATH}")"
    escaped_record_suffix="$(escape_sed_replacement "${RECORD_SUFFIX}")"

    sed \
        -e "s|__RTMP_APP__|${escaped_app}|g" \
        -e "s|__RECORD_PATH__|${escaped_record_path}|g" \
        -e "s|__RECORD_SUFFIX__|${escaped_record_suffix}|g" \
        /etc/obs-rtmp/nginx.conf.template > /usr/local/nginx/conf/nginx.conf
}

mkdir -p "${RECORD_PATH}" /etc/nginx
generate_allowlist
render_nginx_config
/usr/local/nginx/sbin/nginx -t -c /usr/local/nginx/conf/nginx.conf

exec "$@"
