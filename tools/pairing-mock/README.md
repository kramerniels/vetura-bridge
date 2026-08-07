# pairing-mock

Local HTTP stub of the cloud pairing API ([pairing-api.md](../../pairing-api.md)).
Dev only — not deployed to the Pi.

```bash
npm start
# → http://0.0.0.0:3457
# Set CLOUD_BASE_URL=http://<lan-ip>:3457 on pi-api, then npm start from repo root
```
