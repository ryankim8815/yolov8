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

브라우저에서 [패킹 대시보드](http://127.0.0.1:8000)를 엽니다. 대시보드의 탐지 카메라는 활성 모델이 표시한 실시간 영상과 측정된 FPS·서버 지연 p95·탐지 개수를 보여줍니다. 영상 아래 **탐지 클래스**에서 클래스별 수량을 확인할 수 있습니다. 클래스명을 누르면 영상에서 해당 객체의 상자가 강조되고 객체별 신뢰도가 표시됩니다. 다시 누르면 강조가 해제됩니다. 카메라가 꺼져 있으면 **카메라 설정 열기 → 카메라 켜기**로 시작합니다.

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
| `GET /api/detections/latest` | 최신 결과, 미준비·stale 시 503 |
| `GET /stream.mjpg` | 박스가 포함된 MJPEG |
| `WS /ws/detections` | `event=detections` 결과와 `event=status` 상태 메시지 |
| `WS /ws/detections?preview=true` | 미리보기 프레임마다 탐지 JSON과 같은 프레임의 JPEG 바이너리를 차례로 전송 |

탐지 결과의 `xyxy`는 원본 이미지 좌상단 기준 픽셀 좌표입니다. `session_id`와 `frame_id`로 결과를 식별합니다. 물체가 없으면 `objects: []`를 전송합니다. 시각은 UTC, 지연 측정은 단조 증가 시계를 사용합니다. 표시된 서버 지연에는 센서 내부 대기와 브라우저 표시 지연이 포함되지 않습니다.

### 두산 E0509 모니터링과 자세 테스트

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
5. 다른 터미널에서 다음 명령으로 Mac의 경로·소켓과 웹에서 보이는 세션이 같은지 확인할 수 있습니다. `worker_pid`는 `lsof`의 `blink` PID에 해당합니다. 포트 12345 포워딩은 필요 없습니다.

   ```bash
   route -n get 110.120.1.63
   lsof -nP -iTCP@110.120.1.63:12345 -sTCP:ESTABLISHED
   curl -fsS http://localhost:8080/api/robot/host-access/status
   ```

`Ctrl+C`로 Mac 서버를 종료하면 화면의 보유 표시가 해제됩니다. 연결 단절 후에는 유선 경로를 다시 확인하고 새 세션으로 연결하며 이전 승인을 재사용하거나 자동 요청하지 않습니다. ROS 제어로 돌아갈 때는 Mac 서버를 먼저 종료하고 `.env`를 `ROBOT_ACCESS_BACKEND=ros`로 바꾼 뒤 `docker compose up -d robot-web`을 실행하세요. [두산 SDK의 제어권 콜백 예제](https://doosanrobotics.github.io/doosan-robotics-api-manual/GL013301/tutorials/scenarios/1_minimal_motion_sample.html)

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

**운영 → 로봇 모니터링 → 주요 좌표값 설정.** **택배 박스 위치**와 **택배 박스의 송장 위치 (RFID 스캔)**를 각각 설정합니다. 두 위치 모두 로봇 베이스(BASE)를 기준으로 공구 끝점(TCP)의 X·Y·Z(mm)와 A·B·C(도, Euler ZYZ)를 저장합니다. 송장 위치는 RFID 리더로 태그를 읽을 때의 공구 위치와 방향입니다.

좌표를 직접 입력하거나, 공구를 원하는 위치에 멈춘 뒤 해당 항목의 **현재 위치 불러오기 → 좌표 저장**을 누르세요. 불러오기는 기본 Compose의 관절 모니터를 통해 제어기의 Modbus 레지스터 400~405를 읽으며, SDK 제어권이 필요 없습니다. 로봇 미연결 시에도 알고 있는 좌표를 입력하고 저장할 수 있습니다. 저장값은 제어기 IP·포트·ROS 네임스페이스별로 보관하며 화면 새로고침과 서버 재시작 후에도 유지됩니다. 이 화면은 로봇을 이동시키거나 RFID 스캔을 실행하지 않습니다. [두산 Modbus TCP I/O 표](https://cobot-smx.jp/info/wp-content/uploads/2023/08/Doosan_Robotics_Modbus_TCP_Slave_IO_Table.pdf)

**운영 → 로봇 모니터링 → 자세 테스트.** 자세 1·2·3에 각각 J1~J6 **절대 관절각(°)**을 입력하고 저장합니다. 초기 슬롯은 비어 있습니다. 저장값은 Compose 자세 볼륨에서 제어기 IP·포트·네임스페이스별로 보관됩니다. 저장과 이동은 별도 버튼입니다.

**저장한 자세로 이동**을 누르면 확인창에서 6개 목표각과 속도를 확인합니다. Mac SDK에서는 이 세션이 제어권을 보유하고 자세가 저장되면 확인창을 열 수 있습니다. `SAFE_OFF` 또는 수동 모드에서는 현재 상태를 표시합니다. 실물 제어기가 `STANDBY`·자동 모드일 때 확인을 누르면 같은 세션에서 `movej`를 한 번 호출합니다. ROS 모드에서는 서버가 최신 6축 데이터와 `/<namespace>/system/get_robot_state`의 STANDBY 응답을 확인한 뒤 `/<namespace>/motion/move_joint`에 한 번 요청합니다. 속도는 10 °/s, 가속도는 10 °/s²입니다. 위치 범위 검사는 모델의 관절 한계를 기준으로 하며 실제 작업 공간과 충돌 여유는 작업자가 확인해야 합니다. 수신 지연, 표시 일시정지 또는 연결 끊김 시 화면에서 이동을 시작할 수 없습니다. 드라이버 응답에 따라 완료·실패·결과 미확인이 표시됩니다. 통신이 끊기면 마지막 값을 보존하며 이동을 자동 재전송하지 않습니다. **표시 일시정지**는 화면 갱신에만 적용됩니다.

`GET /api/robot/status`에서 연결, 토픽, 저장 자세와 최근 명령 결과를 확인할 수 있습니다. 관절 데이터는 rad에서 °로 변환하고 화면 수신율은 최대 10 Hz입니다. 관절 수신이 끊기면 드라이버 로그에서 SDK 연결 종료 여부를 확인하세요. [두산 MoveJoint 정의](https://github.com/DoosanRobotics/doosan-robot2/blob/dade65d3a99dd8b29d8eca3689a4ead74f228d77/dsr_msgs2/srv/MoveJoint.srv) · [rosbridge 통신 규약](https://github.com/RobotWebTools/rosbridge_suite/blob/ros2/ROSBRIDGE_PROTOCOL.md)

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
5. [학습 작업](http://localhost:8080/#jobs)에서 **데이터셋 선택**을 누릅니다. 후보별 촬영 환경 수와 클래스별 학습·검증 장수를 확인한 뒤 **이 데이터셋 선택**을 누르세요. 화면에 표시된 인식 클래스와 초기 가중치, batch/epochs/patience를 확인하고 **새 버전 학습 시작**을 누릅니다. 기본값은 MPS·640·batch 4·50 epochs·patience 10입니다. 메모리 부족 시 batch를 낮춰 새 작업으로 재시도합니다.
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

서버는 `state/metadata.sqlite3`의 `PRAGMA user_version`으로 스키마를 구분합니다. 버전 3은 버전 2의 고객·주문을 보존하고 사용자별 RFID 할당을 `customer_rfid`에 저장합니다. 상품과 수량은 `products`, 주문 품목은 `order_items`에서 조회하며 `inventory` 뷰가 보유·예약·가용 수량을 제공합니다. 수집한 사진은 `samples`, 학습에 사용한 스냅샷은 `dataset_items`, 모델 클래스 연결은 `product_class_bindings`에 있습니다.

상품, 주문, 주문 품목, 학습 샘플, 모델 등 독립 레코드의 내부 `id`는 SQLite가 `INTEGER PRIMARY KEY AUTOINCREMENT`로 발급합니다. 테이블마다 번호가 증가하며, 삭제한 행의 번호는 자동 발급 시 재사용하지 않습니다. 외래 키는 부모 행의 정수 키를 참조합니다. 예를 들어 `order_items.product_id`는 `products.id`를 가리키고, 화면에는 상품의 `sku`가 표시됩니다. 모델의 `class_id`는 가중치에 정의된 번호이며, 모델과 클래스의 조합으로 상품을 연결합니다. 기존 API와 파일 경로에는 기존 공개 식별자를 사용합니다.

버전 0 또는 1 서버를 종료하고 새 서버를 시작하면 SQLite 백업 API가 같은 데이터 디렉터리의 `backups/`에 커밋된 WAL 내용을 포함한 백업을 만듭니다. 파일명은 각각 `metadata-v0-*.sqlite3`, `metadata-v1-*.sqlite3`입니다. 변환·원본 대조·무결성 검사는 하나의 트랜잭션으로 실행됩니다. 실패하면 원본 테이블을 보존하고 시작을 중단합니다. 오류에 표시된 레코드를 확인한 뒤 재시작하면 다시 시도합니다. 구버전으로 복구할 때는 서버를 종료하고 현재 DB와 WAL·SHM을 별도 보관한 뒤 백업을 `metadata.sqlite3`로 복원하고 구버전 코드를 실행합니다. 백업 이후의 쓰기는 별도 보관한 DB에 남습니다.
