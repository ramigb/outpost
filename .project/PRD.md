# Product Requirements Document: Outpost Deployment Harness

## 1. Product Summary

Outpost is an AI-first deployment harness for applications running on user-owned infrastructure.
It gives a developer a local Mothership that can plan, provision, deploy, inspect, repair, and roll back apps through tool calls.

The product is similar in interaction model to Codex or Claude Code, but its domain is deployment only.
It is not a coding assistant. It does not edit application source code as its main purpose. It uses tools to prepare hosts, configure deployment targets, operate app releases, and keep the user informed while work is running.

The system has three components:

* **Mothership** - the AI-first deployment harness, local operator, tool runner, dashboard, approval gate, and state store.
* **Outpost** - the target-side deployment daemon installed on a host or inside an app project.
* **Beacon** - a blind relay that connects Mothership and Outpost across networks.

Mothership can run in two authority modes:

* **Local host mode:** Mothership is running on the same VPS or host it is managing. It may use local tools directly according to user approval settings.
* **Beacon strict mode:** Mothership is remote from the target and communicates through Beacon. In this mode, Outpost accepts only pre-agreed typed commands. No arbitrary shell command protocol is exposed through Beacon.

The product starts with a practical deployment surface: static front-end apps, Node services, server-rendered JavaScript apps, and Docker-based apps. The harness should support recipes and tools that can grow over time without weakening the strict-mode safety boundary.

---

## 2. Product Positioning

### One-line Pitch

An AI deployment harness for provisioning, deploying, and operating apps on your own machines.

### Short Pitch

Outpost lets developers deploy apps to user-owned servers through a local AI-first Mothership. The user describes the deployment goal, Mothership plans the work, runs approved deployment tools, streams status updates, asks for confirmation when required, and records what happened. When Mothership is not on the target host, Beacon relays signed messages to a narrow Outpost daemon operating in strict mode.

### Internal Product Thesis

A useful implementation must prove this:

A local AI deployment harness can safely provision a host, connect it to a deployment daemon, deploy and roll back apps, explain status as work happens, and enforce different authority boundaries depending on whether it is operating locally or through Beacon.

---

## 3. Product Principles

* **Deployment only.** The product is for app deployment and operations, not general software development.
* **AI first.** Mothership requires an AI provider key and uses AI as the primary planning and operator interface.
* **Tool grounded.** AI decisions must become explicit tool calls, plans, checks, logs, and status events.
* **Visible progress.** Long-running provisioning and deployment work must stream understandable status updates to the user.
* **User-controlled authority.** The user chooses approval behavior, with automatic mode as the default.
* **Strict remote boundary.** When communicating through Beacon, only pre-agreed Outpost commands are allowed.
* **Local-first state.** Mothership stores keys, settings, provider configuration, operation history, and tool state locally.
* **Recoverable operations.** Failed deploys must preserve the last working release when possible.

---

## 4. Components

### 4.1 Mothership

Mothership is the center of the product. It is a local deployment harness with an AI operator, tool registry, approval engine, dashboard, and persistent operation history.

Mothership must:

* require at least one configured AI provider before deployment operations can run
* support OpenAI and OpenRouter provider configuration
* maintain a local identity keypair
* maintain local deployment state under `~/.outpost/mothership/`
* accept user deployment goals in natural language and structured forms
* create an execution plan before performing substantial work
* call deployment tools for provisioning, inspection, deployment, rollback, and repair
* display real-time status updates while tools run
* ask the user for approval according to the selected approval mode
* store operation logs, tool calls, tool results, approvals, and final summaries
* manage one or more Outposts
* manage one or more Beacons
* switch to strict-mode behavior for any target reached through Beacon
* run direct local tools when Mothership is installed on the target host

### 4.2 Outpost

Outpost is the target-side deployment daemon. It remains intentionally narrow.

Outpost must:

* pair with exactly one Mothership
* pin Mothership's public key
* connect to Beacon when remote control is needed
* accept only typed, pre-agreed commands in strict mode
* reject commands from unknown keys
* run deployment recipes that have been configured or approved
* publish releases atomically where the app type supports it
* report status, logs, health, release metadata, and failures to Mothership
* preserve the current working release when a deploy fails

Outpost must not expose a generic remote shell command over Beacon.

### 4.3 Beacon

Beacon is a blind relay. It forwards opaque encrypted messages between Mothership and Outpost.

Beacon must:

