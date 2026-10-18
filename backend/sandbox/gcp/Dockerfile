FROM gcr.io/google.com/cloudsdktool/google-cloud-cli:588.0.0-slim

USER root

# The slim image ships gcloud plus the separate gsutil and bq tools. Only gcloud
# is on the allowlist (guardrail: binary allowlist, not a general-purpose
# sandbox), so the other entry points are removed rather than merely refused.
RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin sandbox \
    && rm -f /usr/bin/gsutil /usr/bin/bq \
        /usr/lib/google-cloud-sdk/bin/gsutil /usr/lib/google-cloud-sdk/bin/bq

# A long-lived container that just waits for `docker exec` calls.
ENTRYPOINT []
CMD ["sleep", "infinity"]

USER sandbox
WORKDIR /home/sandbox
