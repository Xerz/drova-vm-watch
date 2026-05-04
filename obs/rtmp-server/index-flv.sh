#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
    echo "usage: index-flv.sh <recorded-flv-path>" >&2
    exit 64
fi

in="$1"
tmp="${in}.indexed.tmp"

cleanup() {
    if [ -f "$tmp" ]; then
        rm -f "$tmp"
    fi
}

trap cleanup EXIT HUP INT TERM

yamdi -i "$in" -o "$tmp"
mv -f "$tmp" "$in"

trap - EXIT HUP INT TERM
