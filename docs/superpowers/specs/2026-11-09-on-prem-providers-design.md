# On-Prem Providers: vSphere, SSH Servers, Kubernetes

## Context
OpenCAI is meant to be multi-cloud and on-prem first. The code already supports AWS, Azure and GCP through a plug-in registry (`backend/src/ai/csp/`). Each provider module supplies a CLI binary, a sandbox image, a zod credential schema, `buildEnv`, an optional `prepareSandbox`, `classifyOperation` and `promptRules`. On-Prem today is only a "Coming Soon" pill in the operator sidebar.

This change adds three on-prem providers as first-class providers next to the clouds. Each gets its own credential form, its own command allowlist and the same approval flow the clouds use.

**Decisions made with the user:**
- **v1 targets:** VMware vSphere, direct Linux servers over SSH, and Kubernetes.
- **Network:** the sandbox container connects to on-prem targets directly. OpenCAI is deployed inside the network or VPN'd into it. No jump host and no on-site agent in v1.
- **Cloud / On-Prem toggle:** it filters workspaces. On-Prem shows only on-prem workspaces. Chat and dashboards behave the same in both.
- **SSH command policy:** allowlisted read-only commands run freely, known mutating commands need approval, and everything else is rejected.
- **SSH workspace:** one workspace is a group of hosts. They share one user and one key, and each host has a name the agent uses.
- **sudo:** allowed only with approval. Any `sudo …` is classified as mutating and needs passwordless sudo on the host.
- **Host keys:** an optional `known_hosts` field. If filled in, keys are enforced (`StrictHostKeyChecking yes`). If empty, keys are accepted on first connect (`accept-new`, per sandbox).
- **FinOps:** hidden for on-prem workspaces. Only CloudOps is available.

## Backend

### 1. Provider identity
- In `backend/prisma/schema.prisma`, add `VSPHERE`, `SSH` and `KUBERNETES` to the `CloudServiceProvider` enum, with a new migration under `prisma/migrations/`.
- In `backend/src/constants/csp.js`, add the three values plus an exported `ON_PREM_CSPS` set (or a `kind: 'cloud' | 'onprem'` per entry).
- In `backend/src/ai/constants.js`, extend `SANDBOX_IMAGE_TAGS` with `VSPHERE`, `SSH` and `KUBERNETES`.
- Register the three modules in `backend/src/ai/csp/index.js`.
- In `backend/src/ai/prompts/defaults.js`, add `govc`, `kubectl` and `ssh` to `PROVIDER_BINARIES`. Add a **data migration** that appends these to `allowedBinaries` on existing `Persona` rows. The rows are persisted (`schema.prisma:264`), so editing the defaults alone won't reach existing installs.

### 2. `backend/src/ai/csp/vsphere.js` (CLI: `govc`)
- **Credential fields:** `url` (vCenter or ESXi, https), `username`, `password`, `insecure` (boolean, for self-signed TLS), and optional `datacenter`.
- **`buildEnv`:** sets `GOVC_URL`, `GOVC_USERNAME`, `GOVC_PASSWORD`, `GOVC_INSECURE` and `GOVC_DATACENTER`. This is the same pattern as AWS: credentials go in env, and there is no `prepareSandbox`.
- **`classifyOperation`:** keyed on `argv[1]` (the govc command, such as `vm.info`). Patterns go in `backend/src/ai/policy/patterns/vsphere.js`.
  - **Lookup:** `-h` and `help`.
  - **Read-only:** `about`, `ls`, `find`, `tree`, `*.info`, `*.ls`, `events`, `tasks`, `metric.ls`, `metric.sample`, `object.collect`, `datastore.ls`, `datastore.info`, `host.info`, `cluster.usage`, `vm.ip`.
  - **Mutating:** `vm.power`, `vm.create`, `vm.clone`, `vm.destroy`, `vm.change`, `vm.migrate`, `snapshot.*` (except `snapshot.tree`), `host.maintenance.*`, `tags.attach`/`detach`/`create`/`rm`, `*.rm`, `*.create`, `*.add`.
  - **Rejected:** `guest.*` (runs code inside VMs), `datastore.upload` and `datastore.download` (file transfer to and from the sandbox), `session.*`, `env`, `vm.console`, `import.*`/`export.*`. Unknown commands are rejected by default.