* accept WebSocket connections from Mothership and Outpost
* route messages between paired peers
* keep only ephemeral routing state
* avoid storing payload data
* avoid storing secrets
* avoid decrypting payloads
* provide health checks and basic connection hygiene

Beacon is not a control plane and is not trusted with deployment secrets.

---

## 5. AI Provider Requirements

Mothership is AI-first. The product should not perform harness-driven deployment work until at least one AI provider is configured.

Supported providers:

* **OpenAI**
* **OpenRouter**

Provider configuration must include:

* provider name
* API key or local secret reference
* default model
* optional base URL for OpenAI-compatible providers where applicable
* validation status
* last validation timestamp

Mothership stores provider secrets locally in:

```text
~/.outpost/mothership/ai-secrets.json
```

Secrets must not be copied to Outpost hosts or sent through Beacon except as provider API calls from Mothership itself.

The AI operator must be constrained by a deployment-system prompt and a typed tool catalog. It should not invent hidden capabilities. If a needed tool is unavailable, it must report the missing capability and ask the user to install or enable it.

---

## 6. Approval Modes

The user chooses an approval mode in Mothership settings. The default is **automatic**.

```typescript
type ApprovalMode =
  | "automatic"
  | "confirm_risky"
  | "confirm_external_changes"
  | "manual";
```

### Automatic

Mothership may run deployment tools without prompting first. It still records all tool calls and status updates.

### Confirm Risky

Mothership asks before destructive, irreversible, security-sensitive, or broad infrastructure changes.

Examples:

* deleting release directories
* replacing service files
* changing firewall rules
* rotating secrets
* overwriting existing web server config

### Confirm External Changes

Mothership asks before making changes outside local Mothership state or the current app workspace.

Examples:

* installing packages
* writing systemd units
* editing nginx/Caddy config
* changing DNS instructions or records through a provider tool
* starting or stopping services

### Manual

Mothership proposes each meaningful action and waits for the user to approve before running it.

Even in automatic mode, Beacon strict mode remains enforced. Approval settings cannot grant arbitrary shell access through Beacon.

---

## 7. Tool and Harness Model

Mothership tools are deployment capabilities exposed to the AI operator through a typed catalog.

Tool metadata should include:

* name
* description
* input schema
* output schema
* authority level
* target scope
* whether it mutates local state
* whether it mutates remote state
* whether it is destructive
* whether approval is required under each approval mode

Initial tool categories:

* host inspection
* package/runtime installation checks
* repository clone/copy/fetch
* app type detection
* environment variable management
* build and deploy
* service management
* web server configuration
* firewall checks and updates
* TLS and certificate checks
* health checks
* rollback
* log inspection
* Beacon and Outpost pairing
* strict-mode Outpost commands

Mothership should present tool progress as user-readable status events:

```typescript
type OperationEvent = {
  operationId: string;
  timestamp: string;
  level: "info" | "warning" | "error" | "success";
  phase: string;
  message: string;
  toolName?: string;
  target?: string;
};
```

Example status messages:

* "Checking SSH access to the host"
* "Detecting app type"
* "Installing Node.js runtime"
* "Writing systemd service"
* "Reloading Caddy"
* "Waiting for health check"
* "Deployment failed; keeping previous release active"

---

## 8. Authority Modes

### 8.1 Local Host Mode

Local host mode applies when Mothership is running on the host it manages.

In local host mode, Mothership may run local tools directly according to approval settings. This mode is appropriate for a single VPS installation where the user wants the harness on the same machine as the apps.

Examples of allowed local tools:

* inspect OS, ports, services, and app directories
* install required runtimes where the tool supports it
* clone or update repositories
* create app directories
* write deployment config
* write or update systemd service files
* write or update nginx/Caddy config
* reload services
* run health checks

### 8.2 Beacon Strict Mode

Beacon strict mode applies when Mothership controls a target through Beacon and Outpost.

In strict mode:

* Mothership sends only signed typed commands to Outpost.
* Outpost validates command type, sender, freshness, and parameters.
* Outpost refuses arbitrary shell commands.
* Outpost runs only pre-agreed deployment operations and configured recipes.
* Host-level provisioning through Beacon is limited to explicit typed capabilities that Outpost implements.

Strict mode command examples:

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

There must be no command equivalent to:

```typescript
{ type: "RUN_SHELL_COMMAND", command: string }
```

---

## 9. App Deployment Scope

