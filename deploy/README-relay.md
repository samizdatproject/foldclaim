# Deploying the FoldClaim demo relayer

The relayer (`relay/server.ts`) is a small `node:http` service. It submits claims for the ten demo recipients and pays
the fee from its own key. It is deployed as one bundle, `dist/relay.mjs`, which runs on the server's system Node
(20 or newer). The steps below put it on Ubuntu 24.04 (systemd 255) behind nginx, on the subdomain
`foldclaim.cls9.com` (a placeholder). Nothing here has been run yet.

The rules for this install:
- Everything is built on your machine and copied over. The server runs no npm and no build.
- Everything under `/opt/foldclaim` is owned by `root:root` and not group- or world-writable. The service user
  `foldclaim` can read the code but cannot change it.
- The relayer key goes into `/etc/foldclaim/relayer.wif` (`root:root`, mode 600, directory 700), and it is installed
  last. systemd hands it to the service as a credential.

Files in this directory:

| File | Goes to |
|---|---|
| `foldclaim-relay.service` | `/etc/systemd/system/foldclaim-relay.service` |
| `relay.env.example` | `/opt/foldclaim/relay.env` (no secrets in it) |
| `nginx-foldclaim-relay.conf` | the zone lines in `/etc/nginx/conf.d/foldclaim-relay-zones.conf`, the server blocks in `/etc/nginx/sites-available/foldclaim-relay` |

**When to deploy.** Wait until `scripts/autopilot.sh` has finished on mainnet. Both processes spend the pool's master
UTXO, so a relayed claim and an autopilot step sent at the same moment would conflict and one would fail. Also,
autopilot claims all ten demo leaves for epoch 1, so until epoch 2 is synced the relayer can only answer
`nothing to claim`.

## 1. Build on your machine (repository root)

```sh
npm run relay:build          # esbuild → dist/relay.mjs (Node 20 target; npm packages stay external)

# Production node_modules, built in a clean temp dir (no install scripts run):
BUILD=$(mktemp -d)
cp package.json package-lock.json "$BUILD"/
(cd "$BUILD" && npm ci --omit=dev --ignore-scripts)
```

All runtime dependencies (`@solidcash/solidcash`, `@bitauth/libauth`, the electrum client) are pure JavaScript, so a
`node_modules` built on macOS works on Linux. `package-lock.json` fetches `@bitauth/libauth` from a GitHub fork over
SSH, which is one more reason to install here, where `git` and your GitHub access already work, and not on the server.

## 2. Server: user and directories

```sh
node --version          # 20 or newer (system Node at /usr/bin/node, as in ExecStart)
sudo apt install nginx certbot rsync
sudo useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin foldclaim
sudo install -d -o root -g root -m 755 /opt/foldclaim
sudo install -d -o root -g root -m 700 /etc/foldclaim
```

## 3. Copy the files

From the repository root on your machine:

```sh
HOST=user@server
OWN='--chown=root:root --chmod=Du=rwx,Dgo=rx,Fu=rw,Fgo=r'
rsync -av --relative --rsync-path="sudo rsync" $OWN \
  dist/relay.mjs package.json \
  deployments/mainnet/state.json deployments/mainnet/public.json \
  deployments/mainnet/FoldClaimPool.artifact.json deployments/mainnet/RootRegistry.artifact.json \
  deployments/mainnet/tree-epoch*.json \
  deploy/foldclaim-relay.service deploy/relay.env.example \
  "$HOST":/opt/foldclaim/
rsync -a --delete --rsync-path="sudo rsync" $OWN "$BUILD/node_modules/" "$HOST":/opt/foldclaim/node_modules/
```

`package.json` is not strictly needed, because `.mjs` is always ESM, but it documents what is installed. Do not copy
`secrets/` here. The key comes last, in step 7.

**After every new epoch:** once autopilot has synced it on-chain, rsync the new `deployments/mainnet/tree-epoch<N>.json`
with the same `$OWN` flags. The relay finds the epoch file for the pool's current root by itself (cached by file name
and modification time), so no restart is needed. Until the file is there, it answers
`no epoch file for the current root`.

## 4. Environment file

```sh
sudo install -o root -g root -m 644 /opt/foldclaim/deploy/relay.env.example /opt/foldclaim/relay.env
sudoedit /opt/foldclaim/relay.env
```

