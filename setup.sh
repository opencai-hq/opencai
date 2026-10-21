#!/usr/bin/env bash
# Interactive setup. Asks how OpenCAI will run and whether to use the bundled
# Postgres and MinIO containers or your own database and S3 bucket, then writes
# the configuration. Safe to run again: it only changes what it asks about and
# never replaces an existing JWT_SECRET or MASTER_ENCRYPTION_KEY.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

BACKEND_ENV="backend/.env"
FRONTEND_ENV="frontend/.env"
# Compose reads this file by itself; docker-compose.yml takes OPENCAI_* from it.
COMPOSE_ENV=".env"
# Compose also loads this file by itself. It only switches bundled services off.
OVERRIDE_FILE="docker-compose.override.yml"

SANDBOX_IMAGES=(
  "opencai-sandbox-aws:2.15.30 backend/sandbox/aws"
  "opencai-sandbox-azure:2.91.0 backend/sandbox/azure"
  "opencai-sandbox-gcp:588.0.0 backend/sandbox/gcp"
)

get_env_var() {
  # get_env_var <file> <key> — prints the value if present, nothing otherwise.
  if [ -f "$1" ]; then
    grep -E "^$2=" "$1" | head -n 1 | cut -d '=' -f2- | tr -d '\r'
  fi
}

set_env_var() {
  # set_env_var <file> <key> <value> — replaces the key's line where it is, or
  # adds it at the end. awk reads the value from the environment so nothing in
  # it (/, &, $, \) is treated specially.
  touch "$1"
  KEY="$2" VALUE="$3" awk '
    BEGIN { key = ENVIRON["KEY"]; value = ENVIRON["VALUE"] }
    index($0, key "=") == 1 { print key "=" value; done = 1; next }
    { print }
    END { if (!done) print key "=" value }
  ' "$1" > "$1.tmp"
  mv "$1.tmp" "$1"
}

unset_env_var() {
  # unset_env_var <file> <key> — removes the key's line, if any.
  [ -f "$1" ] || return 0
  grep -v -E "^$2=" "$1" > "$1.tmp" || true
  mv "$1.tmp" "$1"
}

quoted() {
  # Single quotes keep $ and # literal for both Compose and dotenv.
  printf "'%s'" "$1"
}

ask() {
  # ask <variable> <prompt> [default] — repeats until the answer is usable.
  local answer
  while true; do
    if [ -n "$3" ]; then
      read -r -p "$2 [$3]: " answer || exit 1
      answer="${answer:-$3}"
    else
      read -r -p "$2: " answer || exit 1
    fi
    if [ -z "$answer" ]; then
      echo "  A value is needed."
    elif [[ "$answer" == *"'"* ]]; then
      echo "  A single quote (') cannot be stored here. URL-encode it as %27, or use another value."
    else
      printf -v "$1" '%s' "$answer"
      return 0
    fi
  done
}

ask_secret() {
  # ask_secret <variable> <prompt> — like ask, without showing what is typed.
  local answer
  while true; do
    read -r -s -p "$2: " answer || exit 1
    echo
    if [ -z "$answer" ]; then
      echo "  A value is needed."
    elif [[ "$answer" == *"'"* ]]; then
      echo "  A single quote (') cannot be stored here. Use another value."
    else
      printf -v "$1" '%s' "$answer"
      return 0
    fi
  done
}

choose() {
  # choose <variable> <question> <option 1> <option 2> — sets it to 1 or 2.
  local answer
  echo
  echo "$2"
  echo "  1) $3"
  echo "  2) $4"
  while true; do
    read -r -p "Choose 1 or 2 [1]: " answer || exit 1
    case "${answer:-1}" in
      1 | 2)
        printf -v "$1" '%s' "${answer:-1}"
        return 0
        ;;
    esac
  done
}

confirm() {
  # confirm <question> — yes unless the answer starts with n.
  local answer
  read -r -p "$1 [Y/n]: " answer || exit 1
  case "$answer" in
    [nN]*) return 1 ;;
    *) return 0 ;;
  esac
}

