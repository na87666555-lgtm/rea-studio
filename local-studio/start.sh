#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"
rea_python=${REA_PYTHON:-python3}
if [ "${1:-}" = "--setup-web" ]; then
    shift
    "$rea_python" -m venv .rea-venv
    .rea-venv/bin/python -m pip install 'playwright>=1.51,<2'
    if [ -z "${REA_CHROMIUM_PATH:-}" ]; then
        .rea-venv/bin/python -m playwright install chromium
    fi
fi
if [ -x .rea-venv/bin/python ]; then
    rea_python=.rea-venv/bin/python
fi
exec "$rea_python" server.py --open "$@"
