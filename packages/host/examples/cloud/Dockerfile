# Build with a locally verified archive named agent-host.tgz in this directory.
# Pin the resulting image by digest in your cloud template.
FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends bash git ca-certificates tini util-linux \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 1001 user \
    && install -d -o user -g user -m 700 /home/user/.agent-host-service /home/user/workspace
COPY agent-host.tgz /tmp/agent-host.tgz
RUN npm install --prefix /opt/agent-host --omit=dev /tmp/agent-host.tgz && rm /tmp/agent-host.tgz
ENV PATH="/opt/agent-host/node_modules/.bin:${PATH}" HOME=/home/user
# Install the selected native CLI/Python environment in your derived image.
# Pi and Claude's SDK engine are included in the archive; credentials are not.
WORKDIR /home/user
EXPOSE 37420
# Root remains available to VCI's injected envd startup. Host runs as user.
ENTRYPOINT ["/usr/bin/tini", "--", "runuser", "-u", "user", "--", "agent-host", "serve", "--config", "/home/user/.agent-host-service/host.json", "--token-file", "/home/user/.agent-host-service/token", "--ready-file", "/home/user/.agent-host-service/ready.json", "--host", "0.0.0.0", "--port", "37420"]