The new product is broader than static Vite deployments. Mothership should support deployment recipes for multiple app types.

Initial app types:

* static front-end apps
* Vite apps
* generic static build outputs
* Node.js services
* server-rendered JavaScript apps
* Docker or Docker Compose apps

Each app type should define a recipe:

```typescript
type DeploymentRecipe = {
  id: string;
  name: string;
  appTypes: string[];
  requiredTools: string[];
  planSteps: string[];
  deployStrategy: "static_release" | "service_restart" | "container_rollout" | "custom";
  rollbackStrategy: "symlink" | "previous_service_version" | "previous_image" | "manual";
  healthCheck?: {
    type: "http" | "tcp" | "command";
    target: string;
  };
};
```

The first implementation may keep static Vite as the most complete recipe, but the PRD must not define the product as static-only.

---

## 10. Provisioning Scope

Mothership owns full host provisioning when the user allows it.

Provisioning capabilities include:

* SSH access validation
* OS and architecture detection
* package manager detection
* runtime installation or validation
* Git setup checks
* repository clone/copy/fetch
* app directory creation
* build dependency installation
* environment file creation
* process manager setup
* systemd service creation and updates
* nginx or Caddy configuration
* firewall checks and updates
* TLS/certificate checks
* app health checks
* rollback plan creation

Every provisioning workflow must stream phase-by-phase status updates. The user should be able to see what is happening without opening an SSH session.

---

## 11. Deployment Flow

A typical AI-harness deployment flow:

1. User configures an AI provider.
2. User asks Mothership to deploy an app or fills a structured deployment form.
3. Mothership inspects known state and asks for missing required inputs.
4. Mothership proposes a deployment plan.
5. Mothership evaluates approval mode.
6. Mothership runs tools while streaming status events.
7. Mothership provisions the host if needed.
8. Mothership installs or pairs Outpost if needed.
9. Mothership deploys the app using the selected recipe.
10. Mothership runs health checks.
11. Mothership summarizes the result and records operation history.

For static release deployments:

1. Resolve repository and target ref.
2. Install dependencies if required.
3. Run the build command.
4. Copy finalized output into a release directory.
5. Atomically move the live pointer.
6. Keep previous release available for rollback.

For service deployments:

1. Resolve repository and target ref.
2. Install dependencies or build image.
3. Write or update service configuration.
4. Restart or roll out the service.
5. Run health checks.
6. Preserve enough metadata to roll back.

---

## 12. UI Requirements

Mothership should provide both conversational and structured control surfaces.

Required views:

* **AI Operator:** prompt input, current plan, tool calls, approvals, and status stream.
* **Operations:** history of deployment/provisioning runs with logs and summaries.
* **Targets:** known hosts, Outposts, Beacon connections, online/offline state, and authority mode.
* **Apps:** deployed apps, app type, current release/version, health, URL, service state, and rollback options.
* **Providers:** OpenAI and OpenRouter settings, model selection, validation status.
* **Approvals:** approval mode and policy settings.
* **Tools:** installed deployment tools, permissions, and availability.
* **Settings:** keys, Beacon URLs, local paths, and product configuration.

The UI must make the current authority mode visible:

* "Local host mode" when Mothership can operate directly on the host.
* "Beacon strict mode" when commands are constrained to Outpost's typed protocol.

---

## 13. State and Storage

Mothership stores local state under:

```text
~/.outpost/mothership/
  mothership_private.pem
  mothership_public.pem
  config.json
  ai-secrets.json
  providers.json
  approvals.json
  targets.json
  apps.json
  operations.json
  tools/
  plugins/
```

Outpost stores target-side state under either the app project or a host-level Outpost directory, depending on the recipe:

```text
project/
  .outpost/
    config.json
    mothership_pub.pem
    outpost_private.pem
    outpost_public.pem
    releases/
    logs/
    state.json
```

Host-level Outpost state may be introduced for managing multiple apps on one VPS, but strict-mode safety rules still apply.

---

## 14. Security Model

### Core Rules

* Mothership is local-first and stores secrets locally.
* AI provider keys are local Mothership secrets.
* Beacon cannot decrypt payloads.
* Outpost pins Mothership's public key.
* Outpost accepts typed protocol commands only in strict mode.
* Approval settings control Mothership tool execution, not Beacon's protocol boundary.
* Tool calls are logged with inputs, outputs, timestamps, and approval decisions.
* Secrets must be redacted from logs and status messages.
* Failed deploys should preserve known-good serving state when possible.

