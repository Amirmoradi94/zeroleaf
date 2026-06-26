# ONLYOFFICE Local Setup

ZeroLeaf uses ONLYOFFICE Document Server for `.docx` editing. The desktop
renderer never reads or writes document bytes directly; it asks the main process
for a typed ONLYOFFICE session, and the local bridge serves document and callback
URLs to Document Server.

## Start the local server

```bash
npm run onlyoffice:start
```

The command starts a Docker container named `zeroleaf-onlyoffice-dev` and exposes
Document Server at `http://127.0.0.1:8082`. JWT is disabled for this local
development workflow, matching the default empty JWT secret in ZeroLeaf settings.

Useful commands:

```bash
npm run onlyoffice:status
npm run onlyoffice:logs
npm run onlyoffice:restart
npm run onlyoffice:stop
```

## App settings

The default Word settings are:

- Document Server URL: `http://127.0.0.1:8082`
- Bridge callback URL: `http://host.docker.internal:27172`
- JWT secret: empty

The callback URL should use `host.docker.internal` for the local Docker server so
the container can call back into ZeroLeaf's bridge.

## Overrides

The helper script supports these environment overrides:

```bash
ZEROLEAF_ONLYOFFICE_CONTAINER=zeroleaf-onlyoffice-dev
ZEROLEAF_ONLYOFFICE_IMAGE=onlyoffice/documentserver:latest
ZEROLEAF_ONLYOFFICE_HOST=127.0.0.1
ZEROLEAF_ONLYOFFICE_PORT=8082
```

If you change the port, update the Word settings Document Server URL to match.

## Verification

Run:

```bash
npm run onlyoffice:status
```

A healthy local setup reports the container as running and the API script as
reachable. Inside ZeroLeaf, open Settings, then Word, and use Check ONLYOFFICE.
