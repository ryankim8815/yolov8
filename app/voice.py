"""Chrome owns audio; the server owns session, turn and command state."""
import asyncio
import logging
from collections import deque
from contextlib import suppress
from uuid import uuid4

from fastapi import APIRouter, Query, Request, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field
from typing import Literal
from urllib.parse import urlsplit

from .store import DomainError
from .voice_commands import INTENTS, normalized, packing_answer
from .conversation import ConversationHistory
from .store import now

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api/voice")
BROWSER_TIMEOUT = 20


class Voice:
    def __init__(self, packing, enabled, *, barge_in=False):
        self.packing = packing
        self.enabled = enabled
        # Web Speech has no reliable echo cancellation for simultaneous synthesis.
        self.barge_in = False
        self.browser = None
        self.browser_id = None
        self.commands = None
        self.state = "idle" if enabled else "disabled"
        self.error = ""
        self.last_playback = None
        self.transcript = ""
        self.reply = ""
        self.session = None
        self.turn = 0
        self.confirming = False
        self.session_lock = asyncio.Lock()
        self.processing = set()
        self.context = "packing"
        self.robot_events = deque(maxlen=256)
        self.robot_sequence = 0
        self.history=ConversationHistory(packing.store.root/'voice-history.json' if packing is not None else None)

    def status(self):
        return {"state": self.state, "can_stop": self.session is not None,
                "barge_in": self.barge_in, "last_playback": self.last_playback,
                "error": self.error, "transcript": self.transcript, "reply": self.reply,
                "context": self.context, "session_id": self.session,
                "provider": "chrome", "browser_connected": self.browser is not None}

    def finish(self, error=""):
        if error and self.session and self.context=='packing':
            self.history.append('system',error,context=self.context,session_id=self.session,turn=self.turn)
        if self.session and self.commands is not None:
            self.commands.put_nowait({"action": "stop", "session": self.session, "turn": self.turn})
        self.session = None
        self.confirming = False
        self.state = "disabled" if not self.enabled else "error" if error else "idle"
        self.error = error

    async def start(self):
        # No server-side microphone, synthesis engine or subprocess is started.
        pass

    async def stop(self, *, session_only=False, expected_session=None, expected_context=None):
        async with self.session_lock:
            if expected_context is not None and self.context != expected_context:
                raise DomainError("로봇 음성 대기가 아닙니다.", 409)
            if expected_session is not None and self.session != expected_session:
                raise DomainError("음성 세션이 변경되었습니다.", 409)
            self.finish()
            if not session_only and self.processing:
                await asyncio.gather(*tuple(self.processing), return_exceptions=True)
            return self.status()

    async def send(self, action, **fields):
        if self.commands is None:
            raise DomainError("Chrome에서 음성 대기를 다시 시작하세요.", 503)
        self.commands.put_nowait({"action": action, "session": self.session, "turn": self.turn,
                                  "context": self.context, **fields})

    async def wake(self, *, context="packing", client_id=None):
        async with self.session_lock:
            if not self.enabled:
                raise DomainError("YOLO_VOICE_ENABLED=1로 서버를 시작하세요.", 503)
            if client_id is not None and client_id != self.browser_id:
                raise DomainError("음성 연결이 다른 탭으로 변경되었습니다. 이 탭에서 다시 시작하세요.", 409)
            if self.session:
                if self.context != context:
                    raise DomainError("다른 음성 대화가 진행 중입니다. 해당 대화를 종료한 뒤 시작하세요.",409)
                return self.status()
            if self.browser is None:
                raise DomainError("Chrome에서 대화 시작을 눌러 마이크를 연결하세요.", 503)
            self.session = uuid4().hex
            self.context = context
            self.turn = 1
            self.state = "preparing"
            self.last_playback = None
            self.transcript = self.reply = self.error = ""
            await self.send("listen")
            return self.status()

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
            if self.context == "robot":
                self.turn += 1
                self.state = "preparing"
                await self.send("listen")
            else:self.finish()
        elif event == "spoken" and not self.barge_in and self.state == "speaking":
            self.last_playback = "finished"
            self.turn += 1
            self.state = "preparing"
            await self.send("listen")
        elif event == "final" and self.state == "listening" and data.get("text", "").strip():
            self.state = "processing"
            self.transcript = data["text"]
            if self.context == "robot":
                self.robot_sequence += 1
                self.robot_events.append(dict(sequence=self.robot_sequence,session_id=self.session,text=self.transcript,created_at=now(),turn=self.turn))
                self.turn += 1
                self.state = "preparing"
                await self.send("listen")
                return
            self.history.append('user',self.transcript,context='packing',session_id=self.session,turn=self.turn,
                                key=f'{self.session}:{self.turn}:user')
            intent = INTENTS.get(normalized(self.transcript))
            if intent == "end":
                self.reply = "대화를 종료했습니다."
                self.history.append('assistant',self.reply,context='packing',session_id=self.session,turn=self.turn)
                self.finish()
                return
            try:
                operation = asyncio.create_task(asyncio.to_thread(packing_answer, self.packing, intent, confirming=self.confirming))
                self.processing.add(operation)
                operation.add_done_callback(self.processing.discard)
                # Disconnect must not cancel an already accepted database operation.
                answer = await asyncio.shield(operation)
                reply, confirming = answer.text, answer.confirm
            except DomainError as exc:
                reply, confirming = str(exc), False
            if self.session != data["session"]:
                return
            self.reply, self.confirming = reply, confirming
            self.history.append('assistant',reply,context='packing',session_id=self.session,turn=self.turn,
                                key=f'{self.session}:{self.turn}:assistant')
            self.state = "speaking"
            await self.send("speak", text=self.reply)


