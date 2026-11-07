FROM python:3.11-slim
WORKDIR /srv/vision
COPY docker/robot-web-requirements.txt .
RUN pip install --no-cache-dir -r robot-web-requirements.txt
COPY app/ app/
CMD ["uvicorn", "app.robot_web:create_robot_app", "--factory", "--uds", "/run/robot-api/http.sock", "--workers", "1"]
