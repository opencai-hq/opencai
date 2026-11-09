# On-Prem Providers (vSphere, SSH, Kubernetes) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add VMware vSphere, Linux servers over SSH, and Kubernetes as Workspace providers that sit next to AWS, Azure and GCP. They get their own credential forms, a default-deny command policy and the existing approval flow. The operator's Cloud / On-Prem toggle filters Workspaces by kind.

**Architecture:** Each provider is a module in `backend/src/ai/csp/` that plugs into the existing registry (`getCsp`). It has a CLI binary (`govc`, `kubectl`, `ssh`), a single-CLI sandbox image, a zod `credentialSchema`, `buildEnv`, an optional `prepareSandbox` and `classifyOperation`. This plan adds two optional hooks:
- `policyContext(credential)`, which feeds per-Workspace facts (the SSH host names) into classification.
- `toExecArgv(argv)`, which rewrites a classified argv just before exec (SSH remote-argument quoting).

**Tech Stack:** Node.js (CommonJS), Express 5, zod, Prisma 7 / PostgreSQL, dockerode, `node --test`, React 19 + Vite.

**Spec:** `docs/superpowers/specs/2026-11-09-on-prem-providers-design.md`. It is a copy of the approved design in `~/.claude/plans/on-prem-provider-support-vsphere-crystalline-melody.md` and is committed in Task 1.

## Global Constraints

- Enum values are `VSPHERE`, `SSH` and `KUBERNETES`. Labels are "VMware vSphere", "Linux servers (SSH)" and "Kubernetes".
- Binaries are `govc`, `ssh` and `kubectl`. Image tags are `opencai-sandbox-vsphere:<govc version>`, `opencai-sandbox-ssh:<openssh version>` and `opencai-sandbox-kubernetes:<kubectl version>`. Pin exact versions, as the existing tags do.
- The sandbox user is uid 10001, the root filesystem is read-only, each image holds its one CLI only, and the entrypoint is `sleep infinity`. Mirror `backend/sandbox/aws/Dockerfile`.
- Secrets never go in argv. A `prepareSandbox` script is a fixed, backend-owned string, and secrets reach it only through the exec env (the pattern in `azure.js:31-61`). Model-proposed commands never carry a secret in their env, except vSphere, where `GOVC_*` env is the CLI's own auth, the same as AWS.
- Classification is default-deny. Anything not positively recognised is `{ reject }`.
- FinOps is unavailable for on-prem Workspaces, both in the API and in the UI.
- There is no Docker network change. The sandbox keeps `NetworkMode: 'bridge'`, and on-prem targets must be reachable from it.
- **Commits:** authored as the user only. No `Co-Authored-By` or session trailers (user memory rule).

## Review Focus

1. **An SSH command that smuggles shell syntax inside a quoted token** (`ssh web-01 cat '/var/log/x;id'`). The token must arrive at the remote end as one literal argument, and the path rule must still reject it. Tested in Task 5.
2. **SSH option injection before the host or the remote command** (`ssh -o ProxyCommand=x web-01 uptime`, `ssh web-01 -L 1:a:2 uptime`). Must be rejected. Tested in Task 5.
3. **A Kubernetes credential whose kubeconfig uses an `exec:` auth plugin, or has several contexts.** Saving must fail with a clear message. Tested in Task 4.
4. **A session restored from history for an on-prem Workspace.** The toggle must land on On-Prem, not reset to Cloud (`OperatorPage.jsx:127`). Checked manually in Task 8.
5. **A credential saved before this change for a Workspace whose `csp` is now on-prem.** This cannot happen because the providers are new. Instead: a confirm-time re-classification must use the same `policyContext` as proposal time, so `confirmCommand` must pass it too. Tested in Task 2.

---

### Task 1: Provider identity, persona binaries, spec

**Files:**
- Create: `docs/superpowers/specs/2026-11-09-on-prem-providers-design.md` (copy of the approved design)
- Modify: `backend/prisma/schema.prisma:18-23` (enum)
- Create: `backend/prisma/migrations/20261109100000_add_on_prem_providers/migration.sql`
- Modify: `backend/src/constants/csp.js`, `backend/src/ai/constants.js:12-16`, `backend/src/ai/prompts/defaults.js:3`
- Test: `backend/src/constants/csp.test.js` (new)

