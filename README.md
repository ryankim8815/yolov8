# YOLOv8 실시간 객체 탐지 서버

MacBook 카메라를 캡처하고, 브라우저에 탐지 영상과 객체 목록을 제공합니다. macOS 네이티브 **MPS / Core ML**을 지원하며 기본값은 YOLOv8n + MPS입니다. 환경은 **conda/mamba**로 관리합니다.

Docker Compose가 두산 E0509 로봇 UI와 ROS 2 서비스를 실행합니다. 카메라 기능을 함께 사용할 때는 Mac의 MPS/Core ML 추론 서버가 영상을 처리하고 Docker 게이트웨이가 HTTP·MJPEG·WebSocket을 중계합니다.

## 1. conda/mamba 환경 생성

arm64 Miniforge와 macOS 카메라 접근 권한이 필요합니다. Mamba가 있으면 우선 사용하고, 없으면 conda를 사용합니다. 기존 base 환경은 변경하지 않습니다.

```bash
cd /Users/ryankim/Documents/robotics/yolov8
bash scripts/setup.sh mps
bash scripts/setup.sh coreml
bash scripts/setup.sh train
```

Python 3.11과 패키지는 프로젝트의 `.conda/mps`, `.conda/coreml`, `.conda/train`에 설치합니다. Python은 conda-forge에서, PyTorch·Ultralytics 등은 각 conda 환경 내부의 pip로 설치합니다. 가상환경이나 Homebrew Python 설치는 필요하지 않습니다.

직접 실행하려면:

```bash
mamba env create -p ./.conda/mps -f environment-mps.yml
mamba env create -p ./.conda/coreml -f environment-coreml.yml
mamba env create -p ./.conda/train -f environment-train.yml
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

브라우저에서 [패킹 대시보드](http://127.0.0.1:8000)를 엽니다. **탐지 카메라 → 입력 카메라**에서 Mac에 연결된 장치를 선택하고 **적용**을 누르면 현재 모델이 그 카메라로 탐지를 계속합니다. 카메라가 꺼져 있다면 **탐지 시작**을 누르세요. 장치를 새로 연결했을 때는 **새로고침**으로 목록을 갱신합니다. 선택은 서버를 재시작할 때까지 유지되며, 서버 시작 시에는 `YOLO_CAMERA_INDEX`를 사용합니다.

RealSense를 macOS에서 사용할 때 `failed to set power state` 또는 USB 접근 오류가 나면 `.env`에 `YOLO_REALSENSE_PRIVILEGED=1`을 설정하고 통합 서버를 다시 시작합니다. Mac 서버만 실행할 때는 `YOLO_REALSENSE_PRIVILEGED=1 bash scripts/start.sh coreml`을 사용합니다. RealSense 선택 시 macOS 관리자 인증창에 직접 인증하면 카메라 전용 작업자가 USB를 읽고, 일반 권한의 영상 서버에 로컬 소켓으로 색상·깊이·적외선 프레임을 전달합니다. 웹 서버와 로봇 제어기는 관리자 권한으로 실행하지 않습니다. 카메라를 끄면 센서 작업자도 종료됩니다. 인증 취소·장치 단절 시 자동으로 인증창을 반복하지 않으며, 다시 연결한 후 **탐지 시작**으로 재시도합니다. 현재 D455f 입력은 640×480 / 15 FPS 조합을 요청하며 실제 지원 모드는 카메라 상태에 표시됩니다. [librealsense macOS USB 권한 안내](https://github.com/realsenseai/librealsense/blob/master/doc/installation_osx.md).

관리자 인증 모드는 Xcode Command Line Tools와 `brew install librealsense`로 설치한 네이티브 SDK를 사용합니다. SDK 설치 위치가 다르면 `YOLO_REALSENSE_PREFIX`를 지정합니다(Apple Silicon 기본 `/opt/homebrew`). 센서 작업자는 보호된 문서 폴더 밖의 임시 경로에서 실행되며, 웹 서버의 Python 환경과 별도로 동작합니다.

대시보드는 실시간 영상과 측정된 FPS·서버 지연 p95·탐지 개수를 보여줍니다. 영상 아래 **탐지 클래스**에서 클래스별 수량을 확인할 수 있습니다. 클래스명을 누르면 영상에서 해당 객체의 상자가 강조되고 객체별 신뢰도가 표시됩니다. 다시 누르면 강조가 해제됩니다.

**사용자 관리**에서 이름으로 사용자를 추가한 후 박스 RFID를 할당합니다. **재고 관리**에서 상품을 선택하고 **탐지 클래스 연결**을 눌러 활성 모델의 클래스를 지정합니다. 연결된 상품은 카메라 카드에 `생수 (bottle) ×2`처럼 표시됩니다. 연결 변경 화면에서 **미연결**을 저장하면 해제됩니다.

사용자·RFID, 상품, 모델별 연결, 주문과 작업 기록은 SQLite에 저장됩니다. 처음에는 빼빼로 10개, 생수 5개, 스팸 3개, 물티슈 1개, 인형 2개로 시작합니다. 주문 #123은 빼빼로·생수·물티슈를 각 1개 예약합니다. **놓기 완료 시연**을 누르면 해당 품목을 출고하고 마지막 품목에서 발송 대기로 전환합니다. **로그**에서 사용자·재고·모델·주문별 기록을 조회할 수 있습니다. 버튼으로 실행한 음성 명령 기록은 현재 탭에 보관합니다.

좌측 **모델 관리**에서 상품별 탐지 클래스 연결을 확인합니다. **새 클래스 학습**을 열면 해당 상품명으로 학습 클래스를 등록하거나 기존 라벨을 선택해 사진을 수집할 수 있습니다. 학습 데이터셋에는 유지할 기존 클래스도 포함하세요. 학습 후 모델 버전을 적용하고 **재고에서 클래스 연결**로 돌아가 상품에 연결합니다. [모델 학습 화면](http://127.0.0.1:8000/training#collect)에서 실제 카메라와 학습 서버를 사용합니다. MPS를 사용할 수 없으면 오류를 표시하며 CPU로 자동 전환하지 않습니다. Core ML은 `CPU_AND_NE`를 명시하여 로드합니다. 이 설정은 CPU와 Neural Engine의 사용을 허용하며 모델 전체의 Neural Engine 실행을 보장하지 않습니다.

최초 실행 시 **시스템 설정 → 개인정보 보호 및 보안 → 카메라**에서 실행 앱의 접근을 허용합니다. 권한 변경 후에도 열리지 않으면 서버를 재시작합니다. 카메라가 없거나 모델 로드에 실패해도 상태 화면과 `/healthz`는 응답하며 `/readyz`는 503을 반환합니다.

**카메라는 Mac 추론 서버가 소유합니다.** 단독 실행한 서버는 브라우저를 닫거나 Docker 컨테이너를 내려도 계속 실행됩니다. 해당 터미널에서 `Ctrl+C`를 누르거나 다른 터미널에서 `bash scripts/stop.sh`를 실행하면 서버를 정상 종료하고 카메라를 해제합니다. 종료 스크립트는 이 프로젝트의 conda 인터프리터·작업 폴더·Uvicorn 실행 인자가 모두 일치하는 프로세스만 종료합니다.

### Mac 패킹 음성 대화

Apple Silicon, macOS 27, macOS 27 SDK가 포함된 Xcode Command Line Tools가 필요합니다. FastAPI가 Mac에서 Swift 프로그램 하나를 실행하고, 이 프로그램이 기본 마이크와 스피커를 사용합니다. 대시보드를 닫아도 서버가 실행 중이면 대화할 수 있습니다.

1. 저장소 루트에서 아래 명령을 실행합니다. 기존 서버가 실행 중이면 해당 터미널에서 정상 종료한 뒤 음성을 활성화하여 다시 시작합니다. 한국어 인식 모델 설치는 최초 한 번이며 다운로드가 필요할 수 있습니다.

   ```bash
   bash scripts/build_voice.sh
   .cache/voice/packing-voice --install-ko
   YOLO_VOICE_ENABLED=1 bash scripts/start.sh mps
   ```

   Core ML 서버는 마지막 인자를 `coreml`로 바꿉니다. Docker 중계까지 사용할 때는 세 번째 명령 대신 `YOLO_VOICE_ENABLED=1 bash scripts/stack.sh up mps`를 실행합니다.
2. 대시보드 **음성 명령 → 대화 시작**을 누릅니다. macOS가 요청하면 마이크를 허용합니다. 권한을 거절했던 경우 **시스템 설정 → 개인정보 보호 및 보안 → 마이크**에서 서버를 실행한 앱(예: 터미널)의 권한을 켜고 서버를 다시 시작합니다. 시스템의 한국어 Yuna 음성이 누락된 경우 손쉬운 사용의 말하기 음성에서 설치합니다.
3. Mac **단축어** 앱에서 ‘패킹 대화 시작’ 단축어를 만듭니다. URL을 `http://127.0.0.1:8000/api/voice/wake`로 설정하고 **URL 콘텐츠 가져오기 → 방법 → POST**를 선택합니다. 단축어를 한 번 실행해 로컬 연결 권한을 허용합니다. **시스템 설정 → 손쉬운 사용 → 음성 단축어**에서 이 단축어를 선택하고 원하는 이름(예: “패킹 도우미”)을 본인의 목소리로 등록합니다. [Apple의 음성 단축어 안내](https://support.apple.com/ko-kr/guide/mac-help/mchlf4548bb6/mac)
4. “패킹 도우미”라고 부르고 준비음이 끝나면 “재고 알려줘”라고 말합니다. Yuna가 다 읽은 뒤 다시 이름을 부르지 않고 “주문 내역 알려줘”라고 말할 수 있습니다. 피킹은 “멈춰”, “피킹 재개해줘”로 제어합니다. “예시 주문해줘”는 124번 주문의 품목을 읽고, 같은 대화에서 “주문 확정” 또는 “네, 주문해줘”라고 말하면 접수합니다. “취소”는 대기 중인 주문을 취소합니다.
5. 말끝 무음은 보통 0.8초, “생수하고…”처럼 이어지는 말은 1.5초 기다립니다. “대화 종료” 또는 6초 동안 후속 발화가 없으면 마이크를 해제합니다. 서버 종료는 `Ctrl+C`입니다. 상태 확인은 `curl http://127.0.0.1:8000/api/voice/status`, 수동 호출은 `curl -X POST http://127.0.0.1:8000/api/voice/wake`입니다. 대시보드는 같은 API의 상태와 최근 인식문·응답을 표시합니다. 이 텍스트는 서버 메모리에만 보관합니다.

**Yuna의 답변 도중 말하기**는 `YOLO_VOICE_BARGE_IN`으로 선택합니다. `1`이면 Mac 스피커의 재생음을 에코 제거에 사용하면서 작업자의 말을 듣습니다. 말소리가 이어지면 Yuna의 음량을 먼저 낮춥니다. 첫 단어가 인식되면 낭독을 멈추고, 발화가 끝나면 최종 인식문으로 명령을 처리합니다. 예를 들어 Yuna가 재고를 읽는 도중 “주문 조회”라고 말할 수 있습니다. `0`(기본값)이면 낭독이 끝난 뒤 다음 말을 듣습니다. 두 모드 모두 답변이 끝난 뒤 6초 동안 후속 발화를 기다립니다.

```bash
bash scripts/build_voice.sh
YOLO_VOICE_ENABLED=1 YOLO_VOICE_BARGE_IN=1 bash scripts/start.sh mps
```

Docker 통합 실행에서는 같은 두 변수를 프로젝트 루트의 `.env`에 적고 스택을 재시작합니다. `GET /api/voice/status`의 `barge_in`으로 적용값을 확인할 수 있습니다. `last_playback`은 직전 낭독이 발화로 중단되면 `interrupted`, 끝까지 재생되면 `finished`입니다.

