#!/bin/sh
set -eu

mkdir -p /data
chown -R appuser:appuser /data
exec gosu appuser "$@"
