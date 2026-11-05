# YOLOv8 실시간 객체 탐지 서버

MacBook 카메라를 캡처하고, 브라우저에 탐지 영상과 객체 목록을 제공합니다. macOS 네이티브 **MPS / Core ML**을 지원하며 기본값은 YOLOv8n + MPS입니다. 환경은 **conda/mamba**로 관리합니다.

Docker 구성은 Mac의 추론 서버 앞에서 HTTP·MJPEG·WebSocket을 중계합니다. **Docker 이미지에 MPS/Core ML 추론 엔진이나 내장 카메라를 넣는 구성이 아닙니다.** Docker Desktop의 Linux VM에서 macOS 프레임워크를 직접 실행하지 않습니다.

## 1. conda/mamba 환경 생성

arm64 Miniforge와 macOS 카메라 접근 권한이 필요합니다. Mamba가 있으면 우선 사용하고, 없으면 conda를 사용합니다. 기존 base 환경은 변경하지 않습니다.

```bash
cd /Users/ryankim/Documents/robotics/yolov8
bash scripts/setup.sh mps
bash scripts/setup.sh coreml
```

Python 3.11과 패키지는 프로젝트의 `.conda/mps`, `.conda/coreml`에 설치합니다. Python은 conda-forge에서, PyTorch·Ultralytics 등은 각 conda 환경 내부의 pip로 설치합니다. 가상환경이나 Homebrew Python 설치는 필요하지 않습니다.

직접 실행하려면:

```bash
mamba env create -p ./.conda/mps -f environment-mps.yml
mamba env create -p ./.conda/coreml -f environment-coreml.yml
```

`mamba` 대신 `conda`도 사용할 수 있습니다. 명령을 찾지 못하면 `YOLO_CONDA_EXE="$HOME/miniforge3/bin/mamba" bash scripts/setup.sh mps`처럼 설치 경로를 지정합니다. 이미 존재하는 환경은 setup 스크립트가 자동으로 변경하지 않습니다.

## 2. 모델과 데이터 준비

```bash
bash scripts/python.sh mps -m scripts.prepare
bash scripts/python.sh coreml -m scripts.export_coreml
```

첫 명령은 공식 YOLOv8n 가중치와 COCO128 이미지·라벨을 다운로드합니다. 두 번째 명령은 NMS를 포함하지 않은 FP16 Core ML 모델을 변환하고 실제 로드·워밍업을 검증합니다. 가중치, 클래스 정보, 변환 설정과 SHA-256은 `models/manifest.json`에 기록합니다. 서버는 실행 중 모델이나 의존성을 자동 다운로드하지 않습니다.

## 3. 서버 실행

Docker와 함께 사용한다면 다음 절의 **통합 실행**을 권장합니다. 이 절은 Mac 추론 서버만 단독 실행하는 방법입니다.

```bash
# 기본 MPS
bash scripts/start.sh mps

# 위 서버를 Ctrl+C로 종료한 뒤 Core ML로 실행
bash scripts/start.sh coreml

# CPU 진단 모드
bash scripts/start.sh cpu
```

