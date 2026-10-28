# Game Server Panel – Architekturplan

Stand: 2026-10-28. Alternative zu Pelican/Pterodactyl. Name: offen (Vorschläge: Kestrel, Osprey, Heron).

## Entscheidungen

| Thema | Entscheidung |
|---|---|
| Dashboard | Nuxt 4 + Nuxt UI, Fullstack (Nitro als API) |
| Daemon | Eigener Daemon in Go, Single Binary pro Node |
| Datenbank | PostgreSQL + Drizzle ORM |
| API | Eigene, typisierte API. Keine Pelican-Kompatibilität (ggf. später als Layer) |
| Templates | Eigenes Server-Template-Format (YAML, typisiert, Hooks, Vererbung). Pelican/Pterodactyl-Eggs per Konverter importierbar |
| Migration | Pelican-Installationen importierbar (Users, Nodes, Server, Subuser, Schedules). Server-Daten bleiben in-place |
| Konnektivität | Daemon baut ausgehende Verbindung zum Panel auf. Nodes brauchen keine öffentliche Adresse, kein TLS-Zertifikat, keine offenen Ports außer Spielports |
| Backups | Ziele: lokal, S3-kompatibel, SFTP. Daemon streamt direkt ins Ziel |
| Login | Lokal + OpenID Connect (generisch, Discovery). Weitere Provider als Plugins |
| Docker-Management | Portainer-artiger Bereich: Container, Stacks (Compose), Images, Volumes, Netzwerke je Node. Gameserver sind ein Spezialfall davon |
| Berechtigungen | Admin-Rollen (RBAC) mit feingranularen Admin-Rechten + Server-Rechte pro Subuser. Superadmin hat alles |
| Organisation | Server-Gruppen pro Nutzer mit Farbe, manuelle Sortierung (Drag & Drop) + Sortierung nach Name/Status |
| Repo | Monorepo in diesem Ordner |

## Repo-Layout

```
apps/panel/        Nuxt 4 + Nuxt UI + Nitro (Web-UI, REST-API, WebSocket, Jobs)
apps/daemon/       Go-Modul: Node-Agent (Docker, Konsole, Dateien, SFTP, Backups)
packages/shared/   Zod-Schemas, TS-Typen, Egg-Format, generierter Daemon-Client
packages/protocol/ Protobuf-Definitionen Panel <-> Daemon (Single Source of Truth)
docker/            docker-compose für Dev (Postgres)
docs/
```

Codegen aus `packages/protocol` mit buf: Go-Typen für den Daemon, TS-Typen (protobuf-es) für das Panel.

## Komponenten

### Panel (apps/panel)
- Nuxt 4, Nuxt UI v4, TypeScript strict
- Drizzle ORM + postgres-js, Migrationen via drizzle-kit
- Auth: nuxt-auth-utils (Sessions), TOTP-2FA, API-Keys (gehasht), Passkeys später
- OpenID Connect: generischer Provider mit Discovery (openid-client), mehrere Provider parallel, Account-Linking, Auto-Provisioning, Rollen-Mapping aus Claims/Gruppen, lokaler Login abschaltbar. Discord/GitHub etc. über den Login-Provider-Extension-Point als Plugin
- Realtime: WebSocket über Nitro/crossws (Konsole, Live-Stats, Server-Status)
- Jobs: pg-boss (Postgres-basierte Queue, kein Redis nötig) für Installs, Backups, Schedules
- Validierung: Zod an jeder API-Grenze
- Zwei Bereiche: `/admin/*` (Nodes, Eggs, Users, Server-Verwaltung) und `/server/:id/*` (Nutzer-Sicht)

