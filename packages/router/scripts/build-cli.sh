#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
# The CLI carries the package version.
version=$(sed -n 's/^  "version": "\(.*\)",$/\1/p' package.json)
mkdir -p bin
CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=$version" -o bin/agent-router ./cmd/agent-router
