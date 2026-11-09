FROM alpine:3.20

# One CLI only (guardrail: binary allowlist, not a general-purpose sandbox).
# kubectl is a static Go binary, pinned and verified by sha256. The checksum is
# the one published at dl.k8s.io/release/v1.31.4/bin/linux/amd64/kubectl.sha256.
ARG KUBECTL_VERSION=1.31.4
ARG KUBECTL_SHA256=298e19e9c6c17199011404278f0ff8168a7eca4217edad9097af577023a5620f
RUN wget -q -O /usr/local/bin/kubectl \
      "https://dl.k8s.io/release/v${KUBECTL_VERSION}/bin/linux/amd64/kubectl" \
    && echo "${KUBECTL_SHA256}  /usr/local/bin/kubectl" | sha256sum -c - \
    && chmod 0755 /usr/local/bin/kubectl \
    && adduser -D -u 10001 -s /sbin/nologin sandbox

ENTRYPOINT []
CMD ["sleep", "infinity"]

USER sandbox
WORKDIR /home/sandbox