**Interfaces:**
- Produces:
  - `CSP.VSPHERE | CSP.SSH | CSP.KUBERNETES`
  - `ON_PREM_CSPS: ReadonlySet<string>`
  - `isOnPrem(csp: string): boolean`, exported from `constants/csp.js`
  - `SANDBOX_IMAGE_TAGS.VSPHERE / .SSH / .KUBERNETES`

- [ ] **Step 1: Write the failing test** `csp.test.js`. `isOnPrem('VSPHERE')`, `isOnPrem('SSH')` and `isOnPrem('KUBERNETES')` are true. `isOnPrem('AWS')` and `isOnPrem('nope')` are false. `Object.keys(CSP)` deep-equals `['AWS','AZURE','GCP','VSPHERE','SSH','KUBERNETES']`.
- [ ] **Step 2:** Run `node --test src/constants/csp.test.js`. Expect FAIL: `isOnPrem is not a function`.
- [ ] **Step 3: Implement** the constants. Then:
  - Add the three values to the Prisma enum.
  - Write the migration SQL:
    - `ALTER TYPE "CloudServiceProvider" ADD VALUE 'VSPHERE';` and likewise for SSH and KUBERNETES.
    - `UPDATE "agent_personas" SET "allowedBinaries" = ARRAY(SELECT DISTINCT unnest("allowedBinaries" || ARRAY['govc','kubectl','ssh'])) WHERE "mode" = 'CLOUDOPS';`

    Only CLOUDOPS gets the new binaries, because FinOps is never available on-prem.
  - Set `PROVIDER_BINARIES` to the cloud three, and give the CLOUDOPS persona(s) in `defaults.js` `[...PROVIDER_BINARIES, 'govc', 'kubectl', 'ssh']`.
  - Add the image tags.
- [ ] **Step 4:** Run `npx prisma validate && node --test`. Expect PASS, with all existing suites still green.
- [ ] **Step 5: Commit** `feat(backend): register on-prem provider identities`.

### Task 2: Policy context and exec-argv hooks

**Files:**
- Modify: `backend/src/ai/csp/index.js`
- Modify: `backend/src/ai/policy/commandPolicy.js:42,104`
- Modify: `backend/src/ai/orchestrator.js:449,557,798,905`
- Modify: `backend/src/ai/dashboard/widgetAuthor.js:292`
- Modify: `backend/src/ai/dashboard/widgetRunner.js:78,124`
- Test: `backend/src/ai/policy/commandPolicy.test.js` (extend, or create if absent), `backend/src/ai/orchestrator.test.js`

**Interfaces:**
- Produces:
  - **`policyContextFor(cspName: string, credential: object|null): object`** in `csp/index.js`. It returns `getCsp(cspName).policyContext?.(credential) ?? {}`.
  - **`execArgvFor(cspName: string, argv: string[]): string[]`**. It returns `getCsp(cspName).toExecArgv?.(argv) ?? argv`.
  - **`classify({ ..., cspContext })`**, which passes `cspContext ?? {}` as the second argument of `provider.classifyOperation(argv, cspContext)`.
- Provider modules may export `policyContext(credential) => object` and `toExecArgv(argv) => string[]`.

