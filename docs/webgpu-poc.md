# YOLOv8n Chrome WebGPU PoC와 MPS/Core ML 비교

2026-11-13 KST에 실제 Mac과 Chrome에서 구현·측정했다. **브라우저 추론은 가능하며, 이 장비에서는 WebGPU가 MPS보다 빨랐고 Core ML이 가장 빨랐다.**

## 구현

- `webgpu/`: 프레임워크 없이 실행하는 브라우저 UI. 샘플 이미지, 사용자 이미지, 카메라 탐지, 벤치마크와 JSON 다운로드.
- `scripts/prepare_webgpu.py`: 기존 YOLOv8n 가중치의 사본을 FP32 ONNX로 변환. opset 17, 정적 640 입력, raw `[1,84,8400]`, NMS 제외. COCO128을 OpenCV로 한 번 디코딩해 공통 RGBA fixture를 생성한다.
- `scripts/serve_webgpu.py`: 기본 `127.0.0.1:8018`의 정적 서버. UI와 준비된 모델·런타임·fixture만 제공하고 디렉터리 목록을 차단한다. 운영 애플리케이션을 import하거나 카메라·로봇을 열지 않는다.
- ONNX Runtime Web 1.23.2를 로컬에서 제공한다. 준비 시 공식 npm 패키지의 SHA-512 integrity를 검증하고, 브라우저에서는 모델·fixture SHA-256을 검증한다. 실행 중 외부 CDN은 사용하지 않는다.
- 브라우저 전처리: 114 패딩 LetterBox, RGB/255, FP32 NCHW. 후처리: 클래스별 최고 점수, confidence 필터, class-aware NMS, 원본 좌표 복원·클리핑. YOLOv8 출력에는 별도 objectness 채널이 없다.
- WebGPU EP를 명시하고 GPU 미지원 시 오류를 표시한다. 애플리케이션의 WASM 자동 재시도는 없다. ORT가 일부 shape/control 연산을 CPU에서 처리할 수 있으므로 모든 연산이 GPU에서 실행됐다는 의미는 아니다.
- 실제 카메라는 사용자가 시작한 경우에만 요청한다. 프레임을 고정해 탐지 상자와 표시 이미지가 일치하도록 하고, 종료·탭 숨김·페이지 이탈 시 트랙을 정리한다.

## 측정 조건

| 항목 | 조건 |
|---|---|
| 장비 | Apple M1 Pro, 메모리 16 GiB, macOS 27.0, arm64 |
| 브라우저 | Google Chrome 157.0.8103.52, headed, Playwright 1.57.0의 별도 프로필 |
| WebGPU 확인 | vendor `apple`, architecture `metal-3`, `isFallbackAdapter=false` |
| 런타임 | ORT Web 1.23.2 / PyTorch 2.7.0 / Core ML Tools 9.0 / Ultralytics 8.4.202 |
| 모델 | 동일 YOLOv8n 체크포인트. WebGPU·MPS FP32 / 기존 Core ML FP16, `CPU_AND_NE` |
| 공통 설정 | 640×640, batch 1, rect=false, conf 0.25, IoU 0.45, max_det 100 |
| 이미지 | 정렬된 COCO128 128장. 동일 RGBA bytes를 브라우저와 native에서 사용 |
| 반복 | 백엔드마다 30회 워밍업 후 256회 × 3라운드. 매 라운드 이미지 순서는 동일 |
| 실행 순서 | WebGPU → MPS → Core ML, 백엔드 간 동시 실행 없음 |
| 지연 구간 | 전처리 + 추론 + CPU 결과 읽기 + NMS + 원본 좌표 복원 |
| 제외 | 이미지 다운로드·JPEG 디코딩·모델 로딩·카메라 캡처·영상 전송·화면 그리기 |

Native는 공통 RGBA를 BGR로 변환해 메모리에 보관한 뒤 기존 `Detector.predict`를 그대로 측정했다. MPS는 기존 코드가 CPU 결과 materialization과 `torch.mps.synchronize()`를 수행한다. 브라우저도 `session.run`과 CPU 출력 읽기가 완료된 뒤 시간을 기록한다. 따라서 GPU 명령 제출 시간만 측정한 수치가 아니다.

