# Setup guide (Windows, macOS and Linux)

There are two ways to run OpenCAI. Pick one.

| | Option A: Docker Compose | Option B: on your machine |
|---|---|---|
| Use it to | run or try OpenCAI | develop OpenCAI, with live reload |
| You install | Git and Docker | Git, Docker and Node.js 24+ |
| Postgres and MinIO | started for you, or use your own | you provide them |
| Web app | http://localhost:5270 | http://localhost:5270 |

Docker is needed in both: the AI agent runs every command in a Docker container.

## Install the tools

**Windows**

- Install [Git for Windows](https://git-scm.com/download/win) and
  [Docker Desktop](https://www.docker.com/products/docker-desktop/), and start Docker Desktop.
- Run every command below in **Git Bash** (installed with Git for Windows), not in Command Prompt
  or PowerShell.
- Option B only: install [Node.js 24+](https://nodejs.org/).

**macOS**

- Install [Homebrew](https://brew.sh/), then `brew install git`.
- Install [Docker Desktop](https://www.docker.com/products/docker-desktop/) and start it.
- Option B only: `brew install node`.

**Linux**

- Install Git from your package manager.
- Install [Docker Engine](https://docs.docker.com/engine/install/) with the Compose plugin, and
  allow your user to run it without `sudo` (`sudo usermod -aG docker $USER`, then log out and
  back in).
- Option B only: install Node.js 24+ with [nvm](https://github.com/nvm-sh/nvm) (`nvm install 24`)
  or your distribution's packages.

## Option A: Docker Compose

Compose starts everything: Postgres, MinIO (and its bucket), the backend and the web app. Node.js
is not needed on your machine; it runs inside the containers.

```sh
git clone https://github.com/AB527/opencai.git
cd opencai
./setup.sh
```

`setup.sh` asks two questions: use the bundled Postgres container or your own database, and use
the bundled MinIO container or your own S3 bucket. It then generates the secrets, writes the
configuration, builds the sandbox images, starts the stack and creates the admin user. It can be
run again later to change an answer; it never replaces an existing `JWT_SECRET` or
`MASTER_ENCRYPTION_KEY`. Before using your own database or bucket, read
[Your own database or bucket](#your-own-database-or-bucket).

When it finishes:

- Web app: http://localhost:5270
- Backend API: http://localhost:5271

Continue with [First sign-in](#first-sign-in).

### By hand, with the bundled containers

These are the steps `setup.sh` runs when you choose the bundled Postgres and MinIO.

```sh
git clone https://github.com/AB527/opencai.git
cd opencai
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env
```

Edit two files before the first start:

- `backend/.env`: set `JWT_SECRET` to the output of `openssl rand -base64 48` and
  `MASTER_ENCRYPTION_KEY` to the output of `openssl rand -base64 32`. Under Compose the database
  and storage values in this file are not used; `docker-compose.yml` sets them.
- `frontend/.env`: set `VITE_API_BASE_URL=http://localhost:5271`. Under Compose the backend
  listens on port 5271, and this value is built into the web app.

Then build the sandbox images and start the stack:

```sh
docker build -t opencai-sandbox-aws:2.15.30 backend/sandbox/aws
docker build -t opencai-sandbox-azure:2.91.0 backend/sandbox/azure
docker build -t opencai-sandbox-gcp:588.0.0 backend/sandbox/gcp
docker compose up --build -d
docker compose exec backend npm run prisma:seed   # first run only
```

- Web app: http://localhost:5270
- Backend API: http://localhost:5271

Continue with [First sign-in](#first-sign-in). See [Notes on the Docker Compose run](#notes-on-the-docker-compose-run)
for how to stop the stack and for the security notes on this setup.

## Option B: on your machine

`dev.sh` runs the backend and the web app directly with Node.js, so code changes reload at once.
It does not start Postgres or MinIO; both must already be reachable. `docker compose` cannot
provide them here, because it does not publish Postgres to your machine. If you have neither, one
way to start both is:

```sh
docker run -d --name opencai-postgres -p 5432:5432 \
  -e POSTGRES_USER=opencai -e POSTGRES_PASSWORD=opencai -e POSTGRES_DB=opencai postgres:16

docker run -d --name opencai-minio -p 9000:9000 -p 9001:9001 \
  -e MINIO_ROOT_USER=opencai -e MINIO_ROOT_PASSWORD=opencai12345 \
  cgr.dev/chainguard/minio:latest server /data --console-address ":9001"
```

Then open the MinIO console at http://localhost:9001, sign in with that user and password, and
create a bucket named `opencai`.

Clone and configure:

```sh
git clone https://github.com/AB527/opencai.git
cd opencai
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env
```

`./setup.sh` can do the next step for you: choose "On your machine" and it asks for the values
below, writes them to `backend/.env` and generates the two secrets.

Edit `backend/.env`:

- `DATABASE_URL`: your Postgres connection string. The default matches the command above.
- `S3_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`: your storage. For the MinIO
  command above, the access key is `opencai` and the secret key is `opencai12345`. Set
  `S3_REGION` too if the bucket is not in `us-east-1`.
- `JWT_SECRET` and `MASTER_ENCRYPTION_KEY`: generate each one with the command written next to it
  in the file.

`frontend/.env` works as it is.

Install, prepare the database, build the sandbox images and start:

```sh
(cd backend && npm install)
(cd frontend && npm install)
(cd backend && npx prisma migrate deploy && npm run prisma:seed)
docker build -t opencai-sandbox-aws:2.15.30 backend/sandbox/aws
docker build -t opencai-sandbox-azure:2.91.0 backend/sandbox/azure
docker build -t opencai-sandbox-gcp:588.0.0 backend/sandbox/gcp
./dev.sh
```

- Web app: http://localhost:5270
- Backend API: http://localhost:5271

## First sign-in

The seed creates the master admin and the default agent personas. Sign in as `admin` with the
password `admin` (or the value of `SEED_ADMIN_PASSWORD` if you set one), enrol MFA with an
authenticator app, and change the password. Then, as Administrator, set the provider, model and
API key in Manage Chat Settings, add an Organisation with a Workspace and its cloud credentials (see
[Cloud credentials](#cloud-credentials)), and
create an Operator.

## Your own database or bucket

Both run modes work with any Postgres and any S3-compatible store (AWS S3, MinIO, on-premises
object storage). `setup.sh` asks for the values; this is what they must satisfy.

**Database**

- A Postgres connection string, for example
  `postgresql://user:password@host:5432/opencai?schema=public`. The database must exist; the
  backend creates and updates its tables each time it starts.
- Under Compose the backend runs in a container, so `localhost` means that container. For a
  database on the same machine use `host.docker.internal` (on Linux, the machine's own address).

**Storage**

- Endpoint URL, region, bucket name, access key and secret key. For AWS S3 the endpoint is
  `https://s3.<region>.amazonaws.com`, and the region must be the bucket's own.
- The bucket must already exist, and the key must be allowed to put objects in it.
- The bucket must allow public read of its objects. OpenCAI stores only branding images there (logo
  and sign-in image), and the browser loads them directly, including on the sign-in page. The
  bundled MinIO is set up this way for you.
- If browsers reach the files at a different address than the backend does (a CDN, or a public
  hostname in front of on-premises storage), give that address as the public URL. Files are
  requested as `<public URL>/<bucket>/<file>`.

**Where the answers are kept (Docker Compose)**

- Your values go in `.env` in the repository root, as `OPENCAI_DATABASE_URL` and `OPENCAI_S3_*`.
  `docker-compose.yml` uses them in place of its defaults.
- `docker-compose.override.yml` switches off the bundled container you replaced. Delete it, and
  the matching lines in `.env`, to go back to the bundled containers, or run `./setup.sh` again.
- Neither file is committed to git. This needs Docker Compose 2.20 or newer.

## Notes on the Docker Compose run

`docker compose down` stops the stack and keeps its data (named volumes); add `-v` to also delete
the Postgres/MinIO data.

Note: the `backend` container mounts the host's Docker socket so the AI agent orchestrator can
provision sandbox containers as siblings on the host — this gives the backend container
host-level Docker control, a deliberate trade-off for how the sandboxed command execution in
Phase 6 works (see PLAN.md's Guardrails section). Given that access, this stack is intended for a
trusted local/single-tenant run only and must never be exposed to an untrusted network.

Note: `opencai` / `opencai12345` (the postgres/minio credentials hardcoded in `docker-compose.yml`)
are local development defaults — change them in both `docker-compose.yml` and `backend/.env` before
this stack is ever reachable from anything beyond localhost.

## Repo layout

```
opencai/
├── frontend/          # Vite + React app, own .env
├── backend/           # Node.js + Express app, own .env
├── docker-compose.yml # frontend + backend + postgres + minio, for packaged/prod-like runs
├── setup.sh           # asks bundled-or-own database and storage, writes config, starts the stack
├── dev.sh             # starts backend + frontend on host, nothing else
├── PLAN.md
└── README.md
```

## Sandbox images

Every command the agent runs executes in a container that holds one cloud provider's CLI and
nothing else. There is one image per provider, and a chat session uses the image of its
Workspace's provider:

| Provider     | Build command                                                         |
| ------------ | --------------------------------------------------------------------- |
| AWS          | `docker build -t opencai-sandbox-aws:2.15.30 backend/sandbox/aws`     |
| Azure        | `docker build -t opencai-sandbox-azure:2.91.0 backend/sandbox/azure`  |
| Google Cloud | `docker build -t opencai-sandbox-gcp:588.0.0 backend/sandbox/gcp`     |

Build only the ones you need. A chat on a provider whose image is missing replies that the
execution environment couldn't be started.

Upgrading from a version that had a single `opencai-sandbox:2.15.30` image: build
`opencai-sandbox-aws:2.15.30` as above. The old image is no longer used and can be removed with
`docker rmi opencai-sandbox:2.15.30`.

## Cloud credentials

An Administrator attaches credentials to each Workspace. They are stored encrypted, and the agent
can do whatever those credentials allow, so grant the least access the Workspace needs (read-only
roles for FinOps-only use).

- **AWS**: an IAM user's access key ID and secret access key.
- **Azure**: a service principal with a client secret. You need its directory (tenant) ID,
  application (client) ID and client secret, plus the subscription ID, and a role assignment on
  that subscription (for example Reader). `az ad sp create-for-rbac --role Reader --scopes
  /subscriptions/<subscription-id>` creates one and prints the first three values.
- **Google Cloud**: a service account key file. Paste the whole JSON file; OpenCAI keeps only the
  account's email, private key and project ID. The project in the key file is used unless you enter
  another project ID. Grant the service account roles on that project (for example Viewer).

How each provider's CLI is signed in:

- AWS: the access key is passed to each command's environment.
- Azure: the Azure CLI cannot sign in from environment variables, so a new sandbox signs in once
  and keeps its token cache in the container's in-memory home directory until the container is
  removed.
- Google Cloud: the backend exchanges the key for a short-lived access token and passes only that
  token to each command. The key itself never enters the sandbox. The backend therefore needs
  outbound HTTPS access to `oauth2.googleapis.com`.

Not available on Azure and Google Cloud: running one command across several regions in a single
step, and the dry-run preview before a confirmation. On Google Cloud only `gcloud` is installed
(`gcloud storage` covers buckets; `bq` is not available).