### Daemon (apps/daemon, Go)
- Go 1.23+, net/http + chi, Docker SDK, coder/websocket, pkg/sftp + x/crypto/ssh
- Konfig: YAML (Panel-URL, Node-Token, Datenpfad, SFTP-Port). Kein eigenes TLS nötig, der Daemon ist Client
- Funktionen:
  - Container-Lifecycle: create / start / stop / kill / restart, Ressourcen-Limits (CPU, RAM, Swap, Disk, IO)
  - Konsole: attach an stdin/stdout, Ring-Buffer für History, WS-Streaming
  - Stats: CPU/RAM/Netz/Disk je Server, Push per WS
  - Install/Hooks: einmaliger Install-Container mit Template-Skript, weitere Hooks (pre_start, post_stop, update), Status-Callback ans Panel
  - Laufzeit-Vertrag kompatibel zu Wings: gleiche Env-Variablen (`SERVER_MEMORY`, `SERVER_IP`, `SERVER_PORT`, `P_SERVER_UUID`, ...), gleiche Platzhalter im Startbefehl, gleiche Verzeichnisstruktur (`/home/container`), damit importierte Eggs unverändert laufen
  - Dateien: list/read/write/rename/delete/compress/decompress, strikt auf Server-Verzeichnis gesandboxt
  - SFTP-Server: Login `user.serverid`, Credentials werden beim Panel validiert
  - Backups: tar+zstd, Ziele lokal / S3-kompatibel / SFTP, Streaming direkt ins Ziel ohne Zwischendatei, Restore aus jedem Ziel
  - Disk-Quota-Überwachung, Crash-Detection mit Auto-Restart
- Auslieferung: statisches Binary, systemd-Unit, Install-Skript

### Protokoll Panel <-> Daemon (Tunnel-Modell)
Problem bei Pelican: Browser verbindet sich direkt mit Wings, deshalb braucht jede Node Domain, TLS-Zertifikat und offenen Port. Hinter NAT/CGNAT unbrauchbar.

Lösung: **Der Daemon verbindet sich ausgehend zum Panel**, nicht umgekehrt.
- Daemon öffnet beim Start eine persistente WSS-Verbindung zu `wss://panel/api/nodes/tunnel`, Auth per Node-Token, Reconnect mit Backoff
- Transport-Wahl: WSS, weil es als einziges ohne Sonderkonfiguration durch Reverse-Proxys, Cloudflare und Cloudflare Tunnel läuft und Nitro es nativ kann. Geprüft und verworfen: gRPC/HTTP2 (Nitro-Integration, Proxy-Hürden), Connect über HTTP/1.1 (ineffizient für Streams), QUIC (kein Node-Support), SSH-Reverse-Tunnel und Roh-TCP (eigener Port, nicht proxyfähig), WireGuard/Tailscale (zwingt zu Overlay-Netz), NATS/MQTT (Zusatz-Infrastruktur)
- Transport im Daemon und Panel als Interface abstrahiert (Verbindung + Streams), damit gRPC oder QUIC später ohne Protokolländerung nachrüstbar sind
- Multiplexing: eigenes Framing (Stream-ID, Typ, Payload) oder yamux über der WS-Verbindung. Entscheidung beim Prototyp
- Unverschlüsseltes WS per Konfig-Flag für Dev/LAN, mit Warnung. In Produktion terminiert TLS am Reverse-Proxy
- Über die Verbindung laufen gemultiplexte Streams (Stream-ID je Frame, Protobuf-Nachrichten): RPCs (Power, Install, Datei-Ops), Konsolen-Streams, Stats, Datei-Transfers (chunked), Events
- Browser spricht nur mit dem Panel (WS über crossws). Panel routet in den Tunnel der jeweiligen Node
- Daemon braucht keine eingehenden Ports außer Spielports und optional SFTP. Kein Zertifikat, keine Domain, NAT egal
- Panel hält Tunnel-Registry in-memory (eine Panel-Instanz). Horizontal skalieren später über Sticky-Routing oder Redis-Registry
- **Direktmodus** (optional pro Node): Node hat öffentliche Adresse, Browser lädt große Dateien/Backups direkt vom Daemon mit kurzlebigem JWT. Spart Panel-Bandbreite bei viel Datei-Traffic
- SFTP: läuft im Daemon (eingehender Port). Für NAT-Nodes später optional SFTP-Server im Panel, der Datei-Ops durch den Tunnel leitet