- `supportsRegions: false`. Add `promptRules` (use `-json`, `govc <cmd> -h` for syntax, and that the datacenter is preselected).
- **Image:** `backend/sandbox/vsphere/Dockerfile`, a minimal base with a pinned `govc` release binary, non-root `sandbox` user uid 10001, `sleep infinity`, mirroring the AWS Dockerfile.

### 3. `backend/src/ai/csp/kubernetes.js` (CLI: `kubectl`)
- **Credential field:** `kubeconfig` (multiline). Zod parses it as YAML and checks for exactly one context with a cluster and a user. Exec-plugin auth (`users[].user.exec`) is rejected because it would run arbitrary binaries. An optional `namespace` default is also accepted.
- **`prepareSandbox`:** follows the Azure pattern (`azure.js:31-61`). A fixed, backend-owned script writes `$OPENCAI_KUBECONFIG` to `~/.kube/config` with `chmod 600`, and the secret reaches it only through the exec env. **`buildEnv`:** non-secret settings only (`KUBECONFIG=/home/sandbox/.kube/config`).
- **`classifyOperation`:** patterns go in `policy/patterns/kubernetes.js`.
  - **Lookup:** `--help`, `explain`, `api-resources`, `version`.
  - **Read-only:** `get`, `describe`, `logs` (without `-f`/`--follow`), `top`, `events`, `cluster-info`, `auth can-i`, `rollout status`/`history`.
  - **Mutating:** `apply` only with `-f -`-free inline forms. Since there is no file in the sandbox, `apply` and `create -f` are rejected in v1. Also mutating: `delete`, `scale`, `rollout restart`/`undo`/`pause`/`resume`, `patch`, `label`, `annotate`, `cordon`, `uncordon`, `drain`, `taint`, `set image`, `create <resource>` (imperative forms).
  - **Rejected:** `exec`, `attach`, `cp`, `port-forward`, `proxy`, `run`, `debug`, `edit`, `config`, `plugin`, and the global flags `--kubeconfig`, `--server`, `--token`, `--as` and `--context`.
  - **Secrets (my call):** reading `secret`/`secrets` resources with `get` or `describe` is rejected, so secret values never reach the model.
- **Image:** `backend/sandbox/kubernetes/Dockerfile` with a pinned `kubectl`.

### 4. `backend/src/ai/csp/ssh.js` (CLI: `ssh`)
- **Credential fields:**
  - `username`
  - `authType`: `key` or `password`. My call: v1 supports **key only**, because password auth needs `sshpass` and a TTY trick. Password is listed as a follow-up.
  - `privateKey` (multiline) and optional `passphrase`. My call: reject keys that have a passphrase in v1, and tell the admin to supply an unencrypted deploy key.
  - `hosts`: a list of `{ name, address, port? }`. Names match `^[a-z0-9][a-z0-9-]{0,62}$` and must be unique.
  - `knownHosts`: optional, multiline.
- **`prepareSandbox`:** a fixed script, with the secrets passed only through the exec env. It writes:
  - `~/.ssh/id` (mode 600).
  - `~/.ssh/known_hosts`, if provided.
  - `~/.ssh/config`, with one `Host <name>` block per host containing `HostName`, `Port`, `User`, `IdentityFile ~/.ssh/id` and `IdentitiesOnly yes`, plus:
    - `StrictHostKeyChecking yes|accept-new`, depending on whether `knownHosts` is set
    - `BatchMode yes`
    - `ConnectTimeout 10`
    - `ProxyCommand none`
    - `ProxyJump none`
    - `PermitLocalCommand no`
    - `ForwardAgent no`
    - `ClearAllForwardings yes`
    - `RequestTTY no`

  The host list is generated from validated data, so no model input ever reaches this script.
