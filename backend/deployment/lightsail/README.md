# Lightsail Rust backend

Rust backend only ang native MVP host contract na ito para sa API, SQLite, private processed
audio, durable inference metadata, comparison, at annotation. Walang Python
model, GPU runtime, Docker, o Colab remote endpoint sa host.

## Cost gate

Lightsail is hourly billed. Bago gumawa o magpanatili ng instance, kumpirmahin
sa mismong AWS account na sapat ang account-specific active Free Tier credits para sa napiling
bundle at expected runtime. Kapag hindi confirmed ang zero-charge coverage,
huwag mag-deploy. Ang stopped instance ay hindi cost-off switch; delete the
instance through a separately approved cleanup action when it is no longer
needed.

## Native service contract

- Install the release at `/opt/gabaybigkas/current/agora-coach-api`.
- The product service mints Agora AccessToken2 credentials inside the Rust process through the pinned official Agora Rust implementation. The deployed backend does not require Node, npm dependencies, or a token-helper path.
- Keep `AGORA_APP_ID`, `AGORA_APP_CERTIFICATE`, and `YOUTUBE_API_KEY` in the service secret file. Fresh RTC/RTM/agent tokens are generated per owned session; do not deploy a manually pasted expiring token as the primary flow.
- Publish the verified coach build at `/var/lib/gabaybigkas/.artifacts/build/coach`; preserve its previous contents for rollback.
- Store SQLite and private audio under `/var/lib/gabaybigkas`.
- Store secrets only in root-owned `/etc/gabaybigkas/coach.env`.
- Keep `COACH_MODAL_INFERENCE_URL`, `COACH_MODAL_TOKEN_ID`, and `COACH_MODAL_TOKEN_SECRET` in that file only; never expose them to the browser or release archive.
- Run through `gabaybigkas.service`; terminate TLS through the approved host
  reverse proxy.
- Never copy export bundles to a public directory. Modal export/import is internal; manual download/import routes and Colab fallback are deprecated.

This repository does not create or mutate a Lightsail instance automatically.

## Approved production target

- Public origin: `https://54.179.89.16`
- GitHub Pages origin: `https://johnandrewbalbarosa.github.io`
- Set `COACH_ALLOWED_ORIGIN=https://johnandrewbalbarosa.github.io,https://54.179.89.16` in the root-owned service env file so the Pages build and the VPS-hosted frontend pass the exact POST origin guard. Keep learner and annotator authentication enabled.
- Rust remains bound to `127.0.0.1:4320`; nginx owns public ports `80` and `443`.
- `gabaybigkas-nginx.conf` uses a browser-trusted short-lived IP certificate.
- Certbot renewal MUST remain enabled because IP certificates expire after about six days.
- Production secrets stay in root-owned `/etc/gabaybigkas/coach.env`.
- The previous release MUST remain available until health, restart, and login checks pass.
