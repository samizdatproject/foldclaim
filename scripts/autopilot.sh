#!/bin/zsh
# Walks the mainnet demo to the end while nobody watches: activate epoch 1 once its audit window has passed,
# sync, claim for the 10 demo recipients, propose epoch 2, and the same again for two top-up claims.
# Each step is retried every 10 minutes until state.json records it; a refused broadcast costs nothing, and
# steps.ts never repeats a recorded step.
cd "${0:A:h}/.."
NET=${1:-mainnet}
LOG=deployments/$NET/autopilot.log
run() { node --experimental-transform-types --no-warnings scripts/run.ts $NET "$@"; }
done_() { python3 -c "import json,sys; sys.exit(0 if '$1' in json.load(open('deployments/$NET/state.json'))['steps'] else 1)"; }
until_done() {
  local key=$1; shift
  until done_ $key; do
    echo "$(date -u +%FT%TZ) $*" >>$LOG
    run "$@" >>$LOG 2>&1 || sleep 600
  done
}
until_done activate1 activate 1
until_done sync1 sync 1
until_done claim1-9 claim 1 all
until_done propose2 propose 2
until_done activate2 activate 2
until_done sync2 sync 2
until_done claim2-9 claim 2 0,9
echo "$(date -u +%FT%TZ) autopilot finished" >>$LOG
run status >>$LOG 2>&1
