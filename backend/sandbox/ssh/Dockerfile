FROM alpine:3.20

# One CLI only (guardrail: binary allowlist, not a general-purpose sandbox).
# openssh-client-default is the ssh client alone: no scp, sftp, ssh-agent or
# ssh-keygen. The backend writes the key, client config and known_hosts into the
# tmpfs home at sign-in (backend/src/ai/csp/ssh.js); busybox `sh` runs that one
# fixed script.
RUN apk add --no-cache openssh-client-default=9.7_p1-r6 \
    && adduser -D -u 10001 -s /sbin/nologin sandbox

ENTRYPOINT []
CMD ["sleep", "infinity"]

USER sandbox
WORKDIR /home/sandbox
