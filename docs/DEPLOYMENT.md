# Deploying Pharma Vault on a VPS with Docker and a Cloudflare Tunnel

```
                                                 ┌─► app (ERP, Node) ──► mysql      erp.example.com
internet ──HTTPS──► Cloudflare ──tunnel──► cloudflared        └──────► backup (daily dump)
                                                 └─► queue (pharmacy queue)         queue.example.com
```

The ERP runs in four containers from `compose.prod.yaml`. **No port is published on the VPS**: the
only way in from the internet is the tunnel, which your VPS opens outward to Cloudflare. You need no
open web ports, no certificates and no reverse proxy; Cloudflare terminates HTTPS for your domain.

The same tunnel also publishes the pharmacy queue on a second subdomain. The queue lives in its own
repository with its own `compose.prod.yaml`; the two stacks meet on a Docker network named
`pharmacy-shared`, which lets this stack's cloudflared reach the queue and lets the queue look up
medicines in the ERP without leaving the VPS. Deploy the ERP first, then follow the queue's
`docs/DEPLOYMENT.md`.

## What you need

- A VPS with Docker Engine and the Compose plugin (Ubuntu 22.04 or 24.04, 2 GB RAM is enough for
  the ERP; 4 GB with the queue as well, since each stack has its own MySQL).
- Your domain added to a (free) Cloudflare account, with its nameservers pointed at Cloudflare. Tunnel
  hostnames can only be created on a domain whose DNS Cloudflare runs; you do not create DNS records
  for the subdomains yourself, the tunnel does.