## Docker-Management (Portainer-Richtung)

Grundidee: Gameserver sind „verwaltete Workloads“ mit Template, Konsole und Nutzer-Rechten. Daneben gibt es allgemeine Docker-Workloads, die Admins direkt verwalten. Beides läuft über denselben Daemon und denselben Tunnel.

### Abgrenzung
- Daemon labelt eigene Container (`panel.managed=true`, `panel.server=<uuid>`, `panel.stack=<id>`)
- Verwaltete Gameserver-Container sind im Docker-Bereich sichtbar, aber geschützt (Bearbeitung nur über die Server-Seite)
- Fremde Container auf der Node werden angezeigt und können optional „adoptiert“ werden

### Funktionen je Node
- **Container**: Liste, Start/Stop/Restart/Kill/Remove, Logs (Live-Stream), Stats, Inspect, Exec-Terminal im Browser (xterm.js über Tunnel), Env/Ports/Volumes anzeigen, Recreate mit geänderter Config
- **Stacks**: Docker-Compose-Dateien anlegen/bearbeiten (Editor mit Validierung), deploy/update/down, Env-Dateien, Git-Quelle mit Auto-Update (Webhook oder Polling)
- **Images**: Liste, Pull, Remove, Prune, Registry-Credentials (verschlüsselt)
- **Volumes**: Liste, Größe, Remove, Datei-Browser (gleiche Komponente wie Server-File-Manager)
- **Netzwerke**: Liste, Create/Remove, verbundene Container
- **Node-Übersicht**: Docker-Info, Disk-Verbrauch, System-Prune
- **Backups**: Volumes und Stacks nutzen dieselben Backup-Ziele wie Gameserver

### Compose im Daemon
- Compose-Spec wird im Daemon selbst ausgewertet (compose-go Library) und über das Docker SDK umgesetzt. Kein `docker compose`-Binary auf der Node nötig

### Templates und Stacks
- Template-Format v2 (später): optionale `services` für Gameserver mit Sidecars (z. B. Server + Datenbank + Web-Map), intern als Stack umgesetzt
- App-Templates für allgemeine Dienste (Portainer „App Templates“): z. B. Postgres, Redis, Uptime Kuma, als Stack-Vorlage mit Variablen-Formular

### Sicherheit
- Docker-Zugriff ist faktisch Root auf der Node. Allgemeines Docker-Management ist nur für Admins bzw. eigene Rolle `docker.*` freigebbar, nie für normale Server-Nutzer
- Pro Node abschaltbar („nur Gameserver“-Modus), z. B. für Hosting-Anbieter
- Privilegierte Container, Host-Mounts und `network_mode: host` in Stacks erfordern explizite Admin-Freigabe pro Node
- Alle Docker-Aktionen landen im Audit-Log

## Berechtigungen

Katalog in `apps/panel/shared/permissions.ts`, Prüfung immer serverseitig, UI blendet nur aus.

### Admin (RBAC)
- `users.is_admin` = Superadmin, hat jedes Recht
- Rollen (`roles`: Name, Beschreibung, `permissions[]`), ein Nutzer hat höchstens eine Rolle
- Rechte: `admin.nodes.read|write`, `admin.servers.read|write|delete`, `admin.users.read|write`, `admin.roles.write`, `admin.templates.read|write`, `admin.docker.read`, `admin.settings.write`, `admin.plugins.read`
- Rechte werden pro Request aus der DB geladen, Änderungen greifen sofort

