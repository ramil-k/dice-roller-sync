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

## API

| Route | What |
| --- | --- |
| `GET /health` | `{ok: true}` |
| `POST /rooms` | create a room, returns `{code}` |
| `GET /rooms/<code>` | `{exists}` / 404 |
| `WS /ws/<code>` | y-websocket sync protocol (yjs 13, awareness included) |

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

Env: `PORT` (3000), `DATA_DIR` (./data).

## Deployment

Runs on `universal.ramilkarimov.me` behind nginx:
`https://universal.ramilkarimov.me:9443` → `127.0.0.1:6120` (docker compose,
checkout in `/opt/dice-roller-sync`).

Push to `main` deploys: the GitHub Actions workflow connects over SSH with a
deploy key whose forced command runs `deploy-remote.sh` on the server
(git reset to origin/main + `docker compose up -d --build` + health check).
