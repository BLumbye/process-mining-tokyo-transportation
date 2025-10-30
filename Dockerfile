# Simple Bun runtime image that runs the monitor script
# See available tags: https://hub.docker.com/r/oven/bun/tags
FROM oven/bun:1

WORKDIR /usr/src/app

# Install curl for Gotify notifications used by scripts/monitor.sh
RUN apt-get update \
	&& apt-get install -y --no-install-recommends curl ca-certificates \
	&& rm -rf /var/lib/apt/lists/*

# Install dependencies first for better layer caching
COPY package.json bun.lockb ./
RUN bun install --frozen-lockfile --production

# Copy the rest of the project (TypeScript runs directly in Bun)
COPY . .

# Ensure the monitor script is executable even if host permissions were lost
RUN chmod +x scripts/monitor.sh || true

# Default command runs the monitor which runs the app and notifies on crash
ENTRYPOINT ["bun", "run", "run:monitor"]