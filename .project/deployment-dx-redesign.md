# Deployment Harness DX Redesign

This document is a product and implementation proposal for the new Outpost direction.
It supersedes the older dashboard-first static Vite redesign.

## Goal

Outpost should make this path feel normal:

```text
Open Mothership -> configure AI provider -> describe deployment goal -> approve or let it run -> watch status -> app is live
```

The user should not need to manually assemble SSH commands, pairing commands, service files, web server snippets, deployment scripts, or health checks for the common case.

Mothership becomes the deployment harness. It plans, calls tools, asks for approval according to user settings, streams status, and records the operation.

## Product Shift

The previous DX goal was:

```text
Open Mothership -> add an app -> run one command on the VPS -> click Deploy
```

The new DX goal is broader:

```text
Tell Mothership what app to deploy and where.
Mothership figures out the deployment workflow and executes it through approved tools.
```

This means:

* AI is first-class and required for harness operations.
* OpenAI and OpenRouter are first supported providers.
* Automatic approval is the default, but the user can choose stricter modes.
* Mothership may provision host infrastructure when allowed.
* Beacon-controlled targets use strict mode with typed commands only.
* Outpost remains a narrow target-side daemon, not a generic shell tunnel.

## Authority Modes

### Local Host Mode

Mothership runs on the VPS or host it manages.

This gives the harness direct local authority according to approval settings.

Expected local capabilities:

* inspect OS, ports, services, and app directories
* validate or install runtimes
* clone or update repositories
* create app directories
* write env files
* write systemd service files
* configure nginx or Caddy
* check firewall and TLS status
* run builds
* restart services
* run health checks
* roll back apps

### Beacon Strict Mode

Mothership runs away from the target and communicates through Beacon and Outpost.

This mode must stay narrow:

* signed typed commands only
* no arbitrary shell command protocol
* no hidden escalation through plugins
* command parameters validated by Outpost
* recipes must be pre-agreed or explicitly approved

Strict mode trades flexibility for a safer remote boundary.

## First-Run UX

### 1. Start Mothership

```bash
npx @outpost/mothership start
```

Mothership opens the dashboard and shows provider setup if no AI provider is configured.

### 2. Configure Provider

The user configures one of:

* OpenAI
* OpenRouter

Mothership validates the provider and selected model. Deployment harness actions remain blocked until validation succeeds.

### 3. Choose Approval Mode

The default is automatic.

Modes:

* Automatic
* Confirm risky
* Confirm external changes
* Manual

The UI must make local host mode plus automatic approval visibly powerful.

### 4. Describe the Deployment

Example:

```text
Deploy https://github.com/acme/site.git on this VPS, serve it with Caddy at example.com, and keep rollback available.
```

Mothership should convert this into:

* missing-input questions
* app/host inspection plan
* tool plan
* expected mutations
* rollback approach
* health-check strategy

### 5. Execute with Status

Mothership streams status while tools run:

```text
Checking host access
Detecting operating system
Detecting app type
Checking runtime requirements
Cloning repository
Installing dependencies
Writing service configuration
Reloading Caddy
Running health check
Deployment complete
```

Status should be understandable without reading raw logs.

### 6. Summarize and Record

At the end, Mothership shows:

* app name
* target host
* authority mode
* deployed ref/version
* public URL if known
* health status
* rollback availability
* changed files/services/configs
* operation log link

## Tool Catalog

Mothership tools should be explicit and typed.

Tool metadata:

* name
* input schema
* output schema
* mutates local state
* mutates remote state
* destructive
* approval behavior
* supported authority modes

Initial tool groups:

* provider validation
* host inspection
* SSH access checks
* repository setup
* app detection
* runtime checks and installation
* env management
* static release deployment
* service deployment
* Docker deployment
* systemd management
* nginx/Caddy management
* firewall checks
* TLS checks
* health checks
* rollback
* Beacon pairing
* strict-mode Outpost commands

## App Recipes

