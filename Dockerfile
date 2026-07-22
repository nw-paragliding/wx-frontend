FROM rust:1.83-bookworm AS builder

WORKDIR /app

# Cache dependencies by copying manifests first
COPY Cargo.toml Cargo.lock* ./
RUN mkdir src && echo "fn main() {}" > src/main.rs
RUN cargo build --release 2>/dev/null || true

# Now copy real source and rebuild
COPY src/ src/
RUN touch src/main.rs
RUN cargo build --release

# Runtime stage - minimal image
FROM debian:bookworm-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Copy binary first (cached unless src/ or Cargo files changed)
COPY --from=builder /app/target/release/windrose-rs /usr/local/bin/windrose-rs

# Copy static assets last — changes here don't trigger a Rust rebuild
COPY static/ /app/static/

ENV PORT=80
ENV STATIC_DIR=/app/static
EXPOSE 80

ENTRYPOINT ["windrose-rs"]