### Server (Subuser)
- Besitzer und Admins mit `admin.servers.write` haben alle Server-Rechte
- Subuser (`server_subusers`: server, user, `permissions[]`) bekommen einzelne Rechte
- Rechte: `control.console`, `control.command`, `control.start`, `control.stop`, `control.restart`, `control.kill`, `startup.read`, `startup.update`, `settings.reinstall`, `user.read`, `user.write`, später `file.*`, `backup.*`, `schedule.*`, `database.*`
- Subuser können nur Rechte vergeben, die sie selbst haben
- Plugins registrieren eigene Rechte unter `plugin.<id>.*`

## Git-Integration

Server-Dateien (Plugins, Configs, Maps, Datapacks) direkt aus Git verwalten, ähnlich wie Git-Quellen bei Stacks.

- Pro Server ein oder mehrere Git-Quellen: Repo-URL, Branch/Tag, Zielverzeichnis im Server (z. B. `plugins/` oder `/`), optional Unterordner im Repo
- Auth: Deploy-Key (vom Panel erzeugtes ed25519-Paar, Public Key zum Kopieren) oder HTTPS-Token, verschlüsselt in der DB
- Aktionen: Clone, Pull, Status/Diff anzeigen, Commit-Log; Pull vor jedem Start (optional), Pull per Webhook (GitHub/GitLab/Gitea, signiert) und per Schedule
- Konflikte: Strategie wählbar (überschreiben vs. abbrechen), lokale Änderungen werden vorher angezeigt
- Daemon führt Git in einem kurzlebigen Container (alpine/git) mit gemountetem Serververzeichnis aus, nicht auf dem Host, damit Hooks und Credentials isoliert bleiben
- Neues Server-Recht `git.read` / `git.write`, Audit-Log für Pulls
- Optional später: Änderungen aus dem File-Manager zurück committen (Push)

## Server-Gruppen und Sortierung

- Gruppen gehören dem Nutzer (`server_groups`: Name, Farbe, Reihenfolge), jeder organisiert seine eigene Ansicht
- Pro Nutzer und Server (`user_server_prefs`): Gruppe, Position, optionale Farbe
- Übersicht: Gruppen als Abschnitte, Server per Drag & Drop sortier- und verschiebbar, alternativ Sortierung nach Name oder Status, Filter/Suche
- Farben aus der Nuxt-UI-Palette, damit sie mit dem Theme-System harmonieren

## Server-Templates (eigenes Format)

Wir übernehmen nicht die Egg-Struktur. Schwächen von Eggs: Laravel-Validierungsstrings als Variablenregeln, nur ein Install-Skript, keine Lifecycle-Hooks, keine Vererbung, keine Versionierung, flache JSON-Struktur.

### Format
- YAML, `schema: 1`, validiert per Zod-Schema in `packages/shared`
- Metadaten: id, name, version, author, tags/Kategorie, Beschreibung, Icon, `source` (z. B. importiert aus Egg X)
- `extends`: Vererbung von Basis-Templates (z. B. `minecraft-java` als Basis für Paper, Purpur, Fabric)
- `images`: mehrere Docker-Image-Varianten mit Label (z. B. Java 17 / 21)
- `startup`: Startbefehl mit Platzhaltern `{{VAR}}`, `done`-Regex für „Server läuft“, `stop` als Befehl oder Signal
- `variables`: typisiert (string, int, bool, enum, port, secret), default, min/max, regex, `user_editable`, `user_viewable`, Beschreibung
- `config_files`: Patching von Konfigdateien mit typisierten Parsern (properties, yaml, json, ini, xml, text)
- `hooks`: `install` (Image + Skript), `pre_start`, `post_stop`, `update`. Skripte laufen in einem separaten Container mit gemountetem Server-Verzeichnis
- `resources`: Default-Limits, Empfehlungen
- `features`: Flags wie `eula`, `steam_disk_space`, `pid_limit`

