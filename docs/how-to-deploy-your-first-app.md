# How to Deploy Your First App with Outpost

This guide describes how to run and use **Outpost**—an AI-first deployment harness for applications running on user-owned infrastructure.

Outpost has three main components:

- **Mothership**: The local operator dashboard, tools runner, approvals gate, and operation history.
- **Outpost daemon**: The target-side daemon that executes signed commands (deploy, rollback, health checks) under a strict protocol.
- **Beacon**: An opaque, blind WebSocket relay forwarding messages between Mothership and Outpost.

---

## 1. Build Outpost

Build the TypeScript codebase in the repository root:

```bash
npm install
npm run build
```

This compiles all modules into their respective `dist/` directories.

---

## 2. Start Beacon

Start the WebSocket relay. By default, it listens on port `8787` and requires no credentials (since it only forwards signed, encrypted envelopes):

```bash
node packages/beacon/dist/cli.js --port 8787
```

You can verify it is running by hitting its health check endpoint:

```bash
curl http://127.0.0.1:8787/health
```

---

## 3. Start Mothership

Start the Mothership control plane. By default, the dashboard runs on port `4173`:

```bash
PORT=4173 node packages/mothership/dist/cli.js start
```

Then open your browser and navigate to:

```text
http://127.0.0.1:4173
```

---

## 4. Configure & Validate AI Provider

Mothership uses an AI Operator for planning and orchestrating deployment steps.

1. On the dashboard, go to the **AI Key** section.
2. Select your AI provider (**OpenAI** or **OpenRouter**).
3. Enter your API Key, Default Model, and optional Base URL.
4. Click **Save Provider**.
5. Click **Validate**. This verifies connectivity and updates the status badge to `validated`.

_Note: Provider credentials are saved strictly in `~/.outpost/mothership/ai-secrets.json` and never leave your local Mothership host._

---

## 5. Pair a Remote Target (VPS Bootstrap)

If your application will run on a remote server (e.g., VPS), you can instruct the AI Operator to bootstrap and pair it for you directly from the chat interface.

### AI-Driven Remote SSH & Bootstrap Tools

The AI Operator has access to a dedicated suite of remote host management tools:

- **`host_inspect_ssh`**: Allows the AI to query target OS, installed runtimes, listening ports, and status.
- **`host_run_ssh_command`**: Allows the AI to execute arbitrary command-line actions on the target over SSH, such as checking files, cloning repositories, installing dependencies, or starting/stopping system services.
- **`mothership_bootstrap_vps`**: A combined high-level workflow that provisions necessary runtimes, clones the repository, configures daemon pairing, and triggers deployment automatically.

For example, you can tell the AI Operator:

> "Connect to root@203.0.113.10 and bootstrap the repository https://github.com/acme/my-app.git"

### Self-Healing Runtime Provisioning

Mothership automatically runs checks on the remote host over SSH. If `git`, `node` (Node.js 20), or `docker` are missing on the target host, it will automatically install them using `sudo apt-get` before configuring the daemon, ensuring the remote host is ready. It will then generate keys, pair the daemon with Mothership via Beacon, and start the daemon.

---

## 6. Dashboard Controls & Inventory

Once paired, the target Outpost will show up in the **Outposts** section as `online` and list its active release, branch, commit, and release history.

You have access to the following actions for any paired target:

- **Deploy**: Run the standard deployment flow.
- **Apply static**: Deploy a static site using the `static-vite` recipe.
- **Apply Node**: Run the application as a background service via the `node-service` recipe.
- **Apply Docker**: Run the application as containerized services via the `docker-compose` recipe.
- **Doctor**: Run a target system diagnostic check.
- **Detect app**: Ask the target daemon to auto-detect what app frameworks are present.
- **Health**: Trigger a direct HTTP health check.

---

## 7. Deployment Recipes & Rollbacks

### A. Static or Vite apps (`static-vite`)

Clones the repository, installs npm dependencies, compiles the build output (e.g., `npm run build`), publishes the output directory (e.g., `dist`) to `.outpost/releases/`, and atomically points `.outpost/live` to it.

- **Rollback**: Updates the `.outpost/live` symlink back to a previous successful release.

### B. Node.js Service (`node-service`)

Runs build commands and installs production dependencies. Generates a custom `systemd` service unit:

- **System mode**: If the target has system-level write permissions, writes a unit under `/etc/systemd/system/` and runs under the target user.
- **User mode**: If running as non-root, automatically writes a user service unit under `~/.config/systemd/user/` and runs with `systemctl --user` without requiring sudo.
- **Health retries**: Automatically polls the local health URL (up to 5 retries) to verify binding.
- **Rollback Boundary**: If building or starting fails, or the health check fails, it automatically reverts the symlink and restarts the service on the previous active version.

### C. Docker or Compose Rollout (`docker-compose`)

Copies the repository to the release folder and runs:

```bash
docker compose -f <compose-file> up -d --build --remove-orphans
```

- **Health checking**: Retries checking the container endpoint up to 5 times.
- **Rollback Boundary**: If verification fails, it restores the previous compose files and runs `docker compose up -d` to restart the prior working containers automatically.

---

## 8. Inline Operation Approvals

Mothership records all operations. If your Approval Mode is set to confirm actions (e.g., `manual` or `confirm_risky`):

1. When an Operator step requires permission, it will pause.
2. The operation will appear in the **Activity** log section with the status `waiting_approval`.
3. An **Approve** button will render inline next to the pending step.
4. Click **Approve** to authorize and continue that same recorded operation.
