#!/bin/zsh
# Walks the mainnet demo forward while nobody watches: activate each epoch once its 144-block audit window has
# passed, sync it into the pool, and propose the next one. Epoch 1 ran with claims for all 10 demo recipients;
# from epoch 2 on the autopilot claims nothing, so every demo recipient stays claimable from the demo page
# (one click, the demo relayer pays the fee). One new epoch per day keeps fresh claims available.
# Each step is retried every 10 minutes until state.json records it; a refused broadcast costs nothing, and
# steps.ts never repeats a recorded step. After each step, scripts/publish-demo.local.sh (if present, not
# committed) copies the state to the relayer server, pushes it and rebuilds the demo page.
cd "${0:A:h}/.."
NET=${1:-mainnet}
LAST=${2:-7}
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
publish() { [[ -x scripts/publish-demo.local.sh && $NET == mainnet ]] && scripts/publish-demo.local.sh "$1" || true; }

until_done activate1 activate 1
until_done sync1 sync 1
until_done claim1-9 claim 1 all
until_done propose2 propose 2
for n in $(seq 2 $LAST); do
  until_done activate$n activate $n
  until_done sync$n sync $n
  publish "epoch $n active and synced"
  if (( n < LAST )); then
    until_done propose$((n + 1)) propose $((n + 1))
    publish "epoch $((n + 1)) proposed"
  fi
done
echo "$(date -u +%FT%TZ) autopilot finished" >>$LOG
run status >>$LOG 2>&1
