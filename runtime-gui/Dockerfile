ARG BASE_RUNTIME_IMAGE=node:22-bookworm-slim
FROM ${BASE_RUNTIME_IMAGE}
USER root
RUN apt-get update && apt-get install -y --no-install-recommends xvfb x11vnc novnc websockify openbox xterm python3-tk python3-pygame && rm -rf /var/lib/apt/lists/*
RUN useradd --create-home --shell /bin/bash coder || true
COPY start-gui.sh /usr/local/bin/start-gui
RUN chmod 755 /usr/local/bin/start-gui && chown coder:coder /usr/local/bin/start-gui
USER coder
WORKDIR /workspace
EXPOSE 6901
ENTRYPOINT ["/usr/local/bin/start-gui"]