FP32 ONNX 크기는 **12,824,165 bytes (약 12.23 MiB)**다. 원본 체크포인트 SHA-256은 `f59b3d833e2ff32e194b5bb8e08d211dc7c5bdf144b90d2c8412c47ccfc83b36`이다. Core ML 모델의 원본 체크포인트와 artifact hash도 기존 manifest에 대조했다.

## 성능 결과

768개 측정 샘플을 합친 통계다. 처리량은 `1000 / 평균 predict_ms`로 계산한 순차 추론 처리량이며, 카메라 FPS가 아니다.

| 백엔드 | 평균 ms | p50 ms | p95 ms | 추론 처리량 images/s |
|---|---:|---:|---:|---:|
| Chrome WebGPU / ONNX FP32 | **24.27** | 24.02 | 25.67 | **41.21** |
| PyTorch MPS FP32 | 30.78 | 28.28 | 44.74 | 32.49 |
| Core ML FP16 / CPU_AND_NE | **7.27** | 7.16 | 7.82 | **137.55** |

WebGPU의 평균 지연은 전체 MPS 측정 대비 **21.2% 낮았다**. Core ML의 평균 지연은 WebGPU의 약 **1/3.34**였다. 이는 이 장비의 기존 실행 경로를 비교한 결과이며, 정밀도·런타임·후처리 구현이 모두 같은 순수 GPU 커널 비교는 아니다. `CPU_AND_NE`는 CPU/Neural Engine 사용을 허용하며 전체 모델의 Neural Engine 실행을 보장하지 않는다.

| 라운드 | WebGPU 평균 / p95 ms | MPS 평균 / p95 ms | Core ML 평균 / p95 ms |
|---|---:|---:|---:|
| 1 | 24.56 / 26.00 | 36.97 / 84.09 | 7.30 / 7.80 |
| 2 | 24.27 / 25.79 | 27.86 / 33.59 | 7.30 / 7.95 |
| 3 | 23.98 / 25.38 | 27.51 / 31.64 | 7.22 / 7.72 |

MPS 첫 라운드의 긴 지연을 제거하지 않았다. 원인은 이 측정만으로 확정하지 못했다. MPS의 후반 2개 라운드 평균은 약 27.69ms이므로 WebGPU의 우위를 모든 환경에서 21.2%로 일반화하면 안 된다. 기기 부하·온도·전력 상태를 통제한 장시간 실험은 별도로 필요하다.

WebGPU 평균 시간 구성은 전처리 **2.34ms**, ORT 실행·CPU 결과 읽기 **21.11ms**, 후처리 **0.82ms**였다. 세션 생성은 약 427ms, 로컬 모델 fetch·hash 검증은 약 90ms였지만, JS/WASM 로딩과 첫 실행의 커널 초기화 전체를 포함한 cold-start 지연은 아니다.

## 탐지 결과 일치

성능 측정 외에 각 이미지의 탐지 결과를 저장했다. MPS의 597개 탐지를 기준으로, 동일 이미지·동일 클래스·박스 IoU ≥ 0.9의 일대일 대응을 계산했다.

| 비교 | 대응 개수 | MPS 탐지 대비 대응률 | 대응한 박스의 평균 IoU | 평균 confidence 절대 차이 |
|---|---:|---:|---:|---:|
| WebGPU ↔ MPS | 596 / 597 | **99.83%** | 0.99913 | 0.00078 |
| Core ML ↔ MPS | 589 / 597 | 98.66% | 0.99091 | 0.00572 |

WebGPU와 MPS는 `000000000143.jpg`에서 각각 1개가 대응되지 않았다. Canvas와 OpenCV의 리사이즈 차이 및 런타임 수치 차이를 포함한 결과다. **이 대응률은 정답 정확도나 mAP가 아니다.** COCO128은 학습 유래 표본이므로 배포 정확도 평가는 별도 검증 데이터로 해야 한다.

## 실행·재현

프로젝트 루트에서 실행한다. 기존 `.conda/mps`, `.conda/coreml`, `models/yolov8n.pt`, `models/yolov8n.mlpackage`, COCO128이 필요하다. 기존 환경과 모델을 변경하지 않도록 변환 의존성·런타임·ONNX·fixture는 `.cache/webgpu`에 둔다.

