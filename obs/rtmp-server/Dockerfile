# ===== СТАДИЯ 1: СБОРКА nginx с модулем RTMP =====
FROM alpine:3.22 AS builder

ARG NGINX_VERSION=1.28.3
ARG NGINX_RTMP_MODULE_VERSION=v1.2.2-r1

RUN apk add --no-cache \
    build-base \
    curl \
    linux-headers \
    openssl-dev \
    pcre2-dev \
    zlib-dev

WORKDIR /build

RUN curl -fsSLO "https://nginx.org/download/nginx-${NGINX_VERSION}.tar.gz" \
    && curl -fsSLO "https://github.com/sergey-dryabzhinsky/nginx-rtmp-module/archive/refs/tags/${NGINX_RTMP_MODULE_VERSION}.tar.gz" \
    && tar -xzf "nginx-${NGINX_VERSION}.tar.gz" \
    && tar -xzf "${NGINX_RTMP_MODULE_VERSION}.tar.gz"

WORKDIR /build/nginx-${NGINX_VERSION}

RUN ./configure \
    --add-module="../nginx-rtmp-module-${NGINX_RTMP_MODULE_VERSION#v}" \
    --prefix=/usr/local/nginx \
    --with-http_ssl_module \
    --with-pcre-jit \
    && make -j"$(getconf _NPROCESSORS_ONLN)" \
    && make install

# ===== СТАДИЯ 2: ФИНАЛЬНЫЙ ОБРАЗ =====
FROM alpine:3.22 AS runtime

RUN apk add --no-cache \
    openssl \
    pcre2 \
    zlib

COPY --from=builder /usr/local/nginx /usr/local/nginx
COPY ./docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
COPY ./nginx.conf.template /etc/obs-rtmp/nginx.conf.template

RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
    && mkdir -p /recordings /etc/nginx \
    && chmod 0777 /recordings

EXPOSE 1935

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["/usr/local/nginx/sbin/nginx", "-g", "daemon off;"]