@router.get("/status")
async def status(request: Request):
    return request.app.state.voice.status()


@router.get('/history')
async def history(request:Request,after:int=Query(default=0,ge=0)):
    voice=request.app.state.voice
    return {**voice.history.snapshot(after),'status':voice.status()}


@router.get("/robot/events")
async def robot_events(request:Request,after:int=0):
    voice=request.app.state.voice
    return dict(**voice.status(),cursor=voice.robot_sequence,events=[e for e in voice.robot_events if e["sequence"]>after and e["session_id"]==voice.session])


@router.post("/robot/start")
async def robot_start(request:Request):
    check_control_origin(request)
    await request.app.state.voice.wake(context="robot",client_id=request.headers.get("x-voice-client"))
    return await robot_events(request)


@router.post("/robot/stop")
async def robot_stop(request:Request):
    check_control_origin(request)
    return await request.app.state.voice.stop(session_only=True,expected_session=request.headers.get("x-voice-session"),expected_context="robot")


def check_control_origin(request: Request):
    # Reject cross-site browser triggers.
    if request.headers.get("sec-fetch-site") == "cross-site":
        raise DomainError("로컬 대시보드에서 음성 대화를 제어하세요.", 403)


@router.post("/wake")
async def wake(request: Request):
    check_control_origin(request)
    return await request.app.state.voice.wake(client_id=request.headers.get("x-voice-client"))


@router.post("/stop")
async def stop_listening(request: Request):
    check_control_origin(request)
    return await request.app.state.voice.stop(session_only=True)


class BrowserEvent(BaseModel):
    event: Literal["ready", "ping", "listening", "permission", "timeout", "spoken", "final", "error"]
    session: str | None = Field(default=None, max_length=64)
    turn: int = Field(default=0, ge=0)
    text: str = Field(default="", max_length=2000)


@router.websocket("/browser")
async def browser_audio(websocket: WebSocket):
    # WebSocket requests do not receive the normal HTTP CSRF checks.
    origin = urlsplit(websocket.headers.get("origin", ""))
    if origin.scheme not in {"http", "https"} or origin.netloc != websocket.headers.get("host"):
        await websocket.close(code=1008)
        return
    voice = websocket.app.state.voice
    await websocket.accept()
    async with voice.session_lock:
        if not voice.enabled or (voice.browser is not None and voice.session is not None):
            await websocket.send_json({"action": "error", "text": "음성 기능이 꺼져 있거나 다른 Chrome 탭에서 사용 중입니다."})
            await websocket.close(code=1008)
            return
        if voice.browser is not None:
            await voice.browser.close(code=1000)
        voice.browser = websocket
        client_id = uuid4().hex
        voice.browser_id = client_id
        voice.commands = asyncio.Queue()
    queue = voice.commands

    async def write_commands():
        while True:
            await websocket.send_json(await queue.get())

    writer = asyncio.create_task(write_commands())
    try:
        ready = BrowserEvent.model_validate(await asyncio.wait_for(websocket.receive_json(), BROWSER_TIMEOUT))
        if ready.event != "ready" or voice.browser is not websocket:
            await websocket.close(code=1008)
            return
        await websocket.send_json({"action": "ready", "client_id": client_id})
        while True:
            data = BrowserEvent.model_validate(await asyncio.wait_for(websocket.receive_json(), BROWSER_TIMEOUT))
            if voice.browser is not websocket:
                return
            if data.event not in {"ping", "ready"}:
                await voice.event(data.model_dump())
    except (WebSocketDisconnect, TimeoutError, ValueError):
        pass
    except Exception:
        log.exception("Chrome voice connection failed")
    finally:
        writer.cancel()
        with suppress(asyncio.CancelledError, WebSocketDisconnect, RuntimeError):
            await writer
        if voice.browser is websocket:
            voice.finish("Chrome 음성 연결이 종료되었습니다. 대화 시작을 다시 누르세요." if voice.session else "")
            voice.browser = voice.commands = voice.browser_id = None
        with suppress(RuntimeError, WebSocketDisconnect):
            await websocket.close()