- **Command shape the model writes:** `ssh <hostName> <command> [args…]`.
- **`classifyOperation`:**
  - `argv[1]` must be a configured host name. This needs the credential's host list at classification time; see "Policy plumbing" below. Any `-` option anywhere before the remote command is **rejected**. This blocks `-o ProxyCommand=…`, `-L`, `-R`, `-D` and `-F`, which matter most for security.
  - The remote part is `argv[2..]`. An optional leading `sudo` (bare, no flags) forces **mutating**.
  - Remote commands are classified from `policy/patterns/linux.js`:
    - **Read-only:** `uptime`, `hostname`, `uname`, `whoami`, `id`, `df`, `du`, `free`, `vmstat`, `iostat`, `mpstat`, `lscpu`, `lsblk`, `lsof -i`, `ps`, `top -b -n 1`, `ip addr|route|link`, `ss`, `netstat`, `systemctl status|is-active|is-enabled|list-units|list-timers`, `journalctl` (no `-f`), `dmesg`, `who`, `w`, `last`, `cat`/`head`/`tail`/`ls`/`stat` restricted to `/var/log/**`, `/etc/os-release` and `/proc/{loadavg,meminfo,cpuinfo,uptime}`, plus `docker ps|images|stats --no-stream|logs` (no `-f`).
    - **Mutating:** `systemctl start|stop|restart|reload|enable|disable`, `kill`/`pkill`, `apt-get`/`apt`/`dnf`/`yum` `install|update|upgrade|remove`, `docker start|stop|restart|rm`, `reboot`, `shutdown`.
    - **Rejected:** everything else, including shells, interpreters (`sh`, `bash`, `python`, `perl`…), editors, `tail -f` and anything with `-f`/`--follow`.
- **Remote quoting (my call, required for safety):** SSH joins remote args into one string that the *remote shell* interprets, so the shell-quote check in `commandPolicy.js` is not enough. Add an optional provider hook, **`toExecArgv(argv)`**. For SSH it returns `['ssh', host, '--', <each remote token single-quoted with ' escaped>]`. The orchestrator (`orchestrator.js` ~454/803, where the classified argv is run) and `widgetRunner.js` call `csp.toExecArgv?.(argv) ?? argv` just before `executeInSandbox`. The classifier additionally rejects remote tokens containing newlines or NUL.
- **Image:** `backend/sandbox/ssh/Dockerfile`, with `openssh-client` only.
- `promptRules`:
  - list the available host names
  - use `sudo` only when necessary
  - no pipes, redirects or globs
  - use `journalctl -n`/`--since` rather than follow
  - use `-b -n 1` for top

### 5. Policy plumbing for SSH host names
`classifyOperation(argv)` gets no workspace context today. Change the signature to `classifyOperation(argv, context)`, where `context = { hostNames }`, and thread it from `commandPolicy.classify({ …, cspContext })`. Callers in the orchestrator and dashboards derive `hostNames` from the decrypted credential they already hold (`workspaceAccess.js:34`, `chat.service.js:111`). Other providers ignore the argument.

### 6. Hardcoded cloud assumptions to generalise
- **Dashboards:** the `widgetAuthor.js:63-118` prompt names the cloud output flags and gives AWS examples. Move the output-format hint into a per-provider `promptRules`/`dashboardHints` field, and add `govc … -json`, `kubectl … -o json` and plain-text SSH hints.
- **`period.js:27`:** remove the AWS wording.
- **Orchestrator region fan-out:** already gated by `supportsRegions: false`. Nothing to do.

### 7. Hiding FinOps for on-prem
- In `backend/src/modules/chat/chat.service.js` `createSession`, reject `mode === 'FINOPS'` when `workspace.csp` is in `ON_PREM_CSPS`, returning 400 with a clear message.
- Hide the FinOps entries in `OperatorSidebar.jsx` when the selected workspace is on-prem.

