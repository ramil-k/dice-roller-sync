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
  rejected - typo protection). `GET /rooms` lists them all, codes included -
  the battle screen shows that list, so a code is *not* a secret against
  anyone who can open the site; the server is meant for one private table.
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
| `GET /rooms` | `{rooms: [{code, createdAt, lastActiveAt, connections, players: [{name, color}]}]}` - every room, busiest first; `connections` and `players` (awareness `user` states) are live |
| `GET /rooms/<code>` | `{exists: true, ...the same fields}` / 404 |
| `POST /rooms/<code>/images` | upload one image (body: raw bytes, `Content-Type: image/png\|jpeg\|webp\|gif`, up to `MAX_IMAGE_BYTES`, 16 MiB by default); returns `{id, path}` - content-addressed, so the same bytes always get the same id |
| `GET /rooms/<code>/images/<id>` | the image, `Cache-Control: immutable` |
| `POST /auth/telegram` | body: the Telegram login widget payload; the server checks Telegram's signature with `BOT_TOKEN` and returns `{token, user: {id, name, username, photo, role}}` (`role` is `gm` for ids in `GM_IDS`); 401 on a bad signature, 503 without `BOT_TOKEN` |
| `GET /me` | `{user, assignments}` - the characters this player plays now |
| `POST /claims/<code>` | take an invite (a character the GM handed out by link) |
| `GET /characters/<id>/assignments` | who plays the character (any logged-in player) |
| `GET /users`, `GET /games`, `POST /games`, `POST /games/<id>/end`, `GET /assignments`, `POST /assignments`, `DELETE /assignments/<id>` | game master only: players who ever logged in, one-shot games, handing characters out (campaign owner or a one-shot loan, to a player or as an invite code) and taking them back |
| `WS /ws/<code>` | y-websocket sync protocol (yjs 13, awareness included); the client must announce its bridge version as awareness field `v` >= `MIN_CLIENT_VERSION` (default 2) - until it does its sync messages are queued, and a missing/lower version or 3 s of silence closes the socket with code 4001 (a stale tab running an old bundle cannot rewrite the room; new clients stop reconnecting on 4001 and ask for a reload) |

The REST routes answer `Access-Control-Allow-Origin: *` - room routes carry
nothing beyond the room code itself, account routes authenticate with an
`Authorization: Bearer` session token (no cookies, so a foreign page cannot
use a player's session), and the client is a static site served from
arbitrary GitHub Pages origins (forks included).

Accounts (`src/accounts.js`, `data/accounts.json`): players who logged in,
games, and assignments - who plays which character. A `campaign`
assignment is the character's standing owner (one at a time, state id =
character id); a `oneshot` one lends a character for one game with its own
state id, ends with the game, by `endsAt` or when revoked, and the same
character can be lent to several games at once. An assignment without a
player is an invite: its claim code goes into a link, the first player to
open it takes the character. Awareness (the client's presence: cursors, focused fields, names,
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

Env: `PORT` (3000), `DATA_DIR` (./data), `MAX_IMAGE_BYTES` (16 MiB), `MIN_CLIENT_VERSION` (2; 0 disables the gate), `BOT_TOKEN` (the Telegram bot behind the site's login; without it login answers 503), `GM_IDS` (comma-separated Telegram ids of game masters), `SESSION_SECRET` (optional; derived from `BOT_TOKEN` by default - changing it logs everyone out).

## Deployment

Runs on `universal.ramilkarimov.me` behind nginx:
`https://universal.ramilkarimov.me:9443` → `127.0.0.1:6120` (docker compose,
checkout in `/opt/dice-roller-sync`). `BOT_TOKEN` and `GM_IDS` go into
`/opt/dice-roller-sync/.env` (gitignored, read by docker compose).

Push to `main` deploys: the GitHub Actions workflow connects over SSH with a
deploy key (`DEPLOY_SSH_KEY` secret) whose forced command runs
`deploy-remote.sh` on the server (git reset to origin/main +
`docker compose up -d --build` + health check), then smoke-tests
`/health` from the outside. The workflow also has `workflow_dispatch`, so
`gh workflow run deploy.yml` redeploys the current `main` by hand.