**음성 명령 → 청취 중단**을 누르면 현재 대화를 종료하고 마이크를 해제합니다. Yuna가 답변 중이면 낭독도 멈추고, 확정 대기 중인 주문은 취소합니다. **대화 시작**을 누르거나 호출어를 말하면 새 대화가 시작됩니다. 단축어에서도 `POST /api/voice/stop`을 사용할 수 있습니다.

파일로 먼저 검사하려면 운영 데이터와 마이크를 사용하지 않고 예시 문장을 합성해 전사할 수 있습니다.

```bash
voice_sample_dir=$(mktemp -d)
say -v Yuna -o "$voice_sample_dir/query.aiff" '재고 알려줘'
say -v Yuna -o "$voice_sample_dir/order.aiff" '주문 내역 알려줘'
.cache/voice/packing-voice --transcribe-file "$voice_sample_dir/query.aiff"

# 마이크 속도로 파일을 입력해 첫 음절, 말끝 대기, 낭독 중 끼어들기와 최종 전사를 검사합니다.
xcrun swiftc -parse-as-library -target arm64-apple-macos27.0 -module-cache-path .cache/voice/modules \
  native/voice/Recognition.swift tests/voice_turns.swift -o "$voice_sample_dir/check-turn"
"$voice_sample_dir/check-turn" "$voice_sample_dir/query.aiff" "$voice_sample_dir/order.aiff"
```

## 4. Docker 이미지 빌드 및 Compose 실행

### 권장: Mac 서버와 Docker 통합 실행

프로젝트 루트에 `.env`가 있으면 그 파일을 사용합니다. 처음 설정할 때는 `cp .env.example .env`로 만든 뒤 필요한 값을 수정하세요. Compose가 `.env`의 환경변수를 중계 컨테이너에 적용하고, 통합 실행 스크립트가 `YOLO_*` 값을 Mac 서버에도 전달합니다. Mac 서버에서는 셸에서 직접 지정한 값이 파일보다 우선하고, 백엔드는 실행 명령의 인자가 결정합니다. 파일을 생략하면 기존 기본값으로 실행합니다.

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

### 카메라 서버와 Compose를 별도로 관리

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

