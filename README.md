# dice-roller-sync

Yjs-based sync server for the [dice-roller](https://github.com/ramil-k/dice-roller)
battle mat. Lets a DM and players on different devices work on the same
encounter concurrently: the document is a CRDT, so simultaneous edits to
different tokens/fields merge without losing either side.

## Model

- A **room** holds one encounter (one Yjs doc). The room code
  (`brave-otter-4821`) is both the address and the secret - anyone who knows
  it is in. Switching encounters = switching codes.
- Rooms are created only via `POST /rooms` (joining an unknown code is
  rejected - typo protection).
- Persistence: a merged Yjs update blob per room under `data/yjs/`, plus
  `data/rooms.json` as the room registry. No database.
- Images: the client uploads attached map images here instead of embedding
  them as data URIs in the Yjs doc; files live under `data/images/<code>/`
  and are never deleted (a room's pictures are tiny next to what the CRDT
  used to carry). Bodies pass through nginx's `client_max_body_size 32m`.

## API

| Route | What |
| --- | --- |
| `GET /health` | `{ok: true}` |
| `POST /rooms` | create a room, returns `{code}` |
| `GET /rooms/<code>` | `{exists}` / 404 |
| `POST /rooms/<code>/images` | upload one image (body: raw bytes, `Content-Type: image/png\|jpeg\|webp\|gif`, up to `MAX_IMAGE_BYTES`, 16 MiB by default); returns `{id, path}` - content-addressed, so the same bytes always get the same id |
| `GET /rooms/<code>/images/<id>` | the image, `Cache-Control: immutable` |
| `WS /ws/<code>` | y-websocket sync protocol (yjs 13, awareness included) |

The REST routes answer `Access-Control-Allow-Origin: *` - there are no
credentials or secrets in the API beyond the room code itself, and the
client is a static site served from arbitrary GitHub Pages origins (forks
included). Awareness (the client's presence: cursors, focused fields, names,
colors) is relayed between connected peers only and never persisted.

The websocket handler is vendored in `src/wsdoc.js` (adapted from the
reference y-websocket server) so the whole process runs on a single stable
`yjs@13` - the published server packages currently depend on yjs 14
pre-releases which cannot talk to yjs 13 clients.

## Development

```bash
npm install
npm test          # vitest, includes an end-to-end concurrent-merge test
npm start         # listens on :3000, data in ./data
```

Env: `PORT` (3000), `DATA_DIR` (./data), `MAX_IMAGE_BYTES` (16 MiB).

## Deployment

Runs on `universal.ramilkarimov.me` behind nginx:
`https://universal.ramilkarimov.me:9443` → `127.0.0.1:6120` (docker compose,
checkout in `/opt/dice-roller-sync`).

Push to `main` deploys: the GitHub Actions workflow connects over SSH with a
deploy key (`DEPLOY_SSH_KEY` secret) whose forced command runs
`deploy-remote.sh` on the server (git reset to origin/main +
`docker compose up -d --build` + health check), then smoke-tests
`/health` from the outside. The workflow also has `workflow_dispatch`, so
`gh workflow run deploy.yml` redeploys the current `main` by hand.