### Risk Boundary

The most powerful mode is local host mode with automatic approval. The UI must make that clear during setup. Users may choose it because they want a self-operating deployment harness on their own VPS.

The safest remote mode is Beacon strict mode. It intentionally trades flexibility for a narrow command surface.

---

## 15. Explicit Non-goals

The system must not include:

* general-purpose coding assistance
* automatic application source-code modification as a primary workflow
* arbitrary shell execution through Beacon
* AI agents running inside Beacon
* Beacon storing secrets or decrypting payloads
* hosted Mothership as a requirement
* team accounts as a requirement
* Kubernetes as an initial target
* database schema migration automation as an initial target

The system may eventually integrate with hosted services, DNS providers, container registries, and cloud APIs, but the core product remains a deployment harness for user-owned infrastructure.

---

## 16. Failure Handling

Mothership must handle failures as first-class operation states.

Failure requirements:

* surface the failed phase clearly
* show the last successful status event
* preserve tool output with secrets redacted
* explain whether target state was changed
* suggest or run diagnostic tools according to approval mode
* avoid replacing a healthy release with a failed one
* support rollback where the recipe provides it

Examples:

* SSH connection failed
* package install failed
* build failed
* systemd service failed to start
* health check failed
* Beacon disconnected
* strict-mode command rejected
* AI provider validation failed

---

## 17. Development Milestones

### Phase 1: AI Provider Gate and Harness Shell

Add provider configuration for OpenAI and OpenRouter, require a valid provider before harness operations, and introduce the AI Operator view.

### Phase 2: Tool Catalog and Approval Engine

Define deployment tools, authority metadata, approval modes, operation events, and operation history.

### Phase 3: Mothership Provisioning Workflows

Add the OpenAI Agents SDK as the OpenAI-provider orchestration adapter for the AI Operator, while keeping the Phase 2 tool runner as the authority boundary. Add host inspection, SSH/local execution, repository setup, runtime checks, service setup, web server configuration, and health checks with streamed status.

### Phase 4: Strict-Mode Protocol

Refine Outpost commands around typed strict-mode operations, status reporting, recipes, health checks, and rejection behavior. Agents SDK tool calls must map to strict typed Outpost commands only; no agent path may introduce arbitrary shell access through Beacon.

### Phase 5: App Recipes

Implement static/Vite as the first complete recipe, then add Node service and Docker/Docker Compose recipes. Recipes should be exposed to the AI Operator as typed tools with explicit required inputs, approval behavior, status events, and rollback metadata.

### Phase 6: Dashboard Alignment

Update dashboard views for AI Operator, Operations, Targets, Apps, Providers, Approvals, and Tools. The AI Operator should display Agents SDK run state, streamed text, tool calls, approval pauses, resumed runs, and operation history from local Mothership state.

### Phase 7: Documentation and First Deployment Flow

Rewrite setup and deployment docs around the harness workflow, authority modes, providers, approval settings, Agents SDK-backed OpenAI orchestration, OpenRouter fallback behavior, and status streams.

---

## 18. Acceptance Scenario

The implementation is complete for the pivot when this scenario works end to end:

1. User starts Mothership.
2. Mothership blocks deployment operations until the user configures either OpenAI or OpenRouter.
3. User keeps the default automatic approval mode or selects another mode.
4. User asks Mothership to deploy an app to a VPS.
5. Mothership identifies missing inputs and asks concise follow-up questions.
6. Mothership proposes a plan.
7. Mothership connects to the target in local host mode or through bootstrap SSH.
8. Mothership streams status updates while inspecting and provisioning the host.
9. Mothership installs or pairs Outpost as needed.
10. If the target is controlled through Beacon, Mothership switches to strict mode.
11. Mothership deploys the app using the selected recipe.
12. Mothership runs health checks.
13. Mothership shows the final URL, release/version, service state, and rollback option.
14. A failed deployment keeps the previous working release active when the recipe supports it.
15. User can inspect the full operation history, tool calls, approvals, and logs.

---

## 19. Final Product Definition

Outpost is an AI-first deployment harness for apps on user-owned infrastructure. Mothership plans and runs deployment workflows through explicit tools, streams status while provisioning and deploying, requires OpenAI or OpenRouter configuration, honors user approval settings, and preserves a strict typed-command boundary when operating through Beacon and Outpost.
