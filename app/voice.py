"""One Mac audio helper per server. The event loop owns the conversation state."""
import asyncio
import json
import logging
from contextlib import suppress
from uuid import uuid4

from fastapi import APIRouter, Request

from .config import ROOT
from .store import DomainError
from .voice_commands import INTENTS, normalized, packing_answer

log = logging.getLogger(__name__)
HELPER = ROOT / ".cache/voice/packing-voice"
router = APIRouter(prefix="/api/voice")


async def close_helper(process):
    if process.returncode is None:
        # The Swift stdin reader exits on EOF even during permission prompts, capture or playback.
        process.stdin.close()
        try:
            await asyncio.wait_for(process.wait(), 2)
        except TimeoutError:
            with suppress(ProcessLookupError):
                process.kill()
            await process.wait()


class Voice:
    def __init__(self, packing, enabled, command=(str(HELPER),), *, barge_in=False):
        self.packing = packing
        self.enabled = enabled
        self.barge_in = barge_in
        self.command = command
        self.process = None
        self.reader = None
        self.state = "idle" if enabled else "disabled"
        self.error = ""
        self.last_playback = None
        self.transcript = ""
        self.reply = ""
        self.session = None
        self.turn = 0
        self.confirming = False
        self.session_lock = asyncio.Lock()

    def status(self):
        return {"state": self.state, "can_stop": self.session is not None,
                "barge_in": self.barge_in, "last_playback": self.last_playback,
                "error": self.error, "transcript": self.transcript, "reply": self.reply}

    def finish(self, error=""):
        self.session = None
        self.confirming = False
        self.state = "error" if error else "idle"
        self.error = error

    async def start(self):
        if not self.enabled:
            return
        try:
            self.process = await asyncio.create_subprocess_exec(
                *self.command, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE)
        except OSError:
            self.finish("음성 프로그램을 실행할 수 없습니다. bash scripts/build_voice.sh 실행 후 다시 시도하세요.")
            return
        self.reader = asyncio.create_task(self.read_events(self.process))

    async def stop(self, *, session_only=False):
        async with self.session_lock:
            if session_only and self.session is None:
                return self.status()
            if self.process is not None:
                process, self.process = self.process, None
                self.finish()  # Invalidate queued finals and pending confirmation before yielding.
                self.state = "stopping"
                try:
                    await close_helper(process)
                finally:
                    self.finish()
            # An accepted packing operation may still be finishing on a worker thread.
            # Shutdown drains it before closing the store. Manual stop only waits for audio release.
            if not session_only and self.reader is not None:
                await self.reader
            return self.status()

    async def send(self, action, **fields):
        data = {"action": action, "session": self.session, "turn": self.turn, **fields}
        self.process.stdin.write((json.dumps(data, ensure_ascii=False) + "\n").encode())
        await self.process.stdin.drain()

    async def wake(self):
        async with self.session_lock:
            if not self.enabled:
                raise DomainError("YOLO_VOICE_ENABLED=1로 서버를 시작하세요.", 503)
            if self.session:
                return self.status()
            if self.process is None or self.process.returncode is not None:
                if self.reader:
                    await self.reader
                await self.start()
                if self.process is None or self.process.returncode is not None:
                    raise DomainError(self.error, 503)
            self.session = uuid4().hex
            self.turn = 1
            self.state = "preparing"
            self.last_playback = None
            self.transcript = self.reply = self.error = ""
            try:
                await self.send("listen")
            except (BrokenPipeError, ConnectionResetError):
                self.finish("음성 프로그램 연결이 끊겼습니다. 대화 시작을 다시 누르세요.")
                raise DomainError(self.error, 503)
            return self.status()

    async def read_events(self, process):
        try:
            async for line in process.stdout:
                await self.event(json.loads(line))
        except Exception:
            log.exception("Voice helper protocol or packing action failed")
        finally:
            await close_helper(process)
            if self.process is process:
                self.finish("음성 프로그램이 종료되었습니다. 대화 시작을 다시 누르세요.")

    async def event(self, data):
        if not self.session or (data.get("session"), data.get("turn")) != (self.session, self.turn):
            return
        event = data["event"]
        if event == "error":
            self.finish(data.get("text") or "마이크와 시스템 음성 설정을 확인하세요.")
        elif event == "permission" and self.state == "preparing":
            self.state = "permission"
        elif event == "listening" and self.state in ("preparing", "permission"):
            self.state = "listening"
        elif event == "timeout" and self.state == "listening":
            self.finish()
        elif event == "playback_started" and self.state == "preparing_reply":
            self.state = "speaking"
        elif event in ("interrupted", "reply_finished") and self.barge_in and self.state == "speaking":
            self.last_playback = "interrupted" if event == "interrupted" else "finished"
            # The helper already owns the next input stream, including the beginning of an interruption.
            self.turn += 1
            self.state = "listening"
        elif event == "spoken" and not self.barge_in and self.state == "speaking":
            self.last_playback = "finished"
            self.turn += 1
            self.state = "preparing"
            await self.send("listen")
        elif event == "final" and self.state == "listening":
            self.state = "processing"
            self.transcript = data["text"]
            intent = INTENTS.get(normalized(self.transcript))
            if intent == "end":
                self.reply = "대화를 종료했습니다."
                self.finish()
                return
            try:
                answer = await asyncio.to_thread(packing_answer, self.packing, intent, confirming=self.confirming)
                reply, confirming = answer.text, answer.confirm
            except DomainError as exc:
                reply, confirming = str(exc), False
            if self.session != data["session"]:
                return
            self.reply, self.confirming = reply, confirming
            self.state = "preparing_reply" if self.barge_in else "speaking"
            await self.send("speak_listen" if self.barge_in else "speak", text=self.reply)


@router.get("/status")
async def status(request: Request):
    return request.app.state.voice.status()


def check_control_origin(request: Request):
    # Native Shortcuts sends no Origin. Reject cross-site browser triggers.
    if request.headers.get("sec-fetch-site") == "cross-site":
        raise DomainError("로컬 대시보드에서 음성 대화를 제어하세요.", 403)


@router.post("/wake")
async def wake(request: Request):
    check_control_origin(request)
    return await request.app.state.voice.wake()


@router.post("/stop")
async def stop_listening(request: Request):
    check_control_origin(request)
    return await request.app.state.voice.stop(session_only=True)