ensure_secret() {
  # ensure_secret <key> <bytes> — generates the key only if it is missing or
  # still the example placeholder. An existing MASTER_ENCRYPTION_KEY must never
  # change: stored credentials and TOTP secrets are encrypted with it.
  case "$(get_env_var "$BACKEND_ENV" "$1")" in
    '' | changeme*)
      set_env_var "$BACKEND_ENV" "$1" "$(openssl rand -base64 "$2" | tr -d '\r\n')"
      echo "  $1: generated"
      ;;
    *)
      echo "  $1: kept"
      ;;
  esac
}

command -v openssl >/dev/null 2>&1 || {
  echo "openssl is needed to generate secrets. Install it and run this again." >&2
  exit 1
}

echo "OpenCAI setup"

choose RUN_MODE "How will you run OpenCAI?" \
  "Docker Compose: everything in containers" \
  "On your machine with ./dev.sh (for development)"

if [ "$RUN_MODE" = 1 ]; then
  choose DB_CHOICE "Which database?" \
    "The bundled Postgres container" \
    "My own Postgres (connection string)"
  choose STORAGE_CHOICE "Which file storage?" \
    "The bundled MinIO container" \
    "My own S3 bucket (AWS S3 or any S3-compatible store)"
else
  # dev.sh starts no containers, so both are always your own.
  DB_CHOICE=2
  STORAGE_CHOICE=2
fi