- [ ] **Step 1: Write failing tests.**
  - In `commandPolicy.test.js`, register a fake provider through a test-only seam, or use the SSH module once Task 5 lands. Prefer a unit test with `classify` against AWS, asserting that `cspContext` is accepted and ignored: same verdict as without it.
  - In `orchestrator.test.js`, assert that the argv handed to the mocked `executeInSandbox` for a confirmed command equals `execArgvFor(workspace.csp, result.argv)`. For AWS this is unchanged. Add a stubbed provider whose `toExecArgv` appends `'X'` and assert that it is applied at both the proposal-run site (557) and the confirm site (905).
  - Also assert that `confirmCommand` passes `cspContext` (Review Focus #5).
- [ ] **Step 2:** Run `node --test src/ai`. Expect the new tests to FAIL.
- [ ] **Step 3: Implement.**
  - Every `classify(...)` caller passes `cspContext: policyContextFor(workspace.csp, credential)`. All four sites already have the credential in scope: `handleUserMessage`, `confirmCommand`, `authorWidget` via `target.credential`, and `runCommand`.
  - Every model-command exec (`orchestrator.js:557,905` and `widgetRunner.js:78`) passes `execArgvFor(workspace.csp, argv)`. Leave the AWS region fan-out and dry-run as they are; they are AWS-only.
- [ ] **Step 4:** Run `node --test`. Expect PASS.
- [ ] **Step 5: Commit** `feat(backend): provider hooks for policy context and exec argv`.

### Task 3: vSphere provider (`govc`)

**Files:**
- Create: `backend/src/ai/csp/vsphere.js`, `backend/src/ai/policy/patterns/vsphere.js`, `backend/sandbox/vsphere/Dockerfile`
- Modify: `backend/src/ai/csp/index.js` (register), `backend/sandbox/README.md` (build line and table row)
- Test: `backend/src/ai/csp/vsphere.test.js`

**Interfaces:**
- Consumes: `SANDBOX_IMAGE_TAGS.VSPHERE`, plus `commandPath` and `matchesVerb` from `csp/grammar.js` if useful.
- Produces: module `{ label: 'VMware vSphere', binary: 'govc', sandboxImage, credentialSchema, buildEnv, classifyOperation, supportsRegions: false, promptRules, dashboardOutputHint: 'add -json' }`.

- [ ] **Step 1: Write failing tests** (table style, as in `azure.test.js`):
  - **Schema:**
    - accepts `{ url:'https://vc.lab/sdk', username:'a', password:'p' }` and gets `insecure:false`
    - accepts `insecure` given as `true` or `'true'`
    - rejects a non-https `url`
    - rejects an empty password
  - **`buildEnv`:** returns `GOVC_URL`, `GOVC_USERNAME`, `GOVC_PASSWORD`, `GOVC_INSECURE` (`'1'`/`'0'`), and `GOVC_DATACENTER` only when it is set.
  - **Read-only verdicts:**
    - `govc about`
    - `govc ls /dc1/vm`
    - `govc find / -type m`
    - `govc vm.info -json web-01`
    - `govc datastore.info -json`
    - `govc host.info`
    - `govc metric.sample -json vm/web-01 cpu.usage.average`
    - `govc events`
  - **Lookup verdicts:** `govc vm.info -h` and `govc help`.
  - **Mutating verdicts:**
    - `govc vm.power -off web-01`
    - `govc vm.destroy web-01`
    - `govc snapshot.create -vm web-01 s1`
    - `govc vm.change -vm web-01 -m 4096`
    - `govc tags.attach t1 /dc1/vm/web-01`
  - **Rejected:**
    - `govc guest.run …`
    - `govc datastore.upload a b`
    - `govc datastore.download a b`
    - `govc session.login`
    - `govc env`
    - `govc import.ova x`
    - `govc vm.console web-01`
    - `govc frobnicate`
    - `govc` alone
  - `snapshot.tree` is read-only, and `*.info` beats any mutating prefix.
- [ ] **Step 2:** Run `node --test src/ai/csp/vsphere.test.js`. Expect FAIL.
- [ ] **Step 3: Implement.**
  - Classify on `argv[1]`:
    1. any `-h` or `argv[1]==='help'` means lookup
    2. a REJECTED prefix match means reject
    3. a READONLY exact or suffix match (`.info`, `.ls`, `.tree`) means read-only
    4. a MUTATING exact or prefix match means mutating
    5. anything else is rejected

    Lists come from the spec (§2). `promptRules`: use `-json` for structured output, check syntax with `govc <cmd> -h`, the datacenter is preselected when configured, and `guest.*` / file transfer are unavailable.
  - The Dockerfile uses a minimal base (e.g. `alpine:3.20`) with a pinned govc release tarball verified by sha256, plus `adduser -u 10001 sandbox`.
- [ ] **Step 4:** Run `node --test`, then `docker build -t <tag> backend/sandbox/vsphere`, then `docker run --rm -u 10001 --read-only <tag> govc version`. Expect tests PASS and the version printed.
- [ ] **Step 5: Commit** `feat(backend): vSphere provider via govc`.

### Task 4: Kubernetes provider (`kubectl`)

**Files:**
- Create: `backend/src/ai/csp/kubernetes.js`, `backend/src/ai/policy/patterns/kubernetes.js`, `backend/sandbox/kubernetes/Dockerfile`
- Modify: `backend/package.json` (add the `yaml` dependency, pinned), `csp/index.js`, `sandbox/README.md`
- Test: `backend/src/ai/csp/kubernetes.test.js`

**Interfaces:**
- Produces: module `{ label: 'Kubernetes', binary: 'kubectl', credentialSchema, buildEnv, prepareSandbox, classifyOperation, supportsRegions: false, promptRules, dashboardOutputHint: 'add -o json' }`.
- The stored credential shape is `{ kubeconfig: string, namespace?: string }`.

- [ ] **Step 1: Write failing tests.**
  - **Schema:**
    - accepts a single-context kubeconfig that has token auth
    - rejects invalid YAML
    - rejects zero or two contexts
    - rejects any `users[].user.exec` or `auth-provider`, with the message `"Kubeconfig exec/auth-provider plugins are not supported; use a token or client certificate"`
    - `namespace` must match `^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$`
  - **`buildEnv`:** returns `{ KUBECONFIG: '/home/sandbox/.kube/config' }` and contains no kubeconfig text.
  - **`prepareSandbox`:**
    - `exec` receives `['sh','-c',<fixed script>]` with the kubeconfig only in `env.OPENCAI_KUBECONFIG`
    - the script is identical across credentials
    - with a namespace, a second fixed step runs `kubectl config set-context --current --namespace "$OPENCAI_NAMESPACE"`
    - a non-zero exit throws `/Kubernetes sign-in exited 1/`
  - **Read-only:**
    - `kubectl get pods -A -o json`
    - `kubectl describe node n1`
    - `kubectl logs deploy/web --tail 100`
    - `kubectl top pods`
    - `kubectl get events`
    - `kubectl rollout status deploy/web`
    - `kubectl auth can-i list pods`
    - `kubectl cluster-info`
  - **Lookup:** `kubectl explain pod.spec`, `kubectl api-resources`, `kubectl version`, `kubectl get --help`.
  - **Mutating:**
    - `kubectl scale deploy/web --replicas 3`
    - `kubectl delete pod p1`
    - `kubectl rollout restart deploy/web`
    - `kubectl cordon n1`
    - `kubectl drain n1 --ignore-daemonsets`
    - `kubectl label pod p1 a=b`
    - `kubectl set image deploy/web web=nginx:1.27`
    - `kubectl create namespace dev`
  - **Rejected:**
    - `kubectl exec p1 -- sh`
    - `kubectl cp a b`
    - `kubectl port-forward p1 80`
    - `kubectl proxy`
    - `kubectl run x --image y`
    - `kubectl edit pod p1`
    - `kubectl config view`
    - `kubectl apply -f x.yaml`
    - `kubectl create -f x.yaml`
    - `kubectl get pods --kubeconfig /x`
    - `kubectl get pods --token t`
    - `kubectl get pods --server s`
    - `kubectl get pods --as admin`
    - `kubectl get pods --context c`
    - `kubectl logs -f p1`
    - `kubectl get secrets`
    - `kubectl get secret s -o yaml`
    - `kubectl describe secret s`
    - `kubectl get pods,secrets`
- [ ] **Step 2:** Run `node --test src/ai/csp/kubernetes.test.js`. Expect FAIL.
- [ ] **Step 3: Implement.**
  - The verb is the first non-flag word after `kubectl`. `rollout`, `auth` and `set` take their sub-verb from the next word.
  - Global-flag rejection scans all of argv, including the `--flag=value` form.
  - For the secrets rule, take the resource word after `get`/`describe`, split it on `,` and `/`, and reject if any part is `secret` or `secrets`.
  - The script is: `mkdir -p "$HOME/.kube" && umask 077 && printf '%s' "$OPENCAI_KUBECONFIG" > "$HOME/.kube/config"`.
  - `promptRules`: no exec/cp/port-forward, secrets are not readable, use `-o json` for structured output, and apply from files is unavailable.
  - The Dockerfile pins a kubectl binary verified by sha256.
- [ ] **Step 4:** Run `node --test`, then `docker build` and `docker run --rm -u 10001 --read-only <tag> kubectl version --client`. Expect PASS.
- [ ] **Step 5: Commit** `feat(backend): Kubernetes provider via kubectl`.

### Task 5: SSH provider (`ssh` to a host group)

**Files:**
- Create: `backend/src/ai/csp/ssh.js`, `backend/src/ai/policy/patterns/linux.js`, `backend/sandbox/ssh/Dockerfile`
- Modify: `csp/index.js`, `sandbox/README.md`
- Test: `backend/src/ai/csp/ssh.test.js`

**Interfaces:**
- Consumes: the Task 2 hooks.
- Produces: module `{ label: 'Linux servers (SSH)', binary: 'ssh', credentialSchema, buildEnv, prepareSandbox, policyContext, toExecArgv, classifyOperation, supportsRegions: false, promptRules, dashboardOutputHint }`.
  - `policyContext(credential) => { hostNames: string[] }`
  - `classifyOperation(argv, { hostNames })`
  - `toExecArgv(argv) => ['ssh', host, '--', ...remote.map(shQuote)]`
- The stored credential shape is `{ username, privateKey, hosts: [{ name, address, port }], knownHosts? }`.

- [ ] **Step 1: Write failing tests.**
  - **Schema:**
    - `username` matches `^[a-z_][a-z0-9_.-]{0,31}$`
    - `privateKey` contains `-----BEGIN` and `PRIVATE KEY-----`
    - rejects `Proc-Type: 4,ENCRYPTED`, and rejects an OpenSSH key whose cipher is not `none`. Decode the base64 body, then check that the bytes after `openssh-key-v1\0` start with a length-prefixed `none`.
    - `hosts` holds 1–50 items. `name` matches `^[a-z0-9][a-z0-9-]{0,62}$` and names are unique. `address` is a hostname or IP with no whitespace and no leading `-`. `port` is an integer from 1 to 65535 and defaults to 22.
    - `knownHosts` is optional.
  - **`prepareSandbox`:**
    - a single exec of `['sh','-c',FIXED]`
    - the env carries `OPENCAI_SSH_KEY`, `OPENCAI_SSH_CONFIG` (generated by `renderSshConfig(credential)`) and, when set, `OPENCAI_KNOWN_HOSTS`
    - `FIXED` writes them to `~/.ssh/id`, `~/.ssh/config` and `~/.ssh/known_hosts` with umask 077
  - **`renderSshConfig`:**
    - contains `StrictHostKeyChecking yes` when `knownHosts` is set and `accept-new` otherwise
    - has `BatchMode yes`, `ProxyCommand none`, `ProxyJump none`, `PermitLocalCommand no`, `ForwardAgent no`, `ClearAllForwardings yes`, `RequestTTY no` and `IdentitiesOnly yes`
    - has a final `Host *` block with `HostName invalid.invalid`, so unknown aliases can't resolve
  - **`buildEnv`:** returns `{}`.
  - **Read-only** (hostNames `['web-01','db-01']`):
    - `ssh web-01 uptime`
    - `ssh web-01 df -h`
    - `ssh db-01 free -m`
    - `ssh web-01 systemctl status nginx`
    - `ssh web-01 journalctl -u nginx -n 200 --no-pager`
    - `ssh web-01 top -b -n 1`
    - `ssh web-01 ip -j addr`
    - `ssh web-01 tail -n 100 /var/log/syslog`
    - `ssh web-01 cat /etc/os-release`
    - `ssh web-01 docker ps --format json`
    - `ssh web-01 ps aux`
  - **Mutating:**
    - `ssh web-01 sudo systemctl restart nginx`
    - `ssh web-01 sudo systemctl status nginx` (sudo forces mutating)
    - `ssh web-01 systemctl restart nginx`
    - `ssh web-01 sudo apt-get install -y htop`
    - `ssh web-01 sudo reboot`
    - `ssh web-01 kill 1234`
    - `ssh web-01 docker restart web`
  - **Rejected:**
    - `ssh -o ProxyCommand=id web-01 uptime`
    - `ssh web-01 -L 1:a:2 uptime`
    - `ssh -F x web-01 uptime`
    - `ssh evil uptime` (unknown host)
    - `ssh web-01` (no command)
    - `ssh web-01 bash -c id`
    - `ssh web-01 sh`
    - `ssh web-01 python3 -c x`
    - `ssh web-01 sudo -i`
    - `ssh web-01 sudo -u root id`
    - `ssh web-01 cat /etc/shadow`
    - `ssh web-01 cat /var/log/../../etc/shadow`
    - `ssh web-01 tail -f /var/log/syslog`
    - `ssh web-01 journalctl -f`
    - `ssh web-01 vi /etc/hosts`
    - `ssh web-01 rm -rf /`
    - a remote token containing `\n`
  - **`toExecArgv`:**
    - `['ssh','web-01','cat',"/var/log/a;id"]` becomes `['ssh','web-01','--','\'cat\'',"'/var/log/a;id'"]`
    - a token `it's` becomes `'it'\''s'`
- [ ] **Step 2:** Run `node --test src/ai/csp/ssh.test.js`. Expect FAIL.
- [ ] **Step 3: Implement.**
  - **Host and option checks:** `argv[1]` must be in `hostNames`. If any of `argv[1]` or `argv[2]` starts with `-`, reject with `SSH options are not allowed`.
  - **Remote command:** `remote = argv.slice(2)`. A leading bare `sudo` is stripped and forces mutating. `sudo` followed by a flag is rejected.
  - **Classifying `remote`** against `linux.js`, whose entries are `{ cmd, sub?: string[], kind, allowFlags?, deny?: string[] }`. Path-restricted commands (`cat`, `head`, `tail`, `ls`, `stat`, `du`) require every non-flag argument to resolve, through `path.posix.normalize`, to an absolute path. That path must be under `/var/log/`, or exactly `/etc/os-release`, `/proc/loadavg`, `/proc/meminfo`, `/proc/cpuinfo` or `/proc/uptime`.
  - **Follow flags:** `-f`, `--follow` and `-F` are rejected for `tail`, `journalctl`, `docker logs` and `kubectl`-like follow commands.
  - **`promptRules`:** the generated list of host names cannot be static, so make `promptRules` a function: `promptRules(credential?)`. Update `conversation.js:34-35` to call it when it is a function. Rules: no pipes, redirects or globs, prefix `sudo` only when needed, use `journalctl -n`/`--since`, `top -b -n 1`, and JSON-capable flags (`ip -j`, `lsblk -J`, `systemctl --output=json`, `docker … --format json`).
  - **Dockerfile:** `alpine` + `openssh-client-default` pinned, with `adduser -u 10001`.
- [ ] **Step 4:** Run `node --test`. Then start the image with the hardened flags against a `linuxserver/openssh-server` container and run `ssh -V` and one real `uptime` through `prepareSandbox`. Expect PASS and output.
- [ ] **Step 5: Commit** `feat(backend): SSH host-group provider`.

### Task 6: Dashboards and FinOps gating

**Files:**
- Modify: `backend/src/ai/dashboard/widgetAuthor.js:~63-118` (the "must print JSON" line)
- Modify: `backend/src/modules/chat/chat.service.js:33`
- Modify: `backend/src/constants/errors.js`
- Modify: the dashboard create/author entry point that accepts a `mode`. Find it via `grep -rn "authorWidget(" src`.
- Test: `chat.service` test (create or extend), `widgetAuthor.test.js`

**Interfaces:**
- Consumes: `isOnPrem`, and `dashboardOutputHint` on every provider. Add it to aws/azure/gcp too: `--output json`, `--output json` and `--format=json`.
- Produces: `ERROR_CODES.FINOPS_NOT_AVAILABLE_ON_PREM` with the message `"FinOps is not available for on-prem Workspaces."`

- [ ] **Step 1: Write failing tests.**
  - `createSession` with `mode:'FINOPS'` on a `VSPHERE` Workspace rejects with `AppError` 400 `FINOPS_NOT_AVAILABLE_ON_PREM`. CLOUDOPS on VSPHERE succeeds.
  - FinOps dashboard authoring for an SSH Workspace is rejected the same way.
  - The author system prompt for a KUBERNETES Workspace contains `It must print JSON (Kubernetes: add -o json)` and not the AWS/Azure line.
- [ ] **Step 2:** Run `node --test`. Expect FAIL.
- [ ] **Step 3: Implement.** Build the JSON line from `csp.label` and `csp.dashboardOutputHint`, then add the guard.
- [ ] **Step 4:** Run `node --test`. Expect PASS.
- [ ] **Step 5: Commit** `feat(backend): on-prem dashboards hint and FinOps gate`.

### Task 7: Admin credential forms

**Files:**
- Modify: `frontend/src/lib/csp.js`
- Modify: `frontend/src/pages/admin/OrganisationDetail.jsx:20-120`

**Interfaces:**
- Produces:
  - Each `CSPS` entry gets `kind: 'cloud'|'onprem'`.
  - Field `type` is `'text'` (the default), `'checkbox'` or `'hostList'`.
  - New exports: `cspKind(csp)`, `CSP_OPTIONS_BY_KIND: { cloud: string[], onprem: string[] }`, `accountLabel(csp)` (`'Account'` for cloud, `'Site / Cluster'` for on-prem).
- The fields per provider are exactly those of the backend schemas from Tasks 3-5:
  - **VSPHERE:** url, username, password (secret), insecure (checkbox), datacenter (optional).
  - **KUBERNETES:** kubeconfig (multiline, secret), namespace (optional).
  - **SSH:** username, privateKey (multiline), hosts (hostList), knownHosts (multiline, optional).

- [ ] **Step 1: Implement.**
  - The provider `<select>` uses `<optgroup label="Cloud">` and `<optgroup label="On-Prem">`.
  - The Account field label comes from `accountLabel(csp)`.
  - `CredentialDialog` renders a checkbox, which submits a boolean.
  - It renders `hostList` as repeatable rows (name, address, port), with Add and Remove buttons and at least one row. This submits `[{ name, address, port: Number }]` and skips blank rows.
  - `body()` only trims string values.
- [ ] **Step 2: Verify.** Run `cd frontend && npm run lint && npm run build`, which should be clean. Then, with the app running:
  - create a VSPHERE Workspace and attach credentials, which should save
  - attach an SSH credential with two hosts, which should save
  - submit a duplicate host name, which should show the backend 400 message
- [ ] **Step 3: Commit** `feat(web): on-prem provider credential forms`.

### Task 8: Operator Cloud / On-Prem toggle

**Files:**
- Modify: `frontend/src/pages/operator/OperatorPage.jsx:55,127,364,406-408`
- Modify: `frontend/src/pages/operator/components/OperatorSidebar.jsx:6-8,151-153`
- Modify: `frontend/src/pages/operator/components/WorkspaceSelectorForm.jsx`

**Interfaces:**
- Consumes: `cspKind`.
- `WorkspaceSelectorForm` gains the prop `kind: 'cloud'|'onprem'`.
- `OperatorSidebar` hides the FINOPS entry when `cspKind(workspace?.csp) === 'onprem'`.

- [ ] **Step 1: Implement.**
  - Remove both "Coming Soon" branches.
  - `WorkspaceSelectorForm` filters `workspaces` by `cspKind(w.csp) === kind` before deriving the environment, provider and account options, and shows "No on-prem Workspaces in this organisation" when the list is empty.
  - Changing the pill clears a `workspace` of the other kind and resets `activeMode` to `CLOUDOPS` if it was FINOPS.
  - A session loaded from history sets the pill from `cspKind(session.workspace.csp)` (Review Focus #4).
  - `showToggle` no longer requires `'cloud'`.
- [ ] **Step 2: Verify.** Run `npm run lint && npm run build`. Then, manually:
  - On-Prem lists only on-prem Workspaces
  - FinOps is hidden for them
  - opening an on-prem session from Recent History lands on On-Prem
  - Cloud behaviour is unchanged
- [ ] **Step 3: Commit** `feat(web): Cloud/On-Prem toggle filters workspaces`.

### Task 9: End-to-end verification and docs

**Files:**
- Modify: `backend/sandbox/README.md` (already updated per task; check it)
- Modify: `docs/SETUP.md` (an "On-prem providers" section)
- Modify: `PLAN.md:124-125,278` (replace "Coming Soon")

- [ ] **Step 1:** Write the docs section:
  - build commands for the three images
  - the network requirement: the sandbox bridge network must reach vCenter, servers and the API server
  - what each credential needs (vSphere read/operate role; an SSH deploy key without a passphrase and passwordless sudo for approved actions; a kubeconfig with a token or client cert)
- [ ] **Step 2: E2E.** Use `vmware/govmomi` `vcsim` (container, port 8989), `linuxserver/openssh-server`, and a `kind` cluster with a service-account token kubeconfig. For each one, in the running app:
  - attach the credential
  - choose On-Prem and pick the Workspace
  - ask for a read-only listing, which should run without approval
  - ask for a change (power off a VM, restart a service, scale a deployment), which should show the approval card and then run
  - try a forbidden command, which should be rejected
  - create one dashboard graph
- [ ] **Step 3:** Run `cd backend && node --test && npm run lint`, then `cd frontend && npm run lint && npm run build`. Everything should be green.
- [ ] **Step 4: Commit** `docs: on-prem provider setup`.
