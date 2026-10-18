FROM mcr.microsoft.com/azure-cli:2.91.0

# Extensions are baked in here because the sandbox root filesystem is read-only
# at runtime and installing them on demand is switched off
# (AZURE_EXTENSION_USE_DYNAMIC_INSTALL=no, see backend/src/ai/csp/azure.js).
# costmanagement serves the FinOps cost queries; resource-graph serves
# cross-resource inventory and tag searches.
ENV AZURE_EXTENSION_DIR=/opt/az-extensions

# The base image is Azure Linux, whose package manager is `tdnf`.
# `shadow-utils` provides `useradd`; `coreutils` provides the `timeout` binary
# that executeInSandbox wraps every command in. Both are no-ops if present.
RUN tdnf install -y shadow-utils coreutils \
    && tdnf clean all \
    && useradd --create-home --uid 10001 --shell /sbin/nologin sandbox \
    && az extension add --name costmanagement \
    && az extension add --name resource-graph \
    && chmod -R a+rX /opt/az-extensions \
    && rm -rf /root/.azure

# A long-lived container that just waits for `docker exec` calls.
ENTRYPOINT []
CMD ["sleep", "infinity"]

USER sandbox
WORKDIR /home/sandbox
