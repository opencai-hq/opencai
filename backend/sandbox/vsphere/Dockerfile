FROM alpine:3.20

# One CLI only (guardrail: binary allowlist, not a general-purpose sandbox).
# govc is a static Go binary, pinned and verified by sha256. wget and tar come
# from busybox; the checksum is for govc_Linux_x86_64.tar.gz from the v0.46.3
# release's checksums.txt.
ARG GOVC_VERSION=0.46.3
ARG GOVC_SHA256=91f96c35a48cdde8c5e661c6c219bdf1303fbefbedcf13eb078b64a194e56d4a
RUN wget -q -O /tmp/govc.tar.gz \
      "https://github.com/vmware/govmomi/releases/download/v${GOVC_VERSION}/govc_Linux_x86_64.tar.gz" \
    && echo "${GOVC_SHA256}  /tmp/govc.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/govc.tar.gz -C /usr/local/bin govc \
    && rm /tmp/govc.tar.gz \
    && adduser -D -u 10001 -s /sbin/nologin sandbox

ENTRYPOINT []
CMD ["sleep", "infinity"]

USER sandbox
WORKDIR /home/sandbox