### Egg-Import (Konverter)
- Egg-JSON (Pelican v1 und Pterodactyl) → Template-YAML, verlustfrei für alles, was Eggs können
- Laravel-Regeln werden übersetzt: `required|string|max:20` → type string, max 20; `in:a,b,c` → enum; `numeric|between:1,100` → int mit min/max; `regex:` → regex. Nicht übersetzbare Regeln landen als Warnung im Import-Log
- `scripts.installation` → `hooks.install`, `config.files` → `config_files`, `docker_images` → `images`
- Bulk-Import: Verzeichnis oder Git-Repo (z. B. pelican-eggs) auf einmal

## Migration von Pelican

Als First-Party-Plugin `pelican-import` (testet gleichzeitig das Plugin-System).

- Quelle: Pelican-Datenbank lesend (MySQL/MariaDB/SQLite/Postgres), nicht die API. Nur die DB liefert Passwort-Hashes (bcrypt, direkt kompatibel), Subuser-Berechtigungen, Schedules, Backup-Metadaten und API-Keys
- Importiert: Users (inkl. Hashes, 2FA-Secrets), Nodes, Allocations, Eggs (via Konverter), Server mit Variablen, Subuser, Schedules/Tasks, Backups-Metadaten, Datenbank-Hosts
- Server-Daten bleiben in-place: unser Daemon wird auf der Node installiert und übernimmt das Wings-Volume-Verzeichnis (`/var/lib/pelican/volumes/<uuid>`). Server-UUIDs bleiben erhalten, damit Pfade stimmen. Wings wird gestoppt, Container werden neu erstellt
- Ablauf in der Admin-UI: DB-Verbindung angeben → Vorschau mit Konfliktliste → Mapping (Nodes, Eggs) bestätigen → Import → pro Node Daemon-Wechsel-Anleitung
- Idempotent: mehrfach ausführbar, bestehende Einträge werden per Source-ID erkannt
- Pterodactyl-Import über denselben Weg, Schema-Unterschiede sind klein

## Datenmodell (Kern)

users, sessions, api_keys, recovery_codes
nodes, allocations (ip, port, server_id nullable)
templates, template_variables, template_tags (statt Eggs/Nests), import_sources (Herkunft für idempotente Imports)
servers, server_variables, server_subusers (permissions[]), server_transfers
backup_targets (local | s3 | sftp, Credentials verschlüsselt, Retention), backups, schedules, schedule_tasks
oidc_providers, user_identities (provider, subject, user_id)
database_hosts, server_databases
stacks (node_id, compose, env verschlüsselt, git_source), registries (Credentials verschlüsselt), app_templates
audit_log, mounts

Container, Images, Volumes und Netzwerke werden nicht in der DB gespiegelt, sondern live vom Daemon abgefragt.

## Sicherheit
- Node-Token nur gehasht in DB, Rotation möglich. Tunnel nur über WSS, Panel-Zertifikat wird vom Daemon geprüft
- Backup-Ziel-Credentials und OIDC-Client-Secrets verschlüsselt in DB (App-Key aus Env)
- Pfad-Sanitizing im Daemon (kein `..`, keine Symlinks aus dem Server-Root)
- Container: keine Privilegien, eigener User, read-only Image-Layer, Netzwerk-Isolation
- Berechtigungssystem je Server (granular wie Pelican: control.*, file.*, backup.*, ...)
- Rate-Limits auf Auth-Endpunkten, CSRF über SameSite-Cookies, Audit-Log für Admin-Aktionen

## Plugin-System

Vertrauensmodell wie Pelican: Plugins laufen in-process, Admins installieren nur vertrauenswürdigen Code. Kein Sandboxing.

### Aufbau eines Plugins
```
data/plugins/<id>/
  plugin.json      id, name, version, panelVersion (semver-range), server, client, permissions, settings
  server.mjs       ESM, exportiert setup(ctx) – läuft in Nitro
  client.mjs       optional, prebuilt Vue-Komponenten (vue + Nuxt UI extern)
  migrations/      Drizzle-SQL-Migrationen, eigenes Postgres-Schema `plugin_<id>`
```

