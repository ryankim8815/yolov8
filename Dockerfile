# Docker Desktop runs Linux containers. Apple MPS/Core ML and AVFoundation stay on macOS.
# This image provides the web/API gateway; it does not claim to containerize Apple acceleration.
FROM nginx:stable-alpine
COPY docker/nginx.conf /etc/nginx/nginx.conf
USER nginx
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
CMD ["nginx", "-g", "daemon off;"]
