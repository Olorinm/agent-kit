FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends bash git ca-certificates tini util-linux curl && rm -rf /var/lib/apt/lists/* && useradd --create-home --uid 1001 user && install -d -o user -g user -m 700 /home/user/.agent-host-service /home/user/workspace /home/user/.codex
COPY agent-host.tgz /tmp/agent-host.tgz
RUN npm install --prefix /opt/agent-host --omit=dev /tmp/agent-host.tgz && rm /tmp/agent-host.tgz && npm install --prefix /opt/native @openai/codex@0.162.0 @larksuite/cli@1.0.97 && npm cache clean --force
ENV PATH="/opt/agent-host/node_modules/.bin:/opt/native/node_modules/.bin:${PATH}" HOME=/home/user
WORKDIR /home/user
EXPOSE 37420
ENTRYPOINT ["/usr/bin/tini", "--", "runuser", "-u", "user", "--", "agent-host", "serve", "--config", "/home/user/.agent-host-service/host.json", "--token-file", "/home/user/.agent-host-service/token", "--ready-file", "/home/user/.agent-host-service/ready.json", "--host", "0.0.0.0", "--port", "37420"]