### Server-API (ctx in setup)
- `hooks`: hookable-basiert. Events u. a. `server.created|installed|deleted`, `server.power`, `backup.completed`, `user.created`, `auth.login`, `schedule.run`
- `router`: eigene Routen unter `/api/plugins/<id>/*`, Auth + Permissions vom Panel
- `db`: Drizzle-Handle auf eigenes Schema, Migrationen beim Aktivieren
- `jobs`: pg-boss-Queues registrieren
- `settings`: Schema deklarieren → Admin-UI wird automatisch generiert
- `permissions`: eigene Permission-Nodes (`plugin.<id>.*`)
- `daemon`: typisierter Client zur Daemon-API (Befehle senden, Dateien lesen)
- `events`: WS-Events an Browser pushen
- `log`: strukturierter Logger mit Plugin-Prefix

### UI-Integration
- **Extension-Points** im Panel: Sidebar-Einträge, Server-Tabs, Admin-Seiten, Dashboard-Widgets, Server-Aktionen (Kontextmenü), Login-Provider, Einstellungs-Seiten
- **Deklarativ** (Default): Plugin liefert JSON-Schema für Formulare, Tabellen, Widgets. Panel rendert mit Nuxt UI. Kein Build nötig.
- **Prebuilt-Komponenten** (für komplexe Plugins): mit Vite als ESM gebaut, `vue` und `@nuxt/ui` als externals. Panel stellt beides per Import-Map bereit und registriert Nuxt UI-Komponenten global. Panel lädt `client.mjs` per dynamic import und mountet die Komponenten in die Slots.
- Plugin-SDK-Paket (`packages/plugin-sdk`): Typen für ctx, Manifest, Slots, Vite-Preset für Plugin-Builds

### Lifecycle
- Installieren: Zip-Upload oder Registry-URL in der Admin-UI → entpacken → Manifest + Kompatibilität prüfen → Migrationen → aktivieren
- Loader lädt Plugins beim Start und bei Aktivierung neu (Nitro-Hot-Reload über Worker-Neustart)
- Deaktivieren/Deinstallieren mit optionalem Schema-Drop
- Daemon bleibt plugin-frei; Daemon-nahe Fälle laufen über Panel-Hooks + Daemon-API

### Dogfooding
Mindestens ein Kern-Feature wird als First-Party-Plugin gebaut (Kandidat: Modrinth/CurseForge-Mod-Manager oder Discord-Benachrichtigungen), damit die Extension-Points real getestet sind. Gesetzt als erstes First-Party-Plugin: `pelican-import` (siehe Migration). Weitere Plugin-Ideen: Billing (Stripe), OAuth/Discord-Login, Mod-Manager, Themes.

## Theme-System

Grundlage: Nuxt UI v4 basiert auf CSS-Variablen (`--ui-primary`, `--ui-bg`, `--ui-text`, `--ui-radius`, ...) und Tailwind v4. Tokens sind zur Laufzeit änderbar, kein Rebuild nötig.

Regel ab Tag 1: Keine hartkodierten Farben/Radien in Komponenten. Alles über Design-Tokens, sonst greifen Themes nur zur Hälfte.

### Stufe 1: Branding (Admin)
- Panel-Name, Logo (hell/dunkel), Favicon, Primärfarbe, Neutralfarbe, Radius, Schriftart
- Gespeichert in DB (`settings`), als CSS-Variablen in den HTML-Head injiziert (SSR, kein Flackern)
- Live-Vorschau in den Einstellungen

### Stufe 2: Nutzer-Präferenzen
- Hell / Dunkel / System, optional Akzentfarbe, Dichte (kompakt/normal)
- Pro User in DB, Cookie für SSR-First-Paint