- Docker Desktop과 Docker Compose 2.24 이상을 사용합니다. CLI가 PATH에 없으면 `/Applications/Docker.app/Contents/Resources/bin/docker`를 사용합니다. [Compose의 선택적 환경 파일](https://docs.docker.com/reference/compose-file/services/#required)
- 컨테이너는 `host.docker.internal:8000`으로 연결합니다. 네이티브 서버가 꺼지면 루트는 로봇 화면으로 이동하고 카메라·학습 API는 502/504를 반환합니다.
- `/gateway-healthz`는 nginx, `/robot-healthz`는 Compose 로봇 API, `/healthz`는 Mac 추론 API를 확인합니다. 게이트웨이 컨테이너는 `/robot-healthz`로 상태를 검사합니다. `/readyz`는 실제 탐지 준비 상태를 확인합니다.
- MJPEG 버퍼링을 끄고 WebSocket 업그레이드를 전달합니다. 외부 공개 없이 `127.0.0.1:8080`에만 포트를 엽니다.
- nginx 게이트웨이는 비루트 사용자로 실행합니다.

```bash
# 수동 구성 전체 종료: 카메라 서버와 중계 컨테이너 종료
bash scripts/stack.sh down

# 중계 컨테이너만 종료 (카메라 서버는 계속 실행됩니다)
docker compose down
```

Docker가 호스트 서버에 연결되지 않으면 Docker Desktop의 실행 상태와 `host.docker.internal` 연결, 호스트 API 응답을 확인합니다. 일반 Linux Docker의 호스트 게이트웨이는 macOS Docker Desktop과 동일하지 않으며, 이 Compose 구성은 Mac을 대상으로 합니다.

## 5. 설정과 API

통합 실행에서는 루트 `.env`를 수정한 뒤 스택을 재시작합니다. Mac 서버만 `scripts/start.sh`로 실행할 때는 셸에서 변수를 지정합니다.

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
| `GET /api/camera/devices` | Mac에 연결된 카메라의 이름, 장치 ID와 OpenCV 인덱스 |
| `POST /api/camera/select` | `{"device_id":"…"}`로 탐지에 사용할 카메라를 선택하고 시작 |
| `GET /api/detections/latest` | 최신 결과, 미준비·stale 시 503 |
| `GET /stream.mjpg` | 박스가 포함된 MJPEG |
| `WS /ws/detections` | `event=detections` 결과와 `event=status` 상태 메시지 |
| `WS /ws/detections?preview=true` | 미리보기 프레임마다 탐지 JSON과 같은 프레임의 JPEG 바이너리를 차례로 전송 |

탐지 결과의 `xyxy`는 원본 이미지 좌상단 기준 픽셀 좌표입니다. `session_id`와 `frame_id`로 결과를 식별합니다. 물체가 없으면 `objects: []`를 전송합니다. 시각은 UTC, 지연 측정은 단조 증가 시계를 사용합니다. 표시된 서버 지연에는 센서 내부 대기와 브라우저 표시 지연이 포함되지 않습니다.

### 두산 E0509 모니터링과 이동 프리셋

이 Mac에서는 Docker Desktop과 LAN 케이블로 로봇 화면을 운영합니다. 실물 SDK 연결을 확인한 주소는 Mac 유선 어댑터 `en7`의 `110.120.1.11/24`와 E0509 제어기의 `110.120.1.63:12345`입니다. 장비 주소는 루트 `.env`에서 관리합니다. 처음 설치할 때만 `.env.example`을 `.env`로 복사하세요.

**모니터링 시작**

```bash
docker compose up -d --build --wait
docker compose ps
```

[로봇 모니터링](http://localhost:8080/robot)에서 여섯 관절의 각도와 마지막 수신 시각을 확인합니다. Compose가 `gateway`, `robot-web`, `rosbridge`, `joint-monitor`를 실행합니다. 로봇 화면에는 Mac Python이나 별도의 ROS 설치가 필요 없습니다. 자세는 `robot-state` 볼륨에 저장되며 `docker compose down` 이후에도 유지됩니다.

기존 Mac 서버에서 전환할 때 저장한 자세가 있다면 첫 실행 전에 제어 UI를 닫고 빈 볼륨에 한 번 복사하세요. 이미 볼륨을 사용 중이라면 이 단계를 생략합니다. 호스트 폴더를 계속 사용하려면 Docker Desktop에서 공유 가능한 경로를 `ROBOT_STATE_STORAGE`에 지정할 수도 있습니다.

```bash
docker compose up -d --build rosbridge
docker compose build robot-web
tar -C state/robot -cf - . | docker compose run --rm -T --no-deps robot-web sh -ec 'cd /var/lib/vision/robot && test -z "$(ls -A)" && tar -xf -'
```

| 연결 | 기본값 | 용도 |
| --- | --- | --- |
| E0509 제어기 | `ROBOT_IP=110.120.1.63`, `ROBOT_PORT=12345` | 두산 DRFL SDK |
| 읽기 전용 모니터 | `ROBOT_MODBUS_PORT=502` | 제어기 관절 레지스터 270~275 읽기 |
| 웹 API → rosbridge | `ROBOT_ROS_PC_IP=127.0.0.1`, `ROBOT_ROSBRIDGE_PORT=9090` | 기본 Compose에서 `rosbridge:9090`, Linux host 구성에서 `127.0.0.1:9090`으로 연결 |
| ROS 그래프 | `ROS_DOMAIN_ID=0`, `ROBOT_NAMESPACE=dsr01` | 브리지·관절 모니터·드라이버가 공유 |

**실장비 제어 연결**

이 E0509는 DART-Platform V2.10.3으로 연결한 이력이 있습니다. 이전 주소(`110.120.1.56`)에서 DART 장치 검색을 실행했을 때 제어기가 다음 정보를 반환했습니다. 버전은 Modbus 레지스터에서 추정한 값이 아닙니다.

| 장치 IP | 시리얼 | 제어기(DRCF) | 통합 소프트웨어 |
| --- | --- | --- | --- |
| `110.120.1.56` | `YLYA56-E0509` | `GF02100300` (2.10.3) | `GV02100300` |

Compose의 `hardware` 프로필은 E0509 제어기(`GF02100300`)에 대해 Linux SDK `GL010117`을 사용합니다. x86_64용 라이브러리이므로 하드웨어 드라이버는 Linux AMD64 / ROS 2 Humble로 빌드하며, Apple Silicon에서는 Docker Desktop이 에뮬레이션합니다. 브리지와 관절 모니터도 Humble을 사용합니다. 기본 Compose에서는 각 ROS 컨테이너가 독립적인 네트워크 주소를 사용하고 Fast DDS가 UDP 멀티캐스트로 같은 도메인의 참여자를 검색합니다. Linux host 구성은 루프백 검색을 유지합니다. 빌드는 고정된 SDK의 헤더·정적 라이브러리·Poco를 사용하며, 라이브러리가 반환한 버전도 검사합니다. [두산 SDK 소스](https://github.com/DoosanRobotics/API-DRFL/tree/ddf59fad8bbd71d8aa318bf5f00349913b33f334) · [E0509용 Humble 드라이버 소스](https://github.com/DoosanRobotics/doosan-robot2/tree/1634069af9cf4b9d446f97aeff2bc0f37dfc6f7d)

먼저 기본 모니터링을 기동한 상태에서 SDK 접속을 검사하세요. 이 검사는 제어권 요청 없이 DRCF 버전과 현재 관절각을 조회합니다. 이미 제어 드라이버가 연결되어 있으면 이 진단 대신 실행 중인 드라이버의 상태를 확인하세요.

```bash
docker compose --profile hardware build doosan-driver
docker compose run --rm --no-deps doosan-driver check-e0509 --sdk-version  # GL010117
docker compose run --rm --no-deps doosan-driver timeout 15 check-e0509
```

Docker에서 SDK 강제 인계만 시험하려면 로봇이 정지한 상태에서 아래 명령을 실행하세요. 검사기는 `MANAGE_ACCESS_CONTROL_FORCE_REQUEST`를 한 번 보내고, `Access callback: GRANT`를 받으면 검사기 세션이 제어권을 획득한 것입니다. 결과를 출력하면 연결을 닫습니다. ROS 2 드라이버를 기동할 때 이 검사를 먼저 실행할 필요는 없습니다.

```bash
docker compose run --rm doosan-driver check-e0509 --force-request-access
```

Apple Silicon Mac에서 SDK 제어권을 한 번 요청할 때는 저장소 루트에서 아래 명령을 사용하세요. 처음 준비할 때는 Xcode 명령줄 도구, CMake, GNU Make 4 이상(`gmake`), Docker Desktop이 필요합니다. 준비가 끝나면 검사기는 Mac의 유선 LAN을 통해 직접 연결합니다.

```bash
bash rosbridge/host-sdk/prepare.sh                       # 첫 설치 또는 검사기 재빌드
python3 scripts/check_robot_sdk_host.py --sdk-version    # 로봇에 접속하지 않고 빌드 확인
python3 scripts/check_robot_sdk_host.py --force-request-access
```

`--force-request-access`는 로봇이 `STANDBY` 또는 `SAFE_OFF`이고 SDK 초기화가 완료되면 `MANAGE_ACCESS_CONTROL_FORCE_REQUEST`를 한 번 보냅니다. 승인되면 기존 보유자가 제어권을 잃을 수 있습니다. `Forced access request sent`는 전송 성공이며, `Access callback: GRANT`가 이 검사기 세션의 획득을 확인합니다. `DENY`는 거절, `LOSS`는 제어권 상실, 10초간 응답이 없으면 결과 미확인입니다. 검사기는 서보나 이동 명령을 보내지 않고 결과를 출력한 뒤 연결을 닫습니다. 일반 인계 요청은 `--request-access`, 읽기 전용 조회는 옵션 없이 실행하세요.

**Mac SDK 세션으로 제어권 유지 확인**: Docker는 웹·ROS 모니터링만 담당하고, Mac의 SDK 작업자 하나가 유선으로 제어기와 직접 통신합니다. 제어권 회수와 저장한 자세 이동은 같은 Mac SDK 세션을 사용합니다. 제어권 회수는 서보나 운전 모드를 변경하지 않습니다.

1. 프로젝트 `.env`에 `ROBOT_ACCESS_BACKEND=mac-sdk`를 설정하고 `ROBOT_IP=110.120.1.63`, `ROBOT_PORT=12345`, `ROBOT_LAN_INTERFACE=en7`이 실제 연결과 맞는지 확인하세요.
2. 저장소 루트에서 아래 명령을 실행하세요. 기존 일회성 검사기만 준비되어 있다면 새 작업자를 한 번 빌드해야 합니다.

   ```bash
   docker compose stop doosan-driver
   bash rosbridge/host-sdk/prepare.sh
   docker compose build robot-web
   docker compose up -d gateway joint-monitor
   bash scripts/robot-access.sh
   ```

   Docker Desktop은 SDK 준비와 웹 UI에만 필요합니다. 준비된 Mac 서버는 Docker 없이 실행할 수 있으며 `127.0.0.1:8011`에서만 수신합니다. 서버가 켜지면 현재 상태를 읽습니다. 제어권을 확인하는 동안에는 별도의 드라이버나 일회성 검사기를 실행하지 마세요.

3. [로봇 화면](http://localhost:8080/robot)의 **제어권 보기 → Mac SDK 검증**에서 연결·초기화 완료를 확인한 뒤 **제어권 회수 → 회수 요청**을 한 번 누르세요. `GRANT` 이후 세션 번호가 같고 ‘보유 중’이 60초 이상인지, 새로고침 후에도 유지되는지 확인하세요. 화면을 새로고침하거나 다른 탭을 열어도 SDK 세션은 유지됩니다. `DENY`는 요청 거절, `LOSS`는 미보유, 10초 동안 응답이 없으면 ‘결과 미확인’입니다. 늦은 콜백이 올 수 있어 같은 세션에서 즉시 재전송하지 않습니다.
4. `SAFE_OFF`에서 제어권을 보유한 상태라면 **서보 켜기 → 서보 ON 요청**으로 관절에 전원을 공급할 수 있습니다. 자세 확인창에서도 같은 버튼을 사용할 수 있습니다. 작업 공간과 안전 알람을 확인한 뒤 요청하세요. 제어기가 `STANDBY`를 보고하면 화면에 **서보 켜짐**이 표시됩니다. 운전 모드 전환과 자세 이동은 별도 작업입니다.
   `SAFE_STOP`에서는 좌측 메뉴 하단의 **STANDBY 복구**를 사용하세요. 정지 원인을 해소한 후 확인창에서 요청하면 `CONTROL_RESET_SAFET_STOP`과 기본 프로그램 정지 정책으로 복구하며, 제어기가 `STANDBY`를 보고해야 완료로 표시합니다. 중단된 작업은 자동 재개하지 않습니다. `SAFE_OFF`에서는 같은 버튼이 서보 ON을 요청합니다. 제어권이 없다면 먼저 **제어권 회수**를 요청하세요. 비상 정지 상태에서는 복구 요청을 허용하지 않습니다. SDK 작업자 갱신과 서비스 재시작이 필요합니다.
5. 다른 터미널에서 다음 명령으로 Mac의 경로·소켓과 웹에서 보이는 세션이 같은지 확인할 수 있습니다. `worker_pid`는 `lsof`의 `blink` PID에 해당합니다. 포트 12345 포워딩은 필요 없습니다.

   ```bash
   route -n get 110.120.1.63
   lsof -nP -iTCP@110.120.1.63:12345 -sTCP:ESTABLISHED
   curl -fsS http://localhost:8080/api/robot/host-access/status
   ```

`Ctrl+C`로 Mac 서버를 종료하면 화면의 보유 표시가 해제됩니다. 연결 단절 후에는 유선 경로를 다시 확인하고 새 세션으로 연결하며 이전 승인을 재사용하거나 자동 요청하지 않습니다. ROS 제어로 돌아갈 때는 Mac 서버를 먼저 종료하고 `.env`를 `ROBOT_ACCESS_BACKEND=ros`로 바꾼 뒤 `docker compose up -d robot-web`을 실행하세요. [두산 SDK의 제어권 콜백 예제](https://doosanrobotics.github.io/doosan-robotics-api-manual/GL013301/tutorials/scenarios/1_minimal_motion_sample.html)

**웹 제어기와 Mac SDK 제어기의 주소가 다를 때**

다음 오류는 웹과 Mac SDK 서버가 서로 다른 대상 주소를 사용한다는 뜻입니다.

```text
웹 제어기 110.120.1.56:12345와 Mac SDK 제어기 110.120.1.63:12345가 다릅니다. 설정을 맞추고 서버를 다시 시작하세요.
```

Mac SDK 서버는 시작할 때 `scripts/check_robot_sdk_host.py`의 `lan_settings()`로 아래 순서에 따라 설정을 읽습니다. 뒤에서 읽은 값이 앞의 값을 덮어씁니다. 읽는 키는 `ROBOT_IP`, `ROBOT_PORT`, `ROBOT_LAN_INTERFACE` 세 개이며, `# ROBOT_IP=…`처럼 주석 처리한 줄은 사용하지 않습니다.

| 우선순위 | 설정 출처 |
| --- | --- |
| 1 | 저장소 루트 `.env`의 값 |
| 2 · 최우선 | SDK 서버를 실행한 프로세스의 환경변수(`export ROBOT_IP=…` 등) |

`.env.example`은 처음 `.env`를 만들 때 사용하는 템플릿이며 실행 시에는 읽지 않습니다. `.env`가 없거나 일부 키가 빠져 있어도 템플릿 값으로 보충하지 않습니다. SDK 실행 전에 위 세 키를 `.env` 또는 프로세스 환경변수에 설정하세요.

읽은 값은 `app/robot_host_access.py`의 `AccessServer.__init__()`에서 `self.cfg`에 보관합니다. 오류 메시지의 **Mac SDK 제어기 주소**는 이 시작 시점의 설정값입니다. `.env`를 수정한 뒤에도 이미 실행 중인 SDK 서버는 이전 값을 계속 사용합니다. Mac SDK 서버는 Docker 밖의 별도 프로세스이므로 웹 컨테이너를 재시작하거나 브라우저를 새로고침해도 SDK 서버의 설정은 갱신되지 않습니다.

저장소 루트에서 다음 명령으로 현재 설정과 실행 중인 SDK 서버를 비교할 수 있습니다. 이 명령들은 로봇 이동이나 제어권 요청을 보내지 않습니다. 주소 예시는 현재 장비의 주소로 바꿔 사용하세요.

```bash
# 현재 파일과 현재 셸 환경으로 새로 계산한 SDK 설정
bash scripts/python.sh coreml -c 'from scripts.check_robot_sdk_host import lan_settings; print(lan_settings())'
# 실행 중인 웹 컨테이너가 사용하는 주소
docker compose exec -T robot-web python -c 'import os; print({k: os.getenv(k) for k in ("ROBOT_IP", "ROBOT_PORT")})'
# Mac SDK 서버의 PID 확인
lsof -nP -iTCP:8011 -sTCP:LISTEN
# SDK 서버가 아래 대상 주소를 사용하는지 읽기 전용으로 확인
curl -i -H 'X-Robot-Target: 110.120.1.56:12345' http://127.0.0.1:8011/api/robot/host-access/status
```

현재 설정 계산 결과와 웹은 `.56`인데 마지막 요청이 HTTP 409와 함께 SDK 주소 `.63`을 반환하면, SDK 서버에 남은 이전 설정을 갱신해야 합니다. 진행 중인 작업을 종료한 뒤 SDK 서버를 실행한 터미널에서 `Ctrl+C`로 종료하고, 저장소 루트에서 `bash scripts/robot-access.sh`로 다시 실행하세요. 백그라운드 실행 중이라면 위 `lsof`의 PID를 `ps -p PID -o pid,command`로 확인하고, 해당 SDK 서버만 `kill -TERM PID`로 종료합니다(`PID`는 확인한 숫자로 교체). `.env`를 기준으로 실행하려면 해당 셸에 남은 `ROBOT_IP` 등의 export 값도 확인하세요. 웹 컨테이너까지 이전 주소를 사용한다면 `docker compose up -d robot-web joint-monitor`로 웹과 읽기 전용 모니터의 환경변수도 갱신합니다.

재시작 후 같은 상태 요청이 HTTP 200이면 대상 주소가 일치한 것입니다. 실제 연결·초기화·제어권은 응답의 `connection`, `initialized`, `held`로 별도 확인합니다. SDK 재시작으로 생성된 새 세션에서는 이전 이동 승인을 재사용하지 않습니다.

실장비 작업 공간이 준비되었을 때 아래 명령을 실행하세요. Docker의 `hardware` 프로필은 ROS 2 드라이버를 `--force-request-access`로 시작합니다. 드라이버는 자신의 SDK 세션에서 강제 인계를 한 번 요청하며, 승인되면 기존 보유자가 제어권을 잃을 수 있습니다. 로그의 `Forced access request sent`는 전송, `Access control granted`는 승인입니다. 드라이버는 승인 시 `SAFE_OFF`이면 서보 ON을 요청하고 `STANDBY`를 확인합니다. 시작할 때 제어기의 수동·자동 운전 모드를 유지합니다. Compose는 6축 관절 토픽과 상태·이동 서비스가 발견될 때까지 기다립니다.

```bash
docker compose --profile hardware up -d --build --wait --wait-timeout 150
docker compose --profile hardware ps -a
docker compose logs --tail 60 doosan-driver
```

화면의 **rosbridge 연결 대기**는 웹이 WebSocket에 재연결 중이라는 뜻입니다. **회수 서비스 대기**는 WebSocket은 연결됐고 `/<namespace>/system/reclaim_control`이 아직 발견되지 않은 상태입니다. 이때는 `docker compose ps doosan-driver`와 `docker compose logs --tail 100 doosan-driver`로 SDK 연결 및 초기화 오류를 확인하세요.

드라이버가 실행 중에 제어권을 잃으면 [로봇 모니터링](http://localhost:8080/robot)에서 **제어권 회수**를 누르고 대상 제어기를 확인한 뒤 **회수 요청**을 선택하세요. 드라이버가 기존 SDK 연결로 한 번 요청하고 화면에 결과를 표시합니다. 이미 보유 중이면 즉시 알려줍니다. 이 버튼은 서보를 켜거나 로봇을 움직이지 않습니다. 버튼에 서비스 대기가 표시되면 `hardware` 프로필의 드라이버가 실행 중인지 확인하세요.

**직접 교시 허용**을 켜면 제어권을 가진 E0509 드라이버가 `STANDBY`에서 수동 모드를 요청합니다. 실제 툴과 페이로드 설정을 확인한 뒤, 로봇팔의 자유이동용 직접 교시 버튼을 누른 채 손으로 자세를 바꾸세요. 버튼에서 손을 떼고 로봇이 정지한 뒤 토글을 끄면 자동 모드로 복귀합니다. 토글 자체는 서보나 이동을 명령하지 않습니다. 웹 자세 이동은 자동 모드가 확인된 경우에만 가능합니다. 로봇에서 모드 변경을 거부하면 화면에 사유를 표시합니다. [두산 E 시리즈 콕핏 안내](https://manual.doosanrobotics.com/ko/user-manual/3.6.0/3-e-series/cockpit) · [두산 SDK 운전 모드 변경](https://doosanrobotics.github.io/doosan-robotics-api-manual/GL013304/mode/manual/safety_servo_operations/set_robot_mode.html)

드라이버만 종료해 읽기 전용 모니터링으로 돌아가려면 `docker compose stop doosan-driver`, 전체를 종료하려면 `docker compose --profile hardware down`을 사용하세요.

**읽기 전용이 계속 표시될 때**

이 Mac의 Docker Desktop에서 SDK 배포본 1.33.0~1.33.5를 시험한 결과, 모두 `open_connection`에서 실패했습니다. 1.31.0과 1.32.1은 이 함수가 성공을 반환했지만 즉시 연결 종료 알림이 발생했고 제어기 버전을 조회할 수 없었습니다. 두산은 1.33.4에서 `open_connection` 도중 연결이 끊겼는데도 이를 감지하지 못하는 문제를 수정했다고 설명합니다. [두산 SDK 릴리스 노트](https://github.com/DoosanRobotics/API-DRFL/releases)

이 Mac의 Docker Desktop에서 `GL010117`을 비교했을 때, `110.120.1.56:12345` 연결 종료 콜백이 먼저 발생하고 `open_connection`은 참을 반환했습니다. 드라이버와 진단 명령은 이 경우 연결 실패로 처리합니다. `--sdk-version`은 로봇에 접속하지 않고 링크된 SDK를 확인합니다. 실장비 세션의 성공 기준은 `check-e0509`가 제어기 버전과 여섯 관절각을 모두 출력하고 성공 종료하는 것입니다.

`/dsr01/monitor/joint_states`는 제어기의 Modbus TCP FC03으로 수신한 실제 각도입니다. UI는 드라이버에서 `/dsr01/joint_states`가 수신되면 해당 토픽으로 전환합니다. 자세 명령은 드라이버의 최신 6축 데이터와 STANDBY 응답이 필요합니다. [두산 ModbusTCP 설명](https://manual.doosanrobotics.com/en/user-manual/3.6.0/3-e-series/setting-modbustcp-slave)

`DRFL open_connection failed` 또는 `DRCF connecting ERROR`가 출력되면 SDK 연결 단계에서 막힌 것입니다. 이 Mac에서는 DART 장치 검색과 Modbus 관절 조회가 성공해도 Docker의 SDK 세션은 성립하지 않았습니다. EtherNet/IP가 반환한 `2.63`은 CIP 어댑터 리비전입니다. 다른 장비의 버전을 확인할 때는 Windows DART Platform의 **장치 검색** 결과에서 IP·시리얼·제어기 버전을 확인하세요. 제어권을 가져올 필요는 없습니다. [두산 DART Platform 장치 검색](https://manual.doosanrobotics.com/ko/user-manual/3.2.1/3-e-series/dart-platform)

같은 유선망의 Linux PC에서 기존 제어 드라이버가 종료된 상태라면, 다음 명령 하나로 SDK를 비교할 수 있습니다. 컨테이너가 Linux 호스트 네트워크에서 제어기 버전과 현재 관절각만 조회한 뒤 종료합니다. 두 값이 모두 출력되면 SDK 세션을 확인한 것입니다. [Docker 호스트 네트워크 제약](https://docs.docker.com/engine/network/drivers/host/)

```bash
docker compose -f docker-compose.yml -f rosbridge/compose.host.yml run --build --rm --no-deps doosan-driver timeout 15 check-e0509
```

**관리 → 로봇 관리 → 캘리브레이션** (`/robot#work-plane`). 대시보드의 탐지 카메라 제목 옆 **캘리브레이션**도 같은 화면을 엽니다. 입력 카메라와 원본 해상도를 확인하세요. 카메라가 꺼져 있어도 메뉴는 열리며, 탐지 영상이 연결되면 한 프레임을 고정해 교시합니다. **새 영상 고정**은 같은 입력의 편집값을 유지합니다. 노트북과 로봇을 고정하고 물체 중심이 놓인 평면에서 작업 영역의 네 모서리를 정합니다. **카메라 좌표 설정** 탭에서 모서리 A~D를 차례로 선택해 탐지 영상의 둘레를 따라 짚고 대응하는 TCP의 BASE 좌표(mm)를 입력하거나 **현재 위치 불러오기**를 누릅니다. 카메라 보정은 XYZ만으로 저장할 수 있습니다. 작업별 공구 방향은 **이동 프리셋 → 파지 자세 · 공구 방향**에서 설정합니다. 이전 작업면에 저장된 ABC는 호환용으로 유지하며, 새 보정에 ABC가 없으면 이전 단일점 실행 대신 이동 프리셋을 사용하세요. **변경 취소**는 마지막 저장값으로 돌아갑니다. **보정 저장** 후, 교시에 사용하지 않은 별도 실측 지점을 선택해 모달의 좌표와 비교하세요. 카메라 위치, 화면 각도, 작업 평면 또는 TCP 설정을 바꾸면 다시 교시하세요.

캘리브레이션의 **E0509 자세 · 가상 작업면**에는 두산 E0509의 원본 외형 모델과 6축 관절 구조를 사용합니다. 실제 관절 모니터의 J1~J6 수신값(라디안)을 이름별로 대응시켜 전체 팔의 자세와 플랜지 방향을 표시합니다. BASE 원점은 고정되며 교시 모서리의 XYZ를 편집해도 실제 팔의 자세를 변경하지 않습니다. 교시 TCP는 별도 표식으로 표시합니다. 연결 끊김, 관절 데이터 불완전 또는 수신 지연 시 **[0, 0, 90, 0, 90, 0]°**로 전환하고 **기본 자세 · 실측 아님**을 표시합니다. **모델 플랜지**는 기구학 계산값이고 **실측 TCP**는 기존 현재 위치 조회 API로 읽습니다. 실측 조회가 실패하거나 연결이 끊기면 이전 실측 수치를 지웁니다. 관절 선택은 강조만 바꾸며, 입체·정면·측면 및 드래그는 보기만 바꿉니다. 모바일에서는 **관절·좌표**를 펼쳐 값을 확인합니다. 그리퍼 관리의 기존 손가락 모형과 설정은 유지합니다. 모델 출처는 [DoosanRobotics/doosan-robot2](https://github.com/DoosanRobotics/doosan-robot2/tree/main/dsr_description2)이며, 배포한 형상은 미리보기용으로 세부 메시를 축소했습니다. 라이선스는 `/static/robot-e0509-LICENSE.txt`에 포함합니다.

**관리 → 로봇 관리 → 그리퍼** (`/robot#gripper`)에서는 **그리퍼 방향 · 가상 작업면**의 입체·측면 미리보기 아래에 캘리브레이션과 단독 조작을 함께 제공합니다. 별도의 하위 탭 없이 RH-P12의 실측 벌림표와 접촉 전류를 저장하고, 이동 입력 단위를 **위치값 (0–700)** 또는 **벌림 (mm)**으로 선택합니다. 기존 `/robot#gripper-table` 링크는 실측 벌림표로 이동하고 `/robot#gripper-test`는 통합 그리퍼 화면으로 연결합니다. 카메라 좌표는 **캘리브레이션**, 모의 객체와 공구 방향은 **이동 프리셋**, 거리 표시 가이드는 **매니퓰레이터 → 3D 보기 옵션**에서 설정합니다. **손가락 치수 · 모형**은 그리퍼 메뉴에 있으며 이 브라우저의 모형에만 적용합니다. 실제 TCP 오프셋·실측 벌림표와 구분합니다.

**캘리브레이션 → 영역 투영 확인.** 고정된 영상에서 측정할 탐지 객체를 고릅니다. 객체가 하나면 자동으로 선택됩니다. 네 점을 교시하면 탐지 상자가 손가락 벌림 방향으로 차지하는 폭과 권장 벌림을 mm로 표시합니다. TCP에서 좌우 끝까지 잰 거리 중 큰 값에 **한쪽 여유**(기본 5 mm)를 더한 뒤 두 배로 계산합니다. 중심에서 좌우가 각각 20 mm라면 권장 벌림은 50 mm입니다. 물체가 비스듬하면 영상 축에 평행한 탐지 상자가 주변 공간을 포함해 폭을 크게 추정할 수 있습니다. 한쪽 여유는 **보정 저장**으로 저장합니다.

**관리 → 로봇 관리 → 매니퓰레이터** (`/robot#manipulator`)에서는 **E0509 자세 · 가상 작업면**과 **로봇 제어 / 이동 프리셋 / 택배 박스 설정** 탭을 제공합니다. 좌우 방향키와 Home/End로 탭을 이동합니다. 기존 `/robot#pose-title`, `/robot#product-grasp-title` 북마크는 이동 프리셋으로 연결됩니다. 로봇 제어의 서보·복구 버튼은 좌측 하단의 공통 복구 확인창을 엽니다. SAFE_OFF에서는 서보 켜기, SAFE_STOP에서는 STANDBY 복구, STANDBY에서는 준비 상태를 확인하며 자동 재개하지 않습니다.

**택배 박스 설정** (`/robot#parcel-box-title`)에서는 가로(BASE X)·세로(BASE Y)·높이(+Z)와 **바닥면 중심의 BASE X·Y·Z(mm)**를 입력합니다. 박스는 BASE 축에 평행한 열린 상자로 표시하며, 입력한 Z가 바닥 높이이고 윗면은 Z+높이입니다. 유효한 편집값은 매니퓰레이터 3D 화면에 즉시 반영하고, 불완전한 입력은 이전 박스를 지웁니다. **박스 설정 저장 / 변경 취소**를 지원하며 다른 탭의 저장과 충돌하면 최신 설정을 불러옵니다. `GET/PUT /api/robot/parcel-box`로 로봇별 저장하며 재시작 후에도 유지됩니다. 박스 외형·설치 위치는 표시용 설정으로, 이동 프리셋의 박스 놓기 TCP·이송 경로와 별개입니다. 캘리브레이션과 그리퍼 화면에는 표시하지 않습니다. 이 탭에서는 박스 미리보기와 크기·위치 입력만 제공하며, 거리 가이드용 **3D 보기 옵션**은 표시하지 않습니다.

저장값이 없으면 플레이스홀더와 같은 **크기 400 × 300 × 250 mm, 바닥면 중심 BASE (500, 0, 0) mm**를 기본값으로 채워 3D에 표시합니다. 기존 저장값은 유지하며, 기본값을 그대로 저장할 수도 있습니다.

매니퓰레이터 관리의 3D 화면에만 참고 사진 형태의 그리퍼를 플랜지에 장착해 표시합니다. 외형과 장착 비율은 도식이며, 실제 위치는 현재 설정된 RH-P12 SDK 피드백을 사용합니다. 저장된 실측 벌림표로 실제 위치값을 mm로 보간해 손가락 간격을 반영하고, 명령 위치는 별도로 표시합니다. 10초 이내의 정상 피드백과 유효한 벌림표가 있을 때만 **추정 벌림(mm)**을 표시합니다. 미연결·오류·수신 지연·벌림표 미등록 시에는 수치를 지우고 손가락을 윤곽선으로 표시합니다. **그리퍼 상태 읽기**는 작업자가 눌렀을 때만 기존 SDK의 읽기 명령을 실행하며, 제어권·자동 모드·정지·동시 작업 검사를 그대로 적용합니다. 화면 진입과 탭 전환은 그리퍼 명령을 보내지 않습니다. 캘리브레이션의 3D 모형과 그리퍼 관리 화면은 변경하지 않습니다.

캘리브레이션의 설정 영역은 선택한 탭의 내용에 맞춰 높이가 늘어납니다. 탭 내부의 별도 스크롤 대신 페이지 스크롤로 전체 설정을 확인합니다.

**마커·깊이 BASE 캘리브레이션.** `/robot#camera-calibration`의 A~D 각 행에 서로 다른 `DICT_4X4_50` 마커 ID(0~49)를 지정합니다. 각 행의 **출력**에서 SVG를 받아 배율 100%로 출력하고, 네 마커에 공통으로 사용할 검은 사각형의 실제 한 변 길이(mm)를 확인합니다. 각 행에는 **해당 마커의 검은 사각형 중심점**에 대한 로봇 BASE XYZ를 입력합니다. 새 등록의 ID 기본값은 0·1·2·3이고, BASE 예시 좌표는 넣지 않습니다. ‘현재 TCP’는 공구 끝점 TCP를 보정한 후 해당 중심점을 정확히 교시했을 때만 사용하세요. 네 중심점은 마커 한 개 크기의 정사각형일 필요가 없으며, 작업 영역에 넓게 분산하고 한 직선으로 배치하지 않습니다. 카메라·네 마커·로봇을 고정하고 **캘리브레이션**을 누르면 로봇 이동 없이 서로 다른 RGB-D 영상 12장에서 네 ID를 모두 인식합니다. ID 중복·누락, 등록한 중심점과 깊이의 불일치(2 mm 초과), 로봇 자세 변화(0.2° 초과), 영상 오차(1.5 px 초과), 깊이 오차(10 mm 초과), 위치 흔들림(5 mm 초과), 회전 흔들림(1° 초과), 출력 크기 불일치(2% 초과)를 거절합니다. 이 기준은 등록 품질 검사이며 실제 절대 정확도를 보증하는 값은 아닙니다. 마커 BASE 실측값과 독립된 지점으로 정확도를 확인하세요.

기존 단일 마커 등록(`marker_id`와 사각형 네 모서리)은 저장값과 계산 방식을 보존합니다. 화면에 기존 방식 안내가 표시되며 **모서리별 마커 4개로 전환**은 초안의 좌표를 비웁니다. 네 중심점을 새로 입력하고 저장해야 새 방식(`marker_ids: [A, B, C, D]`와 각 중심점의 `corners_base_mm`)이 적용됩니다. 단일 마커의 기존 모서리 좌표를 새 마커 중심점으로 자동 해석하지 않습니다.

이 기능은 Mac의 RGB-D 캡처가 제공하는 색상 광학 내부 파라미터와 **색상 카메라 좌표의 Z 깊이**를 사용합니다. USB 권한 작업자는 카메라만 읽으며, 마커 검출·계산은 일반 사용자 서버에서 수행합니다. 무왜곡 또는 Brown-Conrady 색상 광학을 지원합니다. 마커·깊이 BASE 보정을 켜면 YOLO 이동 프리셋은 같은 탐지 프레임의 깊이로 보이는 표면의 BASE XYZ를 계산하고, 프리셋에 저장한 법선 방향 두께의 절반을 빼 객체 중심으로 환산합니다. 전체 6D 객체 자세나 숨은 두께를 추정하지 않으며, 파지 방향과 두께는 프리셋의 바닥·선반 설정을 사용합니다. 벌림은 내부의 일관된 표면 깊이를 검증한 후 탐지 상자의 투영 범위와 기존 양쪽 5 mm 여유로 계산합니다. 깊이 불량·영상 경계에 잘린 객체는 거절합니다.

**영상·로봇 중첩 보기**는 현재 수신한 6축 관절값으로 E0509 CAD를 실제 색상 영상에 투영합니다. 영상과 관절 시각이 다를 수 있으므로 정지 상태에서 정렬을 확인하며, 충돌 판정에는 사용하지 않습니다. 마커 유실·이동, 카메라 세션·입력·해상도·광학값 변경 또는 서버 재시작 후에는 다시 캘리브레이션해야 합니다. 이전 변환을 자동 갱신하거나 자동 복원하지 않습니다. 보정 등록·재계산·실패·글로벌 중단은 관련 확인 대기를 무효화하며, 실제 실행 전과 파지 전에도 최신 영상으로 대상을 재검증합니다. 저장한 BASE 경유점·박스 좌표는 변경하지 않습니다. 보정이 켜진 상태에서 실패하면 기존 평면 좌표로 대신 실행하지 않습니다. 마커 BASE 보정 사용을 명시적으로 끄면 기존 작업면 보정을 사용합니다. 이전 대시보드 단일점 실행 대신 이동 프리셋에서 YOLO 대상을 확인하세요.

보정 좌표와 결과는 로봇별 `camera-marker.json`에 독립 저장합니다. `GET/PUT /api/robot/camera-calibration`, `POST /api/robot/camera-calibration/run`(등록 revision 필요), `GET /api/robot/camera-calibration/view`를 제공합니다. 마커 좌표 등록·조회는 카메라가 꺼져 있어도 가능하며 기존 평면 교시의 잠금과 분리됩니다. 실행 직전 벌림 재검증은 승인된 TCP를 기준으로 수행합니다. 보정 수집 중 광학값이 바뀌면 모든 수집값을 폐기합니다.

모의 RGB-D·SDK 회귀 검사는 `tests/test_camera_marker.py`, `tests/test_robot_camera_calibration.py`, 모든 네트워크를 모의 응답으로 처리하는 화면 검사는 `scripts/check_camera_calibration_ui.cjs`입니다. 이 검사는 실제 공통 다이얼로그 스타일에서 영상·CAD 캔버스 경계와 투명도도 확인합니다. `scripts/check_camera_calibration_integration.cjs`는 아래 격리 QA 서버(8012)에서 전체 페이지의 마우스·키보드 입력, 독립 잠금, 좌표 초기화와 320px 배치를 검사합니다. 모든 변경 요청과 탐지 WebSocket을 차단하며, `CALIBRATION_READONLY_BASE=http://localhost:8080`으로 미등록 상태의 실제 로컬 UI를 읽기 전용으로 확인할 수도 있습니다. 실제 마커 배치·실측 등록과 독립 정확도 검증은 설치 후 운영자가 수행합니다.

**매니퓰레이터 → 로봇 제어 또는 이동 프리셋 → 3D 보기 옵션 → 거리 표시 가이드.** 카메라에서 교시 TCP까지의 표시용 거리와 참고 객체 두께를 조정합니다. 배경 벽과 카메라→벽 거리 설정은 제공하지 않습니다. 탐지 중심이 있으면 그 좌표를 표시하고, 깊이 자료가 없는 참고 객체는 TCP 앞 20 mm에 그립니다. **입체 / 측면**으로 공구 방향과 TCP 위치를 확인하세요. TCP와 앞면 사이의 표시는 시선 방향의 깊이 차이이며 충돌 판정이 아닙니다. 네 모서리의 영상·BASE 교시값이 유효하면 작업면의 법선을 시선축으로 사용하고, 교시 전에는 예시 축인 BASE +X를 씁니다. 표시 설정은 이 브라우저에 카메라별로 저장하며 카메라가 꺼져 있을 때는 기본값을 사용합니다. 이전 카메라별 값 불러오기는 TCP 거리·참고 객체 두께와 손가락 길이를 각각 가져오며, 과거 벽 거리는 무시하고 원본 키는 변경하지 않습니다.

**이동 프리셋 → 시뮬레이션 객체 설정.** 모의 객체의 BASE 중심 XYZ와 크기 XYZ를 프리셋별·바닥/선반별로 저장합니다. 사용하지 않으면 기존 작업 객체·YOLO 탐지값과 같은 경로를 표시합니다. 모의 객체를 켜면 카메라·음성 없이 가상 경로를 확인하며 **모의 객체 · 시뮬레이션 전용**으로 표시합니다. 실제 실행은 모의 객체 설정을 무시하고 원래 작업 좌표·YOLO 확인 절차를 사용합니다. 이전 브라우저 예시는 **기존 브라우저 예시 객체 불러오기**로 모의 객체 초안에만 가져오며, 작업 좌표나 이전 원본을 덮어쓰지 않습니다. 저장·복제·재조회와 revision 충돌 검사는 다른 프리셋 설정과 같습니다.

**이동 프리셋 → 파지 자세 · 공구 방향.** 공구 A·B·C(°)는 BASE Z–Y′–Z″ 회전각이며 바닥·선반별로 독립 저장합니다. **기존 동작 유지**가 기본이어서 이전 저장 경로의 기본 자세와 YOLO 작업면의 교시 자세를 유지합니다. **직접 설정** 또는 **현재 TCP에서 공구 방향 불러오기**는 초안을 변경하고, 프리셋 저장 후 접근·파지·후퇴와 벌림 계산에 반영됩니다. 카메라 보정·다른 프리셋의 자세를 수정하지 않습니다. 임의 각도는 시뮬레이션의 IK와 실제 실행 준비 검사에서 검증합니다. `grasp_abc`와 `simulation_objects`는 각각 바닥/선반 키를 가진 프리셋 필드이며 미설정 값은 null입니다. 모의 객체는 `/presets/{id}/preview`의 `simulation_object: true`로만 컴파일하고 실제 실행 API는 이 옵션을 받지 않습니다.

**바닥 기준 탭.** 수평 바닥 한 점의 BASE Z(mm)를 입력하거나, 그 점에 공구 끝점을 맞춘 뒤 **현재 TCP에서 불러오기**를 누릅니다. **바닥 기준 저장**으로 같은 로봇의 모든 카메라에 적용하며, 카메라가 꺼져 있어도 입력·저장할 수 있습니다. 기본 바닥 Z는 0 mm이며 저장값이 있으면 그 값을 사용합니다. 입력하는 즉시 입체·측면 보기의 바닥 격자가 움직이고 변경 취소로 복원합니다. 격자는 BASE X·Y축에 평행하게 원점을 중심으로 배치하므로 교시점이나 카메라 방향을 바꾸어도 BASE 위치가 고정됩니다. 매니퓰레이터의 격자는 깊이 1,260 mm·너비 1,100 mm, 모의 객체 예시 장면은 1,800 × 1,300 mm, 그리퍼 보기는 500 × 450 mm입니다. 배경 벽 없이 로봇·카메라·상품·박스·이동 경로를 기준으로 화면을 맞추며, 바닥 바깥 부분은 화면 밖까지 이어질 수 있습니다. 선반 작업의 선반 모형과 택배 박스는 유지합니다. 카메라 모형은 본체 55 × 36 × 31, 렌즈 14 × 20 × 22의 표시용 비율이며 실측 치수가 아닙니다. TCP와 선택한 탐지 중심의 높이는 각각의 BASE Z에서 바닥 Z를 뺀 값이며, 바닥 격자는 화면 표시용입니다.

**대시보드 → 이동 프리셋.** 저장 경로를 선택하고 **경로 확인·실행**으로 해당 프리셋의 편집·승인 화면을 엽니다. 별도의 고정 17단계 실행 UI는 제공하지 않습니다. 카메라 표시 모드는 현재 장치가 지원하는 항목만 표시합니다. **상품·클래스 연결 현황**은 재고 상품과 활성 모델의 클래스 연결을 보여주며, 모델 버전과 적용은 `/training#models`에서 관리합니다.

**모델 삭제.** `/training#models`에서 모델을 선택하고 상세 카드 하단의 **삭제**를 누릅니다. 확인 창에 모델 이름·버전과 삭제 범위를 표시하며, 취소 또는 Escape로 닫을 수 있습니다. 기본 모델과 현재 적용 중인 모델은 삭제할 수 없고, 학습·모델 전환·사진 저장 중에도 삭제를 막습니다. 다른 모델을 적용한 뒤 사용하지 않는 모델을 삭제하세요. 삭제하면 모델 목록과 탐지·사진 수집·추가 학습의 선택지에서 제외하며, 재시작 후에도 적용되지 않습니다. 학습 데이터·이력·클래스 연결·원본 가중치 파일은 보존합니다. 기반 모델이 삭제되어도 후속 모델의 계보와 버전 번호는 유지합니다. `DELETE /api/models/{identifier}`는 확인한 이름을 `{ "name": "모델 이름" }`으로 전달하며, 그 사이 이름이나 적용 상태가 변경되면 재확인을 요구합니다. 테스트와 배포 확인에서는 실제 등록 모델을 삭제하지 않습니다.

**관리 → 로봇 관리 → 그리퍼.** RH-P12-RN-A를 24 V 플랜지 RS-485, Modbus RTU(지원 펌웨어, ID 1, 57600 8N1)로 연결합니다. Mac SDK 작업자를 빌드한 뒤 실행하고 매니퓰레이터 화면에서 제어권·자동 모드·STANDBY를 확인합니다. 그리퍼 화면의 **상태 읽기**에서 실제 위치와 전류를 확인하세요. **열기 (0)**, **닫기 (700)**, **지정 위치로 이동**은 장치 구동 명령입니다. 장치에 설정된 위치 제어 모드(5), 목표 전류와 전류 한계를 사용합니다. 토크·목표 위치의 쓰기 응답과 실제 위치(프레임 오프셋 290)를 검증하며 오류나 시간 초과 시 실제 상태를 확인합니다. [ROBOTIS 제어표](https://emanual.robotis.com/docs/en/platform/rh_p12_rna/)

상태 읽기와 구동 전 점검에서는 Dart 예제와 같은 FC03 요청 `01 03 01 28 00 01`에 CRC를 붙여 입력 전압 레지스터 40297(오프셋 296)을 먼저 읽습니다. 응답 대기는 1초이며 분할 수신을 모아 길이·ID·함수·바이트 수·CRC를 검증합니다. 전압은 응답값을 10으로 나눠 **입력 전압 (40297)**에 V 단위로 표시합니다. 후속 장치 점검이 실패해도 이미 확인한 전압은 표시됩니다. 변경 적용에는 `bash rosbridge/host-sdk/prepare.sh`로 SDK 작업자를 다시 빌드하고 SDK 서버와 웹 서버를 재시작해야 합니다.

플랜지 시리얼을 연 뒤 설정이 적용되도록 500 ms 기다립니다. 일시적으로 빈 수신이 반환되면 요청을 재전송하지 않고 남은 1초 동안 수신만 다시 시도합니다. 첫 전압 읽기가 응답 시간 초과로 끝나면 해당 읽기 요청만 최대 3회 시도합니다. 토크나 목표 위치 쓰기는 재전송하지 않습니다. 장치의 최소·최대 위치 레지스터(40027/40025)를 읽어 현재 위치를 검증하므로, 유효한 현재 위치가 웹 목표 범위 0–700을 넘어도 범위 안으로 이동할 수 있습니다. 오류 메시지는 통신 응답 시간 초과(레지스터와 수신 바이트 수 포함)와 목표 위치 도달 시간 초과를 구분합니다.

**그리퍼 캘리브레이션**의 실측 벌림표에서 빈 그리퍼로 두 위치 이상을 교시합니다. 각 위치에서 정지한 뒤 **최근 실측 위치 추가**를 누르고 손가락 안쪽 간격을 측정해 **벌림표 저장**을 누릅니다. 벌림표는 해당 로봇의 장치 1에 저장됩니다. 이동 입력 단위를 **벌림 (mm)**으로 선택하고 **벌림 확인 후 이동**을 누르면 저장한 표로 명령 위치와 예상 벌림을 계산합니다. **승인 후 그리퍼 이동**을 눌러야 실제로 구동하며 확인 창은 30초 후 만료됩니다. **위치값 (0–700)** 모드에서는 기존처럼 지정 정수 위치로 직접 이동합니다. 단위를 바꾸면 입력값을 비우고 이전 이동 확인을 취소합니다. **상태 읽기**로 명령 위치와 실제 위치, **벌림표 기준 추정 벌림**을 비교하세요. mm 표시는 저장된 표를 통한 추정값이며 손가락 간격을 새로 측정한 센서값은 아닙니다. 저장 전 변경사항이나 교시 범위 밖 mm 입력은 이동을 막고, 팔·그리퍼 작업 중에는 구동할 수 없습니다. 탐지 카메라의 한쪽 여유는 기존처럼 카메라별 작업 평면에 저장됩니다.

**기존 저장 작업점·자세 이관.** 기존 경유점·박스 TCP·송장 위치와 저장 자세 1~3 중 값이 있는 항목은 독립된 한 단계 프리셋으로 한 번만 이관합니다. 각 목표 좌표·관절각과 기존 프리셋 ID·revision을 보존하며 새 프리셋은 음성을 사용하지 않습니다. 적용 전 원본 JSON을 `robot/.../backups/ui-cleanup-*`에 백업합니다. 기존 `work-points`·`poses` API와 저장 파일은 호환용으로 유지합니다. 실제 이동은 프리셋 실행 대상과 일회용 승인을 사용합니다.

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

## 8. 사용자 물체 수집·학습·모델 관리

학습 기능은 [최종 설계 및 API](docs/custom-object-training-proposal.md), 검증 결과는 [학습 검증 보고서](docs/custom-object-training-validation.md)에 정리했습니다.

추가 오류 재현·수정은 [구현 후 검토 보고서](docs/post-implementation-review.md), 실제 카메라·브라우저·학습 결과와 당시 자동 검사 결과는 [직접 실행 검증 보고서](docs/direct-execution-review.md)를 참고하세요. UI 경합 검사는 Node 설치 시 `node --test tests/training_ui.test.cjs`로 실행할 수 있습니다. 서버 실행에는 Node가 필요하지 않습니다.

1. `학습 데이터 수집`에서 클래스 이름과 촬영 환경 그룹을 등록하거나 선택합니다. 같은 환경은 기존 그룹을 재사용합니다.
2. 수집 모델을 선택하고 **사진 수집 시작**을 누릅니다. 중앙에 탐지되는 물체 하나가 3프레임 연속 유지되면 기본 250ms 간격으로 원본 사진과 자동 박스를 저장합니다. 탐지되지 않으면 저장하지 않습니다.
3. **사진 저장 중지** 후 사진을 불러와 개별 또는 선택 일괄 승인/제외합니다. 유사 묶음과 박스를 확인하세요. **카메라 끄기**는 별도 버튼입니다.
4. **누적 승인 자료로 데이터셋 고정**을 누릅니다. 한 촬영 환경의 사진도 저장되며 **검증 자료 대기**로 표시됩니다. 학습하려면 같은 클래스를 다른 배경·조명에서 추가 촬영·승인한 뒤 다시 고정하세요. 이전 버전을 유지하면서 누적 승인 자료로 새 버전을 만듭니다.
5. [학습 작업](http://localhost:8080/training#jobs)에서 **데이터셋 선택**을 누릅니다. 원본 자료와 **기반 모델 · 초기 가중치**를 선택한 뒤 **기반 클래스 선택 · 새 클래스 추가**에서 최종 인식 범위를 구성합니다. **최종 클래스·자료 확인**으로 클래스별 학습·검증 장수와 새 ID를 검토하고 확인란을 선택한 뒤 **새 버전 학습 시작**을 누르세요. 기본값은 MPS·640·batch 4·50 epochs·patience 10입니다. 메모리 부족 시 batch를 낮춰 새 작업으로 재시도합니다.

기반 클래스는 검색·전체 선택·선택 해제가 가능하며, 각각 사용할 사진 라벨을 명시적으로 연결합니다. 예를 들어 COCO의 `cup`을 사진 라벨 `컵`에 연결할 수 있습니다. 기반 사용자 모델의 고정 데이터셋과 선택한 데이터셋을 합쳐 중복 sample ID를 한 번만 사용하고, 환경·이미지 해시·dHash 연결 그룹을 다시 나눕니다. 기존 스냅샷의 train/val을 단순 합쳐 같은 사진이 양쪽에 들어가지 않습니다. 사용하지 않는 클래스는 제외하고 최종 ID는 0부터 새로 발급합니다. 자료가 없는 클래스나 독립 환경이 부족한 클래스는 표시하고 학습을 차단합니다. 원본 모델과 데이터셋은 수정하지 않습니다.

`GET /api/training/class-options`는 기반 클래스와 재사용 가능한 사진 라벨을, `POST /api/training/class-preview`는 선택 클래스·분할·설정 signature를 제공합니다. 학습 요청은 `class_selection: {retained: [{source_class_id, class_uuid}], new_class_uuids: [...]}`와 `class_plan_signature`를 전달합니다. 클래스·자료·기반 가중치가 달라지면 재확인해야 합니다. 새 스냅샷과 명시적 ID·이름 매핑은 작업의 `class_plan`에 저장합니다. 이 필드 없는 기존 API는 종전의 동일 클래스 매핑 검사로 유지합니다.

고정한 Ultralytics 8.4.202의 클래스 행 이전을 사용하며, 선택한 영문 클래스 이름만 메모리에서 명시한 사진 라벨명에 연결합니다. 제외한 클래스가 같은 이름으로 잘못 이전되지 않도록 구분하고, 첫 optimizer 단계 전에 선택한 가중치와 bias를 비교합니다. 기반 파일은 변경하지 않습니다. 학습 후에는 새 검증 세트의 동일한 사진으로 기반 PT와 학습 PT를 비교해 유지 클래스별 mAP·recall 변화를 저장합니다. **모델 버전 → 클래스별 검증 성능**에서 기반 PT·학습 PT·Core ML mAP와 차이를 확인하고 별도로 모델을 적용하세요. 체크만으로 성능 유지가 보장되는 것은 아닙니다. 새 모델 ID의 상품·클래스 연결과 음성 클래스 선택도 최종 목록을 기준으로 확인합니다.
6. 학습·평가·Core ML 변환 동안 실시간 카메라를 해제합니다. 끝나면 이전 모델의 탐지를 재개합니다. 사진 저장과 새 모델 적용은 자동 실행하지 않습니다. 작업 중 카메라를 끄면 자동 재개도 취소됩니다.
7. **모델 관리**에서 왼쪽 버전을 선택하면 생성일(KST), 인식 클래스, 기반 모델, 형식별 평가 결과를 확인할 수 있습니다. **이름 변경**으로 이 버전의 표시 이름을 저장합니다. **MPS에 적용** 또는 **Core ML에 적용**을 확인하면 모든 브라우저의 탐지 모델이 전환됩니다. Core ML 변환이 실패한 버전은 MPS에서 검증된 PT를 사용할 수 있습니다.

기본 가중치에서 학습한 모델은 각각 새 계열의 `v1`입니다. 이전 사용자 모델에서 이어 학습하면 같은 계열의 다음 번호를 받습니다. **기반 모델**을 눌러 초기 가중치를 확인하세요. 과거 기록에서 작업과 해시를 대조할 수 없는 경우 **버전 미기록** 및 짧은 ID를 표시합니다. **학습 이력 및 파일 정보**에는 학습·검증 사진 수, 학습 설정과 SHA-256이 표시됩니다. mAP와 추론 p95는 표시된 검증 데이터셋 기준이며, 기본 모델은 가중치·COCO128 해시가 일치하는 로컬 벤치마크를 사용합니다.

같은 모델 ID로 표시 이름만 수정할 수 있습니다. `GET /api/models`에서 ID를 찾은 뒤 다음처럼 호출하세요. 앞뒤 공백을 제거한 이름 길이는 1~80자이며 브라우저에는 `/ws/events`로 반영됩니다.

```bash
curl -X PATCH http://localhost:8080/api/models/coco-yolov8n \
  -H 'Content-Type: application/json' -d '{"name":"기본 객체 탐지"}'
```

카메라를 끈 채 관리 화면만 시작하려면 `YOLO_CAMERA_AUTOSTART=0 bash scripts/stack.sh up coreml`을 사용하세요. 이후 **카메라 켜기**로 실시간 탐지를 시작할 수 있습니다. 기본 실행은 카메라를 자동으로 켭니다.

선택한 모델은 백엔드별로 기억합니다. `YOLO_MODEL_PATH`를 직접 export하면 시작 시 그 경로를 우선합니다. 신규 클래스 모델은 사용자 클래스 전용이며 원본 COCO80 모델을 대체하거나 합치지 않습니다. 사용자 물체의 정확도는 충분한 별도 검증 자료로 확인해야 합니다.

`state/`에 사용자 사진·SQLite DB·데이터셋·모델·로그를 보관하며 Git에서 제외합니다. `YOLO_STATE_DIR`로 경로를 변경할 수 있습니다. 서버를 종료한 뒤 전체 폴더를 백업하세요. 브라우저를 닫으면 10초 안에 **사진 저장만** 중지되고 카메라는 계속 동작합니다. 서버 시작 시 카메라는 자동으로 켜집니다. `bash scripts/stack.sh down` 또는 `bash scripts/stop.sh`는 소유 학습·변환 프로세스도 종료합니다.

### 재현 및 짧은 실장비 검증

```bash
# 학습 환경 설치 후 자동 검사
bash scripts/python.sh train -m pytest -q

# 기존 서버를 중지한 뒤 실행. 카메라를 열지 않으며 공개 10장으로 1 epoch 기능 검사
bash scripts/python.sh train -m scripts.smoke_training

# 테스트와 pip check를 통과한 환경 잠금 파일 생성
bash scripts/python.sh train -m scripts.lock_environment --backend train

# 제공한 잠금 파일로 새 학습 환경 재현
conda create -p ./.conda/reproduced-train --file conda-train.osx-arm64.lock.txt
./.conda/reproduced-train/bin/python -m pip install -r requirements-train.lock.txt
```

Smoke test의 모델은 `artifacts/training-smoke-*/`의 별도 레지스트리에만 생성되며 실제 서비스 버전 목록에 자동 추가되지 않습니다. 이 모델의 정확도 수치는 사용자 물체 학습 성능으로 해석하지 않습니다.

### 한 환경의 데이터셋 저장과 학습 조건

`POST /api/datasets`는 요청 본문 없이 누적 승인 자료를 저장합니다. 승인 사진이 한 환경 그룹에만 있으면 **201 Created**, `status: "awaiting_validation"`으로 저장합니다. 모든 이미지·라벨을 train에 보관하고 val은 비워 둡니다. 예를 들어 한 환경의 승인 사진 18장이면 `counts: {"train": 18, "val": 0}`입니다. 이 버전은 목록에서 확인할 수 있지만 학습 버튼은 비활성화되고 학습 API는 422를 반환합니다.

여러 환경에서 수집했다면 환경 그룹과 동일·유사 사진을 분리하지 않고 묶어서 train/val을 구성합니다. 모든 클래스가 양쪽에 있으면 `status: "ready"`가 됩니다. 여러 환경이 유사 사진으로 연결되거나 특정 클래스의 독립 그룹이 부족해 분할할 수 없을 때는 기존처럼 422와 원인을 표시합니다. 승인 사진이 없거나 파일이 누락·변경된 경우에도 저장하지 않습니다.

연속 촬영한 거의 같은 사진을 학습과 검증 양쪽에 넣으면 처음 보는 장면에서의 성능을 과대평가할 수 있습니다. 같은 클래스를 유지한 채 배경·조명·각도를 바꾸고 **새 환경 등록 → 사진 수집 → 저장 중지 → 사진 불러오기 → 승인 → 누적 승인 자료로 데이터셋 고정**을 진행하세요. 그룹 이름만 추가하거나 같은 사진을 복제하는 것으로는 독립 검증 자료가 생기지 않습니다.

### SQLite 메타데이터 이전

서버는 `state/metadata.sqlite3`의 `PRAGMA user_version`으로 스키마를 구분합니다. 버전 5는 학습 작업의 클래스 선택·ID 매핑·자료 signature를 `training_jobs.class_plan`에 저장합니다. 버전 4의 모델 삭제 시각(`models.deleted_at`)과 기존 모델·클래스·계보·파일, 버전 3의 고객·주문·사용자별 RFID 할당(`customer_rfid`)도 유지합니다. 상품과 수량은 `products`, 주문 품목은 `order_items`에서 조회하며 `inventory` 뷰가 보유·예약·가용 수량을 제공합니다. 수집한 사진은 `samples`, 학습에 사용한 스냅샷은 `dataset_items`, 모델 클래스 연결은 `product_class_bindings`에 있습니다.

상품, 주문, 주문 품목, 학습 샘플, 모델 등 독립 레코드의 내부 `id`는 SQLite가 `INTEGER PRIMARY KEY AUTOINCREMENT`로 발급합니다. 테이블마다 번호가 증가하며, 삭제한 행의 번호는 자동 발급 시 재사용하지 않습니다. 외래 키는 부모 행의 정수 키를 참조합니다. 예를 들어 `order_items.product_id`는 `products.id`를 가리키고, 화면에는 상품의 `sku`가 표시됩니다. 모델의 `class_id`는 가중치에 정의된 번호이며, 모델과 클래스의 조합으로 상품을 연결합니다. 기존 API와 파일 경로에는 기존 공개 식별자를 사용합니다.

버전 0~4 서버를 종료하고 새 서버를 시작하면 SQLite 백업 API가 같은 데이터 디렉터리의 `backups/`에 커밋된 WAL 내용을 포함한 `metadata-v{이전 버전}-*.sqlite3` 백업을 만듭니다. 변환·원본 대조·무결성 검사는 하나의 트랜잭션으로 실행됩니다. 실패하면 원본 테이블을 보존하고 시작을 중단합니다. 오류에 표시된 레코드를 확인한 뒤 재시작하면 다시 시도합니다. 구버전으로 복구할 때는 서버를 종료하고 현재 DB와 WAL·SHM을 별도 보관한 뒤 백업을 `metadata.sqlite3`로 복원하고 구버전 코드를 실행합니다. 백업 이후의 쓰기는 별도 보관한 DB에 남습니다.


### 기존 17단계 API 호환

기존 `GET/PUT /api/robot/pick-scenario`, `/pick/scenario/preview`, `/pick/prepare/{preview,approve}`, `/pick/{preview,approve}`는 기존 연동용으로 유지합니다. 웹의 고정 단계 편집기·별도 수동 이송·단일 지점 시뮬레이터는 이동 프리셋으로 통합했습니다. 서버의 카메라 재검증, SDK 세션·설정 버전 검증과 중단 처리는 그대로 유지합니다. 자동 검증은 모의 SDK로 수행하며 실제 장비를 구동하지 않습니다.

### 이동 프리셋과 연속 음성 명령

[이동 프리셋](http://localhost:8080/robot#work-points-title)에서 여러 경로를 독립 저장합니다. 처음 열 때 기존 로봇 JSON 설정을 `robot/backups/preset-migration-*`에 복사하고 `motion-presets.json`에 **기존 이동 경로**를 생성합니다. 기존 `pick-scenario.json`과 YOLO 작업 API는 유지하며, 새 프리셋을 수정해도 기존 YOLO 경로를 덮어쓰지 않습니다. 시안의 예시 좌표는 이관하지 않습니다.

- 관절·직선·원호 이동, 그리퍼, 0.1~600초 대기, 자동 파지·박스 놓기 묶음을 추가·복제·재정렬합니다. 프리셋은 1~100개 실행 동작을 포함합니다. 묶음의 내부 순서와 객체 기준 목표는 고정하며 실행 구간은 묶음 경계에서 지정합니다.
- 객체·경유·박스 TCP와 단계별 속도를 프리셋마다 저장합니다. 편집기 안의 **상품·접근 설정**에서 선택한 프리셋의 바닥·선반 접근 거리와 반전 방향을 편집합니다. 장비의 벌림표·접촉 전류·작업면 보정은 공통입니다. **택배 박스 크기·위치 복사**는 크기·중심만 복사하고 출처 버전을 표시합니다. 프리셋별 놓기 TCP는 덮어쓰지 않습니다.
- 실행 카드의 **서비스 연결 · 프리셋 준비 상태**에서 카메라·음성 서비스와 실제 로봇 연결을 구분하고 **상태 다시 확인**으로 갱신합니다. 미설정된 1차 경유 관절각·박스 놓기 TCP는 **입력 위치로 이동**으로 해당 항목을 펼칩니다.
- 대기·경유 관절각은 한 단계의 저장 관절 프리셋, 놓기 TCP는 한 단계의 저장 TCP 프리셋을 명시적으로 선택해 불러옵니다. 원본 revision을 확인하고 좌표만 초안에 복사하며 **프리셋 저장** 전에는 실제 저장값을 바꾸지 않습니다. 장비가 연결되면 **현재 TCP를 놓기 목표로 불러오기**로 현재 좌표만 읽을 수 있습니다. 연결이 없을 때 예시 좌표로 채우지 않습니다.
- 로봇이 미연결이어도 **시뮬레이션으로 미리보기**에서 가상 테스트를 할 수 있습니다. 좌표가 없는 경우 **예시 17단계 체험**의 바닥·선반 예시를 선택하세요. 기존 `/pick/scenario/preview`의 `example: true`로 별도 경로를 계산하며, 프리셋이나 작업 좌표를 채우거나 저장하지 않습니다. 카메라·마이크·실측 벌림표가 없어도 예시를 재생하고 종료할 수 있습니다. YOLO 실제 탐지 경로는 기존 클래스 선택 절차를 유지합니다.
- 좌표를 직접 입력한 경로는 저장 전에도 시뮬레이션할 수 있으며 **이 단계 시뮬레이션**은 다른 경유점·박스 좌표가 비어 있어도 선택한 동작만 검증합니다. 실제 실행과 YOLO 음성 선택에는 저장된 프리셋을 사용합니다. 로봇이 미연결이면 실제 실행 버튼과 현재 TCP 불러오기는 비활성화됩니다.
- 이동 프리셋의 3D 박스는 선택한 프리셋의 크기·중심으로 표시합니다. **택배 박스 설정** 탭은 장비 공통 박스를 표시합니다. 시뮬레이션 중에는 실제 그리퍼 피드백 패널을 숨기고 가상 벌림·상품 상태를 표시하며, 프리셋 화면의 카메라 교시 전용 안내는 숨깁니다.
- 실행 카드의 진행 막대로 위치를 확인하면 재생이 일시정지됩니다. **계속 재생**, 가상 파지·놓기 확인과 **가상 재생 종료**를 같은 카드에서 조작합니다. 계산·재생 중에는 중복 시작을 막고, 예시 요청 대기·완료·오류에서도 종료할 수 있습니다. 입력값·프리셋·실행 대상을 변경하면 가상 재생을 종료합니다. 장비 피드백이 없을 때는 기본 관절 자세에서 시작한다고 표시합니다.
- 3D의 **재생 제어로 이동**은 프리셋 선택과 재생 상태를 유지하며 실행 카드로 이동합니다. `/robot?preset={id}#preset-execution` 북마크도 같은 카드를 엽니다. 다른 화면에서 음성 실행 대상을 바꾸면 현재 화면의 시작 버튼과 단계 실행 버튼 문구도 함께 갱신됩니다.
- 음성 명령은 여러 문장을 등록하며 공백·문장부호·영문 대소문자를 정규화한 뒤 정확히 비교합니다. 중복 문장과 `로봇 실행`, `로봇 취소`, `로봇 중단`, `중단`, `음성 대기 종료`는 예약어입니다. 새 프리셋과 복사본은 음성 사용이 꺼져 있습니다.
- 수동·음성 시작은 하나의 **실행 대상** 선택을 공유하고 기본값은 시뮬레이션입니다. **실제 로봇**을 명시적으로 선택하고 **음성 대기 시작**을 눌러야 마이크를 사용합니다. 프리셋별 화면 승인 또는 `로봇 실행` 음성 재확인이 필요하고, 확인은 30초 뒤 만료됩니다. 접힌 **고급 · 문장 입력 테스트**는 실제 장비 승인을 생성하거나 음성 재확인을 대신하지 않습니다.
- 연속 청취는 Mac의 기존 한국어 인식 프로그램을 재사용하며 주문·재고 대화와 동시에 마이크를 점유하지 않습니다. 청취 종료는 마이크와 미승인 요청만 종료합니다. 진행 중인 로봇은 좌측 **로봇 중단** 또는 실제 마이크의 `로봇 중단`으로 별도 중단하며 자동 재개하지 않습니다.
- 그리퍼의 벌림 기준은 직접 입력·객체 권장 벌림·대기 벌림 중 선택합니다. 자동 기준은 객체 크기나 대기 벌림을 바꾸면 다시 계산됩니다. 음성 세션의 종료 응답이 확인되지 않으면 **음성 대기 종료**로 재시도하며, 이전 세션의 종료 요청은 새 마이크 세션을 닫지 않습니다.

Mac 음성 서비스는 다음과 같이 실행합니다. 마이크 권한과 한국어 모델이 준비되지 않았으면 화면의 오류 안내를 따르세요. 아래 실행은 카메라를 자동 시작하지 않으며 마이크도 **음성 대기 시작**을 누를 때 열립니다.

```bash
YOLO_VOICE_ENABLED=1 YOLO_CAMERA_AUTOSTART=0 bash scripts/stack.sh up coreml
```

새 API는 `/api/robot/presets`의 목록·생성, `/{id}` 조회·수정, `/{id}/copy`, `/{id}/preview`와 `/{id}/execution-preview`, `/executions/approve`입니다. 실제 실행은 저장 revision과 일회용 승인에 연결합니다. 진행 상태는 기존 `/api/robot/pick/scenario/status`와 `/pick/moves/{approval_id}`에서 확인합니다. `/api/robot/preset-voice/{status,start,stop,test,approve,cancel}`는 명령 대기와 확인을 관리합니다. Mac의 `/api/voice/robot/events`는 세션·순번이 있는 최종 인식 이벤트를 읽기 전용으로 제공합니다.

격리 UI 검증은 임시 `ROBOT_STATE_DIR`, `ROBOT_ROS_PC_IP=''`, `ROBOT_ACCESS_BACKEND=ros`로 포트 8012에 로봇 웹을 실행한 뒤 `scripts/check_robot_presets_ui.cjs`를 사용합니다. 이 검증은 실제 장비·마이크 명령을 차단하며 프리셋 저장, 단계·묶음 편집, 음성 문장 테스트, 가변 경로 재생, 모의 실행 승인, 입력 잠금과 모바일 배치를 검사합니다. `tests/test_preset_regressions.py`는 수동 목표 이관, 중단과 늦은 음성 응답의 경합, 마이크 소유권·종료 재시도를 모의 장비로 확인합니다.

### 프리셋에서 YOLOv8 탐지값 선택

이동 프리셋의 **객체 정보 출처**에서 `저장한 객체 좌표` 또는 `YOLOv8 탐지값`을 선택합니다. 기존 프리셋의 기본값은 저장 좌표입니다. 기존 객체 좌표·박스 TCP·경유점은 전환하거나 탐지해도 덮어쓰지 않습니다.

- YOLO 모드는 최소 신뢰도, 바닥·선반 작업 영역, 대상 선택 조건을 프리셋마다 저장합니다. 대상 클래스는 매 실행 전에 실제 마이크로 선택합니다. 기존에 저장한 클래스는 실행 대상으로 자동 사용하지 않으며 이번 음성 선택도 프리셋에 덮어쓰지 않습니다. 카메라 시작과 작업면 보정은 기존 화면에서 수행합니다.
- **시뮬레이션 시작** 또는 **실제 프리셋 실행**을 누르면 실행 카드 안에 현재 활성 모델의 허용 클래스 목록을 표시하고 음성 대기를 시작합니다. 목록의 클래스 이름 한 개를 말하면 이름을 정규화해 정확히 비교하고 최신 탐지에서 파지 TCP·평면상 크기·권장 벌림을 계산합니다. 미등록 이름, 복수 클래스, 정규화 후 이름이 중복된 클래스는 거절합니다. 같은 클래스의 후보가 한 개일 때만 자동 확정하거나 항상 화면에서 선택하도록 설정할 수 있습니다. 미탐지·영상 가장자리·보정 누락·영역 겹침 등은 실행 승인을 만들지 않습니다.
- 자동 파지 묶음 한 개가 확정 대상을 사용합니다. 접근·파지·후퇴와 권장 벌림, 놓기 시 벌림 복원을 계산하며 경유점·박스 TCP·복귀 자세는 유지합니다. 단안 영상으로 알 수 없는 두께·깊이는 프리셋의 저장값을 사용합니다. 구간 실행도 YOLO 대상 확인을 거쳐야 합니다.
- 실제 실행은 저장된 대기 관절각과 대기 벌림에서 대상을 확인해야 합니다. **인식 자세 준비**는 대상 탐지와 분리된 일회용 화면 승인으로 자세·벌림만 준비합니다. 완료 후 대상을 다시 확인해 경로를 승인합니다. YOLO 대상이 없을 때 저장 객체 좌표로 자동 대체하지 않습니다.
- 탐지 결과는 저장 프리셋과 분리된 30초 스냅샷입니다. 승인에는 프리셋 내용·revision, 카메라 세션·입력·해상도, 모델, 작업면 보정, 공통 장비 설정과 중단 세대를 연결합니다. 실행 시작·접근·하강 전에 같은 대상인지 다시 확인하며 파지 접촉이 끝난 뒤에는 카메라 없이 나머지 이송을 수행합니다. 대상 이동·필요 벌림 증가·모델 변경·통신 단절로 중단한 작업은 자동 재개하지 않습니다.
- 등록한 프리셋 음성 명령도 **클래스 발화 → YOLO 대상 확인 → 최종 승인** 순서를 따릅니다. 복수 후보는 실행 카드에서 선택한 뒤 화면 승인 또는 새로운 `로봇 실행` 발화로 재확인합니다. 클래스 선택과 승인은 각각 30초 이내에 진행하며 취소·청취 종료·중단·설정 또는 모델/클래스 목록 변경 시 이전 선택을 폐기합니다. 새 실행과 실행 범위·대상 변경에는 새 클래스 발화가 필요합니다. **문장 입력 테스트**에는 클래스 이름을 별도로 입력하며 시뮬레이션 경로만 계산합니다. 실제 승인이나 마이크의 확인 대기를 변경하지 않습니다.

`GET /api/robot/presets/sources/yolo`는 활성 모델의 클래스 목록을 조회합니다. `POST /api/robot/preset-voice/class-request`에 `preset_id`, 저장 `revision`, `target`(`simulation`/`hardware`), 선택적인 `step_id`를 보내면 마이크 클래스 선택을 시작합니다. 클래스 ID나 인식 문장은 이 API에서 받지 않으며 Mac 서비스의 최종 인식 이벤트만 선택 증거를 만듭니다. `execution-preview`는 같은 프리셋·실행 대상·범위·청취 세션에 연결된 음성 선택과 서버 소유 `snapshot_id`·`candidate_id`가 필요하고, 실제 승인은 일회용입니다. 모델과 클래스 목록은 승인 직전 다시 확인합니다. 음성 확인 방식은 일반 승인 API로 우회할 수 없습니다. `recognition-preview`는 별도의 인식 자세 준비 승인을 만듭니다. 후보 선택은 `/api/robot/preset-voice/select`를 사용합니다. `/api/robot/preset-voice/test`의 `class_name`은 시뮬레이션 전용이며 실제 실행 증거를 만들지 않습니다. 기존 `detections`와 `preview`의 읽기 전용 진단은 유지하고 클라이언트 XYZ 입력으로 실제 목표를 만들지 않습니다.

YOLO UI 전체 검증은 다음 격리 서버에서 실행합니다. 이 서버는 모의 카메라·모의 음성 인식을 사용하며 SDK와 실제 실행 API를 차단합니다. 두 번째 명령은 별도 터미널에서 실행합니다.

```bash
TASK_QA_DIR="$(mktemp -d /tmp/preset-yolo-qa.XXXXXX)"
ROBOT_STATE_DIR="$TASK_QA_DIR" ROBOT_ROS_PC_IP='' ROBOT_ACCESS_BACKEND=ros \
  .conda/coreml/bin/python -m uvicorn tests.preset_yolo_qa:create_qa_app --factory --host 127.0.0.1 --port 8012
node scripts/check_preset_yolo_ui.cjs
```

`tests/test_preset_yolo.py`는 탐지값 반영, 저장값 보존, 수동 선택, 구간 실행, 인식 자세 준비, 승인·중단 경합, 파지 전 재검증과 파지 후 카메라 독립 실행을 가짜 SDK로 확인합니다.

UI 통합 회귀 검증은 `scripts/check_robot_presets_ui.cjs`, `scripts/check_preset_yolo_ui.cjs`, `scripts/check_gripper_test_ui.cjs`, `scripts/check_ui_cleanup.cjs`로 수행합니다. 앞의 두 스크립트는 격리 서버를 사용하고 나머지는 네트워크 전체를 모의 응답으로 대체합니다. `tests/test_robot_presets.py`는 이관 대상 6종의 값 보존, 백업·재시작·잘못된 원본의 비파괴 실패를 검증합니다.

`scripts/check_preset_controls_ui.cjs`는 격리 서버에서 다중 화면의 실행 대상 동기화, 일시정지 상태의 재생 제어 링크·새로고침, 미설정 좌표 안내, 명시적 저장 자세/TCP 복사, 현재 TCP 읽기와 저장 분리, 원본 revision 충돌, 서비스 단절·복구, 모바일 배치를 검증합니다. 모든 SDK·마이크 요청은 모의 처리합니다. 반복 재생 완료 검사는 재생 회차와 상태를 함께 비교하여 이전 재생의 완료 표시를 소비하지 않습니다.

프리셋 설정 재배치의 회귀 검사는 `tests/test_preset_settings.py`와 `scripts/check_preset_settings_ui.cjs`로 수행합니다. 오프라인 가상 테스트의 회귀 검사는 같은 8012 QA 서버에서 `scripts/check_preset_offline_ui.cjs`로 수행하며, 카메라·음성·SDK 연결을 모두 차단하고 바닥·선반 전체 재생, 일시정지·위치 확인·취소, 저장 전 단일 단계, 320px 배치와 저장값 보존을 확인합니다. 화면 검사는 SDK·카메라·마이크가 차단된 8012 QA 서버에서 실행하며 이전 브라우저 값 불러오기, 독립 저장·복제, 실제 실행과 모의 객체 분리, 320px 배치를 확인합니다.