- This repository on the VPS (and the queue's, next to it, if you run the queue).

## 1. Create the tunnel in Cloudflare

1. Cloudflare dashboard → **Zero Trust** → **Networks** → **Tunnels** → **Create a tunnel** →
   **Cloudflared**. Name it `pharma-vault`.
2. On the "Install and run a connector" screen, copy the **token** (the long string after
   `--token`). You only need the token: do not run the install command it shows, Compose runs
   cloudflared for you.
3. **Public Hostname** tab → **Add a public hostname**:
   - Subdomain: `erp` (or anything), Domain: your domain, so the address is `erp.example.com`
   - Service type **HTTP**, URL **`app:3000`**

   Cloudflare creates the DNS record for you.
4. For the pharmacy queue, add a second public hostname on the **same tunnel**:
   - Subdomain: `queue` (or anything), Domain: your domain, so the address is `queue.example.com`
   - Service type **HTTP**, URL **`queue:3000`**

   It answers `502` until the queue's stack is running; that is expected.

## 2. Prepare the VPS

```bash
# firewall: allow only SSH in; the tunnel needs no inbound port
sudo ufw allow OpenSSH
sudo ufw enable

# once per VPS: the network the ERP and the queue share (both compose files expect it)
docker network create pharmacy-shared

git clone <your repository url> pharma-vault && cd pharma-vault
cp .env.production.example .env.production
nano .env.production
```

Fill in `.env.production`:

| Variable | What to put |
| --- | --- |
| `TUNNEL_TOKEN` | the token from step 1 |
| `SECRET_KEY` | `openssl rand -hex 48` |
| `MYSQL_PASSWORD`, `MYSQL_ROOT_PASSWORD` | `openssl rand -base64 24` (each) |
| `APP_TIMEZONE` | your business time zone, for example `Asia/Manila` |
| `INTEGRATION_API_TOKEN` | only if you run the queue: `openssl rand -hex 32`; the queue's `ERP_API_TOKEN` gets the same value |

`.env.production` is git-ignored. Keep a copy somewhere safe (a password manager): without
`MYSQL_*` you cannot restore the database volume, and a new `SECRET_KEY` signs everyone out.

## 3. Start it

```bash
docker compose --env-file .env.production -f compose.prod.yaml up -d --build
docker compose --env-file .env.production -f compose.prod.yaml ps      # all four "running", app/mysql "healthy"
```

The first start creates every table from `database/sql/schema.sql` (MySQL only does this on an empty
data volume). Then create your admin account, which also installs the roles and permissions:

```bash
read -rsp "Admin password (14+ characters): " PW; echo
docker compose --env-file .env.production -f compose.prod.yaml exec \
  -e ADMIN_EMAIL=you@example.com -e ADMIN_NAME="Your Name" -e ADMIN_PASSWORD="$PW" \
  -e BRANCH_CODE=MAIN -e BRANCH_NAME="Main Branch" \
  app node database/seed/bootstrap.js
unset PW
```

Open `https://erp.example.com`, sign in, and add your branches' people under **Users**. The bootstrap
creates the branch and one cash register; it is safe to run again (see Upgrading).

## Localhost mode (no tunnel)

To use the stack on the machine it runs on, for example a laptop, or before the tunnel exists, add
the two localhost files. The ERP is then at `http://localhost:3000` (that computer only), cloudflared
does not start, and the session cookie works over plain `http://`:

```bash
docker compose --env-file .env.production --env-file localhost.env -f compose.prod.yaml -f compose.localhost.yaml up -d
```

The data is the same as in tunnel mode. Switch back by running the normal `up -d` command (without the
localhost files): it removes the port and restores the secure cookie. `ERP_LOCAL_PORT` (set in your
shell) picks another port. The queue has the same mode at `http://localhost:3001`.

## Day to day

Shorten the commands once per shell: `alias pvc='docker compose --env-file .env.production -f compose.prod.yaml'`.

| Task | Command |
| --- | --- |
| Logs | `pvc logs -f app` (also `cloudflared`, `mysql`, `backup`) |
| Status | `pvc ps` |
| Restart the app | `pvc restart app` |
| Stop everything | `pvc down` (data stays in the `mysql_data` volume) |
| Health check from the VPS | `pvc exec app node -e "fetch('http://127.0.0.1:3000/api/v1/up').then(r=>console.log(r.status))"` |

## Upgrading

```bash
git pull
pvc up -d --build                                    # rebuilds the image, restarts what changed
# only when the release adds permissions (see its notes): grant them to the standard roles
pvc exec -e ADMIN_EMAIL=you@example.com -e ADMIN_NAME="Your Name" -e ADMIN_PASSWORD="$PW" app node database/seed/bootstrap.js
```

The bootstrap only adds what is missing; it never removes a grant, and it never changes an existing
account's password. **Database changes are not automatic.** A release that adds or changes a table
ships the SQL for it in `database/sql/` and says so in its notes; run it before restarting:

```bash
pvc exec -T mysql sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" "$MYSQL_DATABASE"' < database/sql/<file>.sql
```

Take a backup first (below). `database/sql/schema.sql` is the full schema for new installations
(`npm run db:schema` regenerates it after a model change).

## Backups

The `backup` service writes a compressed dump to `./backups/` on the VPS at start-up and then
every 24 hours, keeping the last `BACKUP_KEEP_DAYS` (14). **Copy them off the VPS** (a second
machine or object storage), or a lost VPS loses the backups too:

```bash
rsync -az --ignore-existing user@vps:/path/to/pharma-vault/backups/ ./vps-backups/
```

Back up right now, by hand:
`pvc exec -T mysql sh -c 'mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" --single-transaction --routines --no-tablespaces "$MYSQL_DATABASE"' | gzip > manual-$(date +%F).sql.gz`.

**Restore** into the running database (this replaces its contents; stop the app first):

```bash
pvc stop app
pvc exec -T mysql sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -e "DROP DATABASE \`$MYSQL_DATABASE\`; CREATE DATABASE \`$MYSQL_DATABASE\` CHARACTER SET utf8mb4"'
gunzip -c backups/pharma-vault-YYYYMMDD-HHMMSS.sql.gz | pvc exec -T mysql sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" "$MYSQL_DATABASE"'
pvc start app
```

Test a restore on a spare machine before you need one.

## Hardening worth doing

- **Cloudflare Access** (Zero Trust → Access → Applications): put a login (one-time email code, Google)
  in front of `erp.example.com`. The app has its own sign-in, but Access keeps strangers off it entirely.
  Do not put Access on the whole queue hostname: customers use `queue.example.com/customer` without an
  account. If you want it there, protect only the staff paths (`/`, `/staff/*`).
  The sign-up page (`/register-page`) creates accounts that can do nothing until an admin grants
  roles, yet you may not want it reachable: Access or a Cloudflare WAF rule on `/register*` closes it.
- **Cloudflare SSL/TLS**: set the mode to *Full* and turn on *Always Use HTTPS*. Traffic from Cloudflare
  to your VPS already travels inside the encrypted tunnel.
- **SSH**: key-only logins, and keep the VPS patched (`unattended-upgrades`).
- **Image versions**: `cloudflare/cloudflared:latest` follows new releases; pin a tag in
  `compose.prod.yaml` once you want control over updates.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `network pharmacy-shared declared as external, but could not be found` | Create it once: `docker network create pharmacy-shared`, then `pvc up -d` again. |
| Tunnel page says *Inactive*, or `1033`/`502` from Cloudflare | `pvc logs cloudflared`: wrong or empty `TUNNEL_TOKEN`, or the hostname's service URL is not `http://app:3000`. `pvc ps` must show `app` healthy. |
| `502` on the queue's subdomain only | The queue's stack is not running or not healthy (see its `docs/DEPLOYMENT.md`), or that hostname's service URL is not `http://queue:3000`. |
| Sign in succeeds but you land back on the login page | The secure session cookie is not being accepted: the app must see `X-Forwarded-Proto: https`. Keep `TRUST_PROXY: 1` (already set in `compose.prod.yaml`) and always use the `https://` address. |
| `app` restarts in a loop | `pvc logs app`. `SECRET_KEY is required` means it is missing from `.env.production`; a database error means the MySQL password differs from the one the data volume was created with. |
| Tables are missing on a new install | `schema.sql` runs only on an *empty* data volume. If the first start failed halfway: `pvc down -v` (deletes the database volume!), then `pvc up -d`. |
| Everyone was signed out | Sessions live in the app's memory, so a restart or deploy signs people out. They sign in again; open carts are kept in each browser. |

## Known limits

- One VPS, one database container: no high availability. Backups are your safety net.
- Sessions are kept in memory (single app process); a restart signs users out.
- Database upgrades are manual SQL (see Upgrading) until a migration runner is added.
- `npm audit --omit=dev` reports one moderate advisory in `hbs` (the view-engine wrapper) with no upstream fix. It is a file-disclosure weakness that needs request data passed to `res.render` as options; no controller does that, and `tests/unit/renderSafety.spec.js` fails if one ever does. Re-run `npm audit` when upgrading.