if [ "$DB_CHOICE" = 2 ]; then
  echo
  echo "Database. Example: postgresql://user:password@host:5432/opencai?schema=public"
  [ "$RUN_MODE" = 1 ] &&
    echo "The backend runs in a container: for a database on this machine use host.docker.internal, not localhost."
  while true; do
    ask DATABASE_URL "Connection string"
    [[ "$DATABASE_URL" =~ ^postgres(ql)?:// ]] && break
    echo "  It must start with postgresql:// or postgres://"
  done
fi

if [ "$STORAGE_CHOICE" = 2 ]; then
  echo
  echo "Storage. For AWS S3 the endpoint is https://s3.<region>.amazonaws.com"
  ask S3_ENDPOINT "Endpoint URL"
  ask S3_REGION "Region" "us-east-1"
  ask S3_BUCKET "Bucket name"
  ask S3_ACCESS_KEY "Access key"
  ask_secret S3_SECRET_KEY "Secret key"
  echo "Uploaded branding images are loaded by the browser from the public URL."
  ask S3_PUBLIC_URL "Public URL of the storage" "$S3_ENDPOINT"
fi

echo
echo "Writing configuration"

[ -f "$BACKEND_ENV" ] || cp backend/.env.example "$BACKEND_ENV"
[ -f "$FRONTEND_ENV" ] || cp frontend/.env.example "$FRONTEND_ENV"
ensure_secret JWT_SECRET 48
ensure_secret MASTER_ENCRYPTION_KEY 32

if [ "$RUN_MODE" = 1 ]; then
  set_env_var "$FRONTEND_ENV" VITE_API_BASE_URL "http://localhost:5271"

  if [ "$DB_CHOICE" = 2 ]; then
    set_env_var "$COMPOSE_ENV" OPENCAI_DATABASE_URL "$(quoted "$DATABASE_URL")"
  else
    unset_env_var "$COMPOSE_ENV" OPENCAI_DATABASE_URL
  fi

  if [ "$STORAGE_CHOICE" = 2 ]; then
    set_env_var "$COMPOSE_ENV" OPENCAI_S3_ENDPOINT "$(quoted "$S3_ENDPOINT")"
    set_env_var "$COMPOSE_ENV" OPENCAI_S3_REGION "$(quoted "$S3_REGION")"
    set_env_var "$COMPOSE_ENV" OPENCAI_S3_BUCKET "$(quoted "$S3_BUCKET")"
    set_env_var "$COMPOSE_ENV" OPENCAI_S3_ACCESS_KEY "$(quoted "$S3_ACCESS_KEY")"
    set_env_var "$COMPOSE_ENV" OPENCAI_S3_SECRET_KEY "$(quoted "$S3_SECRET_KEY")"
    set_env_var "$COMPOSE_ENV" OPENCAI_S3_PUBLIC_URL "$(quoted "$S3_PUBLIC_URL")"
  else
    for key in ENDPOINT REGION BUCKET ACCESS_KEY SECRET_KEY PUBLIC_URL; do
      unset_env_var "$COMPOSE_ENV" "OPENCAI_S3_$key"
    done
  fi

  # A profile that is never activated keeps a bundled service from starting.
  if [ "$DB_CHOICE" = 2 ] || [ "$STORAGE_CHOICE" = 2 ]; then
    {
      echo "# Generated by setup.sh. Delete this file to use the bundled containers again."
      echo "services:"
      if [ "$DB_CHOICE" = 2 ]; then
        echo "  postgres:"
        echo "    profiles: [bundled-off]"
      fi
      if [ "$STORAGE_CHOICE" = 2 ]; then
        echo "  minio:"
        echo "    profiles: [bundled-off]"
        echo "  minio-init:"
        echo "    profiles: [bundled-off]"
      fi
    } > "$OVERRIDE_FILE"
  else
    rm -f "$OVERRIDE_FILE"
  fi
  # Don't leave an empty file behind after going back to the bundled services.
  [ -s "$COMPOSE_ENV" ] || rm -f "$COMPOSE_ENV"
else
  set_env_var "$BACKEND_ENV" DATABASE_URL "$(quoted "$DATABASE_URL")"
  set_env_var "$BACKEND_ENV" S3_ENDPOINT "$(quoted "$S3_ENDPOINT")"
  set_env_var "$BACKEND_ENV" S3_REGION "$(quoted "$S3_REGION")"
  set_env_var "$BACKEND_ENV" S3_BUCKET "$(quoted "$S3_BUCKET")"
  set_env_var "$BACKEND_ENV" S3_ACCESS_KEY "$(quoted "$S3_ACCESS_KEY")"
  set_env_var "$BACKEND_ENV" S3_SECRET_KEY "$(quoted "$S3_SECRET_KEY")"
  set_env_var "$BACKEND_ENV" S3_PUBLIC_URL "$(quoted "$S3_PUBLIC_URL")"
fi

echo "  Done."

if [ "$STORAGE_CHOICE" = 2 ]; then
  echo
  echo "Your bucket must allow public read of its objects, or the sign-in page cannot show"
  echo "uploaded branding images. See docs/SETUP.md, 'Your own database or bucket'."
fi

if [ "$RUN_MODE" = 2 ]; then
  echo
  echo "Next:"
  echo "  (cd backend && npm install)"
  echo "  (cd frontend && npm install)"
  echo "  (cd backend && npx prisma migrate deploy && npm run prisma:seed)"
  for image in "${SANDBOX_IMAGES[@]}"; do
    echo "  docker build -t $image"
  done
  echo "  ./dev.sh"
  echo "Then open http://localhost:5270 and sign in as admin / admin."
  exit 0
fi

echo
if ! confirm "Build and start OpenCAI now?"; then
  echo
  echo "Next:"
  for image in "${SANDBOX_IMAGES[@]}"; do
    echo "  docker build -t $image"
  done
  echo "  docker compose up --build -d"
  echo "  docker compose exec backend npm run prisma:seed   # first run only"
  exit 0
fi

for image in "${SANDBOX_IMAGES[@]}"; do
  # Unquoted on purpose: each entry is "<tag> <build directory>".
  # shellcheck disable=SC2086
  docker build -t $image
done
docker compose up --build -d

echo "Waiting for the backend (it applies database migrations first)..."
ready=""
for _ in $(seq 1 60); do
  if curl -s -o /dev/null http://localhost:5271/; then
    ready=1
    break
  fi
  sleep 2
done
if [ -z "$ready" ]; then
  echo "The backend did not start. Check the database and storage values, then see:" >&2
  echo "  docker compose logs backend" >&2
  exit 1
fi

# The seed creates the master admin and the default agent personas.
if confirm "Create the admin user and default data? Say no if this database was set up before."; then
  docker compose exec -T backend npm run prisma:seed
fi

echo
echo "OpenCAI is running: http://localhost:5270"
echo "Sign in as admin / admin, enrol MFA and change the password."
