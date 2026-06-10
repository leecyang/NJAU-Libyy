#!/bin/sh
set -eu

mkdir -p /data/playwright-profiles
chown -R appuser:appuser /data
exec gosu appuser "$@"