### 8. Credential save and test (my call)
Validation stays format-only, as it is today, through `credentialSchema` in `workspaces.service.js:39-66`. No DB change is needed because the blob is opaque and envelope-encrypted. A "Test connection" button that runs `govc about`, `kubectl version` or `ssh <first host> uptime` in a throwaway sandbox is **out of scope for v1** and listed as a follow-up.

## Frontend
- **`frontend/src/lib/csp.js`:**
  - Add VSPHERE ("VMware vSphere"), SSH ("Linux servers (SSH)") and KUBERNETES ("Kubernetes"), each with `kind: 'onprem'` (clouds get `kind: 'cloud'`) and its credential fields. The `insecure` checkbox needs a new `type: 'checkbox'` field kind.
  - The SSH `hosts` list needs a small repeatable-row field (`type: 'hostList'`: name, address, port). That means a new field renderer in `OrganisationDetail.jsx`'s credential dialog (lines ~152-163, 300-309).
  - Export `cspKind(csp)`.
- **`OrganisationDetail.jsx`:**
  - Group the provider dropdown into "Cloud" and "On-Prem" optgroups.
  - Relabel "Account / Environment" per kind. My call: for on-prem it becomes "Site / Cluster" and "Environment". It is the same DB columns with different labels only.
- **`OperatorPage.jsx` / `OperatorSidebar.jsx` / `WorkspaceSelectorForm.jsx`:**
  - Replace the "Coming Soon" branch with the normal sidebar.
  - Filter the workspace picker by `cspKind(ws.csp) === cloudOrOnPrem`.
  - Switching pills clears a selected workspace of the other kind.
  - Hide FinOps modes when on-prem.

## Tests (follow the existing `*.test.js` patterns next to each module)
- **`vsphere.test.js`, `kubernetes.test.js`, `ssh.test.js`:**
  - credential schema accept/reject
  - `buildEnv`, plus `prepareSandbox` passing secrets only through env (copy the `azure.test.js:157` pattern)
  - a classification table for each provider: lookup, read-only, mutating and rejected
- **SSH security cases:**
  - `-o ProxyCommand=…`, `-F x`, `-L`, an unknown host and `bash -c` are each rejected
  - `sudo systemctl status` is classified as mutating
  - `toExecArgv` quoting round-trips a token like `a;rm -rf /` as a single literal argument
- **Kubernetes cases:** `get secrets`, `exec` and `--kubeconfig` are each rejected.
- **`commandPolicy` tests:** context threading, and the new binaries.
- **`chat.service` test:** FINOPS on an on-prem workspace is rejected.

## Verification
1. `cd backend && npm test`. All existing and new suites pass.
2. Run `npx prisma migrate dev` and confirm the enum values plus the persona `allowedBinaries` data migration apply cleanly.
3. Build the three images (`docker build backend/sandbox/{vsphere,ssh,kubernetes}`) and confirm `govc version`, `ssh -V` and `kubectl version --client` run as uid 10001 with a read-only root filesystem.
4. End to end with real or local targets:
   - **vSphere:** the `vcsim` simulator (`govc`'s companion, run as a container) as a fake vCenter.
   - **SSH:** a `linuxserver/openssh-server` container with a key.
   - **Kubernetes:** a `kind`/`k3d` cluster.

   For each one:
   - create a workspace in Admin and attach credentials
   - switch the operator to On-Prem and pick the workspace
   - in CloudOps, ask for a read-only listing, which should run without approval
   - ask for a change (power off a VM, restart a service, scale a deployment), which should show the approval card
   - try a forbidden command, which should be rejected
   - build one dashboard widget
5. Confirm FinOps is not offered for on-prem workspaces and that the API refuses it.
6. On Docker Desktop for Windows, confirm the bridge-network sandbox can reach the LAN target. If it can't, document the deployment requirement in `docs/SETUP.md`.

## Follow-ups (not in v1)
- SSH password auth and passphrase keys
- jump host
- on-site agent
- "Test connection" button
- `kubectl apply` from model-authored manifests
- Proxmox
- Windows servers via WinRM
- an on-prem capacity flavour of FinOps