브라우저에서 [로컬 서버](http://127.0.0.1:8000)를 엽니다. MPS를 사용할 수 없으면 오류를 표시하며 CPU로 자동 전환하지 않습니다. Core ML은 `CPU_AND_NE`를 명시하여 로드합니다. 이 설정은 CPU와 Neural Engine의 사용을 허용하며 모델 전체의 Neural Engine 실행을 보장하지 않습니다.

최초 실행 시 **시스템 설정 → 개인정보 보호 및 보안 → 카메라**에서 실행 앱의 접근을 허용합니다. 권한 변경 후에도 열리지 않으면 서버를 재시작합니다. 카메라가 없거나 모델 로드에 실패해도 상태 화면과 `/healthz`는 응답하며 `/readyz`는 503을 반환합니다.

**카메라는 Mac 추론 서버가 소유합니다.** 단독 실행한 서버는 브라우저를 닫거나 Docker 컨테이너를 내려도 계속 실행됩니다. 해당 터미널에서 `Ctrl+C`를 누르거나 다른 터미널에서 `bash scripts/stop.sh`를 실행하면 서버를 정상 종료하고 카메라를 해제합니다. 종료 스크립트는 이 프로젝트의 conda 인터프리터·작업 폴더·Uvicorn 실행 인자가 모두 일치하는 프로세스만 종료합니다.

## 4. Docker 이미지 빌드 및 Compose 실행

### 권장: Mac 서버와 Docker 통합 실행

```bash
# 네이티브 서버를 따로 실행하지 않고 이 명령 하나를 실행합니다.
bash scripts/stack.sh up mps

# Core ML을 사용하려면
bash scripts/stack.sh up coreml
```

통합 실행은 Docker 이미지를 빌드하고 중계 컨테이너와 Mac 추론 서버를 실행합니다. 실행 터미널을 유지합니다. 이미 단독 실행 중인 Mac 서버가 있으면 먼저 종료하도록 안내하며 새 서버를 중복 실행하지 않습니다.

- `Ctrl+C`: Mac 추론 서버와 중계 컨테이너를 함께 종료합니다.
- Docker Desktop에서 컨테이너 Stop, `docker compose stop` 또는 `docker compose down`: 통합 실행 스크립트가 약 1초 간격으로 감지해 Mac 추론 서버도 종료합니다. 요청 정리·작업자 종료에 추가 시간이 걸릴 수 있습니다.
- Docker 연결을 확인할 수 없으면 카메라 서버를 종료합니다.
- 통합 실행 스크립트를 강제 종료(`kill -9`)하면 정리 절차를 실행할 수 없습니다. 아래 종료 명령을 사용합니다.

```bash
# 다른 터미널에서 Mac 서버와 Docker를 함께 종료
bash scripts/stack.sh down

# Docker 상태와 무관하게 Mac 카메라 서버만 종료
bash scripts/stop.sh
```

Core ML 환경만 생성한 경우 위 종료 명령 마지막에 `coreml`을 추가합니다. 종료 대상은 백엔드와 관계없이 이 프로젝트에서 실행 중인 네이티브 서버입니다. Docker를 실행할 수 없는 상황에서도 통합 종료 명령은 Mac 서버 종료를 먼저 수행합니다.

### 중계 컨테이너만 별도 관리

다음은 3절의 네이티브 서버를 별도 터미널에서 실행하는 수동 구성입니다. **이 방식에서는 `docker compose down`이 Mac 카메라 서버를 종료하지 않습니다.**

```bash
docker compose up --build -d
docker compose ps
docker compose logs --tail=50 gateway
```

브라우저에서 [Docker 중계 주소](http://127.0.0.1:8080)를 엽니다.

```text
내장 카메라 → Mac conda 환경의 MPS/Core ML 서버 :8000
           → Docker nginx 중계 :8080 → 브라우저
```

- Docker Desktop을 실행해야 합니다. CLI가 PATH에 없으면 `/Applications/Docker.app/Contents/Resources/bin/docker`를 사용합니다.
- 컨테이너는 `host.docker.internal:8000`으로 연결합니다. 네이티브 서버를 종료하면 중계 경로는 502/504, 컨테이너 health는 unhealthy가 됩니다.
- `/gateway-healthz`는 중계 프로세스만, `/healthz`는 네이티브 API 연결까지 확인합니다. `/readyz`는 실제 탐지 준비 상태를 확인합니다.
- MJPEG 버퍼링을 끄고 WebSocket 업그레이드를 전달합니다. 외부 공개 없이 `127.0.0.1:8080`에만 포트를 엽니다.
- 이미지는 비루트 사용자로 실행하고 모델·영상·호스트 conda 환경을 이미지에 포함하지 않습니다.

```bash
# 수동 구성 전체 종료: 카메라 서버와 중계 컨테이너 종료
bash scripts/stack.sh down

# 중계 컨테이너만 종료 (카메라 서버는 계속 실행됩니다)
docker compose down
```

Docker가 호스트 서버에 연결되지 않으면 Docker Desktop의 실행 상태와 `host.docker.internal` 연결, 호스트 API 응답을 확인합니다. 일반 Linux Docker의 호스트 게이트웨이는 macOS Docker Desktop과 동일하지 않으며, 이 Compose 구성은 Mac을 대상으로 합니다.

## 5. 설정과 API

`.env.example`의 `YOLO_` 환경 변수를 실행 전에 export합니다. `.env` 파일을 자동으로 읽거나 shell 코드로 실행하지 않습니다. 예:

```bash
YOLO_CAMERA_INDEX=1 YOLO_PREVIEW_FPS=10 bash scripts/start.sh mps
```

기본 설정: 카메라 1280×720·30 FPS 요청, 모델 입력 640, confidence 0.25, IoU 0.45, 최대 100개 객체, 미리보기 15 FPS, stale 1초, 전송 제한 시간 5초입니다. 실제 입력 해상도와 관측 FPS는 화면과 API에 표시합니다. Core ML의 `YOLO_IMGSZ`는 변환한 정적 입력 크기와 같아야 합니다.

| 인터페이스 | 내용 |
| --- | --- |
| `GET /` | 한국어 탐지 화면 |
| `GET /healthz` | API 프로세스 liveness |
| `GET /readyz` | 모델·카메라·결과 최신성, 미준비 시 503 |
| `GET /api/status` | 백엔드, 입력 모드, FPS, 지연, 드롭 수, 오류 |
| `GET /api/detections/latest` | 최신 결과, 미준비·stale 시 503 |
| `GET /stream.mjpg` | 박스가 포함된 MJPEG |
| `WS /ws/detections` | `event=detections` 결과와 `event=status` 상태 메시지 |

탐지 결과의 `xyxy`는 원본 이미지 좌상단 기준 픽셀 좌표입니다. `session_id`와 `frame_id`로 결과를 식별합니다. 물체가 없으면 `objects: []`를 전송합니다. 시각은 UTC, 지연 측정은 단조 증가 시계를 사용합니다. 표시된 서버 지연에는 센서 내부 대기와 브라우저 표시 지연이 포함되지 않습니다.

## 6. 테스트와 성능 비교

```bash
bash scripts/python.sh mps -m pytest -q
bash scripts/python.sh coreml -m pytest -q
bash scripts/python.sh mps -m scripts.probe --camera

bash scripts/python.sh mps -m scripts.benchmark --backend mps --mode latency
bash scripts/python.sh mps -m scripts.benchmark --backend mps --mode accuracy
bash scripts/python.sh coreml -m scripts.benchmark --backend coreml --mode latency
bash scripts/python.sh coreml -m scripts.benchmark --backend coreml --mode accuracy
```

지연 비교는 50회 워밍업 뒤 같은 이미지 순서로 1,000회 추론합니다. 정확도 비교는 COCO128 전체 이미지와 YOLO 형식 라벨을 COCO 평가 형식으로 변환해 수행합니다. 정확도 측정 confidence는 0.001이며 서비스 confidence는 0.25입니다. COCO128은 학습 데이터의 일부이므로 실사용 정확도를 대표하지 않습니다.

서버를 켠 상태에서 30분 연속 실행을 관측하려면 다음을 사용합니다. `--pid`에는 `/api/status`의 `process_id`를 넣으면 RSS도 수집합니다. MPS/Core ML 서버를 차례로 실행하며 각각 측정하고, GPU 성능 측정 중 두 서버를 동시에 실행하지 않습니다.

```bash
bash scripts/python.sh mps -m scripts.soak --seconds 1800 --clients 1 --output artifacts/mps-soak.json
bash scripts/python.sh coreml -m scripts.soak --seconds 1800 --clients 1 --output artifacts/coreml-soak.json
```

`--clients 0`, `--clients 3`으로 구독자 수에 따른 영향을 확인할 수 있습니다. 이 도구는 원본 프레임을 저장하지 않고 서버 상태와 지표만 기록합니다. 브라우저 표시 지연은 별도 측정 항목입니다.

검증 결과는 `artifacts` 아래 JSON, 읽기 쉬운 결과는 `docs/validation-report.md`에 기록합니다. 목표는 탐지 15 FPS 이상과 서버 내부 지연 p95 150 ms 이하입니다. Core ML은 p95가 10% 이상 개선되고 COCO128 mAP50–95 감소가 1 percentage point 이내일 때 권장합니다.

## 7. 의존성 고정과 재현

```bash
bash scripts/python.sh mps -m scripts.lock_environment --backend mps
bash scripts/python.sh coreml -m scripts.lock_environment --backend coreml
```

`pip check`와 자동 테스트 통과 후 `requirements-*.lock.txt`와 `conda-*.osx-arm64.lock.txt`를 생성합니다. 이 lock은 설치 조합을 고정하며 하드웨어 검증 결과는 별도로 확인해야 합니다.

```bash
# 새로운 경로에서 동일한 arm64 conda 환경 재현
conda create -p ./.conda/reproduced-mps --file conda-mps.osx-arm64.lock.txt
./.conda/reproduced-mps/bin/python -m pip install -r requirements-mps.lock.txt
```

아키텍처와 초기 설계는 [설계 문서](docs/yolov8-m1-pro-realtime-detection-architecture.md)를 참고하세요.

화면 배치, 상태별 동작과 추가 개선안은 [UI 제안서](docs/ui-proposal.md)를 참고하세요.