### Stufe 3: Theme-Pakete
- Plugin-Typ `theme`, gleiche Installation wie Plugins (`data/plugins/<id>/theme.json`)
- Inhalt: Token-Set für Light + Dark, optionales `theme.css`, Assets (Logo, Fonts, Hintergründe)
- Admin setzt Standard-Theme, kann Nutzer-Wahl freigeben
- Einschränkung: Tailwind-Klassen entstehen zur Build-Zeit. Themes arbeiten mit CSS-Variablen und normalem CSS, nicht mit beliebigen Tailwind-Klassen. Komponenten-Varianten werden über Nuxt UI `app.config` (ui.*)-Overrides unterstützt, soweit die Klassen im Panel-Build vorkommen.

### Stufe 4: Layout-Overrides
- Themes dürfen Layout-Slots (Sidebar, Header, Login-Seite, Server-Karte, Dashboard) mit prebuilt Vue-Komponenten ersetzen
- Gleicher Mechanismus wie Prebuilt-Plugin-Komponenten (Import-Map, dynamic import)

### Dogfooding
Das Default-Theme wird selbst als Theme-Paket ausgeliefert, plus ein zweites First-Party-Theme (z. B. „Minimal“ oder „Terminal“), damit die Token-Abdeckung real getestet ist.

## Phasen

1. **Fundament**: Monorepo, Nuxt-Skelett mit Nuxt UI-Layout, Postgres + Drizzle, Auth, Users, Nodes, Allocations, Server-CRUD (Admin). Hook-System + Plugin-Loader-Skelett (server-seitig). Design-Tokens als Fundament, Branding-Einstellungen (Stufe 1), Hell/Dunkel. Daemon: Skelett, Konfig, Tunnel-Verbindung zum Panel mit Reconnect, Heartbeat, Protokoll v0 (Protobuf).
2. **Server laufen**: Daemon Container-Lifecycle + Konsole + Stats. Panel: Server-Seite mit Live-Konsole, Power-Buttons, Ressourcen-Anzeige. Template-Format v1 + Egg-Konverter + Install-Flow. UI-Extension-Points (Slots) definieren. Docker-Bereich read-only: Container, Images, Volumes, Netzwerke, Logs. Berechtigungssystem (Admin-Rollen + Subuser), Server-Gruppen mit Farben und Sortierung.
3. **Dateien**: File-Manager (Browser, Editor mit Syntax-Highlighting, Upload, Archive), SFTP im Daemon. Docker-Aktionen: Container-Steuerung, Exec-Terminal, Image-Pull, Volume-Browser.
4. **Betrieb**: Backup-Ziele (lokal, S3, SFTP) + Backups mit Retention, Schedules/Tasks, Git-Integration für Server-Dateien (Clone/Pull, Deploy-Keys, Webhooks), Server-Datenbanken, Startup-Variablen-UI. Stacks (Compose) inkl. Git-Quelle, Registry-Credentials. Deklarative Plugin-UI (Settings, Widgets). Nutzer-Präferenzen (Theme Stufe 2).
5. **Mehrbenutzer**: API-Keys, 2FA, OpenID Connect, Audit-Log, Activity-Feed. Plugin-Install über Admin-UI, Plugin-SDK, erstes First-Party-Plugin: `pelican-import`. Theme-Pakete (Stufe 3) mit zweitem First-Party-Theme.
6. **Reife**: Server-Transfer zwischen Nodes, Mounts, Node-Auto-Deploy, Direktmodus für Nodes, SFTP durch Tunnel, Prebuilt-Plugin-Komponenten, Layout-Overrides (Theme Stufe 4), App-Templates, Template-Format v2 mit Sidecars, Plugin-Registry, Docs, Release-Pipeline.

## Dev-Setup (Ziel)
- `docker compose up` → Postgres
- `pnpm dev` → Panel auf :3000
- `go run ./cmd/daemon` → Daemon lokal mit Docker Desktop
- Seed: Admin-User, ein Node (localhost), ein Template (z. B. Minecraft Paper, aus Egg konvertiert)
