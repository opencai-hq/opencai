FROM alpine:3.20

# One CLI only (guardrail: binary allowlist, not a general-purpose sandbox).
# openssh-client-default is the OpenSSH client package. It also installs scp,
# sftp, ssh-keygen and ssh-agent; they are present but unreachable, because the
# command classifier only ever runs `ssh`. The backend writes the key, client
# config and known_hosts into the tmpfs home at sign-in (backend/src/ai/csp/ssh.js);
# busybox `sh` runs that one fixed script.
# coreutils provides the GNU `timeout` that executeInSandbox wraps every command in
# (busybox timeout has no --signal flag).
RUN apk add --no-cache coreutils openssh-client-default=9.7_p1-r6 \
    && adduser -D -u 10001 -s /sbin/nologin sandbox

ENTRYPOINT []
CMD ["sleep", "infinity"]

USER sandbox
WORKDIR /home/sandbox
