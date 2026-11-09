# Sandbox images

Every AI-proposed command runs inside a container built from one of the
Dockerfiles in this directory. There is one image per cloud provider, each
holding that provider's CLI and nothing else; a chat session uses the image of
its Workspace's provider. The images are **not** pulled from a registry and are
**not** built automatically — an operator must build them locally before a chat
session on that provider can provision a sandbox.

## Build (required prerequisite)

From the repository root, for each provider you use:

```sh
docker build -t opencai-sandbox-aws:2.15.30 backend/sandbox/aws
docker build -t opencai-sandbox-azure:2.91.0 backend/sandbox/azure
docker build -t opencai-sandbox-gcp:588.0.0 backend/sandbox/gcp
docker build -t opencai-sandbox-vsphere:0.46.3 backend/sandbox/vsphere
docker build -t opencai-sandbox-kubernetes:1.31.4 backend/sandbox/kubernetes
```

The tags must match `SANDBOX_IMAGE_TAGS` in `backend/src/ai/constants.js`
exactly. Each tag carries the version of the CLI in the image.

If an image has not been built, `provisionSandbox()` fails loudly with a
"no such image" error from the Docker daemon. That is deliberate: the tags are
purely local names that cannot resolve against any upstream registry, so a
missing build can never silently fall back to an unhardened upstream image
(which runs as root).

## What the images provide

| Image                   | CLI                                                              |
| ----------------------- | ---------------------------------------------------------------- |
| `opencai-sandbox-aws`   | AWS CLI v2.15.30                                                 |
| `opencai-sandbox-azure` | Azure CLI 2.91.0 with the `costmanagement` and `resource-graph` extensions |
| `opencai-sandbox-gcp`   | Google Cloud CLI 588.0.0, `gcloud` only (`gsutil` and `bq` are removed)    |
| `opencai-sandbox-vsphere` | govc v0.46.3 (VMware vSphere)                                  |
| `opencai-sandbox-kubernetes` | kubectl v1.31.4 (Kubernetes)                               |

- One CLI per image and nothing else — this is a binary allowlist, not a
  general-purpose shell environment. Do not add tools here. An AWS session has
  no `az` or `gcloud` binary to run at all.
- A non-root `sandbox` user (uid 10001). The container is additionally pinned to
  `10001:10001` at the Docker API level by `sandboxManager.js`.
- A long-lived `sleep infinity` process, so one container serves repeated
  `docker exec` calls for the lifetime of a chat session.
- `timeout` and, in the Azure image, `sh`. `executeInSandbox` wraps every
  command in `timeout`; the Azure sign-in (`backend/src/ai/csp/azure.js`) is the
  one fixed, backend-owned command that runs through `sh`.

Runtime hardening (read-only rootfs, dropped capabilities, `no-new-privileges`,
memory/CPU/PID limits, bridge networking) is applied by
`backend/src/ai/sandbox/sandboxManager.js`, not by these Dockerfiles.

## Verifying a build

```sh
id=$(docker run -d opencai-sandbox-azure:2.91.0)
docker exec "$id" whoami              # must NOT print root
docker exec "$id" az version          # aws --version / gcloud --version for the others
docker exec "$id" timeout --version   # executeInSandbox depends on this binary
docker rm -f "$id"
```

## Adding a provider

Add a Dockerfile here, a tag in `SANDBOX_IMAGE_TAGS`, a module in
`backend/src/ai/csp/`, and the enum value in `backend/prisma/schema.prisma` and
`backend/src/constants/csp.js`.
