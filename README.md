# Outpost

Outpost is an AI-first deployment harness for applications running on user-owned infrastructure.

Mothership is the main product surface: a local operator that plans deployment work, calls provisioning and deployment tools, streams status updates, asks for approval according to user settings, and records what happened. It is similar in interaction model to Codex or Claude Code, but its scope is deployment only.

It has three moving parts:

- **Mothership**: local AI deployment harness, dashboard, tool runner, approval gate, provider manager, and operation history.
- **Outpost daemon**: target-side deployment daemon that can deploy, report status, run health checks, and roll back through typed commands.
- **Beacon**: blind WebSocket relay that forwards opaque messages between Mothership and Outpost.

## Core Model

Mothership can operate in two authority modes:

- **Local host mode**: Mothership runs on the VPS or host it manages. It may use local provisioning and deployment tools directly according to the user's approval mode.
- **Beacon strict mode**: Mothership controls a remote target through Beacon and Outpost. Only pre-agreed typed commands are allowed. There is no arbitrary shell command protocol through Beacon.

To bridge these modes, Mothership includes an **SSH & Bootstrapping orchestrator**. The local AI Operator can connect to a remote VPS target over SSH to inspect its operating system, run standard commands (e.g. `git clone`), configure system runtimes, and bootstrap the target-side Outpost daemon securely.

Mothership is AI-first. Deployment harness operations require at least one configured AI provider:

- OpenAI
- OpenRouter

Provider keys are stored only in local Mothership state.

## Repository Layout

```text
packages/
  protocol/     Shared protocol types and runtime validators
  shared/       Crypto, config, filesystem, logging, release helpers
  beacon/       WebSocket relay server
  mothership/   Local AI deployment harness, dashboard, providers, tools, approvals
  daemon/       Target-side deployment daemon and CLI
```

## Install

```bash
npm install
```

## Build and Check

```bash
npm run typecheck
npm run build
```

Generated JavaScript is written to each package's `dist/` directory.

## Start Beacon

Beacon is the relay. It does not decrypt payloads or store secrets.

```bash
node packages/beacon/dist/cli.js --port 8787
```

Health check:

```bash
curl http://127.0.0.1:8787/health
```

## Start Mothership

Mothership is the local AI deployment harness.

```bash
PORT=4173 node packages/mothership/dist/cli.js start
```

Open:

```text
http://127.0.0.1:4173
```

The dashboard should provide:

- AI Operator for deployment prompts, plans, tool calls, approvals, and status updates.
- Provider settings for OpenAI and OpenRouter.
- Approval mode settings.
- Target and app inventory.
- Beacon and Outpost pairing.
- Provisioning and deployment operation history.
- Deploy, rollback, doctor, health check, and log inspection workflows.

Mothership stores local state in:

```text
~/.outpost/mothership/
  mothership_private.pem
  mothership_public.pem
  config.json
  providers.json
  ai-secrets.json
  approvals.json
  targets.json
  apps.json
  operations.json
  tools/
  plugins/
```

AI provider secrets, tools, plugins, and operation history are local-only Mothership data. They are not copied to Beacon or to Outpost hosts unless a specific deployment tool intentionally writes approved app configuration.

For isolated development state, override `HOME`:

```bash
HOME=/tmp/outpost-mothership-home PORT=4173 node packages/mothership/dist/cli.js start
```

## AI Providers

Mothership should not run deployment harness operations until the user configures at least one provider.

Required provider settings:

- provider: `openai` or `openrouter`
- API key
- default model
- validation status

The provider key is stored in:

```text
~/.outpost/mothership/ai-secrets.json
```

## Approval Modes

The user chooses how much Mothership can do without prompting. The default is automatic.

- **Automatic**: run deployment tools without prompting first, while recording all tool calls.
- **Confirm risky**: ask before destructive, security-sensitive, or broad infrastructure changes.
- **Confirm external changes**: ask before changing anything outside local Mothership state or the current app workspace.
- **Manual**: ask before each meaningful action.

