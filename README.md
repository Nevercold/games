# Panel (Arbeitstitel)

Game-Server-Panel als Alternative zu Pelican/Pterodactyl, mit Docker-Management in Richtung Portainer.
Architektur und Roadmap: [PLAN.md](PLAN.md).

## Aufbau

```
apps/panel/        Nuxt 4 + Nuxt UI 4 (Web-UI, API, Tunnel-Endpunkt)
apps/daemon/       Go-Daemon (verbindet sich ausgehend per WSS zum Panel)
packages/shared/   Zod-Schemas (Template-Format), gemeinsame Konstanten
packages/protocol/ Protobuf-Definition des Tunnel-Protokolls + Codegen
data/plugins/      Panel-Plugins (Beispiel: hello-world)
docker/            docker-compose für Postgres
```

## Voraussetzungen

- Node 22+, pnpm
- Go 1.23+
- Docker
- Nur wenn du `.proto`-Dateien änderst: `brew install buf`. Der generierte Code ist eingecheckt,
  `protoc-gen-go` läuft als Go-Tool aus `apps/daemon/go.mod`.

## Entwicklung

```sh
pnpm install
pnpm infra        # Postgres auf Port 5433
pnpm dev          # Panel auf http://localhost:3100
pnpm proto        # nur nach Änderungen an packages/protocol/proto
pnpm --filter @panel/shared test   # Tests für Egg-Konverter und Variablen
```

Beim ersten Aufruf führt das Panel durch die Ersteinrichtung des Admin-Kontos.
Migrationen laufen beim Start automatisch.

### Daemon lokal starten

1. Im Panel unter **Nodes** eine Node anlegen und die angezeigte Konfiguration kopieren.
2. Als `apps/daemon/config.yaml` speichern (Vorlage: `config.example.yaml`).
3. Starten:

```sh
pnpm daemon       # entspricht: cd apps/daemon && go run ./cmd/daemon
```

Die Node erscheint danach im Panel als online, inklusive Systeminfos.
Der Daemon startet außerdem einen SFTP-Server (Standard: Port 2022). Anmeldung mit
`<Panel-Benutzername>.<erste 8 Zeichen der Server-ID>` und dem Panel-Passwort; das
Panel prüft Passwort und Datei-Rechte über den Tunnel.

### Tests

```sh
pnpm --filter @panel/shared test                 # Egg-Konverter, Variablen
cd apps/daemon && go test -race ./internal/...   # Dateien, Archive, SFTP-Rechte
```

### Datenbank

```sh
pnpm db:generate  # Migration aus server/db/schema.ts erzeugen
pnpm db:studio    # Drizzle Studio
```

## Konfiguration (Panel)

| Variable | Zweck |
|---|---|
| `NUXT_DATABASE_URL` | Postgres-Verbindung |
| `NUXT_SESSION_PASSWORD` | Session-Verschlüsselung, mindestens 32 Zeichen. In Dev automatisch erzeugt |
| `NUXT_TRUST_PROXY` | `true` hinter einem Reverse-Proxy, damit X-Forwarded-For für Rate-Limits zählt |
