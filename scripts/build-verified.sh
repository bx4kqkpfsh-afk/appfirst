#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ "${SITES_ENV_READY:-}" != "1" ]]; then
  exec "${script_dir}/sites-env.sh" -- "$0" "$@"
fi

command -v timeout >/dev/null || {
  echo "build-verified.sh requires GNU timeout." >&2
  exit 69
}

vinext="${SITES_PROJECT_ROOT}/node_modules/.bin/vinext"
if [[ ! -x "${vinext}" ]]; then
  echo "vinext is unavailable. Run npm run install:ci and wait for it to finish before building." >&2
  exit 69
fi

echo "Running bounded vinext build..."
timeout \
  --signal=TERM \
  --kill-after="${SITES_BUILD_KILL_AFTER:-10s}" \
  "${SITES_BUILD_TIMEOUT:-3m}" \
  "${vinext}" build

echo "Building static SPA and resilient Worker entry..."
"${SITES_PROJECT_ROOT}/node_modules/.bin/vite" build --config vite.spa.config.ts
core_source="${SITES_PROJECT_ROOT}/node_modules/tesseract.js-core"
core_target="${SITES_PROJECT_ROOT}/dist/client/tesseract-core"
if [[ -d "${core_source}" ]]; then
  mkdir -p "${core_target}"
  cp "${core_source}"/tesseract-core*.wasm.js "${core_target}/"
fi
"${SITES_PROJECT_ROOT}/node_modules/.bin/vite" build --config vite.worker.config.ts
cp "${SITES_PROJECT_ROOT}/worker/wrangler.json" "${SITES_PROJECT_ROOT}/dist/server/wrangler.json"

"${script_dir}/validate-artifact.sh"