- Keep `HOST=127.0.0.1`, because only nginx should reach the relay.
- Keep `TRUST_PROXY=1` behind nginx. Without it, every client looks like 127.0.0.1 and shares one rate limit.
- Do not add `RELAYER_WIF_FILE` here. The unit sets it to the systemd credential, and `EnvironmentFile=` would
  override that.

## 5. nginx and certbot

1. Add DNS: point `foldclaim.cls9.com` (an A record only; see the IPv6 caveat in the nginx file) at the server.
2. Put the zone lines (`limit_req_zone`, `map`, `limit_conn_zone`) into `/etc/nginx/conf.d/foldclaim-relay-zones.conf`.
3. Create `/etc/nginx/sites-available/foldclaim-relay` with **only the port-80 server block**. The certificate does
   not exist yet, so the 443 block would fail `nginx -t`. Then:
   ```sh
   sudo ln -s /etc/nginx/sites-available/foldclaim-relay /etc/nginx/sites-enabled/
   sudo mkdir -p /var/www/html && sudo nginx -t && sudo systemctl reload nginx
   sudo certbot certonly --webroot -w /var/www/html -d foldclaim.cls9.com --deploy-hook "systemctl reload nginx"
   ```
4. Add the 443 server block and the `@foldclaim_rate_limited` location, then run
   `sudo nginx -t && sudo systemctl reload nginx`. Certbot's timer renews the certificate.

To serve the relay from a path on an existing server instead of a subdomain, use the commented
`location /foldclaim-relay/` block. It includes its own JSON 429 handler. Build the page with
`RELAY_URL=https://<existing-host>/foldclaim-relay`.

## 6. systemd (not started yet)

```sh
sudo install -o root -g root -m 644 /opt/foldclaim/deploy/foldclaim-relay.service /etc/systemd/system/
sudo systemctl daemon-reload
systemd-analyze verify /etc/systemd/system/foldclaim-relay.service
systemd-analyze security foldclaim-relay.service     # exposure score of the sandbox
```

## 7. The key, last

Copy the key into your home directory on the server, install it root-only, and delete the copy:

```sh
rsync --chmod=F600 secrets/mainnet-relayer.wif "$HOST":foldclaim-relayer.wif
ssh -t "$HOST" 'sudo install -o root -g root -m 600 ~/foldclaim-relayer.wif /etc/foldclaim/relayer.wif && shred -u ~/foldclaim-relayer.wif'
```

The service never reads `/etc/foldclaim` itself. systemd loads the file (`LoadCredential=`) into a private
credentials directory that only the running service can read, at `$CREDENTIALS_DIRECTORY/relayer.wif`.

## 8. Start and check

```sh
sudo systemctl enable --now foldclaim-relay
systemctl status foldclaim-relay     # the Memory: line shows usage against MemoryMax=256M
journalctl -u foldclaim-relay -f     # one line per request; the first line names the relayer address
curl -s http://127.0.0.1:8792/health
curl -s https://foldclaim.cls9.com/status
```

If the unit fails with status `243/CREDENTIALS`, or the relay cannot read its key, remove `PrivateUsers=true` from the
unit first. It is the one sandbox option not tested together with `LoadCredential=`. Then run
`daemon-reload` and restart.

## 9. Fund the relayer

The address is in the journal at start and in `/status`. One claim costs about 8,000–9,000 sats
(`reports/rehearsal.json`), and the relay refuses claims with `relayer out of funds` below 12,000 sats. At most 10
relayed claims can succeed per epoch, one per demo leaf; repeats are answered from a cache with no transaction.
`DAILY_CAP=12` caps spending at roughly 110,000 sats a day. About 100,000 sats is enough for one epoch.

## 10. Turn on the button on the page

```sh
RELAY_URL=https://foldclaim.cls9.com npm run web:build    # writes web/data/relay.json, adds the origin to the CSP
npm run web:test
```

Then publish `web/` as before. Without `RELAY_URL` (and without `deployments/mainnet/relay.json`), the build has no
button and restores the CSP `connect-src` to `'self' wss:`.

## Updating

Rebuild (`npm run relay:build`, and `node_modules` if `package-lock.json` changed), rsync with the same flags, then
`sudo systemctl restart foldclaim-relay`.