Approval settings affect Mothership tool execution. They do not weaken Beacon strict mode.

## Add a Target

You can add a deployment target in two main ways:

- **Run Mothership on the VPS** for local host mode.
- **Pair an Outpost through Beacon** for strict remote control.

### Local Host Mode

Install and start Mothership on the VPS or host that will run the apps. In this mode, Mothership may inspect and provision the host directly according to approval settings.

Typical operations include:

- detect OS and package manager
- install or validate runtimes
- clone or copy repositories
- create app directories
- write environment files
- create systemd services
- configure nginx or Caddy
- check firewall and TLS status
- deploy and health check apps

Mothership must stream status updates while it performs these operations.

### Beacon Strict Mode

Use Beacon and Outpost when Mothership is not running on the target host.

In this mode:

1. Mothership generates a pairing payload.
2. The Outpost daemon is installed on the target.
3. Outpost pins Mothership's public key.
4. Outpost connects through Beacon.
5. Mothership sends only signed typed commands.

Strict mode allows commands such as:

- `GET_STATE`
- `DOCTOR`
- `DETECT_APP`
- `DEPLOY`
- `ROLLBACK`
- `SET_ENV`
- `RUN_HEALTH_CHECK`
- `APPLY_RECIPE`

It must not allow a generic shell command over Beacon.

## Deployment Recipes

Apps are deployed through recipes. A recipe defines how to detect, provision, deploy, health check, and roll back an app type.

Initial recipe targets:

- static front-end apps
- Vite apps
- generic static build outputs
- Node.js services
- server-rendered JavaScript apps
- Docker or Docker Compose apps

Static/Vite is the most mature current path. Broader app recipes are part of the product pivot.

## Status Updates

Provisioning and deployment operations should emit user-readable status events.

Examples:

- Checking SSH access
- Detecting app type
- Installing runtime
- Cloning repository
- Writing service configuration
- Reloading web server
- Running build
- Publishing release
- Waiting for health check
- Deployment failed; keeping previous release active

These events appear in the AI Operator and operation history.

## Existing Static Deploy Path

The current daemon can still deploy static Vite apps.

A static deployment runs this flow:

1. Verify the signed command.
2. Ensure the git working tree has no tracked local changes.
3. Run `git fetch --all --prune`.
4. Check out the requested branch or commit, if provided.
5. Run `installCommand`, if configured.
6. Run `buildCommand`.
7. Copy `outputDir` into `.outpost/releases/<release-id>/`.
8. Atomically update `.outpost/live` to point at the new release.
9. Prune old successful releases beyond `retainReleases`.

The daemon never accepts arbitrary shell commands from Mothership through Beacon. Build commands come from local Outpost configuration or approved recipes.

## Rollback

Rollback should use the recipe's rollback strategy.

For static releases, rollback switches `.outpost/live` to an existing release without rebuilding.

## Serving Boundary

The old static-only boundary said Outpost never configured nginx, Caddy, DNS, TLS, or firewalls.

The new product direction is different:

- In local host mode, Mothership may provision and configure these systems if the user approval mode allows it.
- In Beacon strict mode, host-level changes are limited to explicit typed capabilities implemented by Outpost.

## Current Implementation Notes

The codebase still contains the earlier static Vite implementation and dashboard. The PRD now describes the intended product pivot:

- AI provider gate
- OpenAI and OpenRouter support
- AI Operator workflow
- tool catalog
- approval modes
- local host mode
- Beacon strict mode
- broader app recipes
- visible provisioning status updates

## Development Commands

```bash
npm run typecheck
npm run build
npm run clean
```

Run Beacon and Mothership together:

```bash
node packages/beacon/dist/cli.js --port 8787
PORT=4173 node packages/mothership/dist/cli.js start
```

Then open:

```text
http://127.0.0.1:4173
```
