# pairing-mock

Local HTTP stub of the cloud pairing API ([pairing-api.md](../../pairing-api.md)).
Dev only — not deployed to the Pi.

```bash
npm start
# → http://0.0.0.0:3457
# Set CLOUD_API_URL and CLOUD_FRONTEND_URL to http://<lan-ip>:3457 on vetura-agent, then npm start from repo root
```
