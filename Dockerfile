# Web/API gateway for the host camera server and browser WebGPU client.
FROM nginx:stable-alpine
COPY docker/nginx.conf /etc/nginx/nginx.conf
USER nginx
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/robot-healthz || exit 1
CMD ["nginx", "-g", "daemon off;"]