The deployment harness should use recipes rather than hard-coded one-off flows.

Initial recipes:

* static front-end
* Vite
* generic static output
* Node service
* server-rendered JavaScript app
* Docker
* Docker Compose

Each recipe should define:

* detection signals
* required tools
* provisioning steps
* deploy steps
* health check
* rollback strategy
* strict-mode compatibility

Static/Vite can remain the first complete recipe while the harness architecture grows around recipes.

## Mothership UI Changes

Required views:

* **AI Operator:** prompt, plan, status stream, tool calls, approvals.
* **Providers:** OpenAI/OpenRouter keys, model selection, validation.
* **Approvals:** approval mode and policy explanations.
* **Targets:** hosts, authority mode, Outposts, Beacon status.
* **Apps:** deployed apps, health, URL, current release/version.
* **Operations:** operation history, logs, summaries, changed resources.
* **Tools:** available tools, permissions, missing capabilities.
* **Settings:** local keys, paths, Beacons.

The UI should always show whether the current target is in local host mode or Beacon strict mode.

## Outpost Changes

Outpost should evolve from a static project daemon into a strict target-side deployment daemon.

Required work:

* keep key pinning and signed command verification
* reject arbitrary shell commands
* support typed strict-mode commands
* report app, host, release, service, and health state
* support deployment recipes approved for strict mode
* preserve current working release on failed deploys where possible
* stream logs and status events to Mothership

Example strict commands:

```typescript
type StrictOutpostCommand =
  | { type: "PING" }
  | { type: "GET_STATE" }
  | { type: "DOCTOR" }
  | { type: "DETECT_APP"; projectPath?: string }
  | { type: "DEPLOY"; appId: string; ref?: string }
  | { type: "ROLLBACK"; appId: string; releaseId: string }
  | { type: "SET_ENV"; appId: string; encryptedEnv: string }
  | { type: "RUN_HEALTH_CHECK"; appId: string }
  | { type: "APPLY_RECIPE"; recipeId: string; approvedParameters: Record<string, unknown> };
```

## Beacon Changes

Beacon can stay simple.

It should:

* route opaque messages
* avoid storing payloads
* avoid storing secrets
* expose health
* maintain ephemeral routing state
* support multiple Mothership and Outpost peers

Beacon should not gain deployment intelligence.

## Implementation Order

1. Add provider setup for OpenAI and OpenRouter.
2. Gate harness operations until a provider validates.
3. Add approval settings with automatic as default.
4. Add operation event and operation history storage.
5. Define the Mothership tool catalog and metadata.
6. Build the AI Operator view around plans, tools, approvals, and status.
7. Add local host inspection and status streaming.
8. Reframe existing static/Vite deployment as the first recipe.
9. Add local host provisioning tools for service and web server setup.
10. Refine Outpost strict-mode command protocol.
11. Add Node service and Docker recipes.
12. Update docs and UI language throughout.

## Non-goals

This redesign still excludes:

* general-purpose coding assistance
* arbitrary shell execution through Beacon
* AI running inside Beacon
* Beacon decrypting or storing secrets
* Kubernetes as an initial target
* database migration automation as an initial target
* team accounts as a requirement

## Acceptance Scenario

The redesign is ready when this works:

1. User starts Mothership.
2. Mothership requires OpenAI or OpenRouter setup.
3. User keeps automatic approval or selects a stricter mode.
4. User asks Mothership to deploy an app.
5. Mothership asks for missing target/app details.
6. Mothership proposes a plan.
7. Mothership runs provisioning and deployment tools while streaming status.
8. Mothership installs or pairs Outpost when needed.
9. Beacon targets operate in strict mode.
10. The app is deployed and health checked.
11. Mothership records the operation, changed resources, logs, and rollback option.

## Summary

Outpost's new DX is not "click a deploy button after manual setup." It is an AI-first deployment harness that owns the deployment workflow, explains what it is doing, honors user approval settings, and preserves a strict typed-command boundary for remote Beacon-controlled targets.