```bash
# 준비에만 네트워크가 필요하다. 기존 conda 패키지 버전은 유지한다.
.conda/mps/bin/python -m pip install --no-deps --target .cache/webgpu/python -r requirements-webgpu-export.txt
PYTHONPATH=.cache/webgpu/python .conda/mps/bin/python -m scripts.prepare_webgpu

# 이 터미널은 켜 두고 Chrome에서 http://localhost:8018 접속
.conda/mps/bin/python -m scripts.serve_webgpu
```

자동 측정에는 Node.js와 Playwright가 필요하다. 기존 설치가 있으면 `PLAYWRIGHT_MODULE`에 패키지 절대 경로를 지정할 수 있다. 이 장비에서는 Codex에 번들된 Node.js 24.22.1과 기존 Playwright 1.57.0을 사용했다. 새 설치 예시는 다음과 같다.

```bash
npm install --prefix .cache/webgpu/tools --save-exact playwright@1.57.0
PLAYWRIGHT_MODULE="$PWD/.cache/webgpu/tools/node_modules/playwright" node scripts/benchmark_webgpu_browser.cjs

# Chrome 측정이 끝난 후 순서대로 실행. GPU 접근 가능한 일반 터미널 필요.
.conda/mps/bin/python -m scripts.benchmark_webgpu_native --backend mps
.conda/coreml/bin/python -m scripts.benchmark_webgpu_native --backend coreml
.conda/mps/bin/python -m scripts.compare_webgpu
```

Chrome은 설치된 Google Chrome을 `channel: chrome`으로 연다. 별도 Chromium 다운로드나 WebGPU 강제 활성화 플래그는 사용하지 않는다. 기본 결과는 `artifacts/webgpu-poc/{webgpu,mps,coreml,comparison}.json`에 저장한다. 이 폴더는 기존 저장소 정책에 따라 Git에서 제외된다. 비교기는 원본 가중치, 이미지 해시, 설정, 반복 조건이 다르면 비교를 거부한다.

브라우저 실행기는 `WEBGPU_URL`, `WEBGPU_OUTPUT`, `WEBGPU_ITERATIONS`, `WEBGPU_WARMUP`, `WEBGPU_REPEATS`를 지원한다. 기본 3라운드 결과와 별도로 8회·1라운드의 UI 검증을 `acceptance.json`에 저장했다. 이 짧은 검증 결과를 성능 표에 섞지 않았다.

320 입력 실험은 `scripts.prepare_webgpu --imgsz 320`으로 준비할 수 있지만, native 비교에는 같은 입력으로 별도 변환한 Core ML 모델이 필요하다. 현재 검증된 비교는 640 입력이다.

## 검증과 적용 판단

- Node 단위 검사 5개 통과: raw head 해석, 클래스별 NMS, confidence/max_det, 좌표 복원·클리핑, padding 반올림, 백분위 통계.
- Python 검사 2개 통과: 일대일·클래스별 대응, 잘못된 입력·반복 조건의 비교 거부.
- 실제 Chrome: 샘플 추론, 벤치마크, JSON 생성, 데스크톱·390px 화면 검사 통과. 페이지 JavaScript 오류 없음, 추론 관련 요청은 동일 출처 GET만 사용.
- 별도 UI 검증: 합성 canvas 스트림으로 카메라 시작·종료 및 트랙 해제, WebGPU 미지원 오류 표시 확인. 실제 카메라와 로봇은 사용하지 않았다.

```bash
node --test tests/webgpu_yolo.test.mjs
.conda/mps/bin/python -m unittest tests.test_webgpu_comparison
```

웹캠 기반 독립 탐지나 Python 설치 없는 사용자 단말 실행에는 WebGPU PoC를 확장할 수 있다. 현재 Mac에서 최대 처리량이 우선이면 Core ML 경로를 유지하는 편이 낫다. RealSense 깊이·로봇 작업에 브라우저 탐지를 연결하려면 서버로 결과를 반환하는 API, 프레임 ID·카메라 세대 동기화, 신선도 검증, 탭 중단 처리가 추가로 필요하다. 이번 PoC는 해당 운영 경로를 변경하지 않는다.

공식 참고: [ORT WebGPU](https://onnxruntime.ai/docs/tutorials/web/ep-webgpu.html), [ORT Web 배포](https://onnxruntime.ai/docs/tutorials/web/deploy.html), [Ultralytics ONNX export](https://docs.ultralytics.com/integrations/onnx).
