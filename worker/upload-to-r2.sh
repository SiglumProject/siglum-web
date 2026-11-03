#!/usr/bin/env bash
set -euo pipefail
echo 'Unversioned uploads are disabled. Use siglum-engine/scripts/release.sh with a verified immutable runtime. See README.md release order.' >&2
exit 1
