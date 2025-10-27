# ===== СТАДИЯ 1: СБОРКА nginx с модулем RTMP =====
FROM alpine:3.13.4 AS builder

RUN apk add --no-cache build-base git bash gcc make g++ zlib-dev linux-headers pcre-dev openssl-dev

WORKDIR /build

RUN git clone https://github.com/arut/nginx-rtmp-module.git && \
    git clone https://github.com/nginx/nginx.git

WORKDIR /build/nginx
RUN ./auto/configure \
    --add-module=../nginx-rtmp-module \
    --prefix=/usr/local/nginx \
    --with-http_ssl_module && \
    make && make install

# ===== СТАДИЯ 2: ФИНАЛЬНЫЙ ОБРАЗ =====
FROM alpine:3.13.4 AS runtime

RUN apk add --no-cache pcre ffmpeg curl

# Копируем собранный nginx
COPY --from=builder /usr/local/nginx /usr/local/nginx

# Конфигурация
COPY ./nginx.conf /usr/local/nginx/conf/nginx.conf

# Каталог для записей
RUN mkdir -p /recordings

EXPOSE 1935 8081

ENTRYPOINT ["/usr/local/nginx/sbin/nginx"]
CMD ["-g", "daemon off;"]
