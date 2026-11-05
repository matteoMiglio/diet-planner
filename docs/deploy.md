# Deploying to the VM

v1 is reachable only over Tailscale: the app binds to the VM's loopback, and `tailscale serve` provides HTTPS with a valid `*.ts.net` certificate. Nothing is exposed to the public internet.

## 1. Prerequisites on the VM

- Docker with the Compose plugin
- Tailscale, logged in to the same tailnet as the phone
- In the Tailscale admin console: **MagicDNS** and **HTTPS certificates** enabled

## 2. Configure

```sh
git clone <repo> diet-planner && cd diet-planner
cp .env.example .env
```

Edit `.env`:

| Variable                                      | Value                                                                                                    |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `POSTGRES_PASSWORD`                           | `openssl rand -hex 24` (hex keeps it URL-safe)                                                           |
| `RESTIC_REPOSITORY`                           | `s3:https://<namespace>.compat.objectstorage.<region>.oraclecloud.com/<bucket>/diet-planner`             |
| `RESTIC_PASSWORD`                             | `openssl rand -base64 32`. **Store it in 1Password too**: without it the off-site backups can't be read. |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | An OCI **Customer Secret Key** (Profile → Customer secret keys)                                          |
| `AWS_DEFAULT_REGION`                          | The OCI region, e.g. `eu-frankfurt-1`                                                                    |

The bucket should be private. Your Object Storage namespace is shown under Tenancy details.

## 3. Start

```sh
APP_VERSION=$(git rev-parse --short HEAD) docker compose up -d --build
docker compose ps                     # app and db healthy
curl -s http://127.0.0.1:8080/api/health
```

## 4. HTTPS over Tailscale

```sh
sudo tailscale serve --bg --https=443 http://127.0.0.1:8080
tailscale serve status                # shows https://<vm-name>.<tailnet>.ts.net
```

On the iPhone (Tailscale connected): open that URL in Safari → Share → **Add to Home Screen**.

## 5. Backups

- Nightly at 03:15: local dump in `./backups` (14 days) + restic upload (90 days).
- 1st of the month at 04:45: restore test from the off-site copy into a throwaway database.
- Watch them with `docker compose logs backup`.

Run either on demand, and do both once right after the first deploy:

```sh
docker compose exec backup backup.sh
docker compose exec backup restore-test.sh
```

## Updating

```sh
git pull
APP_VERSION=$(git rev-parse --short HEAD) docker compose up -d --build
```

Migrations run on start. Roll back by checking out the previous commit and running the same command, as long as no migration ran in between. Otherwise, restore the last dump.
